// customocr.js — пользовательские OCR-модели семейства PP-OCR (PaddleOCR → ONNX).
// Импорт ZIP / папки / файлов / HuggingFace: rec*.onnx (или inference.onnx),
// словарь (*dict*.txt, inference_dict.txt или встроенный в inference.yml),
// det*.onnx (опционален — иначе встроенный детектор строк), meta.json / inference.yml.
// Валидация и сборка записи происходят на стороне popup, файлы кладутся
// в IndexedDB (modelstore.putCustomOcrFiles), индекс — в chrome.storage.local.

import { readZipEntries } from './zipread.js';

export const CUSTOM_OCR_PREFIX = 'custom:';
export const isCustomOcrId = (id) => typeof id === 'string' && id.startsWith(CUSTOM_OCR_PREFIX);
export const customOcrId = (id) => (isCustomOcrId(id) ? id.slice(CUSTOM_OCR_PREFIX.length) : null);

// синтетические «URL» записей Cache API для файлов кастомной модели
export const customOcrUrl = (id, name) => `custom://ocr/${id}/${name}`;

const MAX_DICT_BYTES = 1 * 1024 * 1024;   // словарь больше 1 МБ — точно не словарь
const MAX_ONNX_BYTES = 400 * 1024 * 1024; // разумный потолок на один ONNX
const MIN_ONNX_BYTES = 50 * 1024;         // настоящий ONNX OCR не бывает меньше ~50 КБ
const MAX_NAME_LEN = 40;

// публичные лимиты: их же использует импорт с HuggingFace и выбор локальных файлов
export const LIMITS = {
  maxDictBytes: MAX_DICT_BYTES,
  maxOnnxBytes: MAX_ONNX_BYTES,
  minOnnxBytes: MIN_ONNX_BYTES,
};

const decoder = new TextDecoder();

/** ONNX — protobuf: начинается с 0x08 (поле 1, varint: ir_version) + разумный размер. */
export function isOnnx(u8) {
  return u8.length >= MIN_ONNX_BYTES && u8.length <= MAX_ONNX_BYTES && u8[0] === 0x08;
}

/** Имя модели: безопасные символы, ≤ 40 знаков; пустое входное → fallback. */
export function sanitizeName(raw, fallback) {
  const base = String(raw || fallback || '')
    .replace(/\.zip$/i, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .trim();
  return base.slice(0, MAX_NAME_LEN).trim() || fallback;
}

/** Словарь символов: непустой, ≤1 МБ, 10…30000 непустых строк.
 *  Возвращает null (ок) или код ошибки NO_DICT. */
export function validateDictText(text) {
  if (!text || text.length === 0 || text.length > MAX_DICT_BYTES) return 'NO_DICT';
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 10 || lines.length > 30000) return 'NO_DICT';
  return null;
}

/**
 * Минимальный парсер inference.yml — конфига экспорта PaddleOCR.
 * Нужны только: словарь, встроенный в yaml списком (PostProcess.character_dict,
 * есть во всех экспортах PP-OCRv3+), ссылка на файл словаря (character_dict_path,
 * старые экспорты), use_space_char и высота входа rec
 * (PreProcess → RecResizeImg.image_shape: [3,48,320] или Global.rec_image_shape: '3, 48, 320').
 * Возвращает { recHeight, useSpaceChar, dictText, dictPath, modelType, altDicts }.
 * v1.6.4: якорь на списке («character_dict: &id001») больше не принимается за
 * сам словарь (раньше это давало словарь из одной строки «id001» и кашу в
 * переводе); захват списка привязан к отступу первой записи — вложенные
 * списки (keep_keys и т.п.) не примешиваются; повторные character_dict не
 * склеиваются — берётся самый длинный список, остальные в altDicts.
 */
