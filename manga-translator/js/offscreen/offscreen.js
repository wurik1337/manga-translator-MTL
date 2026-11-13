// offscreen.js — инференс-документ: держит ONNX-сессии (WebGPU с фолбэком на WASM)
// и выполняет конвейер «детекция → OCR» поверх переданного изображения.

import * as ort from '../../vendor/ort/ort.all.min.mjs';
import { processImage } from '../lib/pipeline.js';
import { buildCharset } from '../lib/ppocr.js';
import { loadVocab } from '../lib/mangaocr.js';
import { MODEL_CATALOG, findModel } from '../lib/modelmeta.js';
import { getModelBuffer, getCustomOcrFiles } from '../lib/modelstore.js';
// ВАЖНО: isCustomOcrId/customOcrId экспортирует customocr.js, НЕ modelmeta.js —
// ошибочный импорт из modelmeta роняет линковку всего модульного графа offscreen
// (в браузере это «Could not establish connection» навсегда: слушателей нет).
import { parseCustomOcrZip, pickRecHeight, decodeDict, dictCandidates, fitCharsetToClasses, probeRecClasses, isCustomOcrId, customOcrId } from '../lib/customocr.js';
import { MSG } from '../lib/protocol.js';
import { EpFallback } from '../lib/eptools.js';
import { decodeRgbaB64, encodeRgbaB64, fitLongSide } from '../lib/imagetools.js';
import { inpaintLadder, bubbleInterior } from '../lib/inpaint.js';
import { visionReadCrop } from '../lib/translate.js';

// --- настройка ORT ---
ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/ort/');
ort.env.wasm.numThreads = 1;            // без SharedArrayBuffer в extension-страницах
ort.env.logLevel = 'error';

const gpu = new EpFallback();
let eps = null; // закэшированный список EP (null — ещё не проверяли адаптер)

async function adapterAvailable() {
  try {
    if (!navigator.gpu) return false;
    return !!(await navigator.gpu.requestAdapter());
  } catch (e) { return false; }
}

async function executionProviders() {
  if (gpu.broken) return ['wasm'];
  if (eps) return eps;
  eps = await adapterAvailable() ? ['webgpu', 'wasm'] : ['wasm'];
  return eps;
}

// --- кэш сессий по id модели ---
const sessionCache = new Map(); // key → { promise }

async function createSession(url) {
  const buf = await getModelBuffer(url);
  if (!buf) throw new Error(`Модель не скачана: ${url}`);
  const providers = await executionProviders();
  return ort.InferenceSession.create(buf, { executionProviders: providers, graphOptimizationLevel: 'all' });
}

function cached(key, factory) {
  if (!sessionCache.has(key)) {
    sessionCache.set(key, factory().catch(e => { sessionCache.delete(key); throw e; }));
  }
  return sessionCache.get(key);
}

/** Освободить все сессии (при смене EP они бесполезны и держат GPU-память). */
async function disposeSessions() {
  const entries = [...sessionCache.entries()];
  sessionCache.clear();
  for (const [, p] of entries) {
    try { const s = await p; await s?.release?.(); } catch (e) { /* сессия уже мертва */ }
  }
}

async function dataText(path) {
  const res = await fetch(chrome.runtime.getURL(path));
  return res.text();
}

// --- сборка пайплайна под выбранные модели ---
/** Сессии+словарь для пользовательской PP-OCR модели (custom:<id>).
 *  det.onnx в архиве не обязателен: без него берётся встроенный детектор
 *  строк PP-OCRv5 Mobile (должен быть скачан). Высота входа rec берётся
 *  из meta.json, иначе определяется warmup-прогоном (48 → 32). */
