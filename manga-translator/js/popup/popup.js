// popup.js — логика UI: настройки, каталог моделей с иконками установить/удалить,
// прогресс, вкладки.
// v1.1.2: каталог моделей рендерится МГНОВЕННО локально (modelmeta.js), до любых
// запросов к фону; если фоновый процесс не отвечает — красная карточка с кнопкой
// перезапуска появляется за ~1-2 с, а не после минут ожидания. Все привязки
// null-safe. Карточка «Локальные файлы (file://)» проверяет доступ первой.

import { MSG, DEFAULT_SETTINGS, LANGUAGES, mergeSettings, formatCombo } from '../lib/protocol.js';
import { MODEL_CATALOG } from '../lib/modelmeta.js';
import { parseCustomOcrZip, decodeDict, isCustomOcrId, customOcrId } from '../lib/customocr.js';
import { putCustomOcrFiles } from '../lib/modelstore.js';
import {
  parseHfTarget, listHfRepoFiles, pickOcrFiles, downloadHfFile, buildOcrEntry, basename as hfBasename,
} from '../lib/hfimport.js';
import { UI_LANGS, resolveUiLang, detectBrowserLang, makeT, applyI18n } from '../lib/i18n.js';

const $ = (id) => document.getElementById(id);
// null-safe привязка: если элемента нет — просто пропускаем, UI не падает
const on = (id, evt, fn) => { const el = $(id); if (el) el.addEventListener(evt, fn); };

let settings = { ...DEFAULT_SETTINGS };
let state = null; // { catalog, downloaded, downloads, usage, ... }
// язык интерфейса: 'browser' по умолчанию — берётся из браузера
const BROWSER_LANG = detectBrowserLang(typeof navigator !== 'undefined' ? navigator : null);
let uiLang = resolveUiLang(settings.uiLang, BROWSER_LANG);
let t = makeT(uiLang);

/** Переключить язык интерфейса и перерисовать все статические подписи. */
function applyUiLang() {
  uiLang = resolveUiLang(settings.uiLang, BROWSER_LANG);
  t = makeT(uiLang);
  document.documentElement.lang = uiLang === 'browser' ? BROWSER_LANG.split('-')[0] : uiLang;
  applyI18n(document, t);
  fillUiLangSelect();
}

/** Селектор языка интерфейса: «Язык браузера» + список языков. */
function fillUiLangSelect() {
  const sel = $('ui-lang');
  if (!sel) return;
  if (document.activeElement === sel) return; // не мешаем открытому списку
  sel.innerHTML = '';
  const optB = document.createElement('option');
  optB.value = 'browser';
  optB.textContent = t('uiLangBrowser');
  sel.appendChild(optB);
  for (const l of UI_LANGS) {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = l.name;
    sel.appendChild(o);
  }
  sel.value = settings.uiLang || 'browser';
}
let swDead = false;  // фоновый процесс не отвечает
let pending = true;  // ещё ждём ответ от фона (каталог уже показан локально)
let uiLock = false;

function send(msg, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs);
    chrome.runtime.sendMessage(msg, (res) => {
      clearTimeout(t);
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res);
    });
  });
}

/** Локальное состояние для мгновенного рендера: каталог зашит в расширение. */
function localState() {
  return {
    catalog: MODEL_CATALOG,
    downloaded: state?.downloaded || {},
    downloads: state?.downloads || {},
    usage: state?.usage || { usageMB: 0, quotaMB: 0 },
    activeCount: state?.activeCount || 0,
    settings,
  };
}

// ---------------- инициализация ----------------

async function init() {
  // 1) мгновенный рендер: карточки моделей видны через миллисекунды после
  //    открытия popup, независимо от состояния фонового процесса
  state = localState();
  bindStatic();
  // версия — всегда из манифеста (в v1.4.x–v1.6.0 подпись была захардкожена
  // и после обновлений продолжала показывать «MTL v1.4.0»)
  const verEl = $('ver-label');
  if (verEl) verEl.textContent = `MTL v${chrome.runtime.getManifest?.().version || '?'}`;
  renderAll();
  checkFileAccess();
  // 2) затем уточняем состояние у фона (быстрые попытки, чтобы красную
  //    карточку «фон не отвечает» показать без долгого ожидания)
  await loadStateWithRetry();
  renderAll();
  refreshStorage();
  restorePageProgress();
}

/** Несколько быстрых попыток: SW может холодно стартовать при открытии popup. */
async function loadStateWithRetry() {
  let setRes = null, stRes = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 200 * attempt));
    [setRes, stRes] = await Promise.all([
      send({ type: MSG.GET_SETTINGS }, 1500),
      send({ type: MSG.GET_STATE }, 1500),
    ]);
    if (setRes?.ok && stRes?.ok) break;
  }
  // пустой/битый ответ фона не должен затирать настройки — это выглядело как
  // «сбрасываются горячие клавиши» при переоткрытии popup
  if (setRes?.ok && setRes.settings) settings = setRes.settings;
  if (!setRes?.ok) {
    // фон не отвечает: настройки лежат в storage и читаются без SW
    try {
      const { settings: saved } = await chrome.storage.local.get('settings');
      if (saved) settings = mergeSettings(saved);
    } catch (e) { /* storage недоступен — остаёмся на дефолтах */ }
  }
  if (stRes?.ok && stRes.state?.catalog) {
    state = stRes.state;
    swDead = false;
    pending = false;
  } else {
    // Фоновый процесс мёртв: каталог остаётся видимым (локальный),
    // показываем красную карточку перезапуска.
    swDead = true;
    pending = false;
    state = localState();
  }
}

/**
 * Изменить настройки и перерисовать «хром» UI.
 * Перерисовываем только классы/видимость (не значения полей ввода).
 */
function patchSettings(patch) {
  settings = { ...settings, ...patch };
  // фон может быть спящим: отправляем в сторону, а если он так и не ответил —
  // показываем красную карточку, вместо тихого «ничего не поменялось»
  send({ type: MSG.SET_SETTINGS, patch }, 8000).then((res) => {
    if (!res?.ok) {
      swDead = true;
      renderSwError();
    }
  });
  renderChrome();
}

// ---------------- статические контролы ----------------

