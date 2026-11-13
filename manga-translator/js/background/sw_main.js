// service-worker.js — оркестратор расширения: настройки, загрузка моделей (Cache API),
// жизненный цикл offscreen-документа, перевод (Google / локальная LLM), реле сообщений.

import { MSG, DEFAULT_SETTINGS, mergeSettings } from '../lib/protocol.js';
import { MODEL_CATALOG, findModel, activeUrls } from '../lib/modelmeta.js';
import { missingModelFiles, describeMissing } from '../lib/modelreadiness.js';
import { isCustomOcrId, customOcrId } from '../lib/customocr.js';
import {
  hasModel, downloadModelFile, getModelBuffer, deleteModelFiles, clearAllModels, storageUsage,
  deleteCustomOcrFiles,
} from '../lib/modelstore.js';
import { translateTexts, llmListModels, llmChat, normalizeBaseUrl } from '../lib/translate.js';
import { buildSingleMessage } from '../lib/prompts.js';

const OFFSCREEN_URL = 'html/offscreen.html';
let offscreenCreating = null;
let offscreenLastUsed = 0;

// ---------------- настройки ----------------

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return mergeSettings(settings);
}

async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// ---------------- offscreen ----------------

async function hasOffscreen() {
  // getContexts есть только в Chrome 116+; на старых проверяем пингом
  if (typeof chrome.runtime.getContexts === 'function' && chrome.runtime.ContextType) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    return contexts.length > 0;
  }
  try {
    const pong = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' });
    return !!pong?.ok;
  } catch (e) { return false; }
}

async function ensureOffscreen() {
  if (!chrome.offscreen) {
    throw new Error('Расширению нужен Chrome 109+ (нет offscreen API). Обнови браузер.');
  }
  offscreenLastUsed = Date.now();
  if (!(await hasOffscreen())) {
    if (offscreenCreating) { await offscreenCreating; }
    else {
      // ВАЖНО: reason строго литералом 'DOM_SCRAPING'. Обращение к члену enum по имени
      // опасно: при опечатке/отсутствии члена получается undefined, и Chrome отбраковывает
      // createDocument с «Error in invocation of offscreen.createDocument…» —
      // так пал весь конвейер (реальный кейс, был невалидный член enum).
      offscreenCreating = chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['DOM_SCRAPING'],
        justification: 'Локальный нейросетевой анализ изображений (детекция пузырей и OCR) для перевода манги.',
      }).catch(e => {
        offscreenCreating = null;
        // «Only a single offscreen document may be created» — гонка или документ уже
        // создан до рестарта SW: это не ошибка, документ нам и нужен
        if (/single offscreen document|already exists/i.test(String(e?.message || e))) return;
        throw new Error('Не удалось запустить конвейер (offscreen): ' + String(e?.message || e).slice(0, 160));
      });
      await offscreenCreating;
      offscreenCreating = null;
    }
  }
  // дождаться, пока offscreen-документ зарегистрирует слушателей
  for (let i = 0; i < 20; i++) {
    const pong = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' }).catch(() => null);
    if (pong?.ok) break;
    await new Promise(r => setTimeout(r, 250));
  }
  scheduleIdleClose();
}

let idleCloseSet = false;
function scheduleIdleClose() {
  if (idleCloseSet) return; // ensureOffscreen вызывается на каждую картинку — интервал должен быть один
  idleCloseSet = true;
  setInterval(async () => {
    if (Date.now() - offscreenLastUsed < 120_000) return;
    if (await hasOffscreen()) {
      try { await chrome.offscreen.closeDocument(); } catch (e) { /* уже закрыт */ }
    }
  }, 60_000);
}

// ---------------- состояние моделей ----------------

/** hasModel, который не бросает исключение (Cache API может быть временно недоступен). */
async function safeHasModel(url) {
  try { return await hasModel(url); } catch (e) { return false; }
}

async function getState() {
  const settings = await getSettings();
  const downloaded = {};
  for (const group of [MODEL_CATALOG.detectors, MODEL_CATALOG.ocr]) {
    for (const m of group) {
      const results = await Promise.all(m.files.map(f => safeHasModel(f.url)));
      downloaded[m.id] = results.every(Boolean);
    }
  }
  const { downloads = {} } = await chrome.storage.local.get('downloads');
  let usage = { usageMB: 0, quotaMB: 0 };
  try { usage = await storageUsage(); } catch (e) { /* не критично */ }
  const activeCount = await countActiveModelFiles(settings);
  const { customOcr = [] } = await chrome.storage.local.get('customOcr');
  // getState никогда не должен падать: от него зависит весь UI popup
  return { catalog: MODEL_CATALOG, downloaded, downloads, usage, activeCount, customOcr, settings };
}

