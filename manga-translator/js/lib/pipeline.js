// pipeline.js — полный конвейер: изображение → детекция пузырей → OCR → структурированные тексты.
// Зависимости (ort, сессии) передаются снаружи, модуль работает и в браузере, и в Node.

import { cropImage, fitLongSide, boxIoU, clampBox } from './imagetools.js';
import { runDetector } from './rtdetr.js';
import { ocrRegion } from './ppocr.js';
import { runMangaOcr } from './mangaocr.js';
import { visionEraseBox, visionLineBoxes, visionBubbleLineBoxes } from './inpaint.js';

const MAX_IMAGE_SIDE = 2200;      // ограничение размера обрабатываемого изображения
const WEBTOON_ASPECT = 3.2;       // отношение сторон, при котором режем на окна
const WEBTOON_WINDOW = 1400;      // высота окна для вертикальных лент
const WEBTOON_OVERLAP = 160;      // перекрытие окон

/** Абсолютный бокс кропа с паддингом (в координатах полного изображения). */
function absCropBox(image, box, padAbs = 10, padRel = 0.12) {
  const w = box[2] - box[0], h = box[3] - box[1];
  const px = Math.max(padAbs, w * padRel);
  const py = Math.max(padAbs, h * padRel);
  return clampBox([box[0] - px, box[1] - py, box[2] + px, box[3] + py], image.width, image.height);
}

/** Кроп региона с паддингом (правильно: x0,y0,w,h). */
function regionCrop(image, box, padAbs = 10, padRel = 0.12) {
  const [x0, y0, x1, y1] = absCropBox(image, box, padAbs, padRel);
  return cropImage(image, x0, y0, x1 - x0, y1 - y0);
}

/**
 * Боксы строк OCR (относительные к кропу) → абсолютные «erase»-боксы.
 * Они используются для стирания текста (inpainting): тесная обрезка
 * по строкам не задевает рамку пузыря и фон.
 */
function absEraseBoxes(cropBox, lines) {
  const out = [];
  for (const l of lines) {
    const b = l.box;
    if (!Array.isArray(b) || b.length !== 4) continue;
    const box = [
      Math.max(0, Math.round(cropBox[0] + b[0])),
      Math.max(0, Math.round(cropBox[1] + b[1])),
      Math.round(cropBox[0] + b[2]),
      Math.round(cropBox[1] + b[3]),
    ];
    if (box[2] > box[0] && box[3] > box[1]) out.push(box);
  }
  return out;
}

/** Ужать бокс на долю inset с каждой стороны (для стирания без рамки пузыря). */
function insetBox(box, frac = 0.08) {
  const w = box[2] - box[0], h = box[3] - box[1];
  const dx = Math.round(w * frac), dy = Math.round(h * frac);
  return [box[0] + dx, box[1] + dy, box[2] - dx, box[3] - dy];
}

/** OCR одного региона выбранным движком. */
async function ocrTextRegion(ort, ocr, crop) {
  if (ocr.kind === 'mangaocr') {
    const { text } = await runMangaOcr(ort, ocr, crop);
    return text ? [{ box: [0, 0, crop.width, crop.height], text, vertical: true }] : [];
  }
  const lines = await ocrRegion(ort, ocr, crop, ocr.opts || {});
  return lines.filter(l => l.text && l.text.length > 0);
}

