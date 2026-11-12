// mangaocr.js — Manga-OCR (kha-white/manga-ocr-base, ONNX: mayocream/manga-ocr-onnx).
// ViT-энкодер (pixel_values [1,3,224,224] → last_hidden_state [1,197,768])
// + BERT-декодер (input_ids [1,t] + encoder_hidden_states → logits [1,t,vocab]).
// Автогрессивная генерация: старт [CLS]=2, стоп [SEP]=3. Специалист по вертикальному японскому.

import { resizeImage, toCHWNormalized } from './imagetools.js';

const IMG_SIZE = 224;
const NORM = [0.5, 0.5, 0.5];
const CLS_ID = 2;
const SEP_ID = 3;
const MAX_STEPS = 64;

/** Загрузка vocab.txt → массив токенов (индекс = id). */
export function loadVocab(vocabText) {
  const lines = vocabText.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Генерация текста для одного кропа (пузырь/регион целиком). */
export async function runMangaOcr(ort, { encSession, decSession, vocab }, crop) {
  const t0 = Date.now();
  const resized = resizeImage(crop, IMG_SIZE, IMG_SIZE);
  const pixels = toCHWNormalized(resized, NORM, NORM);
  const encOut = await encSession.run({
    pixel_values: new ort.Tensor('float32', pixels, [1, 3, IMG_SIZE, IMG_SIZE]),
  });
  const hidden = encOut[encSession.outputNames[0]]; // [1,197,768]

  // авто-генерация без KV-cache: на каждом шаге прогоняем декодер целиком
  const ids = [CLS_ID];
  const encStates = { encoder_hidden_states: hidden };
  let text = '';
  for (let step = 0; step < MAX_STEPS; step++) {
    const decOut = await decSession.run({
      ...encStates,
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    });
    const logits = decOut[decSession.outputNames[0]]; // [1, t, vocab]
    const dims = logits.dims;
    const T = dims[dims.length - 2], C = dims[dims.length - 1];
    const data = logits.data;
    // argmax последнего шага
    const off = (T - 1) * C;
    let best = 0, bestScore = -Infinity;
    for (let c = 0; c < C; c++) {
      const v = data[off + c];
      if (v > bestScore) { bestScore = v; best = c; }
    }
    if (best === SEP_ID) break;
    ids.push(best);
    const tok = vocab[best] ?? '';
    if (tok && !tok.startsWith('[') && !tok.startsWith('<')) text += tok.replace(/^##/, '');
  }
  return { text: text.trim(), timing: { mangaocr: Date.now() - t0 } };
}
