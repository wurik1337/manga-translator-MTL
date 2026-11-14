// stitchlib.js — чистая логика «склейки страниц» (v1.9.0): в манге реплика
// бывает разрезана краем страницы — детектор видит текст, но OCR читает только
// половину. Здесь решается, что считать обрывком, как анализировать OCR шва
// (склеенной полоски «низ страницы A + верх страницы B») и как объединять
// половинки в полный текст. Классический скрипт для content script'а
// (ES-модули там недоступны): определяет globalThis.MTLStitch. Чистые функции —
// тестируются в Node.
(() => {
  'use strict';

  // «у края страницы» = ближе 1% высоты изображения (погрешность детектора)
  const EDGE_TOL_FRAC = 0.01;

  function isCJKChar(ch) {
    const c = ch.codePointAt(0);
    return (
      (c >= 0x2e80 && c <= 0x9fff) ||   // CJK-радикалы, иероглифы, кана
      (c >= 0xf900 && c <= 0xfaff) ||   // CJK-совместимость
      (c >= 0x3000 && c <= 0x303f) ||   // пунктуация (。、「」…)
      (c >= 0xff00 && c <= 0xffef)      // полноширинные формы
    );
  }

  /** Объединить половинки разрезанной фразы: CJK — без пробела, латиница — с. */
  function joinTexts(a, b) {
    a = String(a || '').trim();
    b = String(b || '').trim();
    if (!a) return b;
    if (!b) return a;
    const noSpace = isCJKChar(a[a.length - 1]) || isCJKChar(b[0]);
    return noSpace ? a + b : `${a} ${b}`;
  }

  /** Высота полосы страницы для шва: 25% высоты, зажата в [80, 520] px. */
  function stripH(pageH) {
    return Math.max(80, Math.min(520, Math.round(pageH * 0.25)));
  }

  /**
   * Фрагмент, обрезанный краем страницы: текстовый блок, упирающийся в верх
   * ('top') или низ ('bottom') изображения. Нормальный пузырь почти никогда
   * не кончается ровно по границе страницы — значит, блок обрезан.
   * Требования: непустой текст, вменяемые размеры, ещё не склеен.
   * Возвращает самый высокий из подходящих (или null).
   */
  function edgeFragment(items, pageH, edge) {
    const tol = Math.max(3, Math.round(pageH * EDGE_TOL_FRAC));
    let best = null, bestH = 0;
    for (const it of items || []) {
      if (!it || it.stitchMerged) continue; // половинка уже ушла в склейку
      const b = it.box;
      if (!Array.isArray(b) || b.length !== 4) continue;
      if (!String(it.text || '').trim()) continue;
      const w = b[2] - b[0], h = b[3] - b[1];
      if (h < 6 || w < 8 || h > pageH * 0.85) continue;
      const atEdge = edge === 'top' ? b[1] <= tol : b[3] >= pageH - tol;
      if (atEdge && h > bestH) { best = it; bestH = h; }
    }
    return best;
  }

  /**
   * Анализ OCR шва. junction — y-координата стыка страниц в шве, seamH —
   * высота шва. halves — запасной вариант { a, b } (тексты половинок с двух
   * страниц), применяется только когда ОБА фрагмента — пузыри (сильный
   * признак разрезанной реплики); для свободного текста без подтверждения
   * швом склейка отменяется, чтобы не объединить чужие реплики.
   * Возвращает { text, how } или null:
   *  - 'cross'  — один блок детекции пересекает стык (самый надёжный признак);
   *  - 'pair'   — блок в верхней полосе и блок в нижней совпадают по
   *    горизонтали и почти касаются на стыке (детектор разорвал блок);
   *  - 'halves' — убедительного продолжения шов не нашёл, но обе половинки —
   *    пузыри на границах страниц, объединяем их тексты.
   */
  function analyzeSeam(items, junction, seamH, halves = null) {
    const tol = Math.max(4, Math.round(seamH * 0.012));
    const withText = (items || []).filter((it) => {
      const b = it && it.box;
      return Array.isArray(b) && b.length === 4 && (b[3] - b[1]) >= 6 && (b[2] - b[0]) >= 8 &&
        String(it.text || '').trim();
    });
    // 1) блок, пересекающий стык: берем самый крупный
    const cross = withText.filter((it) => it.box[1] < junction - tol && it.box[3] > junction + tol);
    if (cross.length) {
      cross.sort((p, q) =>
        ((q.box[3] - q.box[1]) * (q.box[2] - q.box[0])) -
        ((p.box[3] - p.box[1]) * (p.box[2] - p.box[0])));
      return { text: String(cross[0].text).trim(), how: 'cross' };
    }
    // 2) пара «верхняя половина + нижняя половина»: перекрытие по горизонтали
    //    не меньше 40% узкого бокса, зазор на стыке почти нулевой
    const upper = withText.filter((it) => it.box[3] <= junction + tol);
    const lower = withText.filter((it) => it.box[1] >= junction - tol);
    let bestPair = null, bestGap = Infinity;
    for (const u of upper) {
      for (const l of lower) {
        const ow = Math.min(u.box[2], l.box[2]) - Math.max(u.box[0], l.box[0]);
        if (ow <= 0) continue;
        const minW = Math.min(u.box[2] - u.box[0], l.box[2] - l.box[0]);
        if (ow < minW * 0.4) continue; // по горизонтали не совпадают — разные реплики
        const gap = l.box[1] - u.box[3];
        if (gap < -tol || gap > seamH * 0.15) continue;
        if (gap < bestGap) { bestGap = gap; bestPair = [u, l]; }
      }
    }
    if (bestPair) {
      const text = joinTexts(bestPair[0].text, bestPair[1].text);
      if (text) return { text, how: 'pair' };
    }
    // 3) шов ничего убедительного не нашёл — объединяем только уверенные половинки
    if (halves && halves.a && halves.b) {
      const text = joinTexts(halves.a, halves.b);
      if (text) return { text, how: 'halves' };
    }
    return null;
  }

  /**
   * Шов: нижняя полоса страницы A (ранней) над верхней полосой страницы B
   * (поздней). Страницы масштабируются к общей ширине — у разных разворотов
   * она чуть различается. Возвращает { imageData, junction } (ImageData —
   * так же, как content script передаёт обычные картинки) или null.
   * Требует DOM (canvas) — в Node не тестируется, остальное тестируется.
   */
  function buildSeam(earlyData, lateData) {
    if (typeof document === 'undefined') throw new Error('buildSeam требует DOM');
    const hA = Math.min(stripH(earlyData.height), earlyData.height);
    const hB = Math.min(stripH(lateData.height), lateData.height);
    const W = Math.max(64, Math.round(earlyData.width));
    const jY = Math.round(hA * (W / earlyData.width));
    const sB = Math.round(hB * (W / lateData.width));
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = jY + sB;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const ca = document.createElement('canvas');
    ca.width = earlyData.width; ca.height = earlyData.height;
    ca.getContext('2d').putImageData(earlyData, 0, 0);
    const cb = document.createElement('canvas');
    cb.width = lateData.width; cb.height = lateData.height;
    cb.getContext('2d').putImageData(lateData, 0, 0);
    // нижняя полоса ранней страницы — в верхнюю половину шва
    ctx.drawImage(ca, 0, earlyData.height - hA, earlyData.width, hA, 0, 0, W, jY);
    // верхняя полоса поздней страницы — под стык
    ctx.drawImage(cb, 0, 0, lateData.width, hB, 0, jY, W, sB);
    return { imageData: ctx.getImageData(0, 0, W, canvas.height), junction: jY };
  }

  globalThis.MTLStitch = { isCJKChar, joinTexts, stripH, edgeFragment, analyzeSeam, buildSeam };
})();