async function countActiveModelFiles(settings) {
  const { customOcr = [] } = await chrome.storage.local.get('customOcr');
  const urls = activeUrls(settings.detectorModel, settings.ocrModel, customOcr);
  const results = await Promise.all(urls.map(safeHasModel));
  return results.filter(Boolean).length;
}

function broadcastProgress(payload) {
  chrome.runtime.sendMessage({ type: MSG.MODEL_PROGRESS, ...payload }).catch(() => {});
}

async function downloadModel(id) {
  const model = findModel(id);
  if (!model) throw new Error(`Модель не найдена: ${id}`);
  const { downloads = {} } = await chrome.storage.local.get('downloads');
  if (downloads[id]?.status === 'downloading') return; // уже качается

  const totalBytes = model.sizeMB * 1024 * 1024;
  downloads[id] = { status: 'downloading', received: 0, total: totalBytes, files: model.files.length };
  await chrome.storage.local.set({ downloads });
  broadcastProgress({ id, status: 'downloading', received: 0, total: totalBytes });

  try {
    let doneBytes = 0;
    for (const f of model.files) {
      if (await hasModel(f.url)) continue;
      const fileSize = await fetch(f.url, { method: 'HEAD' })
        .then(r => Number(r.headers.get('content-length')) || 0).catch(() => 0);
      await downloadModelFile(f.url, {
        onProgress: (received) => {
          broadcastProgress({ id, status: 'downloading', received: doneBytes + received, total: totalBytes });
        },
      });
      doneBytes += fileSize;
      broadcastProgress({ id, status: 'downloading', received: doneBytes, total: totalBytes });
    }
    const done = { status: 'done', received: totalBytes, total: totalBytes, files: model.files.length };
    const cur = { ...(await chrome.storage.local.get('downloads')).downloads };
    cur[id] = done;
    await chrome.storage.local.set({ downloads: cur });
    broadcastProgress({ id, ...done });
  } catch (e) {
    const cur = { ...(await chrome.storage.local.get('downloads')).downloads };
    cur[id] = { status: 'error', error: String(e?.message || e) };
    await chrome.storage.local.set({ downloads: cur });
    broadcastProgress({ id, ...cur[id] });
    throw e;
  }
}

async function deleteModel(id) {
  const model = findModel(id);
  if (!model) return;
  await deleteModelFiles(model.files.map(f => f.url));
  const { downloads = {} } = await chrome.storage.local.get('downloads');
  delete downloads[id];
  await chrome.storage.local.set({ downloads });
}

// ---------------- перевод ----------------

// 1×1 прозрачный PNG (68 байт) — проба vision-поддержки в TEST_LLM
const VISION_PROBE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** Конфиг Vision OCR из настроек (null — режим выключен). Имена полей LLM —
 *  как в settings: их читают normalizeBaseUrl/llmHeaders/llmChat. */
function visionFromSettings(settings) {
  if (settings.engine !== 'llm' || !settings.llmVision) return null;
  return {
    enabled: true,
    llmBaseUrl: settings.llmBaseUrl || '',
    llmApiKey: settings.llmApiKey || '',
    llmModel: settings.llmModel || '',
    llmTemperature: settings.llmTemperature,
    targetLang: settings.targetLang || 'ru',
    promptLang: settings.promptLang || 'ru',
    customPrompt: settings.llmCustomPrompt || '',
  };
}

async function runPipeline(image, settings) {
  await ensureOffscreen();
  const vision = visionFromSettings(settings);
  return chrome.runtime.sendMessage({
    type: MSG.OFFSCREEN_RUN,
    image,
    detectorModel: settings.detectorModel,
    ocrModel: settings.ocrModel,
    minConfidence: settings.minConfidence,
    translateFreeText: settings.translateFreeText,
    renderMode: settings.renderMode,   // 'inpaint' → offscreen вернёт очищенную картинку
    ...(vision ? { vision } : {}),
  });
}

/** Последний шанс перед NOT_DOWNLOADED: молча докачать недостающие ВСТРОЕННЫЕ
 *  файлы (обычно это детектор строк PP-OCRv5 Mobile для rec-only кастомной OCR).
 *  custom://-ключи не трогаем — они в IndexedDB и чинятся только реимпортом.
 *  Возвращает true, если что-то удалось докачать (тогда проверку повторяем). */