export function parseInferenceYml(text) {
  const out = { recHeight: null, useSpaceChar: null, dictText: null, dictPath: null, modelType: null, altDicts: null };
  if (!text) return out;
  const lines = String(text).split(/\r?\n/);
  const unquote = (v) => {
    const s = String(v ?? '').trim();
    if (s.length >= 2 && ((s[0] === "'" && s.endsWith("'")) || (s[0] === '"' && s.endsWith('"')))) return s.slice(1, -1);
    return s;
  };
  const dictLists = [];
  let curDict = null;
  let dictIndent = -1; // отступ первой записи списка — только такие и захватываем
  // значения вида «&anchor value» (character_dict_path: &p ppocr_keys_v1.txt) —
  // якорь отбрасываем; алиасы «*anchor» не разворачиваем (не нужны)
  const scalar = (v) => unquote(String(v ?? '').replace(/^&\S+\s+/, ''));
  let inDict = false;  // идёт список PostProcess.character_dict (по «- символ» на строку)
  let shape = null;    // собираем image_shape: / - 3 / - 48 / - 320
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ');
    if (inDict) {
      // ровно один пробел-разделитель после «-», БЕЗ trim: элементом словаря
      // может быть полноценный пробел U+3000, который .trim() бы съел
      const m = line.match(/^(\s*)-(.*)$/);
      if (m) {
        const ind = m[1].length;
        if (dictIndent < 0) dictIndent = ind; // отступ первой записи задаёт уровень списка
        if (ind === dictIndent) {
          let v = m[2];
          if (v.startsWith(' ')) v = v.slice(1);
          if (v.endsWith('\r')) v = v.slice(0, -1);
          const ch = (v.length >= 2 && ((v[0] === "'" && v.endsWith("'")) || (v[0] === '"' && v.endsWith('"')))) ? v.slice(1, -1) : v;
          if (ch !== '' && curDict) curDict.push(ch);
          continue;
        }
      }
      inDict = false; // список кончился (ключ, другой отступ или конец)
    }
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = line.match(/^(\s*)([A-Za-z_][\w]*):\s*(.*)$/);
    if (!kv) continue;
    const indent = kv[1].length, key = kv[2], val = kv[3].trim();
    if (key === 'character_dict' && (val === '' || /^[*&]\S+$/.test(val))) {
      // пустой список или якорь на блоке («character_dict: &id001» + список ниже)
      inDict = true; dictIndent = -1; curDict = []; dictLists.push(curDict);
      continue;
    }
    if (key === 'character_dict' && val) { out.dictText = scalar(val); continue; }
    if (key === 'character_dict_path' && val) { out.dictPath = scalar(val); continue; }
    if (key === 'use_space_char') { out.useSpaceChar = val === 'true'; continue; }
    if (key === 'model_type' && val) { out.modelType = scalar(val); continue; }
    if (key === 'rec_image_shape' && val) {
      const nums = scalar(val).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
      if (nums.length === 3) out.recHeight = nums[1];
      continue;
    }
    if (key === 'image_shape' && val === '') { shape = []; continue; }
    if (shape && indent > 0) {
      const m = line.match(/^\s+-\s*(-?\d+)\s*$/);
      if (m) {
        shape.push(parseInt(m[1], 10));
        if (shape.length === 3) { out.recHeight = shape[1]; shape = null; }
        continue;
      }
      shape = null;
    }
  }
  if (dictLists.length) {
    // самый длинный НЕПУСТОЙ список — словарь PostProcess; остальные — в altDicts
    const longest = dictLists.reduce((a, b) => (b.length > a.length ? b : a));
    if (longest.length) {
      out.dictText = longest.join('\n');
      const rest = dictLists.filter(l => l !== longest && l.length);
      if (rest.length) out.altDicts = rest.map(l => l.join('\n'));
    }
  }
  return out;
}

/**
 * Классификация файлов PP-OCR по ролям (только имена, содержимое не читается):
 *   recish      — *.onnx с «rec» в имени,
 *   detish      — *.onnx с «det» (без «rec»),
 *   neutralOnnx — прочие *.onnx (inference.onnx, model.onnx),
 *   dictTxt     — *.txt со словарными именами (dict/keys/vocab/char),
 *   otherTxt    — прочие *.txt, yml — *.yml/*.yaml, meta — meta.json.
 * Пункты списка проходят насквозь ({ name, ...}) — работают и с путями, и с записями ZIP.
 */