function bindStatic() {
  // импорт пользовательских PP-OCR моделей: ссылка на HuggingFace или файлы с диска
  on('ocr-hf-load', 'click', importFromHf);
  on('ocr-hf-url', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); importFromHf(); } });
  on('ocr-import-btn', 'click', () => $('ocr-import-file')?.click());
  on('ocr-import-file', 'change', (e) => importCustomOcrFiles([...e.target.files || []]).finally(() => { e.target.value = ''; }));
  on('ocr-import-dir-btn', 'click', () => $('ocr-import-dir')?.click());
  on('ocr-import-dir', 'change', (e) => importCustomOcrFiles([...e.target.files || []]).finally(() => { e.target.value = ''; }));

  // язык интерфейса
  on('ui-lang', 'change', (e) => patchSettings({ uiLang: e.target.value }));

  // вкладки
  on('tab-home', 'click', () => switchTab('home'));
  on('tab-config', 'click', () => switchTab('config'));

  // перезапуск расширения (карточка «фоновый процесс не отвечает»)
  on('sw-reload', 'click', () => {
    try { chrome.runtime.reload(); } catch (e) { /* noop */ }
  });

  // доступ к file:// URL
  on('file-access-btn', 'click', () => {
    try {
      chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
    } catch (e) { /* noop */ }
    const sub = $('file-access-sub');
    if (sub) {
      sub.className = 'card-sub';
      sub.textContent = t('fileAllowHint');
    }
  });

  // мастер-выключатель
  on('enabled', 'change', (e) => patchSettings({ enabled: e.target.checked }));

  // движок
  for (const btn of document.querySelectorAll('#engine-seg .seg-card')) {
    btn.addEventListener('click', () => patchSettings({ engine: btn.dataset.engine }));
  }

  // LLM поля
  on('llm-url', 'change', (e) => patchSettings({ llmBaseUrl: e.target.value.trim() }));
  on('llm-model', 'change', (e) => patchSettings({ llmModel: e.target.value.trim() }));
  on('llm-usekey', 'change', (e) => {
    patchSettings({ llmUseKey: e.target.checked });
    const key = $('llm-key');
    if (key) key.disabled = !e.target.checked;
  });
  on('llm-key', 'change', (e) => patchSettings({ llmApiKey: e.target.value.trim() }));
  on('llm-key-eye', 'click', () => {
    const inp = $('llm-key');
    if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  on('llm-temp', 'input', (e) => {
    const v = $('llm-temp-val');
    if (v) v.textContent = Number(e.target.value).toFixed(2);
  });
  on('llm-temp', 'change', (e) => patchSettings({ llmTemperature: Number(e.target.value) }));
  on('llm-custom-prompt', 'change', (e) => {
    e.target.value = e.target.value.trim();
    patchSettings({ llmCustomPrompt: e.target.value });
  });
  on('llm-test', 'click', testLlm);
  // Vision OCR: LLM с картинками сама читает и переводит
  on('llm-vision', 'change', (e) => patchSettings({ llmVision: e.target.checked }));

  // язык промпта
  for (const btn of document.querySelectorAll('#prompt-lang-seg button')) {
    btn.addEventListener('click', () => patchSettings({ promptLang: btn.dataset.v }));
  }

  // языки
  fillLangSelect($('src-lang'), true);
  fillLangSelect($('dst-lang'), false);
  on('src-lang', 'change', (e) => patchSettings({ sourceLang: e.target.value }));
  on('dst-lang', 'change', (e) => patchSettings({ targetLang: e.target.value }));
  on('swap-langs', 'click', () => {
    const s = settings.sourceLang === 'auto' ? 'en' : settings.sourceLang;
    const t = settings.targetLang;
    patchSettings({ sourceLang: t, targetLang: s === t ? 'en' : s });
  });

  // тумблеры home
  on('auto-translate', 'change', (e) => patchSettings({ autoTranslate: e.target.checked }));
  // «Склейка страниц» (v1.9.0): реплики, разрезанные краем страницы
  on('page-stitch', 'change', (e) => patchSettings({ pageStitch: e.target.checked }));
  // «Вне пузырей» удалено из UI в v1.8.1 — перевод вне пузырей всегда включён

  // перевести страницу
  on('translate-page', 'click', async () => {
    // «Остановить» (v1.10.0): во время задачи кнопка-инициатор в режиме стопа
    if ($('translate-page')?.dataset.stop === '1') { await send({ type: MSG.PAGE_JOB_STOP }); return; }
    if (uiLock) return;
    if (swDead) {
      const w = $('page-progress');
      if (w) w.classList.remove('hidden');
      setPageProgress({
        active: false,
        error: 'Нет связи с фоновым процессом. Нажми «Перезапустить расширение» в красной карточке выше.',
      });
      return;
    }
    uiLock = true;
    const btn = $('translate-page');
    if (btn) btn.disabled = true;
    const w = $('page-progress');
    if (w) w.classList.remove('hidden');
    setPageProgress({ active: true, done: 0, total: 0 });
    await send({ type: MSG.TRANSLATE_PAGE });
    // разблокировка произойдёт по PAGE_PROGRESS (finished) или через 90с
    setTimeout(() => { uiLock = false; const b = $('translate-page'); if (b) b.disabled = false; }, 90000);
  });

  // показать рамки детекции (отладка: без перевода, только где модель нашла текст)
  on('debug-page', 'click', async () => {
    if ($('debug-page')?.dataset.stop === '1') { await send({ type: MSG.PAGE_JOB_STOP }); return; }
    if (uiLock) return;
    if (swDead) {
      const w = $('page-progress');
      if (w) w.classList.remove('hidden');
      setPageProgress({
        active: false,
        error: 'Нет связи с фоновым процессом. Нажми «Перезапустить расширение» в красной карточке выше.',
      });
      return;
    }
    uiLock = true;
    const btn = $('debug-page');
    if (btn) btn.disabled = true;
    const w = $('page-progress');
    if (w) w.classList.remove('hidden');
    setPageProgress({ active: true, done: 0, total: 0 });
    await send({ type: MSG.TRANSLATE_PAGE, debug: true });
    // разблокировка произойдёт по PAGE_PROGRESS (finished) или через 120с
    setTimeout(() => { uiLock = false; const b = $('debug-page'); if (b) b.disabled = false; }, 120000);
  });

  // стереть перевод со страницы: убрать оверлеи, кэш и in-flight рендеры
  on('clear-page', 'click', async () => {
    if (swDead) {
      const w = $('page-progress');
      if (w) w.classList.remove('hidden');
      setPageProgress({
        active: false,
        error: 'Нет связи с фоновым процессом. Нажми «Перезапустить расширение» в красной карточке выше.',
      });
      return;
    }
    const res = await send({ type: MSG.CLEAR_TRANSLATIONS }, 8000);
    const w = $('page-progress');
    if (res?.ok) {
      const btn = $('clear-page');
      if (btn) {
        const html = btn.innerHTML; // textContent стёр бы иконку
        btn.textContent = t('cleared');
        setTimeout(() => { if ($('clear-page') === btn) btn.innerHTML = html; }, 1500);
      }
      if (w) w.classList.add('hidden');
    } else {
      // вкладка не отвечает даже после реинжекта: служебная страница,
      // file:// без разрешения или расширение только что перезагружалось
      if (w) {
        w.classList.remove('hidden');
        setPageProgress({
          active: false,
          error: t('tabUnreachable'),
        });
      }
    }
  });

  // «Загрузить всё и перевести» (v1.8.0): сначала виртуальный скролл страницы
  // заставляет сайт подгрузить дальние картинки, затем обычный перевод всего.
  on('load-all-page', 'click', async () => {
    if ($('load-all-page')?.dataset.stop === '1') { await send({ type: MSG.PAGE_JOB_STOP }); return; }
    if (uiLock) return;
    if (swDead) {
      const w = $('page-progress');
      if (w) w.classList.remove('hidden');
      setPageProgress({
        active: false,
        error: 'Нет связи с фоновым процессом. Нажми «Перезапустить расширение» в красной карточке выше.',
      });
      return;
    }
    uiLock = true;
    const btn = $('load-all-page');
    if (btn) btn.disabled = true;
    const w = $('page-progress');
    if (w) w.classList.remove('hidden');
    setPageProgress({ active: true, done: 0, total: 0 });
    await send({ type: MSG.TRANSLATE_PAGE, preload: true });
    // загрузка картинок + перевод — даём больше времени, чем обычному переводу
    setTimeout(() => { uiLock = false; const b = $('load-all-page'); if (b) b.disabled = false; }, 150000);
  });

  // чипы горячих клавиш: клик → режим записи сочетания (v1.8.0)
  for (const [id] of HK_BTNS) {
    on(id, 'click', () => {
      if (hkListening) { hkListening = null; hkRender(); }
      hkListening = { action: (HK_BTNS.find(([bid]) => bid === id) || [])[1] };
      hkRender();
    });
  }
  window.addEventListener('keydown', hkCapture, true);

  // confidence
  on('min-confidence', 'input', (e) => {
    const v = $('conf-val');
    if (v) v.textContent = `${Math.round(e.target.value * 100)}%`;
  });
  on('min-confidence', 'change', (e) => patchSettings({ minConfidence: Number(e.target.value) }));

  // режим вывода, цвет текста и размер шрифта
  for (const btn of document.querySelectorAll('#render-mode-seg button')) {
    btn.addEventListener('click', () => patchSettings({ renderMode: btn.dataset.v }));
  }
  for (const btn of document.querySelectorAll('#overlay-style-seg button')) {
    btn.addEventListener('click', () => patchSettings({ overlayStyle: btn.dataset.v }));
  }
  on('auto-text-color', 'change', (e) => patchSettings({ autoTextColor: e.target.checked }));
  for (const btn of document.querySelectorAll('#font-fit-seg button')) {
    btn.addEventListener('click', () => patchSettings({ fontFit: btn.dataset.v }));
  }
  on('font-size-fixed', 'change', (e) => {
    const v = Math.max(10, Math.min(48, Math.round(Number(e.target.value) || 18)));
    e.target.value = v;
    patchSettings({ fontSizeFixed: v });
  });
  on('peek-original', 'change', (e) => patchSettings({ showOriginalOnHover: e.target.checked }));

  // баннер
  on('warning-goto', 'click', () => switchTab('config'));

  // хранилище (удаление — двойным кликом: confirm() в popup ненадёжен)
  on('clear-models', 'click', async (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = t('clearModelsArmed');
      setTimeout(() => { btn.dataset.armed = ''; btn.dataset.i18nSkip = ''; btn.textContent = t('clearModels'); }, 3500);
      return;
    }
    btn.dataset.armed = '';
    btn.dataset.i18nSkip = ''; btn.textContent = t('clearModels');
    await send({ type: MSG.CLEAR_MODELS });
    await reloadState();
  });

  // модалка
  on('llm-help', 'click', () => $('help-modal')?.classList.remove('hidden'));
  document.querySelector('.modal-close')?.addEventListener('click', () => $('help-modal')?.classList.add('hidden'));
  $('help-modal')?.addEventListener('click', (e) => {
    if (e.target === $('help-modal')) $('help-modal').classList.add('hidden');
  });

  // прогресс из background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === MSG.MODEL_PROGRESS) onModelProgress(msg);
    if (msg?.type === MSG.PAGE_PROGRESS) setPageProgress(msg);
  });

  // обновление pageJob при открытии
  chrome.storage.local.get('pageJob', ({ pageJob }) => { if (pageJob) setPageProgress(pageJob); });
}