async function repairMissingModels(missing) {
  const urls = missing.filter(u => u.startsWith('http'));
  if (!urls.length) return false;
  let done = 0;
  for (const u of urls) {
    try {
      await Promise.race([downloadModelFile(u), new Promise(r => setTimeout(r, 30000))]);
      if (await hasModel(u)) done++;
    } catch { /* нет сети — вернём понятную ошибку */ }
  }
  return done > 0;
}

async function handleTranslateImage(image, debug = false) {
  const settings = await getSettings();
  const { customOcr = [] } = await chrome.storage.local.get('customOcr');
  const vision = visionFromSettings(settings);
  if (vision && (!vision.llmBaseUrl || !vision.llmModel)) {
    return {
      ok: false,
      error: 'Vision OCR включён, но не настроен: в разделе API Mode укажи SERVER URL и MODEL с поддержкой изображений.',
    };
  }
  // Vision OCR: распознаёт LLM с картинками — OCR-модель не требуется
  let missing = await missingModelFiles(settings, customOcr, hasModel, { skipOcr: !!vision });
  if (missing.length && (await repairMissingModels(missing))) {
    missing = await missingModelFiles(settings, customOcr, hasModel, { skipOcr: !!vision });
  }
  if (missing.length) {
    // missingLabels: названия моделей для понятной ошибки на странице
    return { ok: false, error: 'NOT_DOWNLOADED', missing, missingLabels: describeMissing(missing, customOcr) };
  }
  const res = await runPipeline(image, settings);
  if (!res?.ok) return { ok: false, error: res?.error || 'pipeline failed' };
  // Vision: вызовы были, но ВСЕ не удались — пустой результат ничего не скажет,
  // отдаём диагностичную ошибку (обычно модель без поддержки изображений)
  if (vision && res.visionStats?.requested > 0 && res.visionStats.ok === 0) {
    return {
      ok: false,
      error: 'Vision-модель не вернула текст ни для одного фрагмента. Нажми «Проверить соединение» в popup: если проба изображения не прошла — модель без vision (нужна qwen2.5-vl, gemma-3, llava и т.п.).',
    };
  }

  // отладочный режим: отдаём ВСЕ рамки детекции (включая с пустым OCR) без перевода
  if (debug) {
    return {
      ok: true,
      debug: true,
      timing: res.timing,
      items: res.items.map(it => ({
        box: (it.box || []).map(v => Math.round(v)),
        kind: it.kind,
        text: it.text || '',
        score: typeof it.score === 'number' ? it.score : null,
      })),
    };
  }

  const items = res.items.filter(it => it.text && it.text.trim());
  if (!items.length) return { ok: true, items: [], timing: res.timing };

  // v1.7.0 Vision OCR: переводы уже внутри items (LLM читает и переводит одним
  // вызовом); отсутствующие добираются обычным переводчиком (fallback)
  let translations = items.map(it =>
    typeof it.translation === 'string' && it.translation.trim() ? it.translation.trim() : null);
  const needIdx = [];
  for (let i = 0; i < items.length; i++) if (!translations[i]) needIdx.push(i);
  if (needIdx.length) {
    const extra = await translateTexts(needIdx.map(i => items[i].text), settings, {});
    needIdx.forEach((idx, k) => { translations[idx] = extra[k] ?? null; });
  }
  return {
    ok: true,
    items: items.map((it, i) => ({
      box: it.box.map(v => Math.round(v)),
      kind: it.kind,
      text: it.text,
      translation: translations[i],
      score: typeof it.score === 'number' ? it.score : null,
      // тесные erase-боксы и интерьер пузыря — для рисования по очищенной картинке
      ...(Array.isArray(it.erase) && it.erase.length ? { erase: it.erase.map(b => b.map(Math.round)) } : {}),
      ...(Array.isArray(it.drawBox) && it.drawBox.length === 4 ? { drawBox: it.drawBox.map(v => Math.round(v)) } : {}),
    })),
    timing: res.timing,
    // очищенная от текста картинка (режим «Стирать текст») — обязательна к пробросу:
    // без неё content уйдёт в фолбэк-плашки поверх оригинала
    ...(res.image ? { image: res.image } : {}),
    ...(res.inpaintError ? { inpaintError: res.inpaintError } : {}),
  };
}

// ---------------- реле прогресса страницы ----------------