export function classifyOcrFiles(list) {
  const out = { recish: [], detish: [], neutralOnnx: [], dictTxt: [], otherTxt: [], yml: [], meta: [], onnxAll: [], txtAll: [] };
  for (const f of list || []) {
    const b = String(f?.name || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
    if (!b || b.startsWith('.')) continue;
    if (/\.onnx$/.test(b)) {
      out.onnxAll.push(f);
      if (/rec/.test(b)) out.recish.push(f);
      else if (/det/.test(b)) out.detish.push(f);
      else out.neutralOnnx.push(f);
    } else if (/\.ya?ml$/.test(b)) {
      out.yml.push(f);
    } else if (/\.txt$/.test(b)) {
      out.txtAll.push(f);
      if (/(dict|keys|vocab|char)/.test(b)) out.dictTxt.push(f);
      else out.otherTxt.push(f);
    } else if (/^meta\.json$/.test(b)) {
      out.meta.push(f);
    }
  }
  return out;
}

/**
 * Распарсить и провалидировать ZIP с пользовательской PP-OCR моделью.
 * Возвращает { ok: true, entry } или { ok: false, code, message }.
 * entry: { id, name, hasDet, hasRec, recHeight, opts, sizeMB, files: {det?, rec?, dict, meta} }
 * files.dict — строка, остальные — ArrayBuffer.
 */
export async function parseCustomOcrZip(buf, fallbackName = 'Custom OCR') {
  let entries;
  try {
    entries = await readZipEntries(buf);
  } catch (e) {
    return { ok: false, code: 'NOT_ZIP', message: e.message };
  }

  // роли по имени файла (любая вложенность, регистр не важен), а не по точному
  // «rec.onnx»: HF-экспорты называются вроде en_PP-OCRv5_rec_infer.onnx /
  // en_dict.txt, официальный экспорт PaddleOCR — inference.onnx + inference.yml
  // (словарь и высота входа лежат внутри yml). __MACOSX/ и точечные — прочь.
  const base = (n) => String(n).replace(/\\/g, '/').split('/').pop();
  const usable = entries.filter(en => !en.name.includes('__MACOSX') && !base(en.name).startsWith('.'));
  const cls = classifyOcrFiles(usable.map(en => ({ name: base(en.name), data: en.data })));
  const onnxNames = cls.onnxAll.map(f => f.name).slice(0, 3).join(', ') || 'нет .onnx';

  const recE = cls.recish[0] || (cls.neutralOnnx.length === 1 ? cls.neutralOnnx[0] : null);
  const detE = cls.detish[0] || null;
  const metaE = cls.meta[0] || null;
  const ymlE = cls.yml[0] || null;

  if (!recE) return { ok: false, code: 'NO_REC', message: `не найден rec*.onnx или inference.onnx (в архиве: ${onnxNames})` };

  // inference.yml: встроенный словарь (character_dict), recHeight, ссылка на файл словаря
  const ymlInfo = ymlE ? parseInferenceYml(decoder.decode(ymlE.data)) : null;

  let dictE = cls.dictTxt[0] || cls.otherTxt[0] || null;
  if (!dictE && ymlInfo?.dictText) {
    dictE = { name: 'dict.txt', data: new TextEncoder().encode(ymlInfo.dictText) };
  } else if (!dictE && ymlInfo?.dictPath) {
    const want = String(ymlInfo.dictPath).replace(/\\/g, '/').split('/').pop().toLowerCase();
    dictE = usable.find(en => /\.txt$/i.test(base(en)) && base(en).toLowerCase() === want) || null;
  }
  if (!dictE) {
    return { ok: false, code: 'NO_DICT', message: `не найден словарь: *dict*.txt или словарь внутри inference.yml (в архиве: ${onnxNames})` };
  }

  if (!isOnnx(recE.data)) return { ok: false, code: 'BAD_ONNX', message: 'rec.onnx — не похоже на ONNX-модель' };
  if (detE && !isOnnx(detE.data)) return { ok: false, code: 'BAD_ONNX', message: 'det.onnx — не похоже на ONNX-модель' };
  if (dictE.data.length === 0 || dictE.data.length > MAX_DICT_BYTES) {
    return { ok: false, code: 'NO_DICT', message: 'словарь пустой или слишком большой' };
  }

  // meta.json: { name?, recHeight? (32|48), unclipRatio? (1.6..3.2), verticalRotate? ('cw'|'ccw') }
  let meta = {};
  if (metaE) {
    try {
      meta = JSON.parse(decoder.decode(metaE.data)) || {};
    } catch (e) {
      return { ok: false, code: 'BAD_META', message: 'meta.json не парсится как JSON' };
    }
    if (meta.recHeight !== undefined && ![32, 48].includes(Number(meta.recHeight))) {
      return { ok: false, code: 'BAD_META', message: 'meta.json: recHeight должен быть 32 или 48' };
    }
    if (meta.unclipRatio !== undefined && !(Number(meta.unclipRatio) >= 1.6 && Number(meta.unclipRatio) <= 3.2)) {
      return { ok: false, code: 'BAD_META', message: 'meta.json: unclipRatio в диапазоне 1.6–3.2' };
    }
    if (meta.verticalRotate !== undefined && !['cw', 'ccw', 'none'].includes(meta.verticalRotate)) {
      return { ok: false, code: 'BAD_META', message: 'meta.json: verticalRotate — cw | ccw | none' };
    }
  }
  // высота входа из inference.yml, если meta.json её не задаёт
  if (meta.recHeight === undefined && ymlInfo?.recHeight) meta.recHeight = ymlInfo.recHeight;

  const dictText = decoder.decode(dictE.data);
  const dictCode = validateDictText(dictText);
  if (dictCode) return { ok: false, code: dictCode, message: `словарь подозрительный: ${dictText.split(/\r?\n/).filter(l => l.trim() !== '').length} строк` };

  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const sizeBytes = (detE?.data.length || 0) + recE.data.length + dictE.data.length;
  const opts = {};
  if (meta.recHeight !== undefined) opts.recHeight = Number(meta.recHeight);
  if (meta.unclipRatio !== undefined) opts.unclipRatio = Number(meta.unclipRatio);
  if (meta.verticalRotate !== undefined) opts.verticalRotate = meta.verticalRotate;

  const entry = {
    id,
    name: sanitizeName(meta.name, fallbackName),
    hasDet: !!detE,
    hasRec: true,
    recHeight: opts.recHeight || null,     // null → определится warmup-ом на первом запуске
    sizeMB: Math.round((sizeBytes / 1048576) * 10) / 10,
    createdAt: Date.now(),
    opts,
    files: {
      det: detE ? detE.data.slice().buffer : null,
      rec: recE.data.slice().buffer,
      dict: dictText,
      // meta.json как есть; если высоту дала только inference.yml — синтезируем
      meta: metaE
        ? metaE.data.slice().buffer
        : (meta.recHeight !== undefined
          ? new TextEncoder().encode(JSON.stringify({ recHeight: Number(meta.recHeight) })).buffer
          : null),
    },
  };
  return { ok: true, entry };
}

/**
 * Определить высоту входа rec-модели (PP-OCRv3+ = 48, старые = 32):
 * прогоняем пустой тензор [1,3,H,64] — неправильная высота даст ошибку формы.
 * first — подсказка из meta.json (проверяется первой).
 */
export async function pickRecHeight(ort, session, first = null) {
  // v1.6.3: у статических экспортов высота видна прямо в метаданных входа —
  // это точнее warmup-а, который не отличает «принимает 48» от «обучена на 48»
  if (!first) {
    try {
      const m = session.inputMetadata?.[0];
      const dims = m?.shape || m?.dims;
      if (Array.isArray(dims) && Number.isInteger(dims[2]) && dims[2] >= 16 && dims[2] <= 128) return dims[2];
    } catch (e) { /* метаданных нет — обычный warmup */ }
  }
  const candidates = first ? [first, 48, 32] : [48, 32];
  for (const h of [...new Set(candidates)]) {
    try {
      const t = new ort.Tensor('float32', new Float32Array(3 * h * 64), [1, 3, h, 64]);
      await session.run({ [session.inputNames[0]]: t });
      return h;
    } catch (e) { /* пробуем следующую высоту */ }
  }
  return 48; // не смогли определить — стандарт PP-OCRv4/v5
}

/** Декод dict.txt: UTF-8; при BOM или UTF-16 — соответствующий декодер.
 *  Часть экспортов (Windows-инструменты) сохраняет словарь в UTF-16 —
 *  декод «в лоб» UTF-8 даёт mojibake и кашу вместо текста. UTF-16 опознаём
 *  по нулевым байтам: в валидном UTF-8-словаре их не бывает вовсе. */
export function decodeDict(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8).replace(/^\ufeff/, '');
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8).replace(/^\ufeff/, '');
  let zeros = 0;
  for (let i = 0; i < u8.length; i++) if (u8[i] === 0) zeros++;
  const text = zeros > u8.length / 8
    ? new TextDecoder('utf-16le').decode(u8)
    : new TextDecoder('utf-8').decode(u8);
  return text.replace(/^\ufeff/, '');
}

