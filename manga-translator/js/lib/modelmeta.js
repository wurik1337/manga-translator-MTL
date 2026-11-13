// modelmeta.js — каталог моделей расширения: реальные URL HuggingFace, размеры, роли файлов.
// Модели скачиваются в браузере по требованию (Cache API), словари зашиты в расширение.

const OGKALU = 'https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main';
const PPOCR = 'https://huggingface.co/bukuroo/PPOCRv5-ONNX/resolve/main';
const MANGAV6 = 'https://huggingface.co/Kellenok/PP-OCRv6_manga/resolve/main';
const MANGAOCR = 'https://huggingface.co/mayocream/manga-ocr-onnx/resolve/main';
import { isCustomOcrId, customOcrId, customOcrUrl } from './customocr.js';

export const MODEL_CATALOG = {
  detectors: [
    {
      id: 'rtdetr-s',
      kind: 'detector',
      label: 'RT-DETR Lite (S, int8)',
      description: 'Быстрый детектор пузырей — по умолчанию',
      sizeMB: 10.6,
      files: [{ role: 'detector', url: `${OGKALU}/detector-v4-s_int8.onnx` }],
    },
    {
      id: 'rtdetr-r50',
      kind: 'detector',
      label: 'RT-DETR-v2 (R50, int8)',
      description: 'Точнее на сложных панелях, тяжелее',
      sizeMB: 41.8,
      files: [{ role: 'detector', url: `${OGKALU}/detector_int8.onnx` }],
    },
    {
      id: 'rtdetr-r50-full',
      kind: 'detector',
      label: 'RT-DETR-v2 (R50, полная точность)',
      description: 'Максимальное качество детекции',
      sizeMB: 160.7,
      files: [{ role: 'detector', url: `${OGKALU}/detector.onnx` }],
    },
  ],
  ocr: [
    {
      id: 'ppocrv6-manga',
      kind: 'ocr',
      engine: 'ppocr',
      label: 'PP-OCRv6 Manga',
      description: 'Заточен под мангу (яп.), лёгкий — рекомендуется',
      sizeMB: 22.1,
      files: [
        { role: 'det', url: `${MANGAV6}/det/manga_det.onnx` },
        { role: 'rec', url: `${MANGAV6}/rec/manga_rec.onnx` },
        { role: 'cls', url: `${PPOCR}/ppocrv5-cls.onnx` },
      ],
      charset: 'data/ppocrv6_dict.txt',
      // эта модель ждёт вертикальный текст, повёрнутый ПО часовой стрелке
      opts: { verticalRotate: 'cw' },
    },
    {
      id: 'ppocrv5-mobile',
      kind: 'ocr',
      engine: 'ppocr',
      label: 'PP-OCRv5 Mobile',
      description: 'Англ./яп./кит. — быстрый',
      sizeMB: 20.9,
      files: [
        { role: 'det', url: `${PPOCR}/ppocrv5-mobile-det.onnx` },
        { role: 'rec', url: `${PPOCR}/ppocrv5-mobile-rec.onnx` },
        { role: 'cls', url: `${PPOCR}/ppocrv5-cls.onnx` },
      ],
      charset: 'data/ppocrv5_dict.txt',
    },
    {
      id: 'ppocrv5-server',
      kind: 'ocr',
      engine: 'ppocr',
      label: 'PP-OCRv5 Server',
      description: 'Англ./яп./кит. — максимальная точность',
      sizeMB: 164.4,
      files: [
        { role: 'det', url: `${PPOCR}/ppocrv5-server-det.onnx` },
        { role: 'rec', url: `${PPOCR}/ppocrv5-server-rec.onnx` },
        { role: 'cls', url: `${PPOCR}/ppocrv5-cls.onnx` },
      ],
      charset: 'data/ppocrv5_dict.txt',
      // server-рекомендация любит чуть более широкие боксы строк
      opts: { unclipRatio: 2.6 },
    },
    {
      id: 'manga-ocr',
      kind: 'ocr',
      engine: 'mangaocr',
      label: 'Manga-OCR',
      description: 'Вертикальный японский, самый точный (медленный, 440 МБ)',
      sizeMB: 439.6,
      files: [
        { role: 'enc', url: `${MANGAOCR}/encoder_model.onnx` },
        { role: 'dec', url: `${MANGAOCR}/decoder_model.onnx` },
      ],
      vocab: 'data/mangaocr_vocab.txt',
    },
  ],
};

/** Найти модель по id в каталоге. */
export function findModel(id) {
  return (
    MODEL_CATALOG.detectors.find(m => m.id === id) ||
    MODEL_CATALOG.ocr.find(m => m.id === id) ||
    null
  );
}

/** Список файлов всех моделей по id активных моделей.
 *  Кастомная OCR (custom:<id>) участвует своими синтетическими URL;
 *  если у неё нет своего det.onnx — используется встроенный детектор строк
 *  PP-OCRv5 Mobile (его файл добавляется отдельно).
 *  customIndex — список кастомных моделей из chrome.storage.local ('customOcr'). */
export function activeUrls(detectorId, ocrId, customIndex = []) {
  const det = findModel(detectorId);
  const ocr = findModel(ocrId);
  const urls = [...(det?.files || [])].map(f => f.url);
  if (ocr) {
    urls.push(...ocr.files.map(f => f.url));
  } else if (isCustomOcrId(ocrId)) {
    const id = customOcrId(ocrId);
    const entry = customIndex.find(e => e.id === id);
    if (entry?.hasDet) urls.push(customOcrUrl(id, 'det.onnx'));
    else urls.push(...(findModel('ppocrv5-mobile')?.files.filter(f => f.role === 'det') || []).map(f => f.url));
    urls.push(customOcrUrl(id, 'rec.onnx'), customOcrUrl(id, 'dict.txt'));
  }
  return urls;
}