let pageJob = { active: false, done: 0, total: 0, error: null };
let pageJobLastBeat = 0; // время последнего отклика content script'а

async function broadcastPage() {
  chrome.runtime.sendMessage({ type: MSG.PAGE_PROGRESS, ...pageJob }).catch(() => {});
  await chrome.storage.local.set({ pageJob });
}

async function finishPageJob(error) {
  pageJob = { active: false, done: pageJob.done, total: pageJob.total, error: error || null };
  await broadcastPage();
}

async function startTranslatePage(debug = false) {
  const settings = await getSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    await finishPageJob('Активная вкладка не найдена.');
    return;
  }

  // модели должны быть скачаны — иначе честно говорим об этом
  const urls = activeUrls(settings.detectorModel, settings.ocrModel);
  const missing = [];
  for (const u of urls) if (!(await hasModel(u))) missing.push(u);
  if (missing.length) {
    await finishPageJob('Сначала скачайте модели: Config → иконка ⬇ у детектора и OCR.');
    return;
  }

  pageJob = { active: true, done: 0, total: 0, error: null };
  pageJobLastBeat = Date.now();
  await broadcastPage();

  // команда контент-скрипту; если он не отвечает — сразу понятная ошибка
  let responded = false;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_PAGE, debug });
    responded = !!res?.ok;
  } catch (e) {
    responded = false;
  }
  if (!responded) {
    await finishPageJob(
      'Страница не отвечает. Если это локальный файл (file://) — включите «Разрешить доступ к файлам URLs» ' +
      'в деталях расширения (chrome://extensions). Внутренние страницы браузера не поддерживаются.'
    );
  }
}

// сторож: если контент-скрипт замолчал надолго — завершаем с ошибкой, а не висим вечно
setInterval(async () => {
  if (!pageJob.active) return;
  if (Date.now() - pageJobLastBeat > 45_000) {
    await finishPageJob('Превышено время ожидания ответа от страницы. Проверьте, что открыта страница с мангой, и попробуйте ещё раз.');
  }
}, 15_000);

// «Стереть перевод»: убрать оверлеи и кэш на активной вкладке.
// Отдельно от TRANSLATE_PAGE — без pageJob, прогресса и сторожа.
async function clearTranslationsOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: 'NO_TAB' };
  const send = () => chrome.tabs.sendMessage(tab.id, { type: MSG.CLEAR_TRANSLATIONS });
  try {
    const res = await send();
    if (res?.ok) return { ok: true };
  } catch (e) { /* приёмника нет — пробуем реинжект ниже */ }
  // приёмника нет: страница открыта до (пере)установки расширения или file://
  // без разрешения. Реинжект спасает первый случай; content.js идемпотентен
  // (window.__mtlContentLoaded), живой скрипт повторно не инициализируется.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['js/content/content.js'],
    });
    const res = await send();
    if (res?.ok) return { ok: true, reinjected: true };
    return { ok: false, error: 'NO_RESPONSE' };
  } catch (e) {
    // сюда попадают служебные страницы (chrome://) и file:// без разрешения
    return { ok: false, error: 'NO_CONTENT' };
  }
}

// ---------------- обработчик сообщений ----------------

