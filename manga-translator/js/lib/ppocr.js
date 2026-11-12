// ppocr.js — PP-OCR (PaddleOCR → ONNX): детекция текстовых строк (DBNet),
// распознавание (CTC) и классификатор угла.
// Модели: bukuroo/PPOCRv5-ONNX (mobile/server), Kellenok/PP-OCRv6_manga.

import { cropImage, resizeImage, rotate180, rotate90ccw, rotate90cw, toCHWNormalized, clampBox } from './imagetools.js';

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];
const REC_MEAN = [0.5, 0.5, 0.5];
const REC_STD = [0.5, 0.5, 0.5];

/** Словарь PaddleOCR → массив символов. Индекс 0 = blank, последний = пробел. */
export function buildCharset(dictText) {
  const lines = dictText.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return ['\u0000', ...lines, ' '];
}

/** CTC greedy-декодирование вывода [1, T, C]. */
export function ctcDecode(probs, T, C, charset) {
  let prev = -1;
  let out = '';
  for (let t = 0; t < T; t++) {
    let best = 0, bestScore = -Infinity;
    const off = t * C;
    for (let c = 0; c < C; c++) {
      const v = probs[off + c];
      if (v > bestScore) { bestScore = v; best = c; }
    }
    if (best !== 0 && best !== prev && best < charset.length) out += charset[best];
    prev = best;
  }
  return out.trim();
}

/**
 * Детекция текстовых строк внутри кропа (DBNet).
 * Возвращает боксы строк [x0,y0,x1,y1] в координатах кропа, отсортированные по порядку чтения.
 */
export async function detectTextLines(ort, session, crop, opts = {}) {
  const maxSide = opts.maxSide ?? 960;
  const binThresh = opts.threshold ?? 0.3;
  const unclipRatio = opts.unclipRatio ?? 2.4;

  // ресайз кратно 32, длинная сторона <= maxSide
  let w = crop.width, h = crop.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  w = Math.max(32, Math.round(w * scale / 32) * 32);
  h = Math.max(32, Math.round(h * scale / 32) * 32);
  const resized = resizeImage(crop, w, h);
  const pixels = toCHWNormalized(resized, DET_MEAN, DET_STD);
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', pixels, [1, 3, h, w]) });
  const prob = out[session.outputNames[0]].data; // [1,1,h,w]

  // бинаризация + связные компоненты (4-связность)
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = prob[i] > binThresh ? 1 : 0;

  const comps = [];
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || visited[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, count = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w, py = (p - px) / w;
      count++;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
      // соседи
      if (px > 0) { const q = p - 1; if (mask[q] && !visited[q]) { visited[q] = 1; stack[sp++] = q; } }
      if (px < w - 1) { const q = p + 1; if (mask[q] && !visited[q]) { visited[q] = 1; stack[sp++] = q; } }
      if (py > 0) { const q = p - w; if (mask[q] && !visited[q]) { visited[q] = 1; stack[sp++] = q; } }
      if (py < h - 1) { const q = p + w; if (mask[q] && !visited[q]) { visited[q] = 1; stack[sp++] = q; } }
    }
    if (count >= 6) comps.push({ x0, y0, x1, y1, count });
  }

  // объединяем компоненты в строки: вертикальное перекрытие >= 45% и горизонтальный зазор небольшой
  comps.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];
  const used = new Array(comps.length).fill(false);
  for (let i = 0; i < comps.length; i++) {
    if (used[i]) continue;
    const group = [comps[i]];
    used[i] = true;
    let changed = true;
    while (changed) {
      changed = false;
      const g = group[group.length - 1];
      const gh = g.y1 - g.y0;
      for (let j = 0; j < comps.length; j++) {
        if (used[j]) continue;
        const c = comps[j];
        const ch = c.y1 - c.y0;
        const ov = Math.min(g.y1, c.y1) - Math.max(g.y0, c.y0);
        const gap = c.x0 - g.x1;
        const refH = Math.max(4, Math.min(gh, ch));
        if (ov > refH * 0.45 && gap > -refH && gap < refH * 1.6) {
          group.push(c);
          used[j] = true;
          g.x0 = Math.min(g.x0, c.x0); g.y0 = Math.min(g.y0, c.y0);
          g.x1 = Math.max(g.x1, c.x1); g.y1 = Math.max(g.y1, c.y1);
          changed = true;
        }
      }
    }
    const first = group[0];
    const bb = group.reduce((acc, c) => ({
      x0: Math.min(acc.x0, c.x0), y0: Math.min(acc.y0, c.y0),
      x1: Math.max(acc.x1, c.x1), y1: Math.max(acc.y1, c.y1),
    }), { x0: w, y0: h, x1: 0, y1: 0 });
    lines.push(bb);
    void first;
  }

  // масштабируем в координаты кропа + unclip по формуле PaddleOCR:
  // offset = area × (ratio − 1) / perimeter, расширение во все стороны
  const kx = crop.width / w, ky = crop.height / h;
  const boxes = lines.map(l => {
    const bw = (l.x1 - l.x0) * kx, bh = (l.y1 - l.y0) * ky;
    const area = bw * bh, perim = 2 * (bw + bh);
    const off = perim > 0 ? (area * (unclipRatio - 1)) / perim : 0;
    return clampBox([
      l.x0 * kx - off, l.y0 * ky - off, (l.x1 + 1) * kx + off, (l.y1 + 1) * ky + off,
    ], crop.width, crop.height);
  });

  // порядок чтения: сверху вниз; в одной полосе — слева направо
  boxes.sort((a, b) => {
    const ha = a[3] - a[1], hb = b[3] - b[1];
    const sameRow = Math.abs((a[1] + a[3]) / 2 - (b[1] + b[3]) / 2) < Math.max(ha, hb) * 0.6;
    return sameRow ? a[0] - b[0] : a[1] - b[1];
  });
  return boxes;
}