function switchTab(name) {
  $('tab-home')?.classList.toggle('active', name === 'home');
  $('tab-config')?.classList.toggle('active', name === 'config');
  $('view-home')?.classList.toggle('hidden', name !== 'home');
  $('view-config')?.classList.toggle('hidden', name !== 'config');
}

function fillLangSelect(sel, isSource) {
  if (!sel) return;
  sel.innerHTML = '';
  for (const [code, name] of Object.entries(LANGUAGES)) {
    if (!isSource && code === 'auto') continue;
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = name;
    sel.appendChild(opt);
  }
}

// ---------------- доступ к file:// URL ----------------

function checkFileAccess() {
  const sub = $('file-access-sub');
  if (!sub) return;
  try {
    if (typeof chrome.extension?.isAllowedFileSchemeAccess === 'function') {
      chrome.extension.isAllowedFileSchemeAccess((allowed) => updateFileAccessUi(!!allowed));
      return;
    }
  } catch (e) { /* API нет — показываем нейтральный статус */ }
  updateFileAccessUi(null);
}

function updateFileAccessUi(allowed) {
  const sub = $('file-access-sub');
  const btn = $('file-access-btn');
  if (!sub || !btn) return;
  if (allowed === true) {
    sub.className = 'card-sub ok-text';
    sub.textContent = t('fileOk');
    btn.textContent = t('fileBtnOpen');
  } else if (allowed === false) {
    sub.className = 'card-sub bad-text';
    sub.textContent = t('fileOff');
    btn.textContent = t('fileBtnAllow');
  } else {
    sub.className = 'card-sub';
    sub.textContent = t('fileUnknown');
    btn.textContent = 'Открыть настройки';
  }
}

// ---------------- горячие клавиши (v1.8.0) ----------------

const HK_BTNS = [
  ['hk-translatePage', 'translatePage'],
  ['hk-loadAll', 'loadAll'],
  ['hk-debugPage', 'debugPage'],
  ['hk-clearPage', 'clearPage'],
];
let hkListening = null; // { action } — чип ждёт сочетание от пользователя

/** Подписи чипов биндов: «—» / назначенное сочетание / «клавиши…» в режиме записи. */
function hkRender() {
  for (const [id, action] of HK_BTNS) {
    const b = $(id);
    if (!b) continue;
    const listening = hkListening?.action === action;
    const bind = settings?.hotkeys?.[action] || '';
    b.textContent = listening ? t('hkListening') : (bind || t('hkEmpty'));
    b.classList.toggle('listening', listening);
    b.classList.toggle('set', !listening && !!bind);
  }
}

function hkSave(action, combo) {
  const next = { ...(settings?.hotkeys || {}) };
  for (const k of Object.keys(next)) if (next[k] === combo) delete next[k]; // одно сочетание — одно действие
  if (combo) next[action] = combo;
  patchSettings({ hotkeys: next });
  hkRender();
}

/** Захват сочетания в popup (capture-фаза): Esc/Tab — отмена, чистый модификатор
 *  (без клавиши) игнорируется, занятое другим действием — короткая вспышка «занято».
 *  С v1.8.1 одиночные клавиши (R, F3, Space, цифры) тоже назначаются. */
const HK_MOD_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'ContextMenu']);
function hkCapture(e) {
  if (!hkListening) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape' || e.key === 'Tab') { hkListening = null; hkRender(); return; }
  if (HK_MOD_KEYS.has(e.key)) return; // зажат только модификатор — ждём саму клавишу
  const combo = formatCombo(e);
  if (!combo) return;
  const { action } = hkListening;
  hkListening = null;
  const taken = Object.entries(settings?.hotkeys || {}).find(([k, v]) => v === combo && k !== action);
  if (taken) {
    const b = $(`hk-${action}`);
    if (b) b.textContent = t('hkTaken'); // вспышка; реальный рендер вернёт подписи через мгновение
    setTimeout(hkRender, 1200);
    return;
  }
  hkSave(action, combo);
  // ясная обратная связь: чип мигает зелёным, чтобы было видно, что клавиша записалась
  const b = $(`hk-${action}`);
  if (b) {
    b.classList.add('just-set');
    setTimeout(() => b.classList.remove('just-set'), 1400);
  }
}

