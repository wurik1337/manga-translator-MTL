// content.js — работает на странице: находит изображения, дёргает пайплайн через
// background, рисует оверлеи с переводом. Self-contained IIFE (content script не умеет ES-модули).

(() => {
  'use strict';

  if (window.__mtlContentLoaded) return;
  window.__mtlContentLoaded = true;

  // --- константы (копия protocol.js; import в content script недоступен) ---
  const M = {
    GET_SETTINGS: 'GET_SETTINGS',
    SET_SETTINGS: 'SET_SETTINGS',
    TRANSLATE_IMAGE: 'TRANSLATE_IMAGE',
    TRANSLATE_PAGE: 'TRANSLATE_PAGE',
    CLEAR_TRANSLATIONS: 'CLEAR_TRANSLATIONS', // v1.3.0: «Стереть перевод» из popup
    PAGE_PROGRESS_REPORT: 'PAGE_PROGRESS_REPORT',
    FETCH_IMAGE: 'FETCH_IMAGE',
  };

  const IS_TOP = window === window.top;
  const MAX_EXTRACT = 2200;      // совпадает с MAX_IMAGE_SIDE в pipeline.js
  const MIN_IMG_SIZE = 160;      // меньшие изображения пропускаем (иконки, баннеры)

  let settings = null;
  const state = new WeakMap();   // element → { status, overlay, natW, natH }
  const resultCache = new Map(); // src → items (последние 60)
  let pill = null;
  let renderGen = 0; // +1 при «Стереть перевод»: отменяет in-flight рендеры
  let observer = null;
  let collecting = null;

  // ---------------- утилиты ----------------

  function send(msg, timeoutMs = 120000) {
    return new Promise((resolve) => {
      // таймаут: если канал умер (SW убит и т.п.) — не висим вечно
      const t = setTimeout(() => resolve({ ok: false, error: 'Превышено время ожидания (2 мин)' }), timeoutMs);
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          clearTimeout(t);
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res);
        });
      } catch (e) {
        // «Extension context invalidated» бросается синхронно, если расширение перезапустили
        clearTimeout(t);
        resolve({ ok: false, error: String(e?.message || e) });
      }
    });
  }

  // ---------------- «расширение перезапустилось» ----------------

  let ctxDead = false; // однажды потерянный контекст не восстанавливается без F5

  // RGBA → base64 (порциями, чтобы не упереться в лимит аргументов Function.apply)
  function rgbaToB64(data) {
    const u8 = (data instanceof Uint8ClampedArray || data instanceof Uint8Array)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
    }
    return btoa(s);
  }

  function isCtxDead(err) {
    return /extension context invalidated|context invalidated|disconnected port|message port closed/i.test(String(err?.message || err));
  }

  function showCtxBanner() {
    if (ctxDead) return;
    ctxDead = true;
    const b = document.createElement('div');
    b.id = 'mtl-ctx-banner';
    b.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;' +
      'background:#16131f;color:#fda4af;border:1px solid #f8717188;border-radius:12px;padding:12px 18px;' +
      'font:600 14px/1.45 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5);' +
      'max-width:min(92vw,560px);text-align:center;cursor:pointer;pointer-events:auto';
    b.textContent = 'Расширение перезапустилось — контекст устарел. Перезагрузи страницу (F5), чтобы переводить дальше.';
    b.title = 'Клик убирает плашку';
    b.addEventListener('click', () => b.remove());
    (document.documentElement || document.body).appendChild(b);
    setTimeout(() => b.remove(), 30_000);
  }

  function injectStyles() {
    if (document.getElementById('mtl-styles')) return;
    const st = document.createElement('style');
    st.id = 'mtl-styles';
    st.textContent = `
.mtl-overlay{position:absolute;pointer-events:none;z-index:2147483000;contain:layout style}
.mtl-box{position:absolute;display:flex;align-items:center;justify-content:center;text-align:center;
  border-radius:12px;padding:2px 6px;line-height:1.12;overflow:hidden;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;word-break:break-word;
  transition:opacity .15s ease;box-sizing:border-box}
.mtl-box.mtl-light{background:rgba(255,255,255,.96);color:#101014;box-shadow:0 0 0 1px rgba(0,0,0,.25)}
.mtl-box.mtl-dark{background:rgba(18,16,24,.95);color:#f2f0f6;box-shadow:0 0 0 1px rgba(255,255,255,.18)}
.mtl-box.mtl-peek{opacity:0}
.mtl-box.mtl-fallback{color:#666;opacity:.92;font-style:italic}
.mtl-badge{position:absolute;transform:translate(-50%,-50%);width:auto;max-width:96%;
  padding:5px 10px;border-radius:9px;line-height:1.2;text-align:center;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;word-break:break-word;
  box-shadow:0 2px 8px rgba(0,0,0,.35);transition:opacity .15s ease;box-sizing:border-box}
.mtl-badge.mtl-light{background:rgba(255,255,255,.9);color:#101014;border:1px solid rgba(0,0,0,.2)}
.mtl-badge.mtl-dark{background:rgba(18,16,24,.9);color:#f2f0f6;border:1px solid rgba(255,255,255,.2)}
.mtl-badge.mtl-peek{opacity:0}
.mtl-pill{position:absolute;z-index:2147483001;display:flex;align-items:center;gap:6px;
  background:#16131f;color:#22d3ee;border:1px solid #22d3ee88;border-radius:999px;
  padding:6px 12px;font:600 13px/1 system-ui,-apple-system,sans-serif;cursor:pointer;
  pointer-events:auto;box-shadow:0 2px 10px rgba(0,0,0,.45);user-select:none;white-space:nowrap}
.mtl-pill:hover{background:#1d1930}
.mtl-pill svg{width:14px;height:14px;flex:none}
.mtl-spinner{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.mtl-spinner::after{content:"";width:30px;height:30px;border-radius:50%;
  border:3px solid rgba(34,211,238,.25);border-top-color:#22d3ee;animation:mtlspin .8s linear infinite}
@keyframes mtlspin{to{transform:rotate(360deg)}}
.mtl-error{position:absolute;left:50%;top:8px;transform:translateX(-50%);
  background:#2b1216;color:#fda4af;border:1px solid #f8717155;border-radius:8px;
  padding:4px 10px;font:600 12px/1.3 system-ui,sans-serif;white-space:nowrap;max-width:100%;
  overflow:hidden;text-overflow:ellipsis}
.mtl-debug-box{position:absolute;border:2px solid #22d3ee;border-radius:3px;cursor:crosshair;
  pointer-events:auto;background:rgba(34,211,238,.06);
  box-shadow:0 0 0 1px rgba(0,0,0,.55), inset 0 0 0 1px rgba(0,0,0,.35)}
.mtl-debug-box.mtl-debug-free{border-color:#fbbf24;background:rgba(251,191,36,.06)}
.mtl-debug-box:hover{background:rgba(34,211,238,.17);border-color:#a5f3fc}
.mtl-debug-box.mtl-debug-free:hover{border-color:#fde68a;background:rgba(251,191,36,.17)}
.mtl-debug-tip{display:none;position:absolute;left:0;top:calc(100% + 4px);z-index:2147483002;
  max-width:320px;padding:6px 9px;border-radius:7px;background:#0e1220f6;color:#e6edf7;
  border:1px solid #22d3ee77;font:500 12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;
  white-space:pre-wrap;word-break:break-word;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.55)}
.mtl-debug-tip .mtl-dk{color:#67e8f9;font-weight:700}
.mtl-debug-box.mtl-debug-free .mtl-debug-tip{border-color:#fbbf2477}
.mtl-debug-box.mtl-debug-free .mtl-dk{color:#fde68a}
.mtl-debug-box.flip .mtl-debug-tip{top:auto;bottom:calc(100% + 4px)}
.mtl-debug-box:hover .mtl-debug-tip{display:block}
.mtl-debug-badge{position:absolute;top:6px;left:6px;display:flex;align-items:center;gap:6px;
  padding:5px 6px 5px 10px;border-radius:999px;background:#0e1220e8;color:#93e9f7;
  border:1px solid #22d3ee66;font:600 12px/1.2 system-ui,sans-serif;pointer-events:auto;z-index:2147483003}
.mtl-debug-badge .mtl-debug-close{background:none;border:none;color:#fda4af;cursor:pointer;
  font:700 13px/1 system-ui,sans-serif;padding:2px 7px;border-radius:999px}
.mtl-debug-badge .mtl-debug-close:hover{background:#fda4af22}
.mtl-pill-frame{display:inline-flex;align-items:center;justify-content:center;
  border-left:1px solid #22d3ee44;padding:2px 2px 2px 9px;margin-left:3px;color:#93e9f7}
.mtl-pill-frame:hover{color:#fff}
.mtl-pill-frame svg{width:14px;height:14px}
.mtl-canvas{position:absolute;left:0;top:0;width:100%;height:100%;
  transition:opacity .15s ease;image-rendering:auto}
.mtl-overlay.mtl-peeking .mtl-canvas{opacity:0}
`;
    document.documentElement.appendChild(st);
  }

  // ---------------- сбор целей ----------------

  function isCandidateImg(img) {
    if (!(img instanceof HTMLImageElement)) return false;
    if (!img.src && !img.currentSrc) return false;
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || 0;
    if (w < MIN_IMG_SIZE || h < MIN_IMG_SIZE) return false;
    const r = img.getBoundingClientRect();
    if (r.width < 80 || r.height < 80) return false;
    return true;
  }

  function bgCandidates() {
    const out = [];
    for (const el of document.querySelectorAll('div,section,a,span,td')) {
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg && bg !== 'none' ? bg.match(/url\(["']?(.*?)["']?\)/) : null;
      if (!m) continue;
      const r = el.getBoundingClientRect();
      if (r.width >= MIN_IMG_SIZE && r.height >= MIN_IMG_SIZE) {
        el.__mtlBgUrl = m[1];
        out.push(el);
      }
    }
    return out;
  }

  function collectTargets(includeBg = false) {
    const imgs = [...document.images].filter(isCandidateImg);
    // фоновые изображения сканируем только когда обычных картинок нет (дорого по getComputedStyle)
    if (imgs.length && !includeBg) return imgs;
    return [...imgs, ...(includeBg ? bgCandidates() : [])];
  }

  // ---------------- извлечение пикселей ----------------

  function bitmapToImageData(bitmap) {
    let w = bitmap.width, h = bitmap.height;
    const long = Math.max(w, h);
    const k = long > MAX_EXTRACT ? MAX_EXTRACT / long : 1;
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  function imgToImageData(img) {
    let w = img.naturalWidth, h = img.naturalHeight;
    const long = Math.max(w, h);
    const k = long > MAX_EXTRACT ? MAX_EXTRACT / long : 1;
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  function waitForLoad(img, timeout = 10000) {
    if (img.complete && img.naturalWidth) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, timeout);
      function done() { clearTimeout(t); img.removeEventListener('load', done); img.removeEventListener('error', done); resolve(); }
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    });
  }

  async function extractImageData(el) {
    if (el instanceof HTMLImageElement) {
      await waitForLoad(el);
      try {
        return imgToImageData(el); // same-origin / data: / CORS — быстро
      } catch (e) { /* tainted canvas — идём дальше по лестнице */ }
      const src = el.currentSrc || el.src;
      // попытка №2: перезагрузить картинку с crossorigin=anonymous — если CDN
      // разрешает CORS, canvas становится читаемым без скачивания байтов
      const cross = await loadCrossOrigin(src);
      if (cross) {
        try { return imgToImageData(cross); } catch (e) { /* нет CORS — дальше */ }
      }
      // попытка №3: фон качает байты и отдаёт base64 (проходит через любой канал)
      const res = await send({ type: M.FETCH_IMAGE, url: src });
      if (!res?.ok) throw new Error(res?.error || 'Не удалось загрузить изображение');
      const bmp = await decodeBlob(b64ToBlob(res.b64, res.mime || 'image/png'));
      return bitmapToImageData(bmp);
    }
    // background-image
    const res = await send({ type: M.FETCH_IMAGE, url: el.__mtlBgUrl });
    if (!res?.ok) throw new Error(res?.error || 'Не удалось загрузить фон');
    const bmp = await decodeBlob(b64ToBlob(res.b64, res.mime || 'image/png'));
    return bitmapToImageData(bmp);
  }

  /** Картинка с crossorigin=anonymous; null, если CDN не отдал CORS-заголовки. */
  function loadCrossOrigin(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const t = setTimeout(() => { cleanup(); resolve(null); }, 12000);
      function ok() { cleanup(); resolve(img.naturalWidth ? img : null); }
      function bad() { cleanup(); resolve(null); }
      function cleanup() { clearTimeout(t); img.removeEventListener('load', ok); img.removeEventListener('error', bad); }
      img.addEventListener('load', ok, { once: true });
      img.addEventListener('error', bad, { once: true });
      img.src = src;
    });
  }

  function b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  /** Декодирование с запасным путём: createImageBitmap → <img> + objectURL. */
  async function decodeBlob(blob) {
    try {
      return await createImageBitmap(blob);
    } catch (e) { /* некоторые форматы bitmap API не берёт — пробуем <img> */ }
    const objUrl = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = objUrl;
      await waitForLoad(img, 15000);
      if (!img.naturalWidth) throw new Error('Изображение пустое или повреждено');
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
    }
  }

  // ---------------- оверлеи ----------------

  function ensureOverlay(el) {
    const st = state.get(el) || {};
    if (st.overlay && st.overlay.isConnected) return st.overlay;
    const o = document.createElement('div');
    o.className = 'mtl-overlay';
    document.body.appendChild(o);
    st.overlay = o;
    state.set(el, st);
    positionOverlay(el);
    return o;
  }

  function positionOverlay(el) {
    const st = state.get(el);
    if (!st?.overlay) return;
    const r = el.getBoundingClientRect();
    const o = st.overlay;
    o.style.left = `${r.left + window.scrollX}px`;
    o.style.top = `${r.top + window.scrollY}px`;
    o.style.width = `${r.width}px`;
    o.style.height = `${r.height}px`;
  }

  function refreshAllOverlays() {
    for (const el of knownTargets()) positionOverlay(el);
  }

  const allTargetsSet = new Set();
  function track(el) {
    allTargetsSet.add(el);
    if (allTargetsSet.size > 400) { // не копим бесконечно
      const it = allTargetsSet.values().next().value;
      const st = state.get(it);
      if (st?.status === 'done' || st?.status === 'error') allTargetsSet.delete(it);
    }
  }
  function knownTargets() { return [...allTargetsSet]; }

  function clearOverlayContent(el) {
    const st = state.get(el);
    if (st?.overlay) st.overlay.replaceChildren();
  }

  function showSpinner(el) {
    const o = ensureOverlay(el);
    clearOverlayContent(el);
    const sp = document.createElement('div');
    sp.className = 'mtl-spinner';
    o.appendChild(sp);
  }

  function showError(el, message) {
    const o = ensureOverlay(el);
    clearOverlayContent(el);
    const e = document.createElement('div');
    e.className = 'mtl-error';
    e.textContent = message;
    e.title = message;
    o.appendChild(e);
    setTimeout(() => { if (e.isConnected) e.remove(); }, 8000);
  }

  function fitText(box, text) {
    // текст ставится всегда и до измерений — иначе плашка останется пустой
    box.textContent = text;
    const w = box.clientWidth, h = box.clientHeight;
    if (!w || !h) return; // элемент ещё не в DOM — вызывать после appendChild
    // фиксированный кегль: пишем одинаково везде, но не даём вылезти за рамку
    const fixed = settings?.fontFit === 'fixed' ? Math.max(6, Number(settings.fontSizeFixed) || 18) : null;
    let lo = 8, hi = fixed ?? Math.max(10, Math.min(44, h * 0.85));
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      box.style.fontSize = `${mid}px`;
      const over = box.scrollHeight > h + 2 || box.scrollWidth > w + 2;
      if (over) hi = mid; else lo = mid;
    }
    box.style.fontSize = `${lo}px`;
  }

  // ---------------- режим «Стирать текст» ----------------

  const measureCtx = document.createElement('canvas').getContext('2d');

  function b64ToImageData(b64, w, h) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new ImageData(new Uint8ClampedArray(u8.buffer), w, h);
  }

  /** Очищенная картинка + переводы, нарисованные прямо в пузырях. */
  function renderInpaintText(el, items, natW, natH) {
    const st = state.get(el);
    if (!st?.cleanImageData || st.cleanImageData.width !== natW || st.cleanImageData.height !== natH) return false;
    if (!self.MTLTextLayout) return false; // старый content script без textlayout — фолбэк на плашки

    const o = ensureOverlay(el);
    clearOverlayContent(el);
    const canvas = document.createElement('canvas');
    canvas.className = 'mtl-canvas';
    canvas.width = natW;
    canvas.height = natH;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(st.cleanImageData, 0, 0);

    const measure = self.MTLTextLayout.canvasMeasure(measureCtx);
    // автоцвет — только в режиме «Стирать текст»: цвет каждого блока
    // выбирается по яркости очищенного фона под ним (дешёвая сетка по
    // уже посчитанному cleanImageData); не получилось — ручной цвет
    const autoColor = settings?.renderMode === 'inpaint' && settings?.autoTextColor !== false;
    const manualColor = settings?.overlayStyle === 'dark' ? '#f2f0f6' : '#111111';
    for (const it of items) {
      const text = it.translation || it.text;
      if (!text || !text.trim()) continue;
      // drawBox — тесный интерьер пузыря (offscreen считает его по очищенной
      // картинке); если его нет — обычный бокс детекции
      const b = (it.drawBox || it.box || []).map(Math.round);
      if (b.length !== 4 || b[2] - b[0] < 8 || b[3] - b[1] < 8) continue;
      self.MTLTextLayout.drawTextBlock(ctx, text, b, {
        fontFit: settings?.fontFit === 'fixed' ? 'fixed' : 'auto',
        fontSizeFixed: Number(settings?.fontSizeFixed) || 18,
        color: (autoColor && self.MTLTextLayout.pickTextColor(st.cleanImageData, b)) || manualColor,
        measure,
        min: 8,
        max: 72,
        shape: it.kind === 'free' ? 'rect' : 'ellipse',
      });
    }
    o.appendChild(canvas);

    // «показать оригинал при наведении»: канвас прозрачный, под ним исходная картинка
    if (settings?.showOriginalOnHover && !el.__mtlPeekBound) {
      el.__mtlPeekBound = true;
      el.addEventListener('mouseenter', () => {
        const s = state.get(el);
        s?.overlay?.classList.add('mtl-peeking');
      });
      el.addEventListener('mouseleave', () => {
        const s = state.get(el);
        s?.overlay?.classList.remove('mtl-peeking');
      });
    }
    positionOverlay(el);
    return true;
  }

  /** Динамический кегль бейджа: текст вписывается в рамку (96% ширины блока,
   *  до 1.6 его высоты) — как в режиме «Стирать текст». «Фикс.» — единый
   *  кегль везде, но с безопасным ужиманием, если текст не влезает. */
  function fitBadgeText(box, text, regionW, regionH) {
    box.textContent = text;
    if (!box.isConnected) return;
    const maxW = Math.max(40, regionW * 0.96);
    const maxH = Math.max(16, regionH * 1.6);
    const fixed = settings?.fontFit === 'fixed' ? Math.max(6, Number(settings.fontSizeFixed) || 18) : null;
    let lo = 9, hi = fixed ?? Math.max(11, Math.min(40, regionH * 0.6));
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      box.style.fontSize = `${mid}px`;
      const over = box.scrollHeight > maxH + 2 || box.scrollWidth > maxW + 2;
      if (over) hi = mid; else lo = mid;
    }
    box.style.fontSize = `${lo}px`;
  }

  function renderResults(el, items, natW, natH) {
    // основной режим: очищенная от текста картинка + текст в пузырях
    if (settings?.renderMode !== 'badge' && renderInpaintText(el, items, natW, natH)) return;

    const o = ensureOverlay(el);
    clearOverlayContent(el);
    const badgeMode = settings?.renderMode === 'badge';
    const overlayH = o.clientHeight || natH;
    for (const it of items) {
      const [x0, y0, x1, y1] = it.box;
      const text = it.translation || it.text;
      const theme = settings?.overlayStyle === 'dark' ? 'mtl-dark' : 'mtl-light';

      if (badgeMode) {
        // компактная рамка по центру блока: оригинал остаётся виден вокруг
        const box = document.createElement('div');
        box.className = `mtl-badge ${theme}${it.translation ? '' : ' mtl-fallback'}`;
        box.style.left = `${(((x0 + x1) / 2) / natW) * 100}%`;
        box.style.top = `${(((y0 + y1) / 2) / natH) * 100}%`;
        box.style.maxWidth = `${Math.max(30, ((x1 - x0) / natW) * 96)}%`;
        if (settings?.showOriginalOnHover) {
          box.addEventListener('mouseenter', () => box.classList.add('mtl-peek'));
          box.addEventListener('mouseleave', () => box.classList.remove('mtl-peek'));
        }
        o.appendChild(box);
        // динамический кегль: вписываем текст в рамку, когда бейдж уже в DOM
        const regionDisplayW = ((x1 - x0) / natW) * (o.clientWidth || natW);
        const regionDisplayH = ((y1 - y0) / natH) * overlayH;
        fitBadgeText(box, text, regionDisplayW, regionDisplayH);
        continue;
      }

      // перекраска: плашка занимает весь блок текста
      const box = document.createElement('div');
      box.className = `mtl-box ${theme}`;
      box.style.left = `${(x0 / natW) * 100}%`;
      box.style.top = `${(y0 / natH) * 100}%`;
      box.style.width = `${((x1 - x0) / natW) * 100}%`;
      box.style.height = `${((y1 - y0) / natH) * 100}%`;
      if (!it.translation) box.classList.add('mtl-fallback');
      if (settings?.showOriginalOnHover) {
        box.addEventListener('mouseenter', () => box.classList.add('mtl-peek'));
        box.addEventListener('mouseleave', () => box.classList.remove('mtl-peek'));
      }
      o.appendChild(box);
      // подбор кегля — когда плашка уже в DOM: clientWidth/Height реальные
      fitText(box, text);
    }
    positionOverlay(el);
  }

  /** Отладка детекции: рамки там, где модель нашла текст; наведение — что распознала OCR. */
  function renderDebugBoxes(el, items, natW, natH) {
    const o = ensureOverlay(el);
    clearOverlayContent(el);
    const KIND = { bubble: 'пузырь', free: 'текст вне пузыря' };
    const badge = document.createElement('div');
    badge.className = 'mtl-debug-badge';
    badge.innerHTML = `<span>Отладка детекции: ${items.length} блок(ов)</span>`;
    const close = document.createElement('button');
    close.className = 'mtl-debug-close';
    close.textContent = '✕';
    close.title = 'Убрать рамки';
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      clearOverlayContent(el);
      const st = state.get(el) || {};
      st.status = undefined;
      state.set(el, st);
    });
    badge.appendChild(close);
    o.appendChild(badge);

    for (const it of items) {
      const [x0, y0, x1, y1] = it.box || [];
      if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) continue;
      const box = document.createElement('div');
      box.className = `mtl-debug-box${it.kind === 'free' ? ' mtl-debug-free' : ''}`;
      box.style.left = `${(x0 / natW) * 100}%`;
      box.style.top = `${(y0 / natH) * 100}%`;
      box.style.width = `${((x1 - x0) / natW) * 100}%`;
      box.style.height = `${((y1 - y0) / natH) * 100}%`;
      if ((y0 / natH) > 0.6) box.classList.add('flip'); // тултип вверх, чтобы не уходил за край

      const tip = document.createElement('div');
      tip.className = 'mtl-debug-tip';
      const kindName = KIND[it.kind] || it.kind || 'блок';
      const score = typeof it.score === 'number' ? ` · ${Math.round(it.score * 100)}%` : '';
      const label = document.createElement('span');
      label.className = 'mtl-dk';
      label.textContent = `[${kindName}${score}] `;
      tip.appendChild(label);
      tip.appendChild(document.createTextNode(it.text && it.text.trim() ? it.text : 'текст не распознан'));
      box.appendChild(tip);
      o.appendChild(box);
    }
    positionOverlay(el);
  }

  // ---------------- обработка цели ----------------

  async function processTarget(el, { force = false, debug = false } = {}) {
    const st = state.get(el) || {};
    if (st.status === 'processing') return;
    if (st.status === 'done' && !force && !debug) return;

    if (!(el instanceof HTMLImageElement) && !el.__mtlBgUrl) return;
    if (el instanceof HTMLImageElement && !isCandidateImg(el)) return;

    const gen = renderGen; // если по пути нажали «Стереть перевод» — не рендерим
    st.status = 'processing';
    state.set(el, st);
    track(el);
    showSpinner(el);

    try {
      const src = el instanceof HTMLImageElement ? (el.currentSrc || el.src) : el.__mtlBgUrl;
      const cacheKey = (debug ? 'DBG:' : '') + src;
      let items = null, natW = 0, natH = 0;

      if (!force) {
        // в отладке можно показать уже отсканированное: сначала её кэш, затем кэш перевода
        // (у переведённых картинок рамки рисуются мгновенно, без повторной детекции)
        const cached = debug ? (resultCache.get(cacheKey) || resultCache.get(src)) : resultCache.get(cacheKey);
        if (cached) ({ items, natW, natH } = cached);
      }

      if (!items) {
        const imageData = await extractImageData(el);
        natW = imageData.width;
        natH = imageData.height;
        const res = await send({
          type: M.TRANSLATE_IMAGE,
          debug: !!debug,
          // пиксели — base64: typed array при передаче через runtime-каналы
          // превращается в обычный объект и ломает .subarray в offscreen
          image: {
            width: imageData.width,
            height: imageData.height,
            rgbaB64: rgbaToB64(imageData.data),
          },
        });
        if (!res?.ok) {
          if (res?.error !== 'NOT_DOWNLOADED') throw new Error(res?.error || 'Ошибка');
          // v1.6.2: фон присылает missingLabels — названия конкретных моделей
          const labels = (res.missingLabels || []).join(', ');
          throw new Error(labels ? `Модели не скачаны: ${labels} (см. Config)` : 'Модели не скачаны (см. Config)');
        }
        items = res.items || [];
        // режим «Стирать текст»: offscreen возвращает очищенную от текста картинку
        st.cleanImageData = null;
        if (res.image?.rgbaB64 && res.image.width && res.image.height) {
          try { st.cleanImageData = b64ToImageData(res.image.rgbaB64, res.image.width, res.image.height); }
          catch (e) { /* без очищенной картинки рисуем плашки */ }
        }
        if (cacheKey && resultCache.size > 60) resultCache.delete(resultCache.keys().next().value);
        resultCache.set(cacheKey, { items, natW, natH });
      }

      const st2 = state.get(el) || {};
      st2.natW = natW; st2.natH = natH;
      if (gen !== renderGen) return; // переводы стёрли, пока конвейер работал
      if (debug) {
        st2.status = 'debug';
        state.set(el, st2);
        renderDebugBoxes(el, items, natW, natH);
        return;
      }
      st2.status = 'done';
      state.set(el, st2);
      if (!items.length) {
        clearOverlayContent(el);
        return;
      }
      renderResults(el, items, natW, natH);
    } catch (e) {
      const st3 = state.get(el) || {};
      st3.status = 'error';
      state.set(el, st3);
      if (isCtxDead(e)) { clearOverlayContent(el); showCtxBanner(); return; } // без тостов на каждой картинке
      showError(el, String(e?.message || e).slice(0, 120));
    }
  }

  // ---------------- hover-pill ----------------

  function ensurePill() {
    if (pill && pill.isConnected) return pill;
    pill = document.createElement('div');
    pill.className = 'mtl-pill';
    pill.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 5h16M4 5v9a2 2 0 0 0 2 2h6l4 4v-4h2a2 2 0 0 0 2-2V5"/></svg><span>Перевести</span><span class="mtl-pill-frame" title="Показать рамки детекции (без перевода): где модель нашла текст и что распознала OCR"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M2 9h2M2 15h2M20 9h2M20 15h2M9 2v2M15 2v2M9 20v2M15 20v2"/></svg></span>`;
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = pill.__mtlTarget;
      if (el) processTarget(el, { force: true });
      pill.remove();
      pill = null;
    });
    pill.querySelector('.mtl-pill-frame').addEventListener('click', (e) => {
      e.stopPropagation();
      const el = pill.__mtlTarget;
      if (el) processTarget(el, { debug: true }); // без force — кэш приоритетнее
      pill.remove();
      pill = null;
    });
    document.body.appendChild(pill);
    return pill;
  }

  let hoverRaf = 0;
  document.addEventListener('mouseover', (e) => {
    if (!settings?.enabled) return;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      const el = e.target instanceof HTMLImageElement ? e.target : null;
      if (!el || !isCandidateImg(el)) return;
      const st = state.get(el);
      if (st?.status === 'done' || st?.status === 'processing') return;
      if (settings.autoTranslate) return; // и так переведётся автоматически
      const p = ensurePill();
      p.__mtlTarget = el;
      const r = el.getBoundingClientRect();
      p.style.left = `${r.left + window.scrollX + r.width - 165}px`;
      p.style.top = `${Math.max(2, r.top + window.scrollY + 8)}px`;
    });
  }, { passive: true });

  document.addEventListener('scroll', () => {
    if (pill) { pill.remove(); pill = null; }
  }, { passive: true, capture: true });

  // ---------------- авто-перевод видимого ----------------

  function ensureObserver() {
    if (observer) return observer;
    observer = new IntersectionObserver((entries) => {
      if (!settings?.enabled || !settings?.autoTranslate) return;
      for (const en of entries) {
        if (en.isIntersecting && en.intersectionRatio >= 0.4) {
          observer.unobserve(en.target);
          processTarget(en.target);
        }
      }
    }, { threshold: [0.4] });
    return observer;
  }

  function observeNew() {
    if (!settings?.enabled) return;
    const obs = ensureObserver();
    for (const el of collectTargets()) {
      const st = state.get(el);
      if (!st || (st.status !== 'done' && st.status !== 'processing' && st.status !== 'error')) {
        obs.observe(el);
      }
      track(el);
    }
  }

  // ---------------- перевод всей страницы ----------------

  function reportProgress(payload) {
    if (!IS_TOP) return; // репортит только верхний фрейм
    send({ type: M.PAGE_PROGRESS_REPORT, ...payload });
  }

  async function forceLoad(img) {
    img.loading = 'eager';
    if (!img.src && img.dataset.src) img.src = img.dataset.src;
    if (!img.src && img.getAttribute('data-original')) img.src = img.getAttribute('data-original');
    await waitForLoad(img, 12000);
  }

  let pageJobRunning = false;
  async function translateAllPage(debug = false) {
    if (pageJobRunning) return;
    pageJobRunning = true;
    try {
      reportProgress({ done: 0, total: 0 });
      const targets = collectTargets(false);
      // форсируем ленивую загрузку и ждём
      const imgs = targets.filter(t => t instanceof HTMLImageElement);
      await Promise.all(imgs.map(forceLoad));
      const ready = collectTargets(true); // после загрузки список мог вырасти (+ фоны)
      const total = ready.length;
      let done = 0;
      for (const el of ready) {
        if (ctxDead) break; // расширение перезапустилось — дальше идти бессмысленно
        try {
          // force=false: уже отсканированное (в кэше) показывается мгновенно,
          // детекция запускается только для картинок, которых в кэше нет
          await processTarget(el, { force: false, debug });
        } catch (e) { /* продолжаем */ }
        done++;
        reportProgress({ done, total, debug });
      }
      reportProgress({ done, total, finished: true, debug });
    } finally {
      pageJobRunning = false;
    }
  }

  // ---------------- реакция на команды/настройки ----------------

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type === M.TRANSLATE_PAGE) {
      translateAllPage(!!msg.debug);
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === M.CLEAR_TRANSLATIONS) {
      clearAllTranslations();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  /** «Стереть перевод»: убрать все оверлеи (вместе со спиннерами и ошибками),
   *  кэш и состояние; отменить in-flight рендеры. Автоперевод может снова
   *  нарисовать — это штатно. */
  function clearAllTranslations() {
    renderGen++;
    resultCache.clear();
    if (pill) { pill.remove(); pill = null; }
    for (const el of knownTargets()) {
      const st = state.get(el);
      if (st?.overlay) { st.overlay.remove(); st.overlay = null; }
      state.delete(el);
    }
  }

  async function reloadSettings() {
    const res = await send({ type: M.GET_SETTINGS });
    if (res?.ok) {
      settings = res.settings;
      applyEnabledState();
    }
  }

  function applyEnabledState() {
    injectStyles();
    if (!settings?.enabled) {
      observer?.disconnect();
      for (const el of knownTargets()) {
        const st = state.get(el);
        if (st?.overlay) { st.overlay.remove(); st.overlay = null; st.status = undefined; }
      }
      if (pill) { pill.remove(); pill = null; }
      return;
    }
    observeNew();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      const prev = settings || {};
      settings = { ...(settings || {}), ...changes.settings.newValue };
      applyEnabledState();
      // смена режима вывода/стиля/размера текста — перерисовываем готовые оверлеи из кэша
      if (
        settings.enabled && (
          prev.renderMode !== settings.renderMode ||
          prev.overlayStyle !== settings.overlayStyle ||
          prev.autoTextColor !== settings.autoTextColor ||
          prev.showOriginalOnHover !== settings.showOriginalOnHover ||
          prev.fontFit !== settings.fontFit ||
          prev.fontSizeFixed !== settings.fontSizeFixed
        )
      ) rerenderDone();
    }
  });

  function rerenderDone() {
    for (const el of knownTargets()) {
      const st = state.get(el);
      if (st?.status !== 'done' || !st.overlay?.isConnected) continue;
      const src = el instanceof HTMLImageElement ? (el.currentSrc || el.src) : el.__mtlBgUrl;
      const cached = src && resultCache.get(src);
      if (cached?.items?.length) renderResults(el, cached.items, cached.natW, cached.natH);
    }
  }

  // периодический пересбор целей (сайты манги подгружают страницы динамически)
  function scheduleCollect() {
    if (collecting) clearTimeout(collecting);
    collecting = setTimeout(() => {
      collecting = null;
      if (settings?.enabled) observeNew();
      scheduleCollect();
    }, 2500);
  }

  // перепозиционирование при resize/scroll (rAF-throttle)
  let rafPos = 0;
  function onReflow() {
    if (rafPos) return;
    rafPos = requestAnimationFrame(() => {
      rafPos = 0;
      refreshAllOverlays();
    });
  }
  window.addEventListener('resize', onReflow, { passive: true });
  window.addEventListener('scroll', onReflow, { passive: true, capture: true });

  // старт
  reloadSettings().then(() => scheduleCollect());
})();
