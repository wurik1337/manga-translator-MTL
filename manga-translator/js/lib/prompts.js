// prompts.js — системные и пользовательские промпты для локальной LLM (OpenAI-compatible).
// Протокол «нумерованных строк»: маленькие модели 1B–2B стабильно держат формат
// «1. …» и не добавляют пояснений.

const TARGET_LANG_NAMES = {
  ru: 'русский язык', en: 'English', uk: 'українську мову', es: 'español', de: 'Deutsch',
  fr: 'français', pt: 'português', it: 'italiano', pl: 'polski', tr: 'Türkçe',
  kk: 'қазақ тілін', zh: '中文', ja: '日本語', ko: '한국어',
};

export function targetLangName(code) {
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
export function buildTranslationMessages(texts, { targetLang = 'ru', promptLang = 'ru', customPrompt = '' } = {}) {
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
export function buildSingleMessage(text, { targetLang = 'ru', promptLang = 'ru', customPrompt = '' } = {}) {
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
export function buildVisionMessages(dataUrl, { targetLang = 'ru', promptLang = 'ru', customPrompt = '' } = {}) {
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