// ---------------- рендер ----------------

function renderAll() {
  renderChrome(); // включает и renderModelLists
  renderLlm();
  renderLangs();
  renderToggles();
  hkRender(); // подписи чипов горячих клавиш (v1.8.0)
}

/** Перерисовка «хрома»: классы/видимость. Безопасно звать после любого изменения настроек. */
function renderChrome() {
  applyUiLang();
  renderMaster();
  renderEngine();
  renderPromptLangSeg();
  renderDisplaySegs();
  renderStatus();
  renderWarning();
  renderSwError();
  // списки моделей тоже: после переключения активная карточка и её замыкания
  // должны обновиться сразу (регрессия v1.5.0: бейдж двигался раз, дальше
  // строки жили со старыми isActive/downloaded и клики «не работали»)
  renderModelLists();
}

function renderMaster() {
  const el = $('enabled');
  if (el) el.checked = !!settings.enabled;
  const sub = $('master-sub');
  if (sub) {
    sub.textContent = settings.enabled
      ? (settings.engine === 'llm' ? t('masterOnLlm') : t('masterOnGoogle'))
      : t('masterOff');
  }
  document.querySelector('.master')?.classList.toggle('on', !!settings.enabled);
}

function renderEngine() {
  for (const btn of document.querySelectorAll('#engine-seg .seg-card')) {
    btn.classList.toggle('selected', btn.dataset.engine === settings.engine);
  }
  // карточка настроек LLM показывается при выборе API Mode
  $('llm-settings')?.classList.toggle('hidden', settings.engine !== 'llm');
}

function renderPromptLangSeg() {
  for (const btn of document.querySelectorAll('#prompt-lang-seg button')) {
    btn.classList.toggle('selected', btn.dataset.v === settings.promptLang);
  }
}

function renderDisplaySegs() {
  for (const btn of document.querySelectorAll('#render-mode-seg button')) {
    btn.classList.toggle('selected', btn.dataset.v === settings.renderMode);
  }
  for (const btn of document.querySelectorAll('#overlay-style-seg button')) {
    btn.classList.toggle('selected', btn.dataset.v === settings.overlayStyle);
  }
  for (const btn of document.querySelectorAll('#font-fit-seg button')) {
    btn.classList.toggle('selected', btn.dataset.v === settings.fontFit);
  }
  const fontSizeInput = $('font-size-fixed');
  if (fontSizeInput) {
    fontSizeInput.value = Number(settings.fontSizeFixed) || 18;
    fontSizeInput.disabled = settings.fontFit !== 'fixed';
  }
  // автоцвет активен только в режиме «Стирать текст»; пока он активен,
  // ручной выбор цвета приглушён (им цвет не задаётся)
  const autoOn = settings.renderMode === 'inpaint' && settings.autoTextColor !== false;
  $('auto-color-card')?.classList.toggle('disabled', settings.renderMode !== 'inpaint');
  $('overlay-style-card')?.classList.toggle('disabled', autoOn);
  const autoCb = $('auto-text-color');
  if (autoCb) autoCb.checked = settings.autoTextColor !== false;
}

/** Красная карточка «фоновый процесс не отвечает». */
function renderSwError() {
  const el = $('sw-error');
  if (el) el.classList.toggle('hidden', !swDead);
}

/** Обновить подсветку «активна» на карточках моделей без полной перерисовки. */
// активность подсвечивается полной перерисовкой списков в renderChrome
// (renderModelSelection удалён: менял бейджи на строках со старыми замыканиями)

function renderLlm() {
  const url = $('llm-url'), model = $('llm-model'), useKey = $('llm-usekey'),
    key = $('llm-key'), temp = $('llm-temp'), tempVal = $('llm-temp-val');
  if (url) url.value = settings.llmBaseUrl || '';
  if (model) model.value = settings.llmModel || '';
  if (useKey) useKey.checked = !!settings.llmUseKey;
  if (key) { key.value = settings.llmApiKey || ''; key.disabled = !settings.llmUseKey; }
  if (temp) temp.value = settings.llmTemperature;
  if (tempVal) tempVal.textContent = Number(settings.llmTemperature).toFixed(2);
  const customPrompt = $('llm-custom-prompt');
  // не затираем текст, пока пользователь печатает в поле
  if (customPrompt && document.activeElement !== customPrompt) customPrompt.value = settings.llmCustomPrompt || '';
  renderVision();
  renderPromptLangSeg();
}

/** Тумблер Vision OCR: галочка, пояснение и подпись движка в сегменте. */
function renderVision() {
  const on = !!settings.llmVision;
  const cb = $('llm-vision');
  if (cb) cb.checked = on;
  const hint = $('vision-hint');
  if (hint) hint.classList.toggle('hidden', !on);
  const sub = $('engine-llm-sub');
  if (sub) sub.textContent = on ? t('engineLlmVisionSub') : t('engineLlmSub');
}

function renderLangs() {
  const s = $('src-lang'), t = $('dst-lang');
  if (s) s.value = settings.sourceLang;
  if (t) t.value = settings.targetLang;
}

function renderToggles() {
  const auto = $('auto-translate'), free = $('free-text'), conf = $('min-confidence'),
    confVal = $('conf-val'), peek = $('peek-original'), stitch = $('page-stitch');
  if (auto) auto.checked = !!settings.autoTranslate;
  if (stitch) stitch.checked = !!settings.pageStitch;
  if (free) free.checked = !!settings.translateFreeText;
  if (conf) conf.value = settings.minConfidence;
  if (confVal) confVal.textContent = `${Math.round(settings.minConfidence * 100)}%`;
  if (peek) peek.checked = !!settings.showOriginalOnHover;
  renderDisplaySegs();
}

// ---------------- баннеры ----------------

function renderWarning() {
  const banner = $('warning-banner');
  const text = $('warning-text');
  if (!banner || !text || !state?.catalog) return;
  const detOk = state.downloaded[settings.detectorModel];
  const customList = state.customOcr || [];
  const customEntry = isCustomOcrId(settings.ocrModel)
    ? customList.find(e => `custom:${e.id}` === settings.ocrModel)
    : null;
  // Vision OCR: распознаёт LLM с картинками — OCR-модель не требуется,
  // важен только детектор пузырей
  if (settings.engine === 'llm' && settings.llmVision) {
    if (detOk) {
      banner.classList.add('hidden');
    } else {
      text.textContent = t('warnMissing', { list: t('missingDetector') });
      banner.classList.remove('hidden');
    }
    return;
  }
  // кастомная модель уже лежит в IndexedDB — «скачана» по определению
  const ocrOk = customEntry ? customEntry.hasRec : state.downloaded[settings.ocrModel];
  // rec-only кастомной модели нужен встроенный детектор строк; v1.6.2 фон
  // докачает его сам при первом переводе — предупреждаем, чтобы не surprise
  const lineDetOk = !customEntry || customEntry.hasDet || !!state.downloaded['ppocrv5-mobile'];
  if (detOk && ocrOk && lineDetOk) {
    banner.classList.add('hidden');
    return;
  }
  const missing = [];
  if (!detOk) missing.push(t('missingDetector'));
  if (!ocrOk) missing.push('OCR');
  if (!missing.length && !lineDetOk) {
    text.textContent = t('warnLineDet');
    banner.classList.remove('hidden');
    return;
  }
  text.textContent = t('warnMissing', { list: missing.join(t('joinAnd')) });
  banner.classList.remove('hidden');
}