async function buildCustomOcr(id) {
  const files = await getCustomOcrFiles(id);
  if (!files.rec) throw new Error(`Файлы кастомной модели не найдены: ${id}`);
  const providers = await executionProviders();
  const recSession = await ort.InferenceSession.create(files.rec, { executionProviders: providers, graphOptimizationLevel: 'all' });
  let detSession = null;
  if (files.det) {
    detSession = await ort.InferenceSession.create(files.det, { executionProviders: providers, graphOptimizationLevel: 'all' });
  } else {
    const builtin = findModel('ppocrv5-mobile').files.find(f => f.role === 'det').url;
    detSession = await cached('ocr:ppocrv5-mobile:det', () => createSession(builtin));
  }
  // общий классификатор угла — файл ppocrv5-cls, если он скачан с любой встроенной моделью
  const clsUrl = findModel('ppocrv5-mobile').files.find(f => f.role === 'cls').url;
  const clsSession = await cached('ocr:cls-shared', () => createSession(clsUrl)).catch(() => null);

  let meta = {};
  try { meta = files.meta ? JSON.parse(new TextDecoder().decode(files.meta)) : {}; } catch (e) { /* без меты */ }
  const recHeight = await pickRecHeight(ort, recSession, meta.recHeight || null);
  const dictText = decodeDict(files.dict);
  // v1.6.4: перебираем варианты словаря (как есть / без дубликатов) и для
  // каждого — компоновки под фактическое число классов модели. Рассинхрон
  // (dict от другого варианта/репозитория) давал «кашу набора символов».
  const classes = await probeRecClasses(ort, recSession, recHeight);
  let fit = null;
  if (classes) {
    for (const cand of dictCandidates(dictText)) {
      fit = fitCharsetToClasses(cand, classes);
      if (fit) break;
    }
  }
  if (!fit) {
    // без прогона или без совпадения — стандартная компоновка (старое поведение)
    fit = { charset: buildCharset(dictText), mode: 'default' };
  }
  if (fit.mode === 'default' && classes) {
    const L = dictText.split(/\r?\n/).filter(l => l !== '').length;
    throw new Error(
      `Словарь не подходит к rec-модели: в dict.txt ${L} строк, у модели ${classes} выходных классов ` +
      `(расхождение ${classes - L > 0 ? '+' : ''}${classes - L}). Словарь и модель, похоже, из разных вариантов: ` +
      'у вариантов PP-OCRv5/v6 словари различаются между собой. Скачай inference.yml/словарь и inference.onnx из ОДНОГО ' +
      'репозитория (или возьми dict.txt, идущий в паре с твоим rec.onnx), и импортируй заново.'
    );
  }

  return {
    kind: 'ppocr',
    detSession,
    recSession,
    clsSession,
    charset: fit.charset, // компоновка, подобранная под число классов модели (v1.6.3)
    opts: { recHeight, ...(meta.unclipRatio ? { unclipRatio: Number(meta.unclipRatio) } : {}), ...(meta.verticalRotate ? { verticalRotate: meta.verticalRotate } : {}) },
  };
}

async function buildModels(detectorId, ocrId, skipOcr = false) {
  const det = findModel(detectorId) || MODEL_CATALOG.detectors[0];
  const detectorSession = await cached(`det:${det.id}`, () => createSession(det.files[0].url));
  // Vision OCR: распознаёт и переводит LLM — OCR-модель не загружаем вовсе
  // (её можно вообще не скачивать)
  if (skipOcr) return { detector: detectorSession, ocr: null };

  const ocr = isCustomOcrId(ocrId) ? null : (findModel(ocrId) || MODEL_CATALOG.ocr[0]);

  if (isCustomOcrId(ocrId)) {
    const custom = await cached(`custom-ocr:${ocrId}`, () => buildCustomOcr(customOcrId(ocrId)));
    return { detector: detectorSession, ocr: custom };
  }

  if (ocr.engine === 'mangaocr') {
    const [enc, dec, vocabText] = await Promise.all([
      cached(`ocr:${ocr.id}:enc`, () => createSession(ocr.files.find(f => f.role === 'enc').url)),
      cached(`ocr:${ocr.id}:dec`, () => createSession(ocr.files.find(f => f.role === 'dec').url)),
      dataText(ocr.vocab),
    ]);
    return {
      detector: detectorSession,
      ocr: { kind: 'mangaocr', encSession: enc, decSession: dec, vocab: loadVocab(vocabText) },
    };
  }

  const [detS, recS, clsS, dictText] = await Promise.all([
    cached(`ocr:${ocr.id}:det`, () => createSession(ocr.files.find(f => f.role === 'det').url)),
    cached(`ocr:${ocr.id}:rec`, () => createSession(ocr.files.find(f => f.role === 'rec').url)),
    cached(`ocr:${ocr.id}:cls`, () => createSession(ocr.files.find(f => f.role === 'cls').url).catch(() => null)),
    dataText(ocr.charset),
  ]);
  return {
    detector: detectorSession,
    ocr: {
      kind: 'ppocr',
      detSession: detS,
      recSession: recS,
      clsSession: clsS || null,
      charset: buildCharset(dictText),
      opts: ocr.opts || {},
    },
  };
}

/**
 * Пиксели из сообщения → {width, height, data: Uint8ClampedArray}.
 * Новый формат: image.rgbaB64 (base64 — переживает любой сериализатор канала).
 * Легаси: image.data как typed array или как «JSON-объект» {0:..,1:..} —
 * такое приходило от content script, оставшегося с предыдущей версии
 * расширения (страница без F5 после обновления).
 */
function decodeImageMsg(msg) {
  const im = msg?.image || msg?.imageData;
  if (!im || !im.width || !im.height) return null;
  const px = im.width * im.height * 4;
  if (im.rgbaB64) {
    const u8 = decodeRgbaB64(im.rgbaB64);
    if (u8.length !== px) return null;
    return { width: im.width, height: im.height, data: new Uint8ClampedArray(u8.buffer) };
  }
  const d = im.data;
  if (d && typeof d.length === 'number') {
    const data = (d instanceof Uint8ClampedArray) ? d : Uint8ClampedArray.from(Object.values(d));
    if (data.length !== px) return null;
    return { width: im.width, height: im.height, data };
  }
  return null;
}

// --- Vision OCR: кроп (RGBA) → JPEG dataURL → vision-LLM ---
// offscreen-документ — обычная DOM-страница: JPEG кодируем нативным canvas
// (библиотек кодирования JPEG в расширении нет, payload в 10+ раз меньше PNG).

