// hfimport.js — импорт PP-OCR моделей прямо с HuggingFace, чтобы пользователю
// не нужно было ничего скачивать и архивировать руками: вставил ссылку на
// репозиторий — расширение само нашло rec.onnx + dict.txt (det.onnx опционален),
// скачало с прогрессом и зарегистрировало модель.
// CORS у huggingface.co открыт (этим же пользуется transformers.js), работают
// только ПУБЛИЧНЫЕ репозитории. Также здесь сборка модели из локальных файлов
// без ZIP (buildOcrEntry) — общий хвост для всех способов импорта.
// Чистый модуль без DOM: покрыт юнит-тестами (fetch передаётся параметром).

import { isOnnx, sanitizeName, validateDictText, LIMITS, classifyOcrFiles, parseInferenceYml } from './customocr.js';

export const HF_ORIGIN = 'https://huggingface.co';

/**
 * Разобрать ссылку в «импорт модели»: репозиторий или прямой файл.
 * Понимает:
 *   https://huggingface.co/owner/repo
 *   https://huggingface.co/owner/repo/tree/main[/подпапка]
 *   https://huggingface.co/owner/repo/blob|resolve/main/файл.onnx
 *   https://hf.co/owner/repo, huggingface.co/owner/repo (без схемы)
 *   owner/repo (короткая форма)
 *   ?query и #fragment отбрасываются
 * Возвращает { kind:'repo', owner, repo } | { kind:'file', owner, repo, path } | null.
 */