// ---------------- импорт кастомных OCR (PP-OCR) ----------------

const CUSTOM_ERR_KEYS = {
  NOT_ZIP: 'customOcrErrNotZip', NO_REC: 'customOcrErrNoRec', NO_DICT: 'customOcrErrNoDict',
  BAD_ONNX: 'customOcrErrBadOnnx', BAD_META: 'customOcrErrBadMeta',
};

function importStatus(ok, text) {
  const out = $('ocr-import-status');
  if (!out) return;
  out.classList.remove('hidden', 'ok', 'err');
  out.classList.add(ok ? 'ok' : 'err');
  out.textContent = text;
}

/** Общий хвост всех способов импорта: файлы в кэш, запись в индекс фона, выбор модели. */
async function finishCustomImport(entry, fileBuffers) {
  // v1.6.3: число строк словаря — в карточке модели; по нему сразу видно,
  // что dict.txt не от этой rec (например, 100 строк у словаря на канзи)
  const dictBuf = fileBuffers['dict.txt'];
  if (dictBuf) {
    entry.dictLines = decodeDict(new Uint8Array(dictBuf)).split(/\r?\n/).filter(l => l !== '').length;
  }
  await putCustomOcrFiles(entry.id, fileBuffers);
  const res = await send({ type: MSG.OCR_IMPORT_REGISTER, entry: { ...entry, files: undefined } }, 10000);
  if (!res?.ok) {
    importStatus(false, `✗ ${res?.error === 'timeout' ? t('swDeadShort') : escapeHtml(res?.error || t('noAnswer'))}`);
    return false;
  }
  patchSettings({ ocrModel: `custom:${res.entry.id}` });
  await reloadState();
  importStatus(true, t('customOcrOk', { name: res.entry.name }));
  return true;
}

async function importCustomOcrZips(files) {
  if (!files.length) return;
  for (const file of files) {
    importStatus(true, t('customOcrImporting', { name: file.name }));
    try {
      const parsed = await parseCustomOcrZip(await file.arrayBuffer(), file.name);
      if (!parsed.ok) {
        importStatus(false, `✗ ${t(CUSTOM_ERR_KEYS[parsed.code] || 'customOcrErrNotZip')}${parsed.message ? ` (${escapeHtml(parsed.message)})` : ''}`);
        continue;
      }
      const { det, rec, dict, meta } = parsed.entry.files;
      await finishCustomImport(parsed.entry, {
        ...(det ? { 'det.onnx': det } : {}),
        'rec.onnx': rec,
        'dict.txt': new TextEncoder().encode(dict).buffer,
        ...(meta ? { 'meta.json': meta } : {}),
      });
    } catch (err) {
      importStatus(false, `✗ ${escapeHtml(String(err?.message || err))}`);
    }
  }
}

/**
 * Локальные файлы БЕЗ архивирования: достаточно выбрать rec.onnx + dict.txt
 * (det.onnx и meta.json — по желанию). Один ZIP тоже принимается (старый путь),
 * и можно выбрать ЦЕЛУЮ ПАПКУ с моделью — из неё берём только нужные файлы.
 */
async function importCustomOcrFiles(files) {
  if (!files.length) return;
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) return importCustomOcrZips(files);
  // выбрана папка (webkitRelativePath непуст) — читаем только подходящие файлы,
  // чтобы не грузить в память тяжёлые .pth/.pdmodel из репозитория
  const fromDir = files.some(f => f.webkitRelativePath);
  const wanted = fromDir
    ? files.filter(f => {
        const n = f.name.toLowerCase();
        return /\.onnx$/.test(n)
          || (/\.txt$/.test(n) && /(dict|keys|vocab|char)/.test(n))
          || /^meta\.json$/i.test(n)
          || /\.ya?ml$/.test(n); // inference.yml — словарь и высота входа внутри
      })
    : files;
  if (!wanted.length) {
    importStatus(false, `✗ ${t('customOcrMultiNoRec')}`);
    return;
  }
  const sources = [];
  for (const f of wanted) sources.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
  importStatus(true, t('customOcrImporting', { name: sources.map(s => s.name).join(', ').slice(0, 60) }));
  await importOcrSources(sources, fromDir ? (wanted[0].webkitRelativePath.split('/')[0] || 'Custom OCR') : 'Custom OCR');
}

/** Сборка+валидация набора файлов и регистрация (общая для диска и HuggingFace). */
async function importOcrSources(sources, fallbackName) {
  const built = buildOcrEntry(sources, fallbackName);
  if (!built.ok) {
    importStatus(false, `✗ ${t(CUSTOM_ERR_KEYS[built.code] || 'customOcrErrNotZip')}${built.message ? ` (${escapeHtml(built.message)})` : ''}`);
    return;
  }
  try {
    await finishCustomImport(built.entry, built.files);
  } catch (err) {
    // без этого catch ошибка записи (например, недоступна IndexedDB) оставляла
    // статус «Импортирование…» висеть навсегда
    importStatus(false, `✗ ${escapeHtml(String(err?.message || err))}`);
  }
}

// --- импорт с HuggingFace: ссылка на репозиторий или прямой файл ---

let hfStage = null; // набор файлов, собранный прямыми ссылками: { owner, repo, sources: [{name, data}] }

function hfStageHas(name) {
  return !!(hfStage && hfStage.sources.some(s => s.name === name));
}

function updateHfStageStatus() {
  if (!hfStage) return;
  const missing = [];
  if (!hfStageHas('rec.onnx')) missing.push(t('customOcrNeedRec'));
  if (!hfStageHas('dict.txt')) missing.push(t('customOcrNeedDict'));
  importStatus(true, t('customOcrHfStaged', {
    list: hfStage.sources.map(s => s.name).join(', ') || '—',
    missing: missing.join(' '),
  }));
}

async function hfDownload(owner, repo, path, name) {
  return downloadHfFile(fetch, owner, repo, path, {
    onProgress: (received, total) => {
      const frac = total ? received / total : 0;
      const mb = (received / 1048576).toFixed(frac && frac < 0.1 ? 1 : 0);
      importStatus(true, t('customOcrHfDl', { name, mb }));
    },
  });
}

