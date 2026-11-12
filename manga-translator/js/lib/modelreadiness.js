// modelreadiness.js — проверка «все ли модели скачаны» перед переводом.
// Кастомные OCR (custom:<id>) хранятся в IndexedDB, а не в Cache API — их
// наличие гарантирует запись в индексе customOcr; кэш проверяем только для
// встроенных моделей и встроенного детектора строк PP-OCRv5.
// (Регрессия v1.6.0: handleTranslateImage проверял custom://-ключи через кэш
// и перевод с кастомной моделью всегда падал с NOT_DOWNLOADED.)

import { isCustomOcrId, customOcrId } from './customocr.js';
import { MODEL_CATALOG, findModel, activeUrls } from './modelmeta.js';

/**
 * Список отсутствующих файлов ([] = всё на месте).
 * @param settings {detectorModel, ocrModel}
 * @param customIndex записи chrome.storage.local('customOcr')
 * @param hasModel async (url) => boolean — реализация проверки кэша
 * @param opts skipOcr — Vision OCR: распознаёт LLM, OCR-модель не нужна
 */
export async function missingModelFiles(settings, customIndex = [], hasModel, { skipOcr = false } = {}) {
  if (skipOcr) {
    const det = findModel(settings.detectorModel) || MODEL_CATALOG.detectors[0];
    const missing = [];
    for (const f of det.files) if (!(await hasModel(f.url))) missing.push(f.url);
    return missing;
  }
  const missing = [];
  if (isCustomOcrId(settings.ocrModel)) {
    const entry = customIndex.find(e => e.id === customOcrId(settings.ocrModel));
    if (!entry?.hasRec) return [settings.ocrModel];
    // страница-детектор — обычная встроенная модель в кэше
    const pageDet = findModel(settings.detectorModel) || MODEL_CATALOG.detectors[0];
    for (const f of pageDet.files) if (!(await hasModel(f.url))) missing.push(f.url);
    // у rec нет своего det → нужен встроенный детектор строк
    if (!entry.hasDet) {
      const lineDet = findModel('ppocrv5-mobile')?.files.filter(f => f.role === 'det') || [];
      for (const f of lineDet) if (!(await hasModel(f.url))) missing.push(f.url);
    }
    return missing;
  }
  for (const url of activeUrls(settings.detectorModel, settings.ocrModel, customIndex)) {
    if (!(await hasModel(url))) missing.push(url);
  }
  return missing;
}

/** Человеческие имена отсутствующих файлов — для ошибки перевода.
 *  missingModelFiles возвращает URL (или 'custom:<id>'); тут превращаем их в
 *  названия моделей, чтобы вместо безымянного «Модели не скачаны» юзер видел,
 *  КОГО именно нужно скачать. */
export function describeMissing(missing, customIndex = []) {
  const all = [...MODEL_CATALOG.detectors, ...MODEL_CATALOG.ocr];
  const out = [];
  for (const u of missing) {
    if (u.startsWith('custom:')) {
      const e = customIndex.find(x => `custom:${x.id}` === u);
      out.push(e?.name ? `«${e.name}» (кастомная OCR)` : 'кастомная OCR');
      continue;
    }
    const m = all.find(mo => mo.files.some(f => f.url === u));
    out.push(m ? m.label : u);
  }
  return [...new Set(out)];
}