function rgbaToJpegDataUrl(im, maxSide = 1024, quality = 0.8) {
  const fitted = fitLongSide(im, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = fitted.width;
  canvas.height = fitted.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(fitted.data), fitted.width, fitted.height), 0, 0);
  return canvas.toDataURL('image/jpeg', quality);
}

function makeVisionRead(vs) {
  let warned = false;
  return async (crop) => {
    try {
      return await visionReadCrop(vs, rgbaToJpegDataUrl(crop), {
        targetLang: vs.targetLang || 'ru',
        promptLang: vs.promptLang || 'ru',
        customPrompt: vs.customPrompt || '',
      });
    } catch (e) {
      if (!warned) {
        warned = true;
        console.warn('[MTL] vision LLM недоступна (дальнейшие ошибки кропов молча):',
          String(e?.message || e).slice(0, 160));
      }
      return null;
    }
  };
}

// --- обработка сообщений от service worker ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== MSG.OFFSCREEN_RUN) return false; // чужие сообщения не держим канал открытым
  (async () => {
    const t0 = Date.now();
    const { detectorModel, ocrModel, minConfidence, translateFreeText, renderMode, vision } = msg;
    // vision включён осмысленно только если заданы адрес и модель (имена полей —
    // как в settings: их читают normalizeBaseUrl/llmHeaders/llmChat)
    const visionCfg = vision?.enabled && vision.llmBaseUrl && vision.llmModel ? vision : null;
    const img = decodeImageMsg(msg);
    if (!img) {
      sendResponse({ ok: false, error: 'Не удалось прочитать пиксели изображения (устаревший content script? Перезагрузи страницу, F5)' });
      return;
    }
    let epUsed = 'wasm';
    const runOnce = async () => {
      const providers = await executionProviders();
      epUsed = providers[0];
      const models = await buildModels(detectorModel, ocrModel, !!visionCfg);
      const result = await processImage(ort, models, img, {
        minConfidence, translateFreeText,
        vision: visionCfg ? { read: makeVisionRead(visionCfg), concurrency: 2 } : null,
      });
      return result;
    };

    // сборка ответа; в режиме «Стирать текст» — очищенное изображение.
    // Ошибка стирания не должна ронять перевод: отдаём ответ без картинки.
    const makeResponse = (result, extra = {}) => {
      const response = {
        ok: true, items: result.items, ep: epUsed,
        timing: { ...result.timing, build: Date.now() - t0 - result.timing.total },
        ...(result.vision ? { visionStats: result.vision, vision: true } : {}),
        ...extra,
      };
      // «Стирать текст» ('inpaint') — деликатный режим: маска текста, без
      // плоских прямоугольников; «прямоугольно» ('inpaint_rect') — быстрый
      // агрессивный режим с плоской заливкой бокса при ненадёжной маске.
      if ((renderMode === 'inpaint' || renderMode === 'inpaint_rect') && result.items.length) {
        try {
          const tI = Date.now();
          const res = inpaintLadder(img, result.items, {
            mode: renderMode === 'inpaint_rect' ? 'rect' : 'tight',
          });
          response.image = { width: res.image.width, height: res.image.height, rgbaB64: encodeRgbaB64(res.image.data) };
          response.timing.inpaint = Date.now() - tI;
          // тесная рамка интерьера пузыря на очищенной картинке — по ней
          // content script рисует текст (бокс детекции бывает шире пузыря)
          for (const it of result.items) {
            if (it.kind !== 'bubble') continue;
            try { it.drawBox = bubbleInterior(res.image, it.box) || undefined; } catch (e) { /* без интерьера рисуем по боксу */ }
          }
        } catch (e) {
          console.warn('[MTL] inpaint failed:', String(e?.message || e).slice(0, 140));
          response.inpaintError = String(e?.message || e);
        }
      }
      return response;
    };

    try {
      const result = await runOnce();
      sendResponse(makeResponse(result));
    } catch (e) {
      // kernel-ошибка WebGPU (реальный кейс: ceil_mode у MaxPool в детекторе,
      // «...not yet implemented in the webgpu executor») → один раз
      // пересоздаём все сессии на WASM и повторяем прогон
      if (gpu.shouldRetryOnCpu(e, epUsed === 'webgpu')) {
        console.warn('[MTL] WebGPU не смог выполнить модель (' + String(e?.message || e).slice(0, 140) + '), переключаюсь на WASM-CPU');
        gpu.markBroken();
        await disposeSessions();
        try {
          const result = await runOnce();
          sendResponse(makeResponse(result, { fallback: true }));
          return;
        } catch (e2) { e = e2; }
      }
      sendResponse({ ok: false, error: String(e?.message || e), ep: epUsed });
    }
  })();
  return true; // асинхронный ответ
});

// лёгкий пинг: документ живой, сообщаем доступность WebGPU
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'OFFSCREEN_PING') {
    sendResponse({ ok: true, webgpu: !gpu.broken && !!(eps && eps[0] === 'webgpu') });
  }
});