/** Пул с ограниченной конкурентностью: fn(item, idx) → результат по индексу. */
async function runPool(items, n, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Доля площади бокса box, находящейся внутри бокса outer. */
function containment(box, outer) {
  const ix0 = Math.max(box[0], outer[0]), iy0 = Math.max(box[1], outer[1]);
  const ix1 = Math.min(box[2], outer[2]), iy1 = Math.min(box[3], outer[3]);
  const inter = Math.max(0, ix1 - ix0) * Math.max(0, iy1 - iy0);
  const area = Math.max(1, (box[2] - box[0]) * (box[3] - box[1]));
  return inter / area;
}

/**
 * Vision-режим (opts.vision.read): OCR-модель не нужна. Пузыри находит
 * локальный детектор, затем каждый пузырь ОДНИМ кропом отправляется в
 * vision-LLM — она читает текст и переводит одним вызовом. Свободные
 * регионы вне пузырей обрабатываются отдельно (если разрешены).
 * read(crop) → Promise<{source, translation}|null>; erase — инсет кропа:
 * тесных боксов строк без OCR нет, стирание идёт по области региона.
 */
async function processWindowVision(ort, models, image, opts, onProgress) {
  const read = opts.vision.read;
  const concurrency = opts.vision.concurrency || 2;
  const det = await runDetector(ort, models.detector, image, {
    scoreThreshold: opts.minConfidence ?? 0.5,
  });
  const regions = opts.translateFreeText === false
    ? det.textRegions.filter(r => r.cls === 'text_bubble')
    : det.textRegions;

  let done = 0;
  const total = det.bubbles.length + regions.length;
  const report = () => { done++; if (onProgress) onProgress(Math.min(done, total), total); };
  const vision = { requested: 0, ok: 0 };

  const readCrop = async (cBox) => {
    const crop = cropImage(image, cBox[0], cBox[1], cBox[2] - cBox[0], cBox[3] - cBox[1]);
    let res = null;
    try {
      vision.requested++;
      res = await read(crop);
      if (res) vision.ok++;
    } catch (e) { /* один кроп не роняет конвейер */ }
    return res;
  };

  const items = [];

  // 1) пузыри: один вызов на пузырь — внутри может быть несколько реплик
  const bubbleBoxes = [];
  await runPool(det.bubbles, concurrency, async (b) => {
    const b0 = b.box;
    if ((b0[2] - b0[0]) < 24 || (b0[3] - b0[1]) < 24) { report(); return; }
    const cBox = absCropBox(image, b0, 6, 0.06);
    const res = await readCrop(cBox);
    report();
    if (res && (res.source || res.translation)) {
      bubbleBoxes.push(b0);
      // v1.7.5: стирание «под копирку» встроенного OCR — тесные боксы строк
      // (проекция по флуд-интерьеру); каждый бокс стирается тем же
      // механизмом, что у OCR (кольцо — белый интерьер: планар + Telea +
      // билатеральный + residual), а флуд-пресет становится добивающим
      // проходом лестницы — ровно как у OCR-айтемов. Пресет первичной маской
      // быть не должен: строка, слипшаяся антиалиасингом/JPEG с рамкой
      // пузыря, уходит в «небезопасные» компоненты дыр и оставляет серый
      // смаз (кейс «ANE-ZAKI»). Построчный путь деградирует на скринтоне
      // (одна полоса на весь интерьер) — там остаётся пресет (wholeErase).
      const eBox = visionEraseBox(image, b0);
      const lineBoxes = visionBubbleLineBoxes(image, eBox);
      items.push({
        box: b0,
        kind: 'bubble',
        wholeErase: !lineBoxes.length, // нет строк (скринтон/арт) — пресет-флуд
        floodFinish: !!lineBoxes.length, // добивающий проход — пресет и в rect
        text: (res.source || res.translation).trim(),
        translation: (res.translation || '').trim(),
        erase: lineBoxes.length ? lineBoxes : [eBox],
        score: b.score,
      });
    }
  });

  // 2) свободный текст / регионы вне уже обработанных пузырей
  await runPool(regions, concurrency, async (r) => {
    if (r.cls === 'text_bubble' && bubbleBoxes.some(bb => containment(r.box, bb) > 0.55)) {
      report(); return; // уже прочитан вызовом по пузырю
    }
    const cBox = absCropBox(image, r.box);
    const res = await readCrop(cBox);
    report();
    if (res && (res.source || res.translation)) {
      // v1.7.4: тесные боксы строк — как у встроенного OCR. Один большой
      // бокс блока на арте давал плоские прямоугольники (кольцо маски
      // промахивалось мимо текста) и пропуски строк (маска неоднозначна →
      // бокс пропущен, призраки). Проекция яркости режет блок на строки.
      const lineBoxes = visionLineBoxes(image, r.box);
      items.push({
        box: r.box,
        kind: 'free',
        text: (res.source || res.translation).trim(),
        translation: (res.translation || '').trim(),
        erase: lineBoxes.length ? lineBoxes : [visionEraseBox(image, r.box)],
        score: r.score,
      });
    }
  });

  items.sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]));
  return { items, detection: det, vision };
}

