// ⚠️ СГЕНЕРИРОВАННЫЙ ФАЙЛ — не редактировать вручную!
// Собирается скриптом scripts/build_sw_bundle.mjs из модулей js/lib/*.js и js/background/sw_main.js.
// Это ОДИН классический скрипт без ES-модулей, чтобы регистрация service worker
// не могла сломаться из-за загрузки модулей.
// Сгенерирован: 2026-11-14T03:12:13.031Z
'use strict';

// ================= js/lib/protocol.js =================
// protocol.js — типы сообщений и настройки по умолчанию (общие для popup, background, offscreen).

const MSG = {
  PING: 'PING',
  GET_SETTINGS: 'GET_SETTINGS',
  SET_SETTINGS: 'SET_SETTINGS',
  GET_STATE: 'GET_STATE',               // каталог + что скачано + прогресс
  DOWNLOAD_MODEL: 'DOWNLOAD_MODEL',
  DELETE_MODEL: 'DELETE_MODEL',
  CLEAR_MODELS: 'CLEAR_MODELS',
  TRANSLATE_IMAGE: 'TRANSLATE_IMAGE',   // content → background: { imageData, src }
  TRANSLATE_TEXTS: 'TRANSLATE_TEXTS',   // popup → background (тест): { texts }
  TEST_LLM: 'TEST_LLM',                 // popup → background: проверить соединение
  TRANSLATE_PAGE: 'TRANSLATE_PAGE',     // popup → background → content: перевести всё
  PAGE_JOB_STOP: 'PAGE_JOB_STOP',       // popup → background → content: остановить перевод/сбор (v1.10.0)
  CLEAR_TRANSLATIONS: 'CLEAR_TRANSLATIONS', // popup → background → content: убрать все переводы
  PAGE_PROGRESS: 'PAGE_PROGRESS',       // background → popup: прогресс страницы
  MODEL_PROGRESS: 'MODEL_PROGRESS',     // background → popup: прогресс загрузки моделей
  OFFSCREEN_RUN: 'OFFSCREEN_RUN',       // background → offscreen
  OCR_IMPORT_REGISTER: 'OCR_IMPORT_REGISTER', // popup → background: файлы кастомной OCR уже в кэше, записать в индекс
  OCR_DELETE_CUSTOM: 'OCR_DELETE_CUSTOM',     // popup → background: удалить кастомную OCR-модель
};

const DEFAULT_SETTINGS = {
  enabled: false,
  engine: 'google',            // 'google' | 'llm'
  llmBaseUrl: 'http://127.0.0.1:8080/v1',
  llmModel: '',
  llmApiKey: '',
  llmUseKey: false,
  llmTemperature: 0.3,
  llmCustomPrompt: '',         // свой системный промт LLM; пусто — стандартный
  llmVision: false,            // Vision OCR: LLM с картинками сама читает и переводит (OCR-модель не нужна)
  uiLang: 'browser',           // язык интерфейса popup: 'browser' | 'ru' | 'en' | …
  promptLang: 'ru',            // 'ru' | 'en' — язык промпта для LLM
  sourceLang: 'auto',          // 'auto' | 'en' | 'ja' | 'zh' | 'ko'
  targetLang: 'ru',
  autoTranslate: false,        // v1.8.1: по умолчанию ВЫКЛЮЧЕН — включается тумблером на Home
  pageStitch: true,            // v1.10.1: включена с самой установки — реплики, разрезанные краем страницы, докрашиваются по «шву» (v1.9.0)
  translateFreeText: true,     // текст вне пузырей (SFX, подписи); с v1.8.1 всегда включён, тумблер удалён
  detectorModel: 'rtdetr-s',
  ocrModel: 'ppocrv6-manga',
  minConfidence: 0.5,
  renderMode: 'inpaint',      // 'inpaint' — стереть текст, вписать перевод | 'badge' — компактная рамка
  fontFit: 'auto',            // 'auto' — кегль подбирается под пузырь | 'fixed' — фиксированный
  fontSizeFixed: 18,          // кегль при fontFit='fixed' (px изображения)
  overlayStyle: 'light',      // 'light' | 'dark'
  autoTextColor: true,        // автоцвет: тёмный/светлый текст по фону пузыря (только 'inpaint')
  showOriginalOnHover: true,
  // горячие клавиши контент-скрипта (v1.8.0): строка 'Ctrl+Alt+T' или '' — не назначено
  hotkeys: {
    translatePage: '',
    loadAll: '',
    debugPage: '',
    clearPage: '',
  },
};

const LANGUAGES = {
  auto: 'Автоопределение',
  en: 'English',
  ja: '日本語',
  zh: '中文',
  ko: '한국어',
  ru: 'Русский',
  uk: 'Українська',
  es: 'Español',
  de: 'Deutsch',
  fr: 'Français',
  pt: 'Português',
  it: 'Italiano',
  pl: 'Polski',
  tr: 'Türkçe',
  kk: 'Қазақша',
};

/** Глубокое слияние настроек с дефолтами (устойчивость к старым версиям). */
function mergeSettings(saved) {
  const out = { ...DEFAULT_SETTINGS };
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (saved[k] !== undefined && saved[k] !== null) out[k] = saved[k];
    }
  }
  if (out.renderMode === 'replace') out.renderMode = 'inpaint'; // миграция < 1.2.0
  // белый список режимов вывода (v1.3.0: + 'inpaint_rect' — «прямоугольно»)
  if (!['inpaint', 'inpaint_rect', 'badge'].includes(out.renderMode)) out.renderMode = 'inpaint';
  if (out.fontFit !== 'fixed') out.fontFit = 'auto'; // устойчивость к мусору в storage
  out.translateFreeText = true; // v1.8.1: тумблер «Вне пузырей» удалён — функция всегда включена
  return out;
}