async function importFromHf() {
  const input = $('ocr-hf-url');
  const url = (input?.value || '').trim();
  if (!url) return;
  hideHfPicker(); // новый запрос — прошлый выбор больше не актуален
  const target = parseHfTarget(url);
  if (!target) {
    importStatus(false, `✗ ${t('customOcrHfNoFiles')}`);
    return;
  }
  const repoId = `${target.owner}/${target.repo}`;
  try {
    if (target.kind === 'file') {
      // прямая ссылка на файл — докладываем в набор (для репозиториев, где
      // авто-выбор не сработал: несколько rec, словари на несколько языков)
      const label = hfBasename(target.path);
      const lower = label.toLowerCase();
      let name = null;
      if (/\.onnx$/i.test(label)) name = /rec/.test(lower) ? 'rec.onnx' : (/det/.test(lower) ? 'det.onnx' : null);
      else if (/\.txt$/i.test(label)) name = 'dict.txt';
      else if (/^meta\.json$/i.test(label)) name = 'meta.json';
      if (!name) {
        importStatus(false, `✗ ${t('customOcrUnknownFile', { name: label })}`);
        return;
      }
      importStatus(true, t('customOcrHfListing', { repo: repoId }));
      const bytes = await hfDownload(target.owner, target.repo, target.path, name);
      hfStage ??= { owner: target.owner, repo: target.repo, sources: [] };
      hfStage.sources = hfStage.sources.filter(s => s.name !== name);
      hfStage.sources.push({ name, data: bytes });
      updateHfStageStatus();
      if (hfStageHas('rec.onnx') && hfStageHas('dict.txt')) {
        const stage = hfStage;
        hfStage = null;
        await importOcrSources(stage.sources, stage.repo);
      }
      return;
    }
    // ссылка на репозиторий: читаем список файлов, выбираем нужные, качаем
    importStatus(true, t('customOcrHfListing', { repo: repoId }));
    const list = await listHfRepoFiles(fetch, target.owner, target.repo);
    const pick = pickOcrFiles(list);
    if (!pick.rec || !pick.dict) {
      // несколько rec или несколько словарей — окно ручного выбора пары
      if (pick.recCandidates.length > 1 || pick.dictCandidates.length > 1) {
        renderHfPicker(target.owner, target.repo, pick);
        importStatus(true, t('customOcrHfListing', { repo: repoId }));
      } else {
        importStatus(false, `✗ ${t('customOcrHfNoFiles')}`);
      }
      return;
    }
    const plan = [
      ['rec.onnx', pick.rec],
      ['dict.txt', pick.dict],
      ...(pick.det ? [['det.onnx', pick.det]] : []),
      ...(pick.meta ? [['meta.json', pick.meta]] : []),
    ];
    const sources = [];
    for (const [name, f] of plan) {
      sources.push({ name, data: await hfDownload(target.owner, target.repo, f.path, name) });
    }
    await importOcrSources(sources, target.repo);
  } catch (e) {
    importStatus(false, `✗ ${e?.code === 'HF_NOT_FOUND'
      ? t('customOcrHfNotFound', { repo: repoId })
      : t('customOcrHfNet', { err: String(e?.message || e).slice(0, 120) })}`);
  }
}

// --- окно выбора пары файлов из репозитория (когда моделей несколько) ---

let hfPick = null; // { owner, repo } репозиторий, показанный в окне выбора

function hideHfPicker() {
  hfPick = null;
  const box = $('ocr-hf-pick');
  if (box) {
    box.innerHTML = '';
    box.classList.add('hidden');
  }
}

function renderHfPicker(owner, repo, pick) {
  const box = $('ocr-hf-pick');
  if (!box) return;
  hfPick = { owner, repo };
  const recGroup = pick.recCandidates.length ? pick.recCandidates : pick.onnxAll;
  const detGroup = pick.onnxAll.filter(p => /det/i.test(hfBasename(p)) && !/rec/i.test(hfBasename(p)));
  // словарь: *.txt со словарными именами; к ним добавляем *.yml — в inference.yml
  // новых экспортов PaddleOCR (PP-OCRv3+) словарь встроен внутрь (character_dict)
  const dictGroup = [...new Set([...(pick.dictCandidates || []), ...(pick.ymlAll || [])])];
  const dictFinal = dictGroup.length ? dictGroup : pick.txtAll;
  const groupHtml = (labelKey, paths, radioName, withNone) => `
    <div class="hf-pick-group">
      <div class="hf-pick-label">${escapeHtml(t(labelKey))}</div>
      ${withNone ? `<label class="hf-pick-item"><input type="radio" name="${radioName}" value="" checked> ${escapeHtml(t('customOcrPickDetNone'))}</label>` : ''}
      ${paths.map((p, i) => `<label class="hf-pick-item"><input type="radio" name="${radioName}" value="${escapeHtml(p)}"${!withNone && i === 0 ? ' checked' : ''}> ${escapeHtml(hfBasename(p))}</label>`).join('')}
      ${!paths.length && !withNone ? '<div class="hf-pick-empty">—</div>' : ''}
    </div>`;
  box.innerHTML = `
    <div class="hf-pick-title">${escapeHtml(t('customOcrPickTitle'))}</div>
    ${groupHtml('customOcrPickRec', recGroup, 'hf-rec')}
    ${groupHtml('customOcrPickDet', detGroup, 'hf-det', true)}
    ${groupHtml('customOcrPickDict', dictFinal, 'hf-dict')}
    <button id="ocr-hf-pick-btn" class="wide-btn">${escapeHtml(t('customOcrPickBtn'))}</button>`;
  box.classList.remove('hidden');
  $('ocr-hf-pick-btn')?.addEventListener('click', downloadHfPicked);
}

async function downloadHfPicked() {
  if (!hfPick) return;
  const val = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value || '';
  const rec = val('hf-rec'), dict = val('hf-dict'), det = val('hf-det');
  if (!rec || !dict) {
    importStatus(false, `✗ ${t('customOcrHfNoFiles')}`);
    return;
  }
  const { owner, repo } = hfPick;
  try {
    // имена файлов НЕ переиначиваем: buildOcrEntry определяет роли по имени,
    // inference.yml должен остаться .yml (словарь достанется из него)
    const plan = [rec, dict, ...(det ? [det] : [])];
    const sources = [];
    for (const path of plan) {
      sources.push({ name: hfBasename(path), data: await hfDownload(owner, repo, path, hfBasename(path)) });
    }
    hideHfPicker();
    await importOcrSources(sources, repo);
  } catch (e) {
    importStatus(false, `✗ ${e?.code === 'HF_NOT_FOUND'
      ? t('customOcrHfNotFound', { repo: `${owner}/${repo}` })
      : t('customOcrHfNet', { err: String(e?.message || e).slice(0, 120) })}`);
  }
}

// ---------------- модели ----------------

function renderModelLists() {
  if (!state?.catalog) return;
  const dl = state.downloads || {};
  renderModelGroup($('detector-list'), state.catalog.detectors, settings.detectorModel, dl);
  const customModels = (state.customOcr || []).map(e => ({
    id: `custom:${e.id}`,
    customEntryId: e.id,
    custom: true,
    kind: 'ocr',
    engine: 'ppocr',
    label: e.name,
    description: `${e.hasDet ? 'det ✓' : t('customNoDet')} · rec ✓${e.recHeight ? ` · ${e.recHeight}px` : ''}${e.dictLines ? ` · ${t('customDictLines', { n: e.dictLines })}` : ''}`,
    sizeMB: e.sizeMB || 0,
  }));
  renderModelGroup($('ocr-list'), [...state.catalog.ocr, ...customModels], settings.ocrModel, dl);
}

