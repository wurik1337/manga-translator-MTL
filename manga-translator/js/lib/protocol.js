// protocol.js — типы сообщений и настройки по умолчанию (общие для popup, background, offscreen).

export const MSG = {
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
  CLEAR_TRANSLATIONS: 'CLEAR_TRANSLATIONS', // popup → background → content: убрать все переводы
  PAGE_PROGRESS: 'PAGE_PROGRESS',       // background → popup: прогресс страницы
  MODEL_PROGRESS: 'MODEL_PROGRESS',     // background → popup: прогресс загрузки моделей
  OFFSCREEN_RUN: 'OFFSCREEN_RUN',       // background → offscreen
  OCR_IMPORT_REGISTER: 'OCR_IMPORT_REGISTER', // popup → background: файлы кастомной OCR уже в кэше, записать в индекс
  OCR_DELETE_CUSTOM: 'OCR_DELETE_CUSTOM',     // popup → background: удалить кастомную OCR-модель
};

export const DEFAULT_SETTINGS = {
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
  autoTranslate: true,
  translateFreeText: true,     // текст вне пузырей (SFX, подписи)
  detectorModel: 'rtdetr-s',
  ocrModel: 'ppocrv6-manga',
  minConfidence: 0.5,
  renderMode: 'inpaint',      // 'inpaint' — стереть текст, вписать перевод | 'badge' — компактная рамка
  fontFit: 'auto',            // 'auto' — кегль подбирается под пузырь | 'fixed' — фиксированный
  fontSizeFixed: 18,          // кегль при fontFit='fixed' (px изображения)
  overlayStyle: 'light',      // 'light' | 'dark'
  autoTextColor: true,        // автоцвет: тёмный/светлый текст по фону пузыря (только 'inpaint')
  showOriginalOnHover: true,
};

export const LANGUAGES = {
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
export function mergeSettings(saved) {
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
  return out;
}