/** Нормализовать нажатие клавиши в строку 'Ctrl+Alt+T' или одиночную 'R'.
 *  Нужна popup (запись бинда) и content (срабатывание); в content script
 *  продублирована локально — ES-импорт туда не доезжает. С v1.8.1 одиночные
 *  клавиши тоже назначаются (R, F3, Space…) — content script сам пропускает
 *  нажатия, пока пользователь печатает в поле на странице. */
function formatCombo(e) {
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean);
  let key = '';
  const c = String(e.code || '');
  if (c.startsWith('Key')) key = c.slice(3);            // KeyX → X (физическая клавиша, независима от раскладки)
  else if (c.startsWith('Digit')) key = c.slice(5);      // Digit5 → 5
  else if (c === 'Space') key = 'Space';
  else if (/^Arrow|^Numpad\d|^F\d{1,2}$/.test(c)) key = c.replace('Arrow', ''); // ArrowUp → Up
  else if (PUNCT[c]) key = PUNCT[c];                     // знаки: Comma → ',' и т.п.
  else if (e.key && e.key.length === 1) key = e.key.toUpperCase();
  if (!key) return '';
  return [...mods, key].join('+');
}

// e.code → читаемый знак (именованные клавиши пунктуации)
const PUNCT = {
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'",
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backquote: '`',
};

// ================= js/lib/zipread.js =================
// zipread.js — чтение ZIP-архивов без внешних зависимостей.
// Распаковка: метод 0 (STORE) и метод 8 (DEFLATE) через нативный
// DecompressionStream('deflate-raw') (Chrome 103+, Node 18+).
// Используется для импорта пользовательских PP-OCR моделей (customocr.js).