function renderModelGroup(container, models, activeId, dl) {
  if (!container) return;
  container.innerHTML = '';
  for (const m of models) {
    container.appendChild(modelRow(m, m.id === activeId, dl[m.id] || {}));
  }
}

const ICONS = {
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M4 19h16"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5L19.5 7"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/></svg>',
  retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>',
};

/**
 * Карточка модели: клик по карточке = сделать активной (если скачана),
 * иконка справа = установить / удалить с подсветкой состояния.
 */
function modelRow(m, isActive, dlState) {
  const downloaded = m.custom || !!state.downloaded[m.id];
  const row = document.createElement('div');
  row.className = 'model-row';
  row.dataset.id = m.id;

  let statusHtml, iconClass, iconSvg, iconTitle, iconAction;
  if (dlState.status === 'downloading') {
    const pct = dlState.total ? Math.round((dlState.received / dlState.total) * 100) : 0;
    statusHtml = `<div class="model-status dl">⬇ Скачивается… ${pct}% (${fmtMB(dlState.received)} / ${fmtMB(dlState.total)})</div>`;
    iconClass = 'downloading';
    iconSvg = ICONS.download;
    iconTitle = 'Скачивается…';
    iconAction = null;
  } else if (dlState.status === 'error') {
    statusHtml = `<div class="model-status err">${escapeHtml(t('dlError', { err: dlState.error || t('dlFailShort') }))}</div>`;
    iconClass = 'error';
    iconSvg = ICONS.retry;
    iconTitle = 'Повторить загрузку';
    iconAction = 'download';
  } else if (downloaded) {
    statusHtml = `<div class="model-status ok">${t('statusInstalled', { mb: m.sizeMB.toFixed(1) })}</div>`;
    iconClass = 'installed';
    iconSvg = ICONS.check;
    iconTitle = m.custom ? t('iconArmedTitle') : t('iconInstalledTitle');
    iconAction = 'delete';
  } else {
    statusHtml = `<div class="model-status">${t('notInstalled', { mb: m.sizeMB.toFixed(1) })}</div>`;
    iconClass = 'idle';
    iconSvg = ICONS.download;
    iconTitle = t('iconDownloadTitle', { mb: m.sizeMB.toFixed(0) });
    iconAction = 'download';
  }

  row.innerHTML = `
    <div class="model-info">
      <div class="model-name">${escapeHtml(m.label)}
        <span class="active-badge${isActive ? '' : ' hidden'}">${t('badgeActive')}</span>
      </div>
      <div class="model-desc">${escapeHtml(m.description || '')}</div>
      ${statusHtml}
    </div>
    <button class="model-icon ${iconClass}" title="${iconTitle}">${iconSvg}</button>
    <div class="row-bar"><div class="fill"></div></div>`;

  if (isActive) row.classList.add('selected');
  if (!downloaded && dlState.status !== 'downloading') row.classList.add('not-ready');

  // прогресс-полоса
  if (dlState.status === 'downloading' && dlState.total) {
    row.querySelector('.row-bar .fill').style.width = `${Math.min(100, (dlState.received / dlState.total) * 100)}%`;
  }

  // клик по карточке (не по иконке) = сделать активной.
  // Состояние читаем СВЕЖИМ из settings/state на момент клика, а не из
  // замыкания: после первого переключения isActive/downloaded в замыкании
  // уже врут, пока строки не перерисуются.
  row.addEventListener('click', (e) => {
    if (e.target.closest('.model-icon')) return;
    const downloadedNow = m.custom || !!state.downloaded?.[m.id];
    const activeNow = m.kind === 'detector' ? settings.detectorModel === m.id : settings.ocrModel === m.id;
    const dlNow = (state.downloads || {})[m.id]?.status;
    if (!downloadedNow || activeNow || dlNow === 'downloading') return;
    patchSettings(m.kind === 'detector' ? { detectorModel: m.id } : { ocrModel: m.id });
  });

  // иконка = установить/удалить
  const iconBtn = row.querySelector('.model-icon');
  const rowStatus = () => row.querySelector('.model-status');
  if (iconAction === 'download') {
    iconBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      iconBtn.classList.remove('idle', 'error');
      iconBtn.classList.add('downloading');
      const st = rowStatus();
      if (st) { st.className = 'model-status dl'; st.textContent = t('dlStarting'); }
      const res = await send({ type: MSG.DOWNLOAD_MODEL, id: m.id }, 10000);
      if (!res?.ok) {
        // фоновый процесс не ответил — показываем ошибку прямо на карточке
        iconBtn.classList.remove('downloading');
        iconBtn.classList.add('error');
        iconBtn.innerHTML = ICONS.retry;
        const st2 = rowStatus();
        if (st2) {
          st2.className = 'model-status err';
          st2.textContent = t('dlFailStart', { err: res?.error === 'timeout' ? t('swDeadShort') : escapeHtml(res?.error || t('noAnswer')) });
        }
        return;
      }
      // фон отвечает мгновенно, скачивание идёт в фоне; состояние строки
      // обновляется событиями MODEL_PROGRESS, через полсекунды — синхронизация
      setTimeout(reloadState, 500);
    });
  } else if (iconAction === 'delete') {
    iconBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // двойное нажатие: первое — «точно удалить?», второе — удаление
      if (iconBtn.dataset.armed !== '1') {
        iconBtn.dataset.armed = '1';
        iconBtn.classList.add('armed');
        iconBtn.innerHTML = ICONS.trash;
        iconBtn.title = t('iconArmedTitle');
        setTimeout(() => {
          if (!iconBtn.isConnected) return;
          iconBtn.dataset.armed = '';
          iconBtn.classList.remove('armed');
          iconBtn.innerHTML = ICONS.check;
          iconBtn.title = t('iconInstalledTitle');
        }, 3000);
        return;
      }
      if (m.custom) await send({ type: MSG.OCR_DELETE_CUSTOM, id: m.customEntryId });
      else await send({ type: MSG.DELETE_MODEL, id: m.id });
      await reloadState();
    });
  }
  return row;
}

function onModelProgress(msg) {
  const row = document.querySelector(`.model-row[data-id="${msg.id}"]`);
  if (!row) return;
  if (msg.status === 'downloading') {
    const pct = msg.total ? Math.min(100, Math.round((msg.received / msg.total) * 100)) : 0;
    const status = row.querySelector('.model-status');
    if (status) {
      status.className = 'model-status dl';
      status.textContent = t('dlProgress', { pct, got: fmtMB(msg.received), total: fmtMB(msg.total) });
    }
    const fill = row.querySelector('.row-bar .fill');
    if (fill) fill.style.width = `${Math.max(3, pct)}%`;
  } else {
    reloadState();
  }
}

async function reloadState() {
  const res = await send({ type: MSG.GET_STATE });
  if (res?.ok && res.state?.catalog) {
    state = res.state;
    swDead = false;
    if (res.state.settings) settings = res.state.settings;
  } else if (swDead && state) {
    state.catalog = MODEL_CATALOG; // держим локальный каталог
  }
  renderModelLists();
  renderStatus();
  renderWarning();
  renderSwError();
  refreshStorage();
}