/** Обработка одного окна/страницы целиком. */
async function processWindow(ort, models, image, opts, onProgress) {
  if (opts.vision?.read) return processWindowVision(ort, models, image, opts, onProgress);
  const det = await runDetector(ort, models.detector, image, {
    scoreThreshold: opts.minConfidence ?? 0.5,
  });

  const regions = opts.translateFreeText === false
    ? det.textRegions.filter(r => r.cls === 'text_bubble')
    : det.textRegions;

  // сопоставление: текстовый регион → пузырь, в который он входит не менее чем на 55%
  const assignBubble = (box) => {
    let bestIdx = -1, bestC = 0;
    for (let i = 0; i < det.bubbles.length; i++) {
      const c = containment(box, det.bubbles[i].box);
      if (c > bestC) { bestC = c; bestIdx = i; }
    }
    return bestC > 0.55 ? bestIdx : -1;
  };

  // группировка регионов по пузырям
  const groups = new Map(); // bubbleIdx → [{region, text}]
  const ungrouped = [];
  const claimed = new Set();

  let done = 0;
  const total = regions.length + det.bubbles.length;
  const report = () => { done++; if (onProgress) onProgress(Math.min(done, total), total); };

  for (const r of regions) {
    const cBox = absCropBox(image, r.box);
    const crop = cropImage(image, cBox[0], cBox[1], cBox[2] - cBox[0], cBox[3] - cBox[1]);
    let text = '';
    let lines = [];
    try {
      lines = await ocrTextRegion(ort, models.ocr, crop);
      text = lines.map(l => l.text).join(' ').trim();
    } catch (e) { /* один регион не должен ронять конвейер */ }
    if (text) {
      // тесные боксы строк — для стирания текста без задевания рамки пузыря
      const erase = absEraseBoxes(cBox, lines);
      const bi = r.cls === 'text_bubble' ? assignBubble(r.box) : -1;
      if (bi >= 0) {
        claimed.add(bi);
        if (!groups.has(bi)) groups.set(bi, []);
        groups.get(bi).push({ text, erase });
      } else {
        ungrouped.push({ box: r.box, text, score: r.score, erase });
      }
    }
    report();
  }

  const items = [];

  // пузыри с текстом: один айтем на пузырь, дедуп одинаковых текстов
  for (const [bi, entries] of groups) {
    const uniq = [...new Map(entries.map(e => [e.text, e])).values()];
    items.push({
      box: det.bubbles[bi].box,
      kind: 'bubble',
      text: uniq.map(e => e.text).join(' '),
      erase: uniq.flatMap(e => e.erase),
      score: det.bubbles[bi].score,
    });
  }

  // свободный текст / текст вне пузырей
  for (const u of ungrouped) {
    // не дублируем текст, который уже вошёл в какой-то пузырь
    if (items.some(it => it.kind === 'bubble' && it.text.includes(u.text))) continue;
    items.push({ box: u.box, kind: 'free', text: u.text, erase: u.erase, score: u.score });
  }

  // пузыри без найденного текста — пробуем OCR напрямую по кропу пузыря
  for (let i = 0; i < det.bubbles.length; i++) {
    if (claimed.has(i)) { report(); continue; }
    const b = det.bubbles[i].box;
    if ((b[2] - b[0]) < 24 || (b[3] - b[1]) < 24) { report(); continue; }
    const cBox = absCropBox(image, b, 6, 0.06);
    const crop = cropImage(image, cBox[0], cBox[1], cBox[2] - cBox[0], cBox[3] - cBox[1]);
    let text = '';
    let lines = [];
    try {
      lines = await ocrTextRegion(ort, models.ocr, crop);
      text = lines.map(l => l.text).join(' ').trim();
    } catch (e) { /* skip */ }
    if (text) {
      // тесные боксы строк; если их нет (manga-OCR и Vision отдают текст по
      // всему кропу) — тесный интерьер пузыря или ужатый бокс: рамка цела
      const tightBoxes = absEraseBoxes(cBox, lines);
      const erase = tightBoxes.length ? tightBoxes : [visionEraseBox(image, b)];
      items.push({ box: b, kind: 'bubble', wholeErase: !tightBoxes.length, text, erase, score: det.bubbles[i].score });
    }
    report();
  }

  // сортировка по порядку чтения
  items.sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]));
  return { items, detection: det };
}

/**
 * Главная функция: изображение → { items: [{box, kind, text, score}], timing }.
 * Умеет резать высокие вертикальные ленты (webtoon) на окна и склеивать результат.
 */
export async function processImage(ort, models, image, opts = {}, onProgress = null) {
  const t0 = Date.now();
  image = fitLongSide(image, MAX_IMAGE_SIDE);
  const aspect = image.height / image.width;

  if (aspect <= WEBTOON_ASPECT) {
    const { items, detection, vision } = await processWindow(ort, models, image, opts, onProgress);
    return {
      items,
      width: image.width,
      height: image.height,
      ...(vision ? { vision } : {}),
      timing: { total: Date.now() - t0, ...(detection.timing || {}) },
    };
  }

  // webtoon: режем на перекрывающиеся окна
  const all = [];
  const visionAgg = { requested: 0, ok: 0 };
  let y = 0;
  while (y < image.height) {
    const h = Math.min(WEBTOON_WINDOW, image.height - y);
    const win = cropImage(image, 0, y, image.width, h);
    const { items, vision } = await processWindow(ort, models, win, opts, onProgress);
    if (vision) { visionAgg.requested += vision.requested; visionAgg.ok += vision.ok; }
    for (const it of items) {
      const box = [it.box[0], it.box[1] + y, it.box[2], it.box[3] + y];
      const dup = all.some(a => boxIoU(a.box, box) > 0.45 && a.text === it.text);
      if (!dup) all.push({ ...it, box });
    }
    if (y + h >= image.height) break;
    y += h - WEBTOON_OVERLAP;
  }
  all.sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]));
  return {
    items: all,
    width: image.width,
    height: image.height,
    ...(opts.vision?.read ? { vision: visionAgg } : {}),
    timing: { total: Date.now() - t0, webtoon: true },
  };
}
