// translate.js — модуль перевода: Google Translate (бесплатный эндпоинт) и
// локальная LLM (OpenAI-compatible: Unsloth / LM Studio / Ollama / vLLM).
// Оба движка используют протокол «нумерованных строк» + запасной одиночный перевод.

import { buildTranslationMessages, buildSingleMessage, buildVisionMessages } from './prompts.js';

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
export function parseNumbered(text) {
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
export function normalizeBaseUrl(raw) {
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
export async function llmListModels(settings, signal) {
  const base = normalizeBaseUrl(settings.llmBaseUrl);
  const res = await fetchWithTimeout(`${base}/models`, { headers: llmHeaders(settings) }, signal);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data.map(m => m.id).filter(Boolean) : [];
  return list;
}

// export нужен: sw_main.js использует llmChat в TEST_LLM (пробный перевод).
// До v1.4.1 была приватной — модульный граф sw_main не линковался.
export async function llmChat(settings, messages, { maxTokens = 2048, signal, timeout } = {}) {
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
export function parseVisionJson(content) {
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
export async function visionReadCrop(settings, dataUrl, {
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
export async function translateTexts(texts, settings, { onProgress, signal } = {}) {
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