async function refreshStorage() {
  const el = $('storage-usage');
  if (!el) return;
  if (swDead) {
    el.textContent = t('swDead');
    return;
  }
  const res = await send({ type: MSG.GET_STATE });
  if (res?.ok) {
    state = res.state;
    const u = res.state.usage;
    if (el) el.textContent = t('storageUsage', { used: fmtMBv(u.usageMB), quota: fmtMBv(u.quotaMB) });
  }
}

function renderStatus() {
  const el = $('models-status');
  if (!el) return;
  if (!state?.catalog) { el.innerHTML = `<div class="card-sub">${t('loading')}</div>`; return; }
  // v1.6.2: кастомная OCR — имя из индекса, статус по факту импорта
  // (раньше здесь было «OCR ()» и красное «Не скачан» для рабочей модели)
  const customEntry = isCustomOcrId(settings.ocrModel)
    ? (state.customOcr || []).find(e => `custom:${e.id}` === settings.ocrModel)
    : null;
  const ocr = customEntry ? null : state.catalog.ocr.find(m => m.id === settings.ocrModel);
  const ocrLabel = customEntry ? customEntry.name : ocr?.label;
  const detOk = state.downloaded[settings.detectorModel];
  const ocrOk = customEntry ? !!customEntry.hasRec : state.downloaded[settings.ocrModel];
  // rec-only кастомная модель работает через встроенный детектор строк
  const lineDetPending = !!customEntry && !customEntry.hasDet && !state.downloaded['ppocrv5-mobile'];
  // v1.7.1 Vision OCR: распознаёт LLM с картинками — OCR-модель не нужна,
  // строка всегда зелёная (иначе «Не скачан» выглядит как сломанный режим)
  const visionMode = settings.engine === 'llm' && !!settings.llmVision;
  const dot = ok => (ok ? '<span class="dot ok"></span>Готов' : '<span class="dot bad"></span>Не скачан');
  el.innerHTML = `
    <div class="status-row">
      <span class="status-name">Детектор</span>
      <span>${dot(detOk)}</span>
    </div>
    ${visionMode ? `
    <div class="status-row">
      <span class="status-name">Vision OCR</span>
      <span>${dot(true)}</span>
    </div>` : `
    <div class="status-row">
      <span class="status-name">OCR (${escapeHtml(ocrLabel || '')})</span>
      <span>${dot(ocrOk)}</span>
    </div>`}
    ${(!visionMode && lineDetPending) ? `
    <div class="status-row">
      <span class="status-name">Детектор строк (PP-OCRv5 Mobile)</span>
      <span>${dot(false)}</span>
    </div>` : ''}
    ${(!detOk || (!visionMode && !ocrOk) || (!visionMode && lineDetPending)) ? '<a class="status-link" id="goto-config">→ Скачать модели в Config</a>' : ''}`;
  const link = $('goto-config');
  if (link) link.addEventListener('click', () => switchTab('config'));
}

// ---------------- LLM тест ----------------

async function testLlm() {
  const btn = $('llm-test');
  const out = $('llm-test-result');
  if (!btn || !out) return;
  btn.disabled = true;
  btn.textContent = t('llmTestingBtn');
  out.classList.remove('hidden', 'ok', 'err');
  out.textContent = t('llmConnecting');
  const res = await send({ type: MSG.TEST_LLM }, 25000);
  btn.disabled = false;
  btn.textContent = t('llmTest');
  if (!res?.ok) {
    out.classList.add('err');
    out.textContent = `✗ ${res?.error || t('llmFailDefault')}`;
    return;
  }
  const list = $('llm-models');
  if (list) {
    list.innerHTML = '';
    for (const m of res.models || []) {
      const opt = document.createElement('option');
      opt.value = m;
      list.appendChild(opt);
    }
  }
  if (!settings.llmModel && res.models?.length) {
    settings.llmModel = res.models[0];
    const modelInput = $('llm-model');
    if (modelInput) modelInput.value = settings.llmModel;
    send({ type: MSG.SET_SETTINGS, patch: { llmModel: settings.llmModel } });
  }
  if (res.warn) {
    out.classList.add('err');
    out.textContent = `✗ ${res.warn}`;
    return;
  }
  out.classList.add('ok');
  out.textContent = t('llmOk', { n: res.models?.length || 0, sample: res.sample?.slice(0, 120) || '—' });
}

// ---------------- прогресс страницы ----------------

/** Кнопка в режим «Остановить» и обратно (v1.10.0). */
function setBtnStop(id, on) {
  const btn = $(id);
  if (!btn) return;
  if (on) {
    if (btn.dataset.stop === '1') return;
    btn.dataset.mtlLabel = btn.textContent;
    btn.dataset.stop = '1';
    btn.textContent = t('stopBtn');
    btn.disabled = false; // клик теперь не запуск, а остановка
  } else {
    if (btn.dataset.stop === '1') {
      btn.textContent = btn.dataset.mtlLabel || btn.textContent;
      delete btn.dataset.stop;
      delete btn.dataset.mtlLabel;
    }
    btn.disabled = false;
  }
}

function setPageProgress(job) {
  const wrap = $('page-progress');
  const fill = $('page-fill');
  const text = $('page-text');
  if (!wrap || !fill || !text) return;
  if (job?.active) {
    wrap.classList.remove('hidden');
    const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
    fill.style.width = `${Math.max(4, pct)}%`;
    text.textContent = job.debug
      ? (job.total ? t('pageDetect', { done: job.done, total: job.total, pct }) : t('pageDetectCollect'))
      : (job.total ? t('pageTrans', { done: job.done, total: job.total, pct }) : t('pageCollect'));
    // кнопка-инициатор задачи превращается в «Остановить»
    setBtnStop('translate-page', job.kind === 'translate');
    setBtnStop('load-all-page', job.kind === 'loadAll');
    setBtnStop('debug-page', job.kind === 'debug');
  } else {
    if (job?.error) {
      wrap.classList.remove('hidden');
      fill.style.width = '100%';
      fill.style.background = 'var(--err)';
      text.textContent = job.error;
      setTimeout(() => { fill.style.background = ''; wrap.classList.add('hidden'); }, 10000);
    } else if (job?.stopped) {
      // «Остановлено: N / M» — ненадолго, затем полоса прячется
      wrap.classList.remove('hidden');
      fill.style.width = '100%';
      text.textContent = t('pageStopped', { done: job.done || 0, total: job.total || 0 });
      setTimeout(() => { wrap.classList.add('hidden'); }, 6000);
    } else {
      wrap.classList.add('hidden');
    }
    uiLock = false;
    setBtnStop('translate-page', false);
    setBtnStop('load-all-page', false);
    setBtnStop('debug-page', false);
  }
}

function restorePageProgress() {
  chrome.storage.local.get('pageJob', ({ pageJob }) => {
    if (pageJob) setPageProgress(pageJob);
  });
}

// ---------------- утилиты ----------------

function fmtMB(bytes) {
  const mb = bytes / 1024 / 1024;
  return mb >= 10 ? `${mb.toFixed(0)} MB` : `${mb.toFixed(1)} MB`;
}

/** Формат значения, которое УЖЕ в мегабайтах (fmtMB ждёт байты — раньше
 *  из-за двойного деления «Занято» всегда показывало 0.0 MB). */
function fmtMBv(mb) {
  return mb >= 10 ? `${mb.toFixed(0)} MB` : `${mb.toFixed(1)} MB`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();