/**
 * Компоновка словаря под ФАКТИЧЕСКОЕ число выходных классов rec-модели (C).
 * Стандарт PaddleOCR: класс 0 = blank, затем строки dict по порядку, последним
 * — пробельный класс (use_space_char=true → C = L+2). Часть экспортов идёт без
 * пробельного класса (C = L+1), у части blank/пробел уже лежат строками внутри
 * самого словаря (C = L). Рассинхрон словаря и модели давал «кашу набора
 * символов» вместо текста: индексы классов указывали не на те символы.
 * Возвращает { charset, mode } подобранного варианта или null, если словарь
 * по размеру не соответствует модели (обычно — dict.txt от другой модели).
 */
export function fitCharsetToClasses(dictText, C) {
  if (!Number.isInteger(C) || C <= 1) return null;
  const lines = dictText.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const L = lines.length;
  const unBlank = (arr) => arr.map((s, i) => (i === 0 ? '\u0000' : s));
  if (C === L + 2) return { charset: ['\u0000', ...lines, ' '], mode: 'blank+space' };
  if (C === L + 1) {
    if (lines[0] === 'blank') return { charset: unBlank([...lines, ' ']), mode: 'blank-in-dict' };
    return { charset: ['\u0000', ...lines], mode: 'no-space' };
  }
  if (C === L && lines[0] === 'blank') return { charset: unBlank(lines), mode: 'self-contained' };
  return null;
}

/** Число выходных классов rec-модели: пробный прогон нулями [1,3,H,320],
 *  читаем последний dim выхода [1,T,C]. Ошибка → null (проверка пропускается). */
export async function probeRecClasses(ort, session, height) {
  try {
    const t = new ort.Tensor('float32', new Float32Array(3 * height * 320), [1, 3, height, 320]);
    const out = await session.run({ [session.inputNames[0]]: t });
    const first = out[session.outputNames[0]];
    const dims = first?.dims;
    return Array.isArray(dims) ? dims[dims.length - 1] : null;
  } catch (e) {
    return null;
  }
}

/**
 * Варианты текста словаря для подбора к модели. Если есть дубликаты записей
 * (бывают в кривых экспортах), сначала пробуем вариант без них: дубликат
 * смещает все классы после себя и не давал совпасть ни одной компоновке.
 * Порядок строк всегда сохраняется.
 */
export function dictCandidates(dictText) {
  const lines = dictText.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const seen = new Set();
  const uniq = [];
  for (const l of lines) {
    if (!seen.has(l)) { seen.add(l); uniq.push(l); }
  }
  if (uniq.length !== lines.length) return [uniq.join('\n'), lines.join('\n')];
  return [lines.join('\n')];
}