export function parseHfTarget(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (/^(?:www\.)?(?:huggingface\.co|hf\.co)\//i.test(s)) s = `https://${s}`;
  let m = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (m) return { kind: 'repo', owner: m[1], repo: m[2] };
  m = s.match(/^https?:\/\/(?:www\.)?(?:huggingface\.co|hf\.co)\/([^/\s]+)\/([^/\s]+)(?:\/(.*))?$/i);
  if (!m) return null;
  const owner = m[1], repo = m[2];
  const seg = (m[3] || '').split('/').filter(Boolean);
  if (!seg.length) return { kind: 'repo', owner, repo };
  if (seg[0] === 'resolve' || seg[0] === 'blob') {
    const path = seg.slice(2).join('/');
    return path ? { kind: 'file', owner, repo, path } : { kind: 'repo', owner, repo };
  }
  // /tree/... — всегда весь репозиторий; голый путь к одному файлу — как файл
  if (seg[0] === 'tree') return { kind: 'repo', owner, repo };
  if (seg.length === 1 && /\.(onnx|txt|json)$/i.test(seg[0])) {
    return { kind: 'file', owner, repo, path: seg[0] };
  }
  return { kind: 'repo', owner, repo };
}

/** Последний сегмент пути файла. */
export function basename(path) {
  return String(path || '').replace(/\\/g, '/').split('/').pop();
}

/**
 * Список файлов публичного репозитория: GET /api/models/<owner>/<repo>/tree/main?recursive=true.
 * Возвращает [{ path, size }]. Ошибки: Error с code = HF_NOT_FOUND | HF_NET.
 */
export async function listHfRepoFiles(fetchImpl, owner, repo) {
  const url = `${HF_ORIGIN}/api/models/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tree/main?recursive=true`;
  let res;
  try {
    res = await fetchImpl(url);
  } catch (e) {
    const err = new Error(String(e?.message || e)); err.code = 'HF_NET'; throw err;
  }
  if (res.status === 404 || res.status === 401) {
    const err = new Error('not found'); err.code = 'HF_NOT_FOUND'; throw err;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`); err.code = 'HF_NET'; throw err;
  }
  const arr = await res.json().catch(() => null);
  if (!Array.isArray(arr)) { const err = new Error('bad API response'); err.code = 'HF_NET'; throw err; }
  return arr
    .filter(f => f && f.type === 'file' && typeof f.path === 'string')
    .map(f => ({ path: f.path, size: Number(f.size) || 0 }));
}

/**
 * Авто-выбор файлов под наш формат по именам (общий классификатор customocr):
 *   rec  — *.onnx с «rec» в имени; если таких нет — единственный «нейтральный»
 *          *.onnx (inference.onnx из официального экспорта PaddleOCR);
 *   det  — *.onnx с «det» в имени (опционален, ровно один);
 *   dict — *.txt со словом dict/keys/vocab/char; иначе единственный *.txt;
 *          иначе единственный *.yml/*.yaml (в inference.yml новых экспортов
 *          словарь PP-OCRv3+ встроен внутрь — buildOcrEntry его вытащит);
 *   meta — meta.json в КОРНЕ репозитория (в подпапках не ищем — чужие конфиги).
 * Возвращает { rec, det, dict, meta, recCandidates, dictCandidates, onnxAll, txtAll, ymlAll }.
 */
export function pickOcrFiles(files) {
  const orig = (path) => files.find(f => f.path === path) || null;
  const cls = classifyOcrFiles(files.map(f => ({ name: f.path })));
  const recish = cls.recish.map(f => f.name);
  const neutral = cls.neutralOnnx.map(f => f.name);
  const detP = cls.detish.map(f => f.name);
  const dictP = cls.dictTxt.map(f => f.name);
  const txtP = cls.txtAll.map(f => f.name);
  const ymlP = cls.yml.map(f => f.name);
  return {
    rec: recish.length === 1 ? orig(recish[0])
      : (recish.length === 0 && neutral.length === 1 ? orig(neutral[0]) : null),
    det: detP.length === 1 ? orig(detP[0]) : null,
    dict: dictP.length === 1 ? orig(dictP[0])
      : (dictP.length === 0 && txtP.length === 1 ? orig(txtP[0])
        : (dictP.length === 0 && txtP.length === 0 && ymlP.length === 1 ? orig(ymlP[0]) : null)),
    meta: files.find(f => f.path === 'meta.json') || null,
    recCandidates: [...recish, ...neutral],
    dictCandidates: dictP,
    // полные списки — для окна ручного выбора, когда кандидатов несколько
    onnxAll: cls.onnxAll.map(f => f.name),
    txtAll: txtP,
    ymlAll: ymlP,
  };
}

/**
 * Скачать один файл репозитория (resolve/main) с прогрессом.
 * onProgress(receivedBytes, totalBytes). Возвращает Uint8Array.
 * Ошибки: Error с code = HF_NET (сеть/HTTP) | HF_TOO_BIG.
 */
export async function downloadHfFile(fetchImpl, owner, repo, path, { onProgress, signal } = {}) {
  const segs = String(path || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const url = `${HF_ORIGIN}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/resolve/main/${segs}`;
  let res;
  try {
    res = await fetchImpl(url, { signal });
  } catch (e) {
    const err = new Error(String(e?.message || e)); err.code = 'HF_NET'; throw err;
  }
  if (!res.ok) { const err = new Error(`HTTP ${res.status}`); err.code = 'HF_NET'; throw err; }
  const total = Number(res.headers?.get?.('content-length')) || 0;
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.(buf.length, buf.length);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(received, total);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

const asU8 = (d) => (d instanceof Uint8Array ? d : new Uint8Array(d));

/**
 * Собрать и провалидировать запись кастомной OCR-модели из набора файлов
 * (локальные файлы без ZIP или файлы, скачанные с HuggingFace).
 * sources: [{ name, data: Uint8Array|ArrayBuffer }] — роли по имени (classifyOcrFiles):
 *   *.onnx с «rec» → rec (обязателен), с «det» → det (опционален), нейтральный
 *   inference.onnx → rec; *.txt → словарь (обязателен), иначе словарь из
 *   inference.yml (встроенный character_dict); meta.json / inference.yml → meta.
 * Возвращает { ok:true, entry, files } — entry для OCR_IMPORT_REGISTER, files
 * для putCustomOcrFiles ({ 'rec.onnx': ArrayBuffer, ... }) — или { ok:false, code, message? }.
 */
export function buildOcrEntry(sources, fallbackName = 'Custom OCR') {
  const cls = classifyOcrFiles(sources || []);
  const rec = cls.recish[0] || (cls.neutralOnnx.length === 1 ? cls.neutralOnnx[0] : null) || null;
  const det = cls.detish[0] || null;
  const metaSrc = cls.meta[0] || null;
  const ymlSrc = cls.yml[0] || null;
  // словарь: файл со словарным именем, иначе любой .txt, иначе — inference.yml
  // (в экспортах PaddleOCR PP-OCRv3+ словарь встроен в yaml как character_dict)
  let dictSrc = cls.dictTxt[0] || cls.otherTxt[0] || null;
  const ymlInfo = ymlSrc ? parseInferenceYml(new TextDecoder().decode(asU8(ymlSrc.data))) : null;
  if (!dictSrc && ymlInfo?.dictText) {
    dictSrc = { name: 'dict.txt', data: new TextEncoder().encode(ymlInfo.dictText) };
  } else if (!dictSrc && ymlInfo?.dictPath) {
    const want = String(ymlInfo.dictPath).replace(/\\/g, '/').split('/').pop().toLowerCase();
    dictSrc = [...cls.dictTxt, ...cls.otherTxt].find(s => String(s.name).toLowerCase().endsWith(want)) || null;
  }

  if (!rec) return { ok: false, code: 'NO_REC' };
  const recU8 = asU8(rec.data);
  if (recU8.length > LIMITS.maxOnnxBytes) return { ok: false, code: 'BAD_ONNX', message: `rec.onnx больше ${Math.round(LIMITS.maxOnnxBytes / 1048576)} MB` };
  if (!isOnnx(recU8)) return { ok: false, code: 'BAD_ONNX', message: 'rec.onnx — не похоже на ONNX-модель' };
  let detU8 = null;
  if (det) {
    detU8 = asU8(det.data);
    if (detU8.length > LIMITS.maxOnnxBytes) return { ok: false, code: 'BAD_ONNX', message: `det.onnx больше ${Math.round(LIMITS.maxOnnxBytes / 1048576)} MB` };
    if (!isOnnx(detU8)) return { ok: false, code: 'BAD_ONNX', message: 'det.onnx — не похоже на ONNX-модель' };
  }
  if (!dictSrc) return { ok: false, code: 'NO_DICT', message: 'нет ни словаря (*.txt), ни словаря внутри inference.yml' };
  const dictText = new TextDecoder().decode(asU8(dictSrc.data));
  const dictCode = validateDictText(dictText);
  if (dictCode) return { ok: false, code: dictCode, message: 'dict.txt пустой, слишком большой или подозрительный' };

  let meta = {};
  if (metaSrc) {
    try { meta = JSON.parse(new TextDecoder().decode(asU8(metaSrc.data))) || {}; } catch (e) { meta = {}; }
  }
  // высота входа из inference.yml (RecResizeImg.image_shape / rec_image_shape)
  if (meta.recHeight === undefined && ymlInfo?.recHeight) meta.recHeight = ymlInfo.recHeight;

  const sizeBytes = recU8.length + (detU8 ? detU8.length : 0) + dictText.length;
  const entry = {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name: sanitizeName(typeof meta.name === 'string' && meta.name.trim() ? meta.name : fallbackName, fallbackName),
    hasDet: !!detU8,
    hasRec: true,
    recHeight: [32, 48].includes(Number(meta.recHeight)) ? Number(meta.recHeight) : null,
    sizeMB: Math.round((sizeBytes / 1048576) * 10) / 10,
    createdAt: Date.now(),
    opts: {},
  };
  if (Number.isFinite(Number(meta.unclipRatio)) && Number(meta.unclipRatio) >= 1.6 && Number(meta.unclipRatio) <= 3.2) {
    entry.opts.unclipRatio = Number(meta.unclipRatio);
  }
  if (['cw', 'ccw', 'none'].includes(meta.verticalRotate)) entry.opts.verticalRotate = meta.verticalRotate;

  const files = {
    ...(detU8 ? { 'det.onnx': detU8.slice().buffer } : {}),
    'rec.onnx': recU8.slice().buffer,
    'dict.txt': new TextEncoder().encode(dictText).buffer,
    // meta.json как есть; если recHeight дал только inference.yml — синтезируем,
    // чтобы offscreen взял высоту без warmup-подбора
    ...(metaSrc
      ? { 'meta.json': asU8(metaSrc.data).slice().buffer }
      : (meta.recHeight !== undefined
        ? { 'meta.json': new TextEncoder().encode(JSON.stringify({ recHeight: Number(meta.recHeight) })).buffer }
        : {})),
  };
  return { ok: true, entry, files };
}
