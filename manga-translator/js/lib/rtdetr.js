// rtdetr.js — детекция пузырей и текста (ogkalu/comic-text-and-bubble-detector,
// HF RTDetrV2ForObjectDetection, ONNX export).
// Входы:  images [1,3,640,640] float32, orig_target_sizes [1,2] int64 (h, w оригинала)
// Выходы: labels [1,300], boxes [1,300,4], scores [1,300]
// Классы: 0 = bubble (пузырь), 1 = text_bubble (текст в пузыре), 2 = text_free (свободный текст/SFX)

import { resizeImage, toCHWNormalized } from './imagetools.js';

export const DETECTOR_CLASSES = { 0: 'bubble', 1: 'text_bubble', 2: 'text_free' };
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

/**
 * Прогон детектора. Возвращает:
 * {
 *   bubbles: [{ box:[x0,y0,x1,y1], score }],        — пузыри
 *   textRegions: [{ box, score, cls }],              — регионы текста (text_bubble + text_free)
 * }
 * Координаты — в пикселях исходного изображения.
 */
export async function runDetector(ort, session, image, opts = {}) {
  const scoreThreshold = opts.scoreThreshold ?? 0.5;
  const inputSize = opts.inputSize ?? 640;

  const t0 = Date.now();
  const resized = resizeImage(image, inputSize, inputSize);
  const pixels = toCHWNormalized(resized, IMAGENET_MEAN, IMAGENET_STD);
  // ВАЖНО: этот ONNX-экспорт масштабирует x по первому элементу, y — по второму,
  // поэтому передаём [width, height] (проверено эмпирически на тестовой странице).
  const targetSizes = new ort.Tensor('int64', BigInt64Array.from([BigInt(image.width), BigInt(image.height)]), [1, 2]);
  const feeds = {
    images: new ort.Tensor('float32', pixels, [1, 3, inputSize, inputSize]),
    orig_target_sizes: targetSizes,
  };
  const out = await session.run(feeds);

  // выходы могут называться по-разному — берём по порядку с проверкой
  const labelsT = out.labels ?? out[session.outputNames.find(n => n.includes('label'))];
  const boxesT = out.boxes ?? out[session.outputNames.find(n => n.includes('boxe'))];
  const scoresT = out.scores ?? out[session.outputNames.find(n => n.includes('score'))];

  const labels = labelsT.data;
  const boxes = boxesT.data;
  const scores = scoresT.data;
  const num = scoresT.dims[1] ?? (labelsT.dims[1] || 300);
  const boxStride = 4;

  // Определяем формат координат: HF-экспорт отдаёт xyxy в масштабе orig_target_sizes.
  // Если все значения <= ~1.5 — считаем нормализованными cxcywh и конвертируем.
  let maxVal = 0;
  for (let i = 0; i < Math.min(boxes.length, 4000); i++) maxVal = Math.max(maxVal, Math.abs(boxes[i]));
  const normalized = maxVal <= 1.5;

  const bubbles = [];
  const textRegions = [];
  const W = image.width, H = image.height;

  for (let i = 0; i < num; i++) {
    const score = Number(scores[i]);
    if (score < scoreThreshold) continue;
    const cls = Number(labels[i]);
    let b = [
      Number(boxes[i * boxStride]),
      Number(boxes[i * boxStride + 1]),
      Number(boxes[i * boxStride + 2]),
      Number(boxes[i * boxStride + 3]),
    ];
    if (normalized) {
      // cxcywh (0..1) → xyxy в пикселях
      const [cx, cy, w, h] = b;
      b = [(cx - w / 2) * W, (cy - h / 2) * H, (cx + w / 2) * W, (cy + h / 2) * H];
    }
    // защита от перепутанного формата (x1 < x0)
    if (b[2] < b[0]) { const t = b[0]; b[0] = b[2]; b[2] = t; }
    if (b[3] < b[1]) { const t = b[1]; b[1] = b[3]; b[3] = t; }
    const entry = { box: b, score };
    if (cls === 0) bubbles.push(entry);
    else textRegions.push({ ...entry, cls: DETECTOR_CLASSES[cls] || `cls${cls}` });
  }

  // сортируем текстовые регионы: сверху вниз, слева направо
  textRegions.sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]));
  bubbles.sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]));

  // NMS: убираем дубликаты (перекрытие > 0.5), оставляем более уверенный бокс.
  // Для текстовых регионов — общий пул по классам (text_bubble/text_free дублируют друг друга).
  const nms = (entries, iouThresh = 0.5) => {
    const sorted = [...entries].sort((a, b) => b.score - a.score);
    const kept = [];
    for (const e of sorted) {
      if (!kept.some(k => iou(k.box, e.box) > iouThresh)) kept.push(e);
    }
    return kept;
  };
  const iou = (a, b) => {
    const ix0 = Math.max(a[0], b[0]), iy0 = Math.max(a[1], b[1]);
    const ix1 = Math.min(a[2], b[2]), iy1 = Math.min(a[3], b[3]);
    const inter = Math.max(0, ix1 - ix0) * Math.max(0, iy1 - iy0);
    const areaA = (a[2] - a[0]) * (a[3] - a[1]);
    const areaB = (b[2] - b[0]) * (b[3] - b[1]);
    return inter > 0 ? inter / (areaA + areaB - inter) : 0;
  };

  const nmsBubbles = nms(bubbles, 0.6);
  const nmsTextRegions = nms(textRegions, 0.45).sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]));

  return { bubbles: nmsBubbles, textRegions: nmsTextRegions, raw: { num, normalized }, timing: { detect: Date.now() - t0 } };
}