/** Классификатор угла: 0 = нормально, 1 = перевёрнуто на 180°. Высокий порог против ложных срабатываний. */
export async function classifyAngle(ort, session, lineCrop) {
  const h = 48, w = 192;
  const resized = resizeImage(lineCrop, w, h);
  const pixels = toCHWNormalized(resized, REC_MEAN, REC_STD);
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', pixels, [1, 3, h, w]) });
  const probs = out[session.outputNames[0]].data;
  return probs[1] > 0.98 ? 180 : 0;
}

/**
 * Распознавание одной текстовой строки.
 * opts.verticalRotate: 'ccw' (по умолчанию) | 'cw' | 'none' — как поворачивать вертикальный текст.
 * Возвращает { text, vertical }.
 */
export async function recognizeLine(ort, session, charset, lineCrop, opts = {}) {
  const recH = opts.recHeight ?? 48;
  const maxW = opts.recMaxWidth ?? 640;
  const minW = 16;
  const verticalRotate = opts.verticalRotate ?? 'ccw';

  const vertical = lineCrop.height > lineCrop.width * 1.5;
  let img = lineCrop;
  if (vertical && verticalRotate !== 'none') {
    if (verticalRotate === 'cw') img = rotate90cw(img);
    else img = rotate90ccw(img);
  }

  const aspect = img.width / img.height;
  let recW = Math.max(minW, Math.min(maxW, Math.round(recH * aspect)));
  const resized = resizeImage(img, recW, recH);
  const pixels = toCHWNormalized(resized, REC_MEAN, REC_STD);
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', pixels, [1, 3, recH, recW]) });
  const res = out[session.outputNames[0]];
  const [, T, C] = res.dims;
  const text = ctcDecode(res.data, T, C, charset);
  return { text, vertical };
}

/**
 * Полный OCR региона: детекция строк → угол → распознавание.
 * Возвращает [{ box:[x0,y0,x1,y1], text, vertical }] в координатах кропа.
 */
export async function ocrRegion(ort, { detSession, recSession, clsSession, charset }, crop, opts = {}) {
  const lineBoxes = await detectTextLines(ort, detSession, crop, opts);
  const results = [];
  for (const box of lineBoxes) {
    // небольшой внутренний отступ, чтобы не цеплять края
    const pad = Math.round(Math.min(3, (box[3] - box[1]) * 0.04));
    const lineCrop = cropImage(crop, box[0] + pad, box[1] + pad, (box[2] - box[0]) - pad * 2, (box[3] - box[1]) - pad * 2);
    let work = lineCrop;
    let angle = 0;
    if (clsSession && !opts.skipCls) {
      angle = await classifyAngle(ort, clsSession, lineCrop);
      if (angle === 180) work = rotate180(lineCrop);
    }
    const { text, vertical } = await recognizeLine(ort, recSession, charset, work, opts);
    if (text) results.push({ box, text, vertical, angle });
  }
  return results;
}
