// textlayout.js — вёрстка переведённого текста в области пузыря (классический
// скрипт для content script'а: ES-модули там недоступны). Определяет
// globalThis.MTLTextLayout. Чистые функции — тестируются в Node через vm.
//
// Перенос: слова латиницы не рвутся, CJK — по символам, сверхдлинные токены
// жёстко разрываются. Автоподбор размера: бинарный поиск максимального
// кегля, при котором перенесённый текст влезает в бокс. Фиксированный
// размер: пишем заданным кеглем, но если не влезает — ужимаем (чтобы
// текст не вылезал за пузырь), минимум min.
(() => {
  'use strict';

  const FONT_STACK = '"Comic Sans MS","Comic Neue","Segoe Print","Segoe UI",system-ui,sans-serif';
  const DEFAULT_LINE_HEIGHT = 1.16;

  function isCJKChar(ch) {
    const c = ch.codePointAt(0);
    return (
      (c >= 0x2e80 && c <= 0x9fff) ||   // CJK-радикалы, иероглифы, кана
      (c >= 0xf900 && c <= 0xfaff) ||   // CJK-совместимость
      (c >= 0x3000 && c <= 0x303f) ||   // CJK-пунктуация
      (c >= 0xff66 && c <= 0xff9f)      // полуширинная кана
    );
  }

  /** Токены для переноса: слова латиницы целиком, CJK — по символам. */
  function tokenize(text) {
    const tokens = [];
    let word = '';
    const flush = () => { if (word) { tokens.push(word); word = ''; } };
    for (const ch of String(text ?? '')) {
      if (ch === ' ' || ch === '\u00a0' || ch === '\t' || ch === '\n') { flush(); continue; }
      if (isCJKChar(ch)) { flush(); tokens.push(ch); continue; }
      word += ch;
    }
    flush();
    return tokens;
  }

  function hardBreak(token, maxW, measure, size) {
    const lines = [];
    let piece = '';
    for (const ch of token) {
      const cand = piece + ch;
      if (piece && measure(cand, size) > maxW) { lines.push(piece); piece = ch; }
      else piece = cand;
    }
    if (piece) lines.push(piece);
    return lines;
  }

  /**
   * Перенос текста на строки шириной ≤ maxW при кегле size.
   * measure(token, size) → ширина токена в пикселях.
   */
  function wrapText(text, maxW, size, measure) {
    const tokens = tokenize(text);
    const lines = [];
    let cur = '';
    for (const tok of tokens) {
      const candidate = cur ? `${cur} ${tok}` : tok;
      if (measure(candidate, size) <= maxW) {
        cur = candidate;
        continue;
      }
      if (!cur) {
        // сверхдлинный токен на пустой строке — жёсткий разрыв
        const parts = hardBreak(tok, maxW, measure, size);
        lines.push(...parts.slice(0, -1));
        cur = parts[parts.length - 1] || '';
        continue;
      }
      lines.push(cur);
      cur = tok;
      if (measure(cur, size) > maxW) {
        const parts = hardBreak(cur, maxW, measure, size);
        lines.push(...parts.slice(0, -1));
        cur = parts[parts.length - 1] || '';
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  /**
   * Максимальный кегль, при котором перенесённый текст влезает в maxW×maxH.
   * Возвращает { size, lines, overflow }.
   */
  function fitFontSize(text, maxW, maxH, measure, { min = 9, max = 64, lineHeight = DEFAULT_LINE_HEIGHT } = {}) {
    const fits = (s) => {
      const lines = wrapText(text, maxW, s, measure);
      return { lines, ok: lines.length * s * lineHeight <= maxH };
    };
    const atMin = fits(min);
    if (!atMin.ok) return { size: min, lines: atMin.lines, overflow: true };
    if (fits(max).ok) {
      const lines = wrapText(text, maxW, max, measure);
      return { size: max, lines, overflow: false };
    }
    let lo = min, hi = max;
    while (hi - lo > 0.5) {
      const mid = (lo + hi) / 2;
      if (fits(mid).ok) lo = mid;
      else hi = mid;
    }
    const size = Math.max(min, Math.floor(lo));
    return { size, lines: wrapText(text, maxW, size, measure), overflow: false };
  }

  /** Ширина хорды эллипса (вписанного в бокс w×h) на вертикали строки i из n. */
  function chordW(i, n, w, h, lh) {
    const a = w / 2, b = h / 2;
    const dy = Math.abs((i - (n - 1) / 2) * lh);
    if (dy >= b) return Math.max(w * 0.3, 0);
    const c = 2 * a * Math.sqrt(1 - (dy / b) * (dy / b));
    return Math.max(w * 0.3, Math.min(w, c));
  }

  /** Перенос с ограничением ширины i-й строки хордой эллипса на её высоте.
   * Возвращает { lines, broke } — broke=true, если слово пришлось рвать. */
  function wrapEllipse(text, w, h, size, measure, lineHeight) {
    const lh = size * lineHeight;
    let n = 1;
    let broke = false;
    for (let iter = 0; iter < 4; iter++) {
      const lines = [];
      let cur = '';
      const limitAt = (idx) => chordW(Math.min(idx, n - 1), n, w, h, lh);
      for (const tok of tokenize(text)) {
        const limit = limitAt(lines.length);
        const cand = cur ? `${cur} ${tok}` : tok;
        if (measure(cand, size) <= limit) { cur = cand; continue; }
        if (!cur) {
          const parts = hardBreak(tok, limit, measure, size);
          lines.push(...parts.slice(0, -1));
          cur = parts[parts.length - 1] || '';
          broke = true;
          continue;
        }
        lines.push(cur);
        cur = tok;
        if (measure(cur, size) > limitAt(lines.length)) {
          const parts = hardBreak(cur, limitAt(lines.length), measure, size);
          lines.push(...parts.slice(0, -1));
          cur = parts[parts.length - 1] || '';
          broke = true;
        }
      }
      if (cur) lines.push(cur);
      const result = lines.length ? lines : [''];
      if (result.length === n) return { lines: result, broke };
      n = result.length;
    }
    return { lines: wrapText(text, w, size, measure), broke };
  }

  /** Эллипс-режим: максимальный кегль, при котором все строки влезают по хордам.
   * Предпочитает размер БЕЗ разрыва слов: если целый вариант существует в
   * диапазоне — берём его, даже если он мельче. */
  function fitFontSizeEllipse(text, w, h, measure, { min = 9, max = 64, lineHeight = DEFAULT_LINE_HEIGHT } = {}) {
    const search = (allowBreak) => {
      const ev = (s) => {
        const r = wrapEllipse(text, w, h, s, measure, lineHeight);
        return { ...r, ok: r.lines.length * s * lineHeight <= h && (allowBreak || !r.broke) };
      };
      if (!ev(min).ok) return null;
      const atMax = ev(max);
      if (atMax.ok) return { size: max, lines: atMax.lines };
      let lo = min, hi = max;
      while (hi - lo > 0.5) {
        const mid = (lo + hi) / 2;
        if (ev(mid).ok) lo = mid;
        else hi = mid;
      }
      const size = Math.max(min, Math.floor(lo));
      return { size, lines: wrapEllipse(text, w, h, size, measure, lineHeight).lines };
    };
    const noBreak = search(false);
    if (noBreak) return { ...noBreak, overflow: false };
    const withBreak = search(true);
    if (withBreak) return { ...withBreak, overflow: false };
    const r = wrapEllipse(text, w, h, min, measure, lineHeight);
    return { size: min, lines: r.lines, overflow: true };
  }

  /**
   * Рисование текста в боксе пузыря (координаты канваса).
   * opts.fontFit: 'auto' — подобрать максимальный влезающий кегль;
   * opts.fontSizeFixed: фиксированный кегль (с безопасным ужиманием).
   * opts.shape: 'ellipse' — строки ограничены хордами эллипса, вписанного
   * в бокс (пузыри); 'rect' (по умолчанию) — весь бокс (текст на арте).
   * Возвращает использованный размер шрифта (px) или null, если рисовать
   * нечего (пустой текст / нулевой бокс).
   */
  function drawTextBlock(ctx, text, box, opts = {}) {
    const str = String(text ?? '').trim();
    const [x0, y0, x1, y1] = box;
    if (!str || !(x1 > x0) || !(y1 > y0)) return null;

    const w = x1 - x0, h = y1 - y0;
    const lineHeight = opts.lineHeight || DEFAULT_LINE_HEIGHT;
    const measure = opts.measure;
    // эллипс считаем чуть меньше интерьера (92/94%): пузыри бывают наклонные,
    // углы тесной рамки могут выходить за настоящую обводку
    const ew = opts.shape === 'ellipse' ? w * 0.92 : w;
    const eh = opts.shape === 'ellipse' ? h * 0.94 : h;

    let size, lines;
    if (opts.fontFit === 'fixed') {
      const fixed = Math.max(6, Math.min(96, Number(opts.fontSizeFixed) || 18));
      const scale = opts.shape === 'ellipse' ? 0.9 : 1.0;
      lines = wrapText(str, ew * scale, fixed, measure);
      const totalH = lines.length * fixed * lineHeight;
      if (totalH <= eh * scale) {
        size = fixed;
      } else {
        // не влезает — ужимаем до влезающего (текст не должен выходить за пузырь)
        const fit = opts.shape === 'ellipse'
          ? fitFontSizeEllipse(str, ew, eh, measure, { min: opts.min ?? 8, max: fixed, lineHeight })
          : fitFontSize(str, ew - Math.min(ew * 0.2, 28), eh - Math.min(eh * 0.28, 32), measure, { min: opts.min ?? 8, max: fixed, lineHeight });
        size = fit.size;
        lines = fit.lines;
      }
    } else if (opts.shape === 'ellipse') {
      const fit = fitFontSizeEllipse(str, ew, eh, measure, { min: opts.min ?? 9, max: opts.max ?? 64, lineHeight });
      size = fit.size;
      lines = fit.lines;
    } else {
      const fit = fitFontSize(str, ew - Math.min(ew * 0.2, 28), eh - Math.min(eh * 0.28, 32), measure, { min: opts.min ?? 9, max: opts.max ?? 64, lineHeight });
      size = fit.size;
      lines = fit.lines;
    }

    ctx.font = `700 ${size}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = (x0 + x1) / 2;
    const totalH = lines.length * size * lineHeight;
    let ty = (y0 + y1) / 2 - totalH / 2 + (size * lineHeight) / 2;
    const prevFill = ctx.fillStyle;
    for (const line of lines) {
      ctx.fillStyle = opts.color || '#111';
      ctx.fillText(line, cx, ty);
      ty += size * lineHeight;
    }
    ctx.fillStyle = prevFill;
    return size;
  }

  /** Фабрика measure по canvas-контексту (для content script). */
  function canvasMeasure(ctx) {
    return (token, size) => {
      ctx.font = `700 ${size}px ${FONT_STACK}`;
      return ctx.measureText(token).width;
    };
  }

  /**
   * Автоцвет текста: медианная яркость фона внутри бокса по ОЧИЩЕННОЙ
   * картинке (ImageData уже в памяти — ни новых канвасов, ни getImageData).
   * Разрежённая сетка: не более maxSamples точек, O(площади / шаг²),
   * на обычном пузыре доли миллисекунды. null — если фон не читается,
   * тогда вызывающий код откатывается на ручной цвет.
   */
  function pickTextColor(im, box, { stride = 5, maxSamples = 1200, threshold = 140 } = {}) {
    const [x0, y0, x1, y1] = box;
    const w = Math.max(0, (x1 | 0) - (x0 | 0)), h = Math.max(0, (y1 | 0) - (y0 | 0));
    if (!w || !h || !im?.data || !im.width) return null;
    // шаг сетки: минимум stride, растянут до ~maxSamples точек на больших боксах
    let sx = Math.max(stride, Math.ceil(w / Math.sqrt(maxSamples)));
    let sy = Math.max(stride, Math.ceil(h / Math.sqrt(maxSamples)));
    const D = im.data, W = im.width;
    const lums = [];
    for (let y = y0 + 1; y < y1; y += sy) {
      const row = y * W;
      for (let x = x0 + 1; x < x1; x += sx) {
        const i = (row + x) * 4;
        if (D[i + 3] < 128) continue; // прозрачных не считаем
        lums.push(0.299 * D[i] + 0.587 * D[i + 1] + 0.114 * D[i + 2]);
      }
    }
    if (!lums.length) return null;
    lums.sort((a, b) => a - b);
    return lums[lums.length >> 1] >= threshold ? '#111111' : '#f2f0f6';
  }

  globalThis.MTLTextLayout = {
    FONT_STACK,
    DEFAULT_LINE_HEIGHT,
    tokenize,
    wrapText,
    fitFontSize,
    drawTextBlock,
    canvasMeasure,
    pickTextColor,
  };
})();