/** CRC-32 (IEEE 802.3), little-endian полином 0xEDB88320. */
function crc32(u8) {
  let table = crc32._table;
  if (!table) {
    table = crc32._table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = table[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const U16 = (dv, off) => dv.getUint16(off, true);
const U32 = (dv, off) => dv.getUint32(off, true);

async function inflateRaw(u8) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Прочитать ZIP. Возвращает [{ name, data: Uint8Array, size, crc }] только
 * с файлами (каталоги пропускаются). Бросает Error с code:
 * NOT_ZIP | TRUNCATED | UNSUPPORTED | ENCRYPTED | CRC_MISMATCH.
 */
async function readZipEntries(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  // End of Central Directory: сигнатура 0x06054b50, ищем с конца (комментарий до 64 КБ)
  let eocd = -1;
  const minEocd = Math.max(0, u8.length - 22 - 65535);
  for (let i = u8.length - 22; i >= minEocd; i--) {
    if (U32(dv, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) { const e = new Error('не ZIP-архив'); e.code = 'NOT_ZIP'; throw e; }

  const count = U16(dv, eocd + 10);
  let cdOff = U32(dv, eocd + 16);
  const entries = [];

  for (let n = 0; n < count; n++) {
    if (cdOff + 46 > u8.length || U32(dv, cdOff) !== 0x02014b50) {
      const e = new Error('повреждённый центральный каталог'); e.code = 'TRUNCATED'; throw e;
    }
    const flags = U16(dv, cdOff + 8);
    const method = U16(dv, cdOff + 10);
    const crc = U32(dv, cdOff + 16);
    const compSize = U32(dv, cdOff + 20);
    const nameLen = U16(dv, cdOff + 28);
    const extraLen = U16(dv, cdOff + 30);
    const commentLen = U16(dv, cdOff + 32);
    const lhoOff = U32(dv, cdOff + 42);
    const name = new TextDecoder().decode(u8.subarray(cdOff + 46, cdOff + 46 + nameLen));
    cdOff += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;             // каталог
    if (flags & 0x1) { const e = new Error(`зашифрован: ${name}`); e.code = 'ENCRYPTED'; throw e; }
    if (method !== 0 && method !== 8) {
      const e = new Error(`метод сжатия ${method} не поддерживается: ${name}`); e.code = 'UNSUPPORTED'; throw e;
    }

    // локальный заголовок: имя/extra могут отличаться по длине — берём данные после них
    if (lhoOff + 30 > u8.length || U32(dv, lhoOff) !== 0x04034b50) {
      const e = new Error(`повреждён локальный заголовок: ${name}`); e.code = 'TRUNCATED'; throw e;
    }
    const lhNameLen = U16(dv, lhoOff + 26);
    const lhExtraLen = U16(dv, lhoOff + 28);
    const dataOff = lhoOff + 30 + lhNameLen + lhExtraLen;
    if (dataOff + compSize > u8.length) {
      const e = new Error(`обрезанные данные: ${name}`); e.code = 'TRUNCATED'; throw e;
    }
    const raw = u8.subarray(dataOff, dataOff + compSize);
    const data = method === 8 ? await inflateRaw(raw) : raw;
    if (data.length !== U32(dv, lhoOff + 22)) {
      const e = new Error(`несовпадение размера: ${name}`); e.code = 'TRUNCATED'; throw e;
    }
    if (crc && crc32(data) !== crc) {
      const e = new Error(`CRC не совпал: ${name}`); e.code = 'CRC_MISMATCH'; throw e;
    }
    entries.push({ name, data, size: data.length, crc });
  }
  return entries;
}

// ================= js/lib/customocr.js =================
// customocr.js — пользовательские OCR-модели семейства PP-OCR (PaddleOCR → ONNX).
// Импорт ZIP / папки / файлов / HuggingFace: rec*.onnx (или inference.onnx),
// словарь (*dict*.txt, inference_dict.txt или встроенный в inference.yml),
// det*.onnx (опционален — иначе встроенный детектор строк), meta.json / inference.yml.
// Валидация и сборка записи происходят на стороне popup, файлы кладутся
// в IndexedDB (modelstore.putCustomOcrFiles), индекс — в chrome.storage.local.


const CUSTOM_OCR_PREFIX = 'custom:';
const isCustomOcrId = (id) => typeof id === 'string' && id.startsWith(CUSTOM_OCR_PREFIX);
const customOcrId = (id) => (isCustomOcrId(id) ? id.slice(CUSTOM_OCR_PREFIX.length) : null);

// синтетические «URL» записей Cache API для файлов кастомной модели
const customOcrUrl = (id, name) => `custom://ocr/${id}/${name}`;

const MAX_DICT_BYTES = 1 * 1024 * 1024;   // словарь больше 1 МБ — точно не словарь
const MAX_ONNX_BYTES = 400 * 1024 * 1024; // разумный потолок на один ONNX
const MIN_ONNX_BYTES = 50 * 1024;         // настоящий ONNX OCR не бывает меньше ~50 КБ
const MAX_NAME_LEN = 40;

// публичные лимиты: их же использует импорт с HuggingFace и выбор локальных файлов
const LIMITS = {
  maxDictBytes: MAX_DICT_BYTES,
  maxOnnxBytes: MAX_ONNX_BYTES,
  minOnnxBytes: MIN_ONNX_BYTES,
};

const decoder = new TextDecoder();

/** ONNX — protobuf: начинается с 0x08 (поле 1, varint: ir_version) + разумный размер. */
function isOnnx(u8) {
  return u8.length >= MIN_ONNX_BYTES && u8.length <= MAX_ONNX_BYTES && u8[0] === 0x08;
}

/** Имя модели: безопасные символы, ≤ 40 знаков; пустое входное → fallback. */
function sanitizeName(raw, fallback) {
  const base = String(raw || fallback || '')
    .replace(/\.zip$/i, '')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .trim();
  return base.slice(0, MAX_NAME_LEN).trim() || fallback;
}

/** Словарь символов: непустой, ≤1 МБ, 10…30000 непустых строк.
 *  Возвращает null (ок) или код ошибки NO_DICT. */
function validateDictText(text) {
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
function parseInferenceYml(text) {
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
function classifyOcrFiles(list) {
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
async function parseCustomOcrZip(buf, fallbackName = 'Custom OCR') {
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
async function pickRecHeight(ort, session, first = null) {
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
function decodeDict(bytes) {
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
function fitCharsetToClasses(dictText, C) {
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
async function probeRecClasses(ort, session, height) {
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
function dictCandidates(dictText) {
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

// ================= js/lib/modelmeta.js =================
// modelmeta.js — каталог моделей расширения: реальные URL HuggingFace, размеры, роли файлов.
// Модели скачиваются в браузере по требованию (Cache API), словари зашиты в расширение.

const OGKALU = 'https://huggingface.co/ogkalu/comic-text-and-bubble-detector/resolve/main';
const PPOCR = 'https://huggingface.co/bukuroo/PPOCRv5-ONNX/resolve/main';
const MANGAV6 = 'https://huggingface.co/Kellenok/PP-OCRv6_manga/resolve/main';
const MANGAOCR = 'https://huggingface.co/mayocream/manga-ocr-onnx/resolve/main';

const MODEL_CATALOG = {
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
function findModel(id) {
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
function activeUrls(detectorId, ocrId, customIndex = []) {
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

// ================= js/lib/modelstore.js =================
// modelstore.js — хранение моделей в Cache API (только браузер).
// Скачивание с прогрессом, получение буферов, удаление, оценка занятого места.

const CACHE_NAME = 'mt-models-v1';

function cache() {
  return caches.open(CACHE_NAME);
}

async function hasModel(url) {
  const c = await cache();
  return (await c.match(url)) !== undefined;
}

/** Скачать файл модели с прогрессом (onProgress: received, total). */
async function downloadModelFile(url, { onProgress, signal } = {}) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} при скачивании модели`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    const c = await cache();
    await c.put(url, new Response(buf, { headers: { 'content-length': String(buf.byteLength) } }));
    return buf.byteLength;
  }
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (onProgress) onProgress(received, total);
  }
  const buf = new Uint8Array(received);
  let off = 0;
  for (const ch of chunks) { buf.set(ch, off); off += ch.byteLength; }
  const c = await cache();
  await c.put(url, new Response(buf.slice().buffer, { headers: { 'content-length': String(received) } }));
  return received;
}

/** Получить ArrayBuffer скачанной модели (или null). */
async function getModelBuffer(url) {
  const c = await cache();
  const hit = await c.match(url);
  if (!hit) return null;
  return await hit.arrayBuffer();
}

async function deleteModelFiles(urls) {
  const c = await cache();
  await Promise.all(urls.map(u => c.delete(u)));
  await invalidateUsageCache();
}

// ---------- пользовательские OCR-модели (импорт ZIP / папки / файлов / HF) ----------
// Храним в IndexedDB ('mtl-custom-ocr', store 'files'), ключ '<id>/<имя>'.
// Cache API для этого не годится: cache.put() принимает только http(s),
// а синтетические ключи custom://ocr/<id>/<file> дают в Chrome ошибку
// "Request scheme 'custom' is unsupported" (регрессия v1.4.x–v1.5.x: любой
// импорт кастомной OCR падал уже после валидации).
// Индекс записей ведёт service worker в chrome.storage.local ('customOcr').

const CUSTOM_IDB = 'mtl-custom-ocr';
const CUSTOM_STORE = 'files';
const CUSTOM_FILES = ['det.onnx', 'rec.onnx', 'dict.txt', 'meta.json'];
const customKey = (id, name) => `${id}/${name}`;

function customIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CUSTOM_IDB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(CUSTOM_STORE)) req.result.createObjectStore(CUSTOM_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB недоступна'));
  });
}

/** Одна транзакция: fn(store) → IDBRequest; резолвится после complete. */
async function customTx(mode, fn) {
  const db = await customIdb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CUSTOM_STORE, mode);
      const req = fn(tx.objectStore(CUSTOM_STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB: транзакция прервана'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB: ошибка транзакции'));
    });
  } finally {
    db.close();
  }
}

async function putCustomOcrFiles(id, files) {
  await customTx('readwrite', (st) => {
    for (const [name, data] of Object.entries(files)) {
      if (!data) continue;
      const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      st.put(buf, customKey(id, name));
    }
  });
}

async function getCustomOcrFiles(id) {
  // один диапазон ключей '<id>/…' — читаем только файлы этой модели
  const range = IDBKeyRange.bound(customKey(id, ''), `${customKey(id, '')}\uffff`);
  const db = await customIdb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CUSTOM_STORE, 'readonly');
      const st = tx.objectStore(CUSTOM_STORE);
      const keysReq = st.getAllKeys(range);
      const bufsReq = st.getAll(range);
      tx.oncomplete = () => {
        const out = {};
        (keysReq.result || []).forEach((key, i) => {
          const name = key.slice(id.length + 1);
          if (CUSTOM_FILES.includes(name)) {
            out[name.replace('.onnx', '').replace('.txt', '').replace('.json', '')] = bufsReq.result[i];
          }
        });
        resolve(out);
      };
      tx.onabort = () => reject(tx.error || new Error('IndexedDB: транзакция прервана'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB: ошибка транзакции'));
    });
  } finally {
    db.close();
  }
}

async function getCustomOcrDict(id) {
  const buf = await customTx('readonly', (st) => st.get(customKey(id, 'dict.txt')));
  return buf ? new TextDecoder().decode(buf) : '';
}

async function deleteCustomOcrFiles(id) {
  await customTx('readwrite', (st) => {
    for (const name of CUSTOM_FILES) st.delete(customKey(id, name));
  });
  await invalidateUsageCache();
}

async function clearAllModels() {
  await caches.delete(CACHE_NAME);
  await customTx('readwrite', (st) => st.clear()).catch(() => { /* IDB могла не создаться */ });
  await invalidateUsageCache();
}

/** Сбросить кэшированную оценку занятого места (после удаления моделей). */
async function invalidateUsageCache() {
  try { await chrome.storage?.session?.remove('modelsUsage'); } catch (e) { /* не критично */ }
}

/**
 * Реальный занятый объём хранилища моделей.
 * navigator.storage.estimate() в MV3-воркерах расширений почти всегда
 * возвращает usage = 0 (известное поведение Chrome), поэтому размер
 * считаем сами: сумма content-length записей кэша моделей; для записей
 * без заголовка — потоковый подсчёт байт (тело в память не читается).
 * Результат кэшируется на 60 с, чтобы popup не пересчитывал гигабайты
 * при каждом открытии. { usageMB, quotaMB }
 */
async function storageUsage() {
  // свежий кэш оценки?
  try {
    const { modelsUsage } = await chrome.storage?.session?.get('modelsUsage') || {};
    if (modelsUsage && Date.now() - modelsUsage.at < 60_000) {
      return { usageMB: modelsUsage.usageMB, quotaMB: modelsUsage.quotaMB };
    }
  } catch (e) { /* session недоступна — считаем без кэша */ }

  let bytes = 0;
  let counted = false;
  try {
    const c = await cache();
    const keys = await c.keys();
    counted = true;
    for (const req of keys) {
      const res = await c.match(req);
      if (!res) continue;
      const cl = Number(res.headers.get('content-length'));
      if (Number.isFinite(cl) && cl > 0) { bytes += cl; continue; }
      // без content-length — считаем потоково, память константная
      if (res.body) {
        for await (const chunk of res.body) bytes += chunk.byteLength;
      }
    }
  } catch (e) { /* Cache API недоступен */ }

  // файлы кастомных OCR лежат в IndexedDB — прибавляем их к кэшу моделей
  try {
    const db = await customIdb();
    const bytesIdb = await new Promise((resolve, reject) => {
      const tx = db.transaction(CUSTOM_STORE, 'readonly');
      const req = tx.objectStore(CUSTOM_STORE).getAll();
      tx.oncomplete = () => resolve((req.result || []).reduce((s, b) => s + (b?.byteLength || 0), 0));
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    bytes += bytesIdb;
    counted = true;
  } catch (e) { /* IDB недоступна */ }

  if (!counted) {
    // последний шанс — estimate() (врёт, но лучше, чем ничего)
    try {
      const est = await navigator.storage.estimate();
      return { usageMB: (est.usage || 0) / 1048576, quotaMB: (est.quota || 0) / 1048576 };
    } catch (e2) {
      return { usageMB: 0, quotaMB: 0 };
    }
  }

  let quotaMB = 0;
  try {
    const est = await navigator.storage.estimate();
    quotaMB = (est.quota || 0) / 1048576;
  } catch (e) { /* квоту не узнали — покажем только занятое */ }

  const usageMB = bytes / 1048576;
  try { await chrome.storage?.session?.set({ modelsUsage: { at: Date.now(), usageMB, quotaMB } }); } catch (e) { /* не критично */ }
  return { usageMB, quotaMB };
}

// ================= js/lib/modelreadiness.js =================
// modelreadiness.js — проверка «все ли модели скачаны» перед переводом.
// Кастомные OCR (custom:<id>) хранятся в IndexedDB, а не в Cache API — их
// наличие гарантирует запись в индексе customOcr; кэш проверяем только для
// встроенных моделей и встроенного детектора строк PP-OCRv5.
// (Регрессия v1.6.0: handleTranslateImage проверял custom://-ключи через кэш
// и перевод с кастомной моделью всегда падал с NOT_DOWNLOADED.)


/**
 * Список отсутствующих файлов ([] = всё на месте).
 * @param settings {detectorModel, ocrModel}
 * @param customIndex записи chrome.storage.local('customOcr')
 * @param hasModel async (url) => boolean — реализация проверки кэша
 * @param opts skipOcr — Vision OCR: распознаёт LLM, OCR-модель не нужна
 */
async function missingModelFiles(settings, customIndex = [], hasModel, { skipOcr = false } = {}) {
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
function describeMissing(missing, customIndex = []) {
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

// ================= js/lib/prompts.js =================
// prompts.js — системные и пользовательские промпты для локальной LLM (OpenAI-compatible).
// Протокол «нумерованных строк»: маленькие модели 1B–2B стабильно держат формат
// «1. …» и не добавляют пояснений.

const TARGET_LANG_NAMES = {
  ru: 'русский язык', en: 'English', uk: 'українську мову', es: 'español', de: 'Deutsch',
  fr: 'français', pt: 'português', it: 'italiano', pl: 'polski', tr: 'Türkçe',
  kk: 'қазақ тілін', zh: '中文', ja: '日本語', ko: '한국어',
};

function targetLangName(code) {
  return TARGET_LANG_NAMES[code] || code;
}

// Форматный контракт: без него маленькие модели ломают нумерованный
// протокол, поэтому он сохраняется даже при пользовательском промте.
const FMT = {
  ru: (langName) =>
    `Переведи пронумерованные предложения ниже на ${langName}. ` +
    `Сохрани ту же форму, в которой они написаны: в начале каждой строки цифра с точкой («1. », «2. » …), ` +
    `по одной строке на каждый пункт. Напиши только переведённые строки, без дополнительных объяснений и лишнего текста.`,
  en: (langName) =>
    `Translate the numbered lines below into ${langName}. ` +
    `Keep the exact same numbered format ("1. ", "2. ", ...), one line per item. ` +
    `Output only the translated lines. No explanations, no extra text.`,
};

/**
 * Сообщения для перевода массива строк. promptLang: 'ru' | 'en'.
 * customPrompt: свой текст пользователя — заменяет роль/стиль переводчика,
 * а задание на перевод (язык, нумерованный формат, «только перевод»)
 * всегда добавляется следом, иначе распарсить ответ не получится.
 */
function buildTranslationMessages(texts, { targetLang = 'ru', promptLang = 'ru', customPrompt = '' } = {}) {
  const langName = targetLangName(targetLang);
  const numbered = texts.map((t, i) => `${i + 1}. ${t.replace(/\s+/g, ' ').trim()}`).join('\n');
  const custom = (customPrompt || '').trim();

  let system;
  if (promptLang === 'en') {
    system = custom
      ? `${custom} ${FMT.en(langName)}`
      : `You are a professional translator. ${FMT.en(langName)} ` +
        `Preserve the tone and style of comics dialogue.`;
    return [
      { role: 'system', content: system },
      { role: 'user', content: `Translate into ${langName}:\n${numbered}` },
    ];
  }
  system = custom
    ? `${custom} ${FMT.ru(langName)}`
    : `Ты профессиональный переводчик. ${FMT.ru(langName)} ` +
      `Сохраняй смысл, разговорный стиль и настроение реплик из комиксов.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Переведи на ${langName}:\n${numbered}` },
  ];
}

/** Промпт для одиночного перевода (fallback, когда модель не справилась с нумерацией). */
function buildSingleMessage(text, { targetLang = 'ru', promptLang = 'ru', customPrompt = '' } = {}) {
  const langName = targetLangName(targetLang);
  const custom = (customPrompt || '').trim();
  if (promptLang === 'en') {
    const task = `Translate the user's text into ${langName}. Output only the translation, nothing else.`;
    return [
      { role: 'system', content: custom ? `${custom} ${task}` : `You are a professional translator. ${task}` },
      { role: 'user', content: text },
    ];
  }
  const task = `Переведи текст пользователя на ${langName}. Выведи только перевод, без пояснений.`;
  return [
    { role: 'system', content: custom ? `${custom} ${task}` : `Ты профессиональный переводчик. ${task}` },
    { role: 'user', content: text },
  ];
}

// Форматный контракт Vision OCR: ответ строго JSON {source, translation} —
// по нему кроп пузыря превращается в пару «оригинал → перевод».
const VFMT = {
  ru: (langName) =>
    `На изображении — фрагмент манги или комикса (пузырь, подпись или звукоподражание). ` +
    `1) Прочитай текст точно как написан: язык может быть любым, текст бывает вертикальным. ` +
    `2) Переведи его на ${langName}, сохранив разговорный стиль комиксов. ` +
    `Ответь ТОЛЬКО валидным JSON без пояснений: {"source": "оригинальный текст", "translation": "перевод"}. ` +
    `Если текста на изображении нет — ответь {"source": "", "translation": ""}.`,
  en: (langName) =>
    `The image shows a fragment of a manga or comic (a speech bubble, caption or sound effect). ` +
    `1) Read the text exactly as written: the language may be any, the text can be vertical. ` +
    `2) Translate it into ${langName}, preserving the conversational comic style. ` +
    `Reply ONLY with valid JSON, no explanations: {"source": "original text", "translation": "translation"}. ` +
    `If there is no text in the image, reply {"source": "", "translation": ""}.`,
};

/**
 * Сообщения для Vision OCR: один кроп (dataURL) → {source, translation}.
 * Модель должна поддерживать изображения (vision). maxTokens маленький:
 * текст пузыря короткий.
 */
function buildVisionMessages(dataUrl, { targetLang = 'ru', promptLang = 'ru', customPrompt = '' } = {}) {
  const langName = targetLangName(targetLang);
  const custom = (customPrompt || '').trim();
  const task = VFMT[promptLang === 'en' ? 'en' : 'ru'](langName);
  const system = custom || (promptLang === 'en'
    ? 'You are a professional comic/manga translator with perfect OCR skills.'
    : 'Ты профессиональный переводчик комиксов и манги с навыками точного OCR.');
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: task },
      ],
    },
  ];
}

// ================= js/lib/translate.js =================
// translate.js — модуль перевода: Google Translate (бесплатный эндпоинт) и
// локальная LLM (OpenAI-compatible: Unsloth / LM Studio / Ollama / vLLM).
// Оба движка используют протокол «нумерованных строк» + запасной одиночный перевод.


// Два бесплатных фронта Google Translate: если один рейтинг-лимитит, берём второй.
const GOOGLE_ENDPOINTS = [
  'https://translate.googleapis.com/translate_a/single',
  'https://clients5.google.com/translate_a/single',
];
let googleEndpointIdx = 0;
const BATCH_MAX_CHARS = 1400;   // лимит длины GET-запроса к Google
const BATCH_MAX_ITEMS = 20;     // строк в одном батче
const LLM_BATCH_MAX_ITEMS = 15;
const CONCURRENCY = 3;
const RETRIES = 2;
const TIMEOUT_MS = 15000;

// ---------- Разбор нумерованного ответа ----------

/** Разбирает «1. текст» строки; возвращает Map<номер, текст> или null. */
function parseNumbered(text) {
  if (!text) return null;
  const clean = text.replace(/```[a-z]*\n?/g, '').trim();
  const map = new Map();
  let any = false;
  for (const line of clean.split(/\n+/)) {
    const m = line.match(/^\s*(\d{1,3})\s*[.)]\s*(.*)$/);
    if (m) {
      any = true;
      const val = m[2].trim();
      if (val) map.set(parseInt(m[1], 10), val);
    }
  }
  return any ? map : null;
}

/** Сопоставляет переводы с исходниками; добирает пропуски позиционно. */
function mapByNumber(responseText, texts) {
  const map = parseNumbered(responseText);
  if (!map) return null;
  const out = new Array(texts.length).fill(null);
  let matched = 0;
  for (let i = 0; i < texts.length; i++) {
    const v = map.get(i + 1);
    if (v) { out[i] = v; matched++; }
  }
  if (matched === 0) return null;
  // позиционный добор: если число строк совпало, а нумерация съехала
  if (matched < texts.length) {
    const lines = responseText.split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (lines.length === texts.length) {
      for (let i = 0; i < texts.length; i++) if (!out[i]) out[i] = lines[i].replace(/^\s*\d{1,3}\s*[.)]\s*/, '');
    }
  }
  return out;
}

// ---------- Google Translate (бесплатный клиент gtx) ----------

async function googleTranslateOne(text, sl, tl, signal) {
  let lastErr = null;
  for (let attempt = 0; attempt < GOOGLE_ENDPOINTS.length; attempt++) {
    const base = GOOGLE_ENDPOINTS[(googleEndpointIdx + attempt) % GOOGLE_ENDPOINTS.length];
    const url = `${base}?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
    try {
      const res = await fetchWithTimeout(url, {}, signal);
      if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('Google: неожиданный ответ');
      const translated = data[0].map(seg => (Array.isArray(seg) && seg[0]) ? seg[0] : '').join('');
      if (!translated.trim()) throw new Error('Google: пустой ответ');
      googleEndpointIdx = (googleEndpointIdx + attempt) % GOOGLE_ENDPOINTS.length; // закрепить рабочий фронт
      return translated;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Google: все эндпоинты недоступны');
}

async function googleTranslateBatch(texts, sl, tl, signal) {
  const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const translated = await googleTranslateOne(numbered, sl, tl, signal);
  const mapped = mapByNumber(translated, texts);
  if (mapped && mapped.every(v => v)) return mapped;
  // запасной путь: по одной строке
  const out = [];
  for (const t of texts) {
    if (mapped && mapped[texts.indexOf(t)]) { out.push(mapped[texts.indexOf(t)]); continue; }
    out.push(await googleTranslateOne(t, sl, tl, signal).catch(() => null));
  }
  return out;
}

// ---------- OpenAI-compatible LLM ----------

/** Нормализация Base URL: гарантированно заканчивается на /v1. */
function normalizeBaseUrl(raw) {
  let u = (raw || '').trim().replace(/\s+/g, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/chat\/completions$/i, '');
  u = u.replace(/\/models$/i, '');
  if (!/\/v\d+$/i.test(u)) u += '/v1';
  return u;
}

function llmHeaders(settings) {
  const h = { 'Content-Type': 'application/json' };
  if (settings.llmApiKey) h['Authorization'] = `Bearer ${settings.llmApiKey}`;
  return h;
}

/** Список моделей с сервера (для кнопки «Проверить соединение»). */
async function llmListModels(settings, signal) {
  const base = normalizeBaseUrl(settings.llmBaseUrl);
  const res = await fetchWithTimeout(`${base}/models`, { headers: llmHeaders(settings) }, signal);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data.map(m => m.id).filter(Boolean) : [];
  return list;
}

// export нужен: sw_main.js использует llmChat в TEST_LLM (пробный перевод).
// До v1.4.1 была приватной — модульный граф sw_main не линковался.
async function llmChat(settings, messages, { maxTokens = 2048, signal, timeout } = {}) {
  const base = normalizeBaseUrl(settings.llmBaseUrl);
  const body = {
    model: settings.llmModel || undefined,
    messages,
    temperature: settings.llmTemperature ?? 0.3,
    max_tokens: maxTokens,
    stream: false,
  };
  const res = await fetchWithTimeout(`${base}/chat/completions`, {
    method: 'POST',
    headers: llmHeaders(settings),
    body: JSON.stringify(body),
  }, signal, timeout || TIMEOUT_MS);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('LLM: нет content в ответе');
  return content;
}

// ---------- Vision OCR: LLM с картинками читает и переводит одним вызовом ----------

/** Разворачивает экранированные кавычки/переводы строк в JSON-строке. */
function jsonUnescape(s) {
  return s.replace(/\\(["\\\/bfnrt])/g, (_, c) => (
    { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[c]
  ));
}

/**
 * Разбор ответа vision-модели → {source, translation} | null.
 * Маленькие модели заворачивают JSON в ```-блоки, добавляют текст вокруг
 * или ломают кавычки — пробуем строгий JSON, затем regex по полям,
 * затем считаем весь ответ переводом.
 */
function parseVisionJson(content) {
  if (!content) return null;
  let s = String(content).trim();
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const tryParse = (raw) => {
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      const source = typeof obj.source === 'string' ? obj.source.trim() : '';
      const translation = typeof obj.translation === 'string' ? obj.translation.trim() : '';
      return { source, translation };
    } catch { return null; }
  };
  const m = s.match(/\{[\s\S]*\}/);
  const parsed = tryParse(m ? m[0] : null);
  if (parsed) return parsed;
  // сломанный JSON: вытаскиваем поля по отдельности. source — лениво (до
  // ближайшей кавычки), translation — жадно (до последней: в переводе бывают
  // внутренние кавычки; закрывающая от них неотличима, это best-effort)
  const src = s.match(/"source"\s*:\s*"((?:[^"\\]|\\.)*)/);
  const tr = s.match(/"translation"\s*:\s*"(.*)/);
  if (src || tr) {
    const trVal = tr ? tr[1].replace(/"[^"]*$/, '').replace(/"\s*\}?\s*$/, '') : '';
    return {
      source: src ? jsonUnescape(src[1]).trim() : '',
      translation: tr ? jsonUnescape(trVal).trim() : '',
    };
  }
  // модель проигнорировала формат — считаем весь текст переводом
  return { source: '', translation: s };
}

/**
 * Vision OCR одного кропа: dataURL изображения → {source, translation}.
 * Валидный JSON с пустыми полями = «текста нет» ({'',''}) — это НЕ ошибка.
 * null = вызов/разбор не удался вовсе.
 */
async function visionReadCrop(settings, dataUrl, {
  targetLang = 'ru', promptLang = 'ru', customPrompt = '', signal, timeout = 120000,
} = {}) {
  const messages = buildVisionMessages(dataUrl, { targetLang, promptLang, customPrompt });
  const content = await llmChat(settings, messages, { maxTokens: 512, signal, timeout });
  const parsed = parseVisionJson(content);
  if (parsed) return parsed;
  const t = String(content || '').trim();
  return t ? { source: '', translation: t } : null;
}

// ---------- Общий движок ----------

async function translateBatchEngine(texts, settings, signal) {
  if (settings.engine === 'llm') {
    const messages = buildTranslationMessages(texts, {
      targetLang: settings.targetLang || 'ru',
      promptLang: settings.promptLang || 'ru',
      customPrompt: settings.llmCustomPrompt || '',
    });
    const content = await llmChat(settings, messages, { maxTokens: 1024 + texts.length * 256, signal });
    const mapped = mapByNumber(content, texts);
    if (mapped && mapped.every(v => v)) return mapped;
    // fallback: по одной строке простым промптом
    const out = [];
    for (let i = 0; i < texts.length; i++) {
      if (mapped && mapped[i]) { out.push(mapped[i]); continue; }
      const single = await llmChat(settings, buildSingleMessage(texts[i], {
        targetLang: settings.targetLang || 'ru', promptLang: settings.promptLang || 'ru',
        customPrompt: settings.llmCustomPrompt || '',
      }), { maxTokens: 512, signal }).catch(() => null);
      out.push(single && single.trim() ? single.trim() : null);
    }
    return out;
  }

  const sl = settings.sourceLang && settings.sourceLang !== 'auto' ? settings.sourceLang : 'auto';
  return googleTranslateBatch(texts, sl, settings.targetLang || 'ru', signal);
}

/**
 * Перевод массива текстов. Возвращает массив той же длины (null на неудачах).
 * onProgress(done, total) — для UI.
 */
async function translateTexts(texts, settings, { onProgress, signal } = {}) {
  const list = texts.map(t => String(t || ''));
  const results = new Array(list.length).fill(null);
  const nonEmpty = [];
  const idx = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].trim()) { nonEmpty.push(list[i]); idx.push(i); }
  }
  if (!nonEmpty.length) return results;

  const batches = [];
  {
    let start = 0;
    let cur = [], curLen = 0;
    for (let i = 0; i < nonEmpty.length; i++) {
      const t = nonEmpty[i];
      const len = t.length + 8;
      if (cur.length && (cur.length >= LLM_BATCH_MAX_ITEMS || curLen + len > BATCH_MAX_CHARS || cur.length >= BATCH_MAX_ITEMS)) {
        batches.push({ batch: cur, start });
        cur = []; curLen = 0; start = i;
      }
      cur.push(t); curLen += len;
    }
    if (cur.length) batches.push({ batch: cur, start });
  }
  let done = 0;
  const total = nonEmpty.length;
  const queue = [...batches];
  let cursor = 0;

  async function worker() {
    while (cursor < queue.length) {
      const { batch, start } = queue[cursor++];
      let translated = null;
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        try {
          translated = await translateBatchEngine(batch, settings, signal);
          break;
        } catch (e) {
          if (attempt === RETRIES) translated = batch.map(() => null);
          else await sleep(300 * (attempt + 1));
        }
      }
      for (let i = 0; i < batch.length; i++) {
        results[idx[start + i]] = translated ? translated[i] : null;
      }
      done += batch.length;
      if (onProgress) onProgress(Math.min(done, total), total);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return results;
}

// ---------- утилиты ----------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithTimeout(url, options = {}, signal, timeout = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ================= js/background/sw_main.js (логика SW) =================
// service-worker.js — оркестратор расширения: настройки, загрузка моделей (Cache API),
// жизненный цикл offscreen-документа, перевод (Google / локальная LLM), реле сообщений.


const OFFSCREEN_URL = 'html/offscreen.html';
let offscreenCreating = null;
let offscreenLastUsed = 0;

// ---------------- настройки ----------------

// v1.10.1: склейка страниц включается по умолчанию — в том числе у тех, кто
// обновился с версий, где она была выключена. Однократно (флаг stitchMigrated);
// если пользователь после этого выключил её сам — его выбор уважается.
let stitchMigrationChecked = false;
async function migrateStitchDefault() {
  if (stitchMigrationChecked) return;
  stitchMigrationChecked = true;
  const { settings, stitchMigrated } = await chrome.storage.local.get(['settings', 'stitchMigrated']);
  if (stitchMigrated) return;
  const merged = mergeSettings(settings);
  merged.pageStitch = true;
  await chrome.storage.local.set({ settings: merged, stitchMigrated: true });
}

async function getSettings() {
  await migrateStitchDefault();
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

async function handleTranslateImage(image, debug = false, opts = {}) {
  const settings = await getSettings();
  const { customOcr = [] } = await chrome.storage.local.get('customOcr');
  // ocrOnly (v1.9.0, склейка страниц): нужен только текст шва — детекция+OCR
  // без перевода; renderMode 'badge' отключает inpaint в offscreen
  const runSettings = opts.ocrOnly ? { ...settings, renderMode: 'badge' } : settings;
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
  const res = await runPipeline(image, runSettings);
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

async function finishPageJob(error, extra = {}) {
  pageJob = { active: false, done: pageJob.done, total: pageJob.total, error: error || null, ...extra };
  await broadcastPage();
}

// Контент-скрипт мог остаться от предыдущей версии расширения: вкладка манги
// открыта с прошлого дня, а расширение обновилось — старый скрипт отвечает на
// команды, но не знает новых флагов (preload «Загрузить всё», hotkeys). Сверяем
// версию: при несовпадении перезагружаем вкладку — после неё Chrome сам
// инжектит актуальный content script. Один раз после обновления, дальше мгновенно.
// тег сборки контент-скрипта: при правках без смены версии расширения
// обновить здесь И в content.js (window.__mtlBuild) — устаревшие вкладки
// перезагрузятся сами при первой команде страницы
const CONTENT_BUILD = 'st3';

async function contentVersionMatches(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: MSG.PING });
    return !!(r?.ok && r.v === chrome.runtime.getManifest().version && r.b === CONTENT_BUILD);
  } catch (e) {
    return false; // приёмника нет вообще (или file:// без разрешения)
  }
}

function waitTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function startTranslatePage(debug = false, preload = false) {
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

  // устаревший (или отсутствующий) контент-скрипт: перезагружаем вкладку
  if (!(await contentVersionMatches(tab.id))) {
    try {
      await chrome.tabs.reload(tab.id);
      await waitTabComplete(tab.id);
    } catch (e) { /* chrome:// и file:// без разрешения — ответим ошибкой ниже */ }
  }

  pageJob = {
    active: true, done: 0, total: 0, error: null,
    kind: debug ? 'debug' : (preload ? 'loadAll' : 'translate'), // чья кнопка станет «Остановить»
  };
  pageJobLastBeat = Date.now();
  await broadcastPage();

  // команда контент-скрипту; если он не отвечает — сразу понятная ошибка
  let responded = false;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_PAGE, debug, preload });
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

// «Остановить» (v1.10.0): просим контент-скрипт прервать цикл перевода/сбора.
// Контент досматривает текущую картинку (или сразу возвращает камеру на место,
// если стоп пришёл во время сбора) и присылает финальный отчёт finished+stopped;
// если вкладка молчит — закрываем задачу сами через 2.5 с.
async function stopTranslatePage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    try { await chrome.tabs.sendMessage(tab.id, { type: MSG.PAGE_JOB_STOP }); } catch (e) { /* приёмника нет */ }
  }
  if (pageJob.active) {
    setTimeout(() => {
      if (pageJob.active) finishPageJob(null, { stopped: true }).catch(() => {});
    }, 2500);
  }
  return { ok: true };
}

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
          sendResponse(await handleTranslateImage(msg.image, !!msg.debug, { ocrOnly: !!msg.ocrOnly }));
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
          await startTranslatePage(!!msg.debug, !!msg.preload);
          sendResponse({ ok: true });
          break;

        case MSG.CLEAR_TRANSLATIONS:
          sendResponse(await clearTranslationsOnActiveTab());
          break;

        case 'PAGE_PROGRESS_REPORT': {
          // от content script: {done, total, finished, stopped, error, debug}
          pageJobLastBeat = Date.now();
          pageJob = {
            active: !msg.finished,
            done: msg.done || 0,
            total: msg.total || 0,
            error: msg.error || null,
            debug: !!msg.debug,
            kind: pageJob.kind || 'translate',
            stopped: !!msg.stopped,
          };
          await broadcastPage();
          offscreenLastUsed = Date.now();
          sendResponse({ ok: true });
          break;
        }

        case MSG.PAGE_JOB_STOP:
          sendResponse(await stopTranslatePage());
          break;

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