// Определение формата по магическим байтам: некоторые CDN вместо картинки
// отдают HTML-страницу (защита от хотлинка, требование входа) — тогда честно
// говорим об этом вместо непонятного «could not be decoded» у пользователя.
function sniffImage(head) {
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) return 'image/png';
  if (head.length >= 3 && head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return 'image/jpeg';
  if (head.length >= 6 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'image/gif';
  if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'image/webp';
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4D) return 'image/bmp';
  if (head.length >= 12 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
    const brand = String.fromCharCode(head[8], head[9], head[10], head[11]);
    if (brand.startsWith('av')) return 'image/avif';
    return 'image/heif';
  }
  return null;
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case MSG.PING:
          sendResponse({ ok: true });
          break;

        case MSG.GET_SETTINGS:
          sendResponse({ ok: true, settings: await getSettings() });
          break;

        case MSG.SET_SETTINGS:
          sendResponse({ ok: true, settings: await setSettings(msg.patch || {}) });
          break;

        case MSG.OCR_IMPORT_REGISTER: {
          // файлы уже в кэше (кладёт popup через modelstore.putCustomOcrFiles)
          const entry = msg.entry;
          if (!entry?.id || !entry.name || !entry.hasRec) { sendResponse({ ok: false, error: 'BAD_ENTRY' }); break; }
          const { customOcr = [] } = await chrome.storage.local.get('customOcr');
          const clean = {
            id: String(entry.id).slice(0, 32), name: String(entry.name).slice(0, 40),
            hasDet: !!entry.hasDet, hasRec: true, recHeight: entry.recHeight || null,
            dictLines: Number(entry.dictLines) || 0,
            sizeMB: Number(entry.sizeMB) || 0, createdAt: Number(entry.createdAt) || Date.now(),
            opts: entry.opts && typeof entry.opts === 'object' ? entry.opts : {},
          };
          const idx = customOcr.filter(e => e.id !== clean.id); idx.push(clean);
          await chrome.storage.local.set({ customOcr: idx });
          // rec-only импорт: заранее докачиваем встроенный детектор строк (~5 МБ),
          // чтобы первый же перевод кастомной моделью не упёрся в «не скачаны».
          // Ошибка не фатальна: repairMissingModels повторит попытку при переводе.
          if (!clean.hasDet) {
            const detUrl = findModel('ppocrv5-mobile')?.files.find(f => f.role === 'det')?.url;
            if (detUrl && !(await hasModel(detUrl))) {
              try {
                await Promise.race([downloadModelFile(detUrl), new Promise(r => setTimeout(r, 25000))]);
              } catch { /* повтор при переводе */ }
            }
          }
          sendResponse({ ok: true, entry: clean });
          break;
        }
        case MSG.OCR_DELETE_CUSTOM: {
          const id = customOcrId(msg.id) || msg.id;
          await deleteCustomOcrFiles(id);
          const { customOcr = [] } = await chrome.storage.local.get('customOcr');
          await chrome.storage.local.set({ customOcr: customOcr.filter(e => e.id !== id) });
          const settings = await getSettings();
          if (isCustomOcrId(settings.ocrModel) && customOcrId(settings.ocrModel) === id) {
            await setSettings({ ocrModel: 'ppocrv5-mobile' });
          }
          sendResponse({ ok: true });
          break;
        }
        case MSG.GET_STATE:
          sendResponse({ ok: true, state: await getState() });
          break;

        case MSG.DOWNLOAD_MODEL:
          // отвечаем мгновенно, скачивание идёт в фоне; ошибки и прогресс
          // приходят событиями MODEL_PROGRESS
          downloadModel(msg.id).catch(e =>
            broadcastProgress({ id: msg.id, status: 'error', error: String(e?.message || e) }));
          sendResponse({ ok: true, started: true });
          break;

        case MSG.DELETE_MODEL:
          await deleteModel(msg.id);
          sendResponse({ ok: true });
          break;

        case MSG.CLEAR_MODELS:
          await clearAllModels();
          await chrome.storage.local.set({ downloads: {} });
          sendResponse({ ok: true });
          break;

        case MSG.TRANSLATE_IMAGE:
          sendResponse(await handleTranslateImage(msg.image, !!msg.debug));
          break;

        case MSG.TRANSLATE_TEXTS: {
          const settings = await getSettings();
          const translations = await translateTexts(msg.texts, settings, {});
          sendResponse({ ok: true, translations });
          break;
        }

        case MSG.TEST_LLM: {
          const settings = await getSettings();
          // проверка соединения: 5 секунд на ответ списка моделей, иначе считаем сервер недоступным
          let models;
          try {
            models = await llmListModels(settings, AbortSignal.timeout(5000));
          } catch (e) {
            const reason = e?.name === 'TimeoutError' || e?.name === 'AbortError'
              ? 'сервер не ответил за 5 секунд'
              : String(e?.message || e);
            sendResponse({ ok: false, error: `Нет соединения (${reason}). Проверь: сервер запущен? Адрес и порт верные?` });
            break;
          }
          let sample = null, warn = null;
          try {
            const testText = 'Hello! How are you?';
            const target = settings.targetLang || 'ru';
            sample = await llmChat(settings, buildSingleMessage(testText, {
              targetLang: target, promptLang: settings.promptLang || 'ru',
            }), { maxTokens: 256 });
          } catch (e) {
            warn = `Соединение есть (${models.length} моделей), но пробный перевод не удался: ${String(e?.message || e)}`;
          }
          // Vision OCR включён — проверяем, что модель принимает изображения
          // (1×1 png, ответ в одно слово; 20 с — локальные серверы думают дольше текста)
          let visionOk = null;
          if (settings.llmVision) {
            try {
              await llmChat(settings, [{
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: VISION_PROBE_PNG } },
                  { type: 'text', text: 'Reply with the single word OK.' },
                ],
              }], { maxTokens: 16, timeout: 20000 });
              visionOk = true;
            } catch (e) {
              visionOk = false;
              warn = (warn ? `${warn} · ` : '') +
                'Vision: модель не приняла изображение — для Vision OCR нужна модель с поддержкой картинок (qwen2.5-vl, gemma-3, llava…).';
            }
          }
          sendResponse({ ok: true, models, sample, warn, base: normalizeBaseUrl(settings.llmBaseUrl), visionOk });
          break;
        }

        case MSG.TRANSLATE_PAGE:
          await startTranslatePage(!!msg.debug);
          sendResponse({ ok: true });
          break;

        case MSG.CLEAR_TRANSLATIONS:
          sendResponse(await clearTranslationsOnActiveTab());
          break;

        case 'PAGE_PROGRESS_REPORT': {
          // от content script: {done, total, finished, error, debug}
          pageJobLastBeat = Date.now();
          pageJob = {
            active: !msg.finished,
            done: msg.done || 0,
            total: msg.total || 0,
            error: msg.error || null,
            debug: !!msg.debug,
          };
          await broadcastPage();
          offscreenLastUsed = Date.now();
          sendResponse({ ok: true });
          break;
        }

        case 'FETCH_IMAGE': {
          // content script не может прочитать кросс-доменную картинку в canvas — качаем байты
          // здесь. Отдаём base64 + mime, определённый по байтам (заголовки CDN врут).
          let lastErr = 'неизвестная ошибка';
          let sent = false;
          for (const opt of [{ credentials: 'include' }, { credentials: 'omit' }]) {
            let res;
            try {
              res = await fetch(msg.url, opt);
            } catch (e) { lastErr = `сетевая ошибка: ${String(e?.message || e)}`; continue; }
            const buf = await res.arrayBuffer().catch(() => null);
            if (!buf || !buf.byteLength) {
              lastErr = res.ok ? 'сервер вернул пустой ответ' : `сервер ответил HTTP ${res.status}`;
              continue;
            }
            const sniff = sniffImage(new Uint8Array(buf, 0, Math.min(16, buf.byteLength)));
            if (sniff) {
              // байты изображения есть — отдаём даже при не-200 (так делают некоторые CDN)
              sendResponse({ ok: true, b64: bufToB64(buf), mime: sniff });
              sent = true;
              break;
            }
            const ct = res.headers.get('content-type') || 'неизвестный формат';
            const headText = new TextDecoder().decode(buf.slice(0, 600)).toLowerCase();
            if (headText.includes('<!doctype html') || headText.includes('<html') || headText.includes('<body')) {
              lastErr = `сайт вернул HTML-страницу (${ct}${res.status !== 200 ? `, HTTP ${res.status}` : ''}) вместо картинки — похоже на защиту от хотлинка или нужен вход на сайт`;
            } else {
              lastErr = `сервер вернул не изображение (${ct}, ${buf.byteLength} байт${res.status !== 200 ? `, HTTP ${res.status}` : ''})`;
            }
          }
          if (!sent) sendResponse({ ok: false, error: `Не удалось получить изображение: ${lastErr}` });
          break;
        }

        default:
          sendResponse({ ok: false, error: `unknown message: ${msg?.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // асинхронный ответ
});

// при старте SW: сбрасываем зависшие состояния.
// SW запускается заново только если предыдущий экземпляр умер — значит,
// «качающиеся» загрузки мертвы, а активный pageJob больше не существует.
{
  (async () => {
    try {
      const { downloads = {} } = await chrome.storage.local.get('downloads');
      let changed = false;
      for (const id of Object.keys(downloads)) {
        if (downloads[id]?.status === 'downloading') {
          downloads[id] = { status: 'error', error: 'Загрузка прервана (перезапуск расширения) — нажмите ⟳' };
          changed = true;
        }
      }
      if (changed) await chrome.storage.local.set({ downloads });
      const { pageJob: stored } = await chrome.storage.local.get('pageJob');
      if (stored?.active) {
        pageJob = { active: false, done: 0, total: 0, error: 'Задача была прервана — запустите перевод заново.' };
        await chrome.storage.local.set({ pageJob });
      }
    } catch (e) { /* хранилище недоступно — игнорируем */ }
  })();
}

chrome.runtime.onStartup?.addListener(async () => {
  pageJob = { active: false, done: 0, total: 0, error: null };
  await chrome.storage.local.set({ pageJob });
});
