// inpaint.js — стирание текста «лестницей» без моделей (model-free ladder):
//   1) planar fill  — заливка области текста линейной плоскостью, построенной
//      по пикселям границы (идеально для плоских белых пузырей);
//   2) Telea (FMM)  — распространение цвета внутрь маски от границы (Fast
//      Marching Method, A. Telea 2004): направленно-взвешенное среднее;
//   3) bilateral    — двусторонний фильтр поверх заполненного: убирает шум
//      стыков и восстанавливает ровный скринтон.
// Чистые функции над {width, height, data: Uint8ClampedArray} (RGBA) —
// работают и в браузере (offscreen), и в Node (тесты).

/** Яркость пикселя (0..255). */
function lum(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Маска текста в области (локальные координаты региона).
 * Порог — Otsu по гистограмме яркости бокса; класс (тёмный/светлый)
 * выбирается как более удалённый по яркости от фона, оценённого по
 * кольцу pad вокруг бокса. Фон берём как 60-й процентиль яркости
 * кольца (медианная оценка): среднее тянет обводка пузыря/арт, попавшие
 * в кольцо, — из-за этого класс «текст» выбирался неверно и жирные
 * слова оставались на картинке. Кольцо считаем надёжным, если ≥ половины
 * его пикселей лежит около оценки фона; только тогда включаем
 * дополнительный критерий «сильного выброса» (|L − фон| > outlierMargin):
 * он добирает антиалиасинг краёв, который Otsu режет, но не трогает
 * скринтон (тот слабо отличается от фона).
 * Если маска ненадёжна (почти пустая или почти вся область) — стираем
 * весь бокс, кольцо остаётся источником цвета.
 */
export function buildTextMask(region, box, { pad = 4, dilate = 2, outlierMargin = 66, minRingReliability = 0.5, fallback = 'box' } = {}) {
  const W = region.width, H = region.height;
  const rx = Math.max(0, Math.round(box[0]) - pad);
  const ry = Math.max(0, Math.round(box[1]) - pad);
  const rx1 = Math.min(W - 1, Math.round(box[2]) + pad);
  const ry1 = Math.min(H - 1, Math.round(box[3]) + pad);
  const w = rx1 - rx + 1, h = ry1 - ry + 1;
  const d = region.data;

  const bx0 = Math.round(box[0]) - rx, by0 = Math.round(box[1]) - ry;
  const bx1 = Math.round(box[2]) - rx, by1 = Math.round(box[3]) - ry;

  // ВАЖНО: вырезаем суб-регион (w×h) — region здесь полная картинка,
  // а все дальнейшие индексы локальные (y*w+x). Без вырезания чтение
  // шло «по диагонали» через полный массив, маска была мусорной и
  // всегда срабатывал фолбэк «весь бокс» (баг v1.0–v1.2.1).
  const sub = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const off = ((ry + y) * W + rx) * 4;
    sub.set(d.subarray(off, off + w * 4), y * w * 4);
  }
  const sd = sub; // локальные пиксели суб-региона

  // гистограмма яркостей бокса + яркости фонового кольца
  const hist = new Int32Array(256);
  let boxN = 0, boxSum = 0;
  for (let y = Math.max(0, by0); y <= Math.min(h - 1, by1); y++) {
    for (let x = Math.max(0, bx0); x <= Math.min(w - 1, bx1); x++) {
      const i = (y * w + x) * 4;
      const L = lum(sd[i], sd[i + 1], sd[i + 2]) | 0;
      hist[L]++;
      boxSum += L;
      boxN++;
    }
  }
  const ringLums = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= bx0 && x <= bx1 && y >= by0 && y <= by1) continue;
      const i = (y * w + x) * 4;
      ringLums.push(lum(sd[i], sd[i + 1], sd[i + 2]) | 0);
    }
  }
  let bgLum = boxN ? boxSum / boxN : 255;
  let ringRel = 0, ringSd = 255;
  if (ringLums.length) {
    ringLums.sort((a, b) => a - b);
    // 60-я процентиль: смещение к светлому большинству (интерьер пузыря)
    bgLum = ringLums[Math.min(ringLums.length - 1, Math.floor(ringLums.length * 0.6))];
    let near = 0, sq = 0;
    for (const L of ringLums) {
      if (Math.abs(L - bgLum) <= 35) near++;
      sq += (L - bgLum) * (L - bgLum);
    }
    ringRel = near / ringLums.length;
    ringSd = Math.sqrt(sq / ringLums.length);
  }
  const useOutlier = ringRel >= minRingReliability;

  // Otsu: порог, максимизирующий межклассовую дисперсию
  let thr = 128, bestVar = -1, wsum = 0;
  for (let t = 0; t < 256; t++) wsum += t * hist[t];
  let wB = 0, sumB = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = boxN - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (wsum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; thr = t; }
  }

  // средние яркости классов — нужны для Otsu-фолбэка (ненадёжное кольцо)
  let darkN = 0, darkSum = 0;
  for (let t = 0; t < thr; t++) { darkN += hist[t]; darkSum += t * hist[t]; }
  const lightN = boxN - darkN;
  const meanDark = darkN ? darkSum / darkN : bgLum;
  const meanLight = lightN ? (boxSum - darkSum) / lightN : bgLum;
  const pickDark = Math.abs(meanDark - bgLum) >= Math.abs(meanLight - bgLum);

  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < bx0 || x > bx1 || y < by0 || y > by1) continue; // pad-кольцо не в маске
      const i = (y * w + x) * 4;
      const L = lum(sd[i], sd[i + 1], sd[i + 2]);
      // надёжное кольцо: текст = всё, что сильно отличается от фона —
      // Otsu на 3 кластерах (текст/скринтон/белый) выбирает границу
      // «тон|белый» и маскирует тон целиком; критерий выброса этого не делает
      const isText = useOutlier
        ? Math.abs(L - bgLum) > outlierMargin
        : (pickDark ? L < thr : L >= thr);
      if (isText) mask[y * w + x] = 1;
    }
  }
  dilateMask(mask, w, h, dilate);

  let cnt = 0;
  for (let i = 0; i < mask.length; i++) cnt += mask[i];
  const coverage = cnt / (w * h);
  const fallbackUsed = fallback === 'box' && (coverage < 0.004 || coverage > 0.55);
  if (fallbackUsed) {
    // ненадежная маска → стираем весь бокс; кольцо pad остаётся известным —
    // оно источник цвета для заливки (полностью дыряный регион нечем заполнять).
    // Режим 'tight' (fallback:false) решает сам: локальный контраст или пропуск.
    mask.fill(0);
    for (let y = Math.max(0, by0); y <= Math.min(h - 1, by1); y++) {
      for (let x = Math.max(0, bx0); x <= Math.min(w - 1, bx1); x++) {
        mask[y * w + x] = 1;
      }
    }
  }
  return { mask, x: rx, y: ry, w, h, pixels: sub, bx0, by0, bx1, by1, coverage, reliable: useOutlier, ringSd, fallbackUsed };
}

/** Дилатация бинарной маски (структурный элемент 3x3, k проходов). */
export function dilateMask(mask, w, h, k = 1) {
  for (let pass = 0; pass < k; pass++) {
    const src = mask.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (src[y * w + x]) continue;
        const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
        const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
        let hit = 0;
        for (let yy = y0; yy <= y1 && !hit; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            if (src[yy * w + xx]) { hit = 1; break; }
          }
        }
        if (hit) mask[y * w + x] = 1;
      }
    }
  }
  return mask;
}

/**
 * Planar fill: линейная плоскость z = a·x + b·y + c на каждый канал,
 * построенная по МНК по известным (mask=0) пикселям границы области.
 * Заполняет дыры мгновенно — база для Telea и спасение для больших масок.
 */
export function planarFill(region, mask) {
  const w = region.width, h = region.height, d = region.data;
  // граничные известные пиксели: mask=0 и хотя бы один сосед в маске
  const samples = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) continue;
      const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
      const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
      let border = 0;
      for (let yy = y0; yy <= y1 && !border; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          if (mask[yy * w + xx]) { border = 1; break; }
        }
      }
      if (border) samples.push([x, y]);
    }
  }
  if (!samples.length) return region; // некому подсказывать — не трогаем

  // при большой границе прореживаем (МНК не меняет смысл)
  const step = Math.max(1, Math.floor(samples.length / 4000));

  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, cnt = 0;
  const sc = [0, 0, 0], sxc = [0, 0, 0], syc = [0, 0, 0];
  for (let i = 0; i < samples.length; i += step) {
    const [x, y] = samples[i];
    const j = (y * w + x) * 4;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y;
    for (let c = 0; c < 3; c++) {
      const v = d[j + c];
      sc[c] += v; sxc[c] += x * v; syc[c] += y * v;
    }
    cnt++;
  }
  // решение 3x3 нормальных уравнений для z = a·x + b·y + c
  const M = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, cnt],
  ];
  const det = det3(M);
  const coef = det ? [0, 1, 2].map((c) => {
    const rhs = [sxc[c], syc[c], sc[c]];
    return solve3(M, rhs, det);
  }) : null;

  if (!coef || !coef.every(Number.isFinite)) {
    // вырожденный случай: средний цвет границы
    const avg = [0, 1, 2].map((c) => sc[c] / cnt);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        const j = (y * w + x) * 4;
        d[j] = avg[0]; d[j + 1] = avg[1]; d[j + 2] = avg[2]; d[j + 3] = 255;
      }
    }
    return region;
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const j = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        d[j + c] = clamp255(coef[c][0] * x + coef[c][1] * y + coef[c][2]);
      }
      d[j + 3] = 255;
    }
  }
  return region;
}

function det3(m) {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

function solve3(m, rhs, det) {
  const a = [
    [rhs[0], m[0][1], m[0][2]],
    [rhs[1], m[1][1], m[1][2]],
    [rhs[2], m[2][1], m[2][2]],
  ];
  const b = [
    [m[0][0], rhs[0], m[0][2]],
    [m[1][0], rhs[1], m[1][2]],
    [m[2][0], rhs[2], m[2][2]],
  ];
  const c = [
    [m[0][0], m[0][1], rhs[0]],
    [m[1][0], m[1][1], rhs[1]],
    [m[2][0], m[2][1], rhs[2]],
  ];
  return [det3(a) / det, det3(b) / det, det3(c) / det];
}

/**
 * Telea (FMM-стиль): дистанционное поле от границы дыры (BFS, 8-связность),
 * заполнение в порядке возрастания расстояния взвешенным средним уже
 * известных соседей в радиусе r. Веса — как в оригинале:
 *   dst = 1/d², lev = 1/(1+|T(q)-T(p)|), dir = |(q-p)·∇T(p)| / |q-p|.
 * Модифицирует region на месте (обычно после planarFill).
 */
export function inpaintTelea(region, mask, radius = 4) {
  const w = region.width, h = region.height, d = region.data;
  const N = w * h;
  const KNOWN = 0, BAND = 1, INSIDE = 2;
  const state = new Uint8Array(N);
  const dist = new Float32Array(N);
  let holeCount = 0;
  for (let i = 0; i < N; i++) {
    if (mask[i]) { state[i] = INSIDE; dist[i] = Infinity; holeCount++; }
  }
  if (!holeCount) return region;

  // multi-source BFS: дыряные пиксели рядом с известными получают dist=1
  let frontier = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (state[i] !== INSIDE) continue;
      const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
      const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          if (!mask[yy * w + xx]) { frontier.push(i); yy = y1 + 1; break; }
        }
      }
    }
  }
  for (const i of frontier) { dist[i] = 1; state[i] = BAND; }

  // BFS по дыре: присваиваем dist в порядке распространения
  // (указатель головы вместо shift — shift на массиве это O(n))
  const bfs = frontier.slice();
  for (let head = 0; head < bfs.length; head++) {
    const i = bfs[head];
    const x = i % w, y = (i / w) | 0;
    const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
    const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const j = yy * w + xx;
        if (state[j] === INSIDE) {
          dist[j] = dist[i] + 1;
          state[j] = BAND;
          bfs.push(j);
        }
      }
    }
  }
  // в очередь идут ВСЕ дыряные пиксели в порядке BFS (от границы вглубь):
  // раньше попадал только фронтир — Telea заполнял однопиксельное кольцо,
  // а глубину «закрывал» planarFill; на арте (без planarFill) текст оставался
  const queue = [];
  for (let i = 0; i < N; i++) {
    if (!mask[i]) continue;
    if (state[i] !== BAND) { dist[i] = 1; state[i] = BAND; }
    queue.push(i);
  }
  queue.sort((a, b) => dist[a] - dist[b]);

  const filled = new Uint8Array(N); // уже заполнено (или известно изначально)
  for (let i = 0; i < N; i++) filled[i] = mask[i] ? 0 : 1;
  // после planarFill дыры уже имеют базовый цвет — считаем их пригодными
  // источниками, но с меньшим весом (lev penalisation делает своё дело).

  const r2 = radius * radius;
  for (let qh = 0; qh < queue.length; qh++) {
    const i = queue[qh];
    if (filled[i]) continue;
    const x = i % w, y = (i / w) | 0;
    const p = dist[i];

    // градиент дистанции в p (по уже назначенным соседям)
    let gx = 0, gy = 0, gcnt = 0;
    const gAt = (xx, yy) => {
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) return null;
      const j = yy * w + xx;
      return state[j] !== INSIDE || dist[j] !== Infinity ? dist[j] : null;
    };
    const l = gAt(x - 1, y), rt = gAt(x + 1, y), tp = gAt(x, y - 1), bt = gAt(x, y + 1);
    if (l !== null && rt !== null) { gx = rt - l; gcnt++; }
    else if (l !== null) { gx = dist[i] - l; gcnt++; }
    else if (rt !== null) { gx = rt - dist[i]; gcnt++; }
    if (tp !== null && bt !== null) { gy = bt - tp; gcnt++; }
    else if (tp !== null) { gy = dist[i] - tp; gcnt++; }
    else if (bt !== null) { gy = bt - dist[i]; gcnt++; }
    if (!gcnt) { gx = 1; gy = 0; }
    const glen = Math.hypot(gx, gy) || 1;
    const ux = gx / glen, uy = gy / glen;

    let sr = 0, sg = 0, sb = 0, sw = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w || (!dx && !dy)) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const j = yy * w + xx;
        if (!filled[j]) continue;
        // направленный вес: сосед «позади» фронта полезнее
        const dirDot = (dx * ux + dy * uy) / Math.sqrt(d2);
        const wDir = Math.abs(dirDot);
        const wDst = 1 / d2;
        const wLev = 1 / (1 + Math.abs(dist[j] === Infinity ? p : dist[j] - p));
        const wgt = wDir * wDst * wLev;
        const k = j * 4;
        sr += wgt * d[k]; sg += wgt * d[k + 1]; sb += wgt * d[k + 2];
        sw += wgt;
      }
    }

    const k = i * 4;
    if (sw > 0) {
      d[k] = clamp255(Math.round(sr / sw));
      d[k + 1] = clamp255(Math.round(sg / sw));
      d[k + 2] = clamp255(Math.round(sb / sw));
    } // иначе остаётся цвет от planarFill
    d[k + 3] = 255;
    filled[i] = 1;
  }
  return region;
}

/**
 * Двусторонний фильтр поверх заполненной области (маска + доп. дилатация):
 * убирает «песок» на стыках заливки, сохраняет края рамки пузыря.
 */
export function bilateralDenoise(region, mask, { sigmaS = 3, sigmaR = 26, extraDilate = 2 } = {}) {
  const w = region.width, h = region.height, d = region.data;
  const zone = mask.slice();
  dilateMask(zone, w, h, extraDilate);
  // у границы региона не выходим за пределы
  const src = region.data.slice();
  const win = Math.max(1, Math.round(sigmaS));
  const inv2s = 1 / (2 * sigmaS * sigmaS);
  const inv2r = 1 / (2 * sigmaR * sigmaR);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!zone[y * w + x]) continue;
      const ci = (y * w + x) * 4;
      const cr = src[ci], cg = src[ci + 1], cb = src[ci + 2];
      let sr = 0, sg = 0, sb = 0, sw = 0;
      for (let dy = -win; dy <= win; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -win; dx <= win; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = (yy * w + xx) * 4;
          const dr = src[j] - cr, dg2 = src[j + 1] - cg, db = src[j + 2] - cb;
          const rangeW = Math.exp(-(dr * dr + dg2 * dg2 + db * db) * inv2r);
          const spatialW = Math.exp(-(dx * dx + dy * dy) * inv2s);
          const wgt = rangeW * spatialW;
          sr += wgt * src[j]; sg += wgt * src[j + 1]; sb += wgt * src[j + 2];
          sw += wgt;
        }
      }
      if (sw > 0) {
        d[ci] = clamp255(Math.round(sr / sw));
        d[ci + 1] = clamp255(Math.round(sg / sw));
        d[ci + 2] = clamp255(Math.round(sb / sw));
      }
    }
  }
  return region;
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Внутренняя область пузыря (тесная рамка «где можно писать») по очищенной
 * картинке: flood fill от центра бокса по светлым пикселям, обводка пузыря
 * (тёмный контур) служит границей. Возвращает [x0,y0,x1,y1] или null,
 * если центр не светлый и светлых пикселей рядом нет (тёмный пузырь/арт).
 * Бокс детекции часто шире самого пузыря (хвост, наклон) — рисовать текст
 * нужно именно по интерьеру, иначе текст вылезает за обводку.
 */
export function bubbleInterior(img, box, { lumThr = 175, minArea = 150, shrink = 2 } = {}) {
  const W = img.width, H = img.height, d = img.data;
  const bx0 = Math.max(0, Math.round(box[0]));
  const by0 = Math.max(0, Math.round(box[1]));
  const bx1 = Math.min(W - 1, Math.round(box[2]));
  const by1 = Math.min(H - 1, Math.round(box[3]));
  const w = bx1 - bx0 + 1, h = by1 - by0 + 1;
  if (w < 12 || h < 12) return null;

  const lumAt = (x, y) => {
    const j = ((by0 + y) * W + (bx0 + x)) * 4;
    return 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  };
  const visited = new Uint8Array(w * h);
  const queue = [];
  const push = (x, y) => {
    const i = y * w + x;
    if (!visited[i] && lumAt(x, y) >= lumThr) { visited[i] = 1; queue.push(i); }
  };

  // старт — центр бокса; если он на тексте/обводке, ищем светлый рядом
  const cx = Math.round(w / 2), cy = Math.round(h / 2);
  let sx = -1, sy = -1;
  const rad = Math.max(6, Math.round(Math.min(w, h) / 4));
  outer:
  for (let r = 0; r <= rad; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (lumAt(x, y) >= lumThr) { sx = x; sy = y; break outer; }
      }
    }
  }
  if (sx < 0) return null;

  push(sx, sy);
  let minX = sx, maxX = sx, minY = sy, maxY = sy, area = 0;
  while (queue.length) {
    const i = queue.pop();
    area++;
    const x = i % w, y = (i / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  if (area < minArea) return null;
  // защита от «утечки»: если флуд занял почти весь бокс, он прошёл сквозь
  // рамку (антиалиасинг) на светлый фон страницы — интерьером такое считать
  // нельзя, иначе добивающий проход сотрёт рамку пузыря целиком
  if (area > w * h * 0.85) return null;

  // тесная рамка интерьера, не выходящая за пределы бокса детекции
  const ix0 = Math.max(bx0, bx0 + minX + shrink);
  const iy0 = Math.max(by0, by0 + minY + shrink);
  const ix1 = Math.min(bx1, bx0 + maxX - shrink);
  const iy1 = Math.min(by1, by0 + maxY - shrink);
  if (ix1 - ix0 < 8 || iy1 - iy0 < 8) return null;
  return [ix0, iy0, ix1, iy1];
}

/**
 * Erase-бокс для стирания БЕЗ тесных боксов строк OCR (Vision OCR и
 * manga-OCR, где текст известен целиком по кропу). Тесный интерьер пузыря
 * (флуд по светлому от центра) с КЛИРЕНСОМ 8px от обводки: кольцо маски
 * (pad 4 вокруг бокса) должно целиком лежать в светлом интерьере, минимум
 * в 4px от рамки. При клиренсе 2 (v1.7.1) кольцо половиной попадало на
 * тёмную обводку — оценка фона ломалась, маска становилась «ненадёжной»,
 * локальный контраст/фолбэк цепляли рамку, и граница пузыря стиралась
 * прямоугольником. Без светлого интерьера (тёмный пузырь, арт, SFX) —
 * ужатый бокс с минимумом 8px: кольцо остаётся внутри региона.
 */
export function visionEraseBox(image, box) {
  try {
    const interior = bubbleInterior(image, box, { shrink: 8 });
    if (interior) return interior;
  } catch (e) { /* нет интерьера — ужатый бокс */ }
  const w = box[2] - box[0], h = box[3] - box[1];
  const dx = Math.max(8, Math.round(w * 0.1));
  const dy = Math.max(8, Math.round(h * 0.1));
  const x0 = Math.max(0, Math.round(box[0]) + dx);
  const y0 = Math.max(0, Math.round(box[1]) + dy);
  const x1 = Math.max(x0 + 1, Math.round(box[2]) - dx);
  const y1 = Math.max(y0 + 1, Math.round(box[3]) - dy);
  return [x0, y0, x1, y1];
}

/**
 * Разрезка бокса свободного текста на тесные боксы строк по проекции
 * локального контраста (v1.7.4). У встроенного OCR стирание идёт тесными
 * боксами строк от распознавателя; у Vision OCR тесных строк нет — детектор
 * отдаёт блок, и один большой бокс на арте работает плохо: кольцо маски
 * подмешивает арт (маска ненадёжна → бокс пропускается, остаются призраки
 * строк) либо промахивается мимо текста (маска съедает бокс → плоская
 * заливка видна прямоугольником). Доказательство текста в строке — пиксели
 * с сильным ЛОКАЛЬНЫМ контрастом (штрихи — резкие отклонения от среднего
 * окрестности, как в lc-маске лестницы). Мягкие пятна арта, градиенты и
 * шум локально однородны и доказательств не дают — полоса из них не
 * собирается, поэтому текст на пятне режется на строки, а не сливается
 * с пятном в один бокс. Полярность любая (тёмный текст на светлом и белый
 * на тёмном). Возвращает массив боксов; пустой — вызывающий использует
 * фолбэк (один бокс). Вертикальные колонки даёт одной высокой полосой —
 * тесный бокс колонки вместо блока.
 */
export function visionLineBoxes(image, box, opts = {}) {
  const pad = opts.pad ?? 2;
  const minH = opts.minLineHeight ?? 9;
  const margin = opts.margin ?? 60; // штрих — сильный локальный выброс
  const radius = opts.radius ?? 6;  // окно локального среднего
  const rowRange = opts.rowRange || null; // (y) => [x0,x1] | null — зона скана строки
  const bx0 = Math.max(0, Math.round(box[0]));
  const by0 = Math.max(0, Math.round(box[1]));
  const bx1 = Math.min(image.width - 1, Math.round(box[2]));
  const by1 = Math.min(image.height - 1, Math.round(box[3]));
  const w = bx1 - bx0 + 1, h = by1 - by0 + 1;
  if (w < 16 || h < 16) return [];
  const minCount = Math.max(3, Math.round(w * 0.02));
  const d = image.data, W = image.width;
  // интегральное изображение по области бокс+окрестность
  const mx0 = Math.max(0, bx0 - radius - 1), my0 = Math.max(0, by0 - radius - 1);
  const mx1 = Math.min(W - 1, bx1 + radius + 1);
  const my1 = Math.min(image.height - 1, by1 + radius + 1);
  const iw = mx1 - mx0 + 1, ih = my1 - my0 + 1;
  const I = new Float64Array((iw + 1) * (ih + 1));
  for (let y = 0; y < ih; y++) {
    let rs = 0;
    for (let x = 0; x < iw; x++) {
      const j = ((my0 + y) * W + (mx0 + x)) * 4;
      rs += 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      I[(y + 1) * (iw + 1) + (x + 1)] = rs + I[y * (iw + 1) + (x + 1)];
    }
  }
  // среднее квадрата без центра (как в lc-маске); радиус — параметр:
  // один интеграл обслуживает и доказательства (radius), и профиль разрезки
  const nbMean = (x, y, rad) => {
    const x0 = Math.max(mx0, x - rad), y0 = Math.max(my0, y - rad);
    const x1 = Math.min(mx1, x + rad), y1 = Math.min(my1, y + rad);
    const n = (x1 - x0 + 1) * (y1 - y0 + 1) - 1;
    if (n <= 0) return null;
    const s = I[(y1 - my0 + 1) * (iw + 1) + (x1 - mx0 + 1)]
      - I[(y0 - my0) * (iw + 1) + (x1 - mx0 + 1)]
      - I[(y1 - my0 + 1) * (iw + 1) + (x0 - mx0)]
      + I[(y0 - my0) * (iw + 1) + (x0 - mx0)];
    const j = (y * W + x) * 4;
    const L = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    return Math.abs(L - (s - L) / n) > margin;
  };
  const profRadius = Math.min(radius, opts.profileRadius ?? 4);
  const rows = [];
  for (let y = by0; y <= by1; y++) {
    let xs = bx0, xe = bx1;
    if (rowRange) {
      const r = rowRange(y);
      if (!r) { rows.push({ cnt: 0, cntP: 0, minX: -1, maxX: -1 }); continue; }
      xs = Math.max(bx0, Math.round(r[0]));
      xe = Math.min(bx1, Math.round(r[1]));
      if (xe - xs + 1 < 16) { rows.push({ cnt: 0, cntP: 0, minX: -1, maxX: -1 }); continue; }
    }
    let cnt = 0, cntP = 0, minX = -1, maxX = -1;
    for (let x = xs; x <= xe; x++) {
      if (nbMean(x, y, radius)) {
        cnt++;
        if (minX < 0) minX = x - bx0;
        maxX = x - bx0;
      }
      if (nbMean(x, y, profRadius)) cntP++;
    }
    rows.push({ cnt, cntP, minX, maxX });
  }
  // слияние строк с доказательствами в полосы; разрыв ≤ 2 строки — ещё
  // внутри строки (редкие пробелы), больше — межстрочный интервал
  const bands = [];
  let cur = null, gap = 0;
  const close = () => { if (cur) { bands.push(cur); cur = null; } };
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (row.cnt >= minCount) {
      if (!cur) cur = { y0: r, y1: r, minX: row.minX, maxX: row.maxX };
      else {
        cur.y1 = r;
        cur.minX = Math.min(cur.minX, row.minX);
        cur.maxX = Math.max(cur.maxX, row.maxX);
      }
      gap = 0;
    } else if (cur && ++gap > 2) close();
  }
  close();
  const out = [];
  // v1.7.5: рекурсивное деление полос по долинам профильного счётчика.
  // Гало локального контраста (radius 6) продлевает доказательства на ~6px
  // за штрихи, поэтому межстрочный промежуток 8-10px может не дать пустых
  // строк и соседние строки сливаются в одну полосу. Долина — зона строк
  // с cntP ≤ 20% максимума полосы; делим по ней, если с ОБЕИХ сторон остаётся
  // по линии (высота ≥ minH, сила ≥ 40% максимума — иначе это не зазор между
  // строками, а край полосы или тонкая кромка). Профильный счётчик (radius 4,
  // гало вдвое уже) видит зазор 8px, а основной (radius 6) — блёклый текст
  // на пятнах, поэтому полосы собираются по нему.
  const pushBox = (p0, p1) => {
    let minX = -1, maxX = -1;
    for (let r = p0; r <= p1; r++) {
      if (rows[r].minX < 0) continue;
      if (minX < 0 || rows[r].minX < minX) minX = rows[r].minX;
      if (maxX < 0 || rows[r].maxX > maxX) maxX = rows[r].maxX;
    }
    if (minX < 0 || maxX - minX + 1 < Math.max(12, Math.round(w * 0.08))) return;
    out.push([
      Math.max(0, bx0 + minX - pad),
      Math.max(0, by0 + p0 - pad),
      Math.min(image.width - 1, bx0 + maxX + pad),
      Math.min(image.height - 1, by0 + p1 + pad),
    ]);
  };
  const splitRec = (p0, p1, depth) => {
    if (depth > 8 || p1 - p0 + 1 < minH) { if (p1 - p0 + 1 >= minH) pushBox(p0, p1); return; }
    let maxAll = 0;
    for (let r = p0; r <= p1; r++) maxAll = Math.max(maxAll, rows[r].cntP);
    if (maxAll <= 0) { pushBox(p0, p1); return; } // блёклая строка — профиль пуст
    let zs = -1, ze = -1, cut = null;
    for (let r = p0; r <= p1 + 1 && !cut; r++) {
      const inZone = r <= p1 && rows[r].cntP <= 0.2 * maxAll;
      if (inZone) { if (zs < 0) zs = r; ze = r; continue; }
      if (zs < 0) continue;
      // зона [zs..ze] закончилась: две живые стороны?
      // масштабно-независимый критерий: минимум долины ≤ 10% СЛАБЕЙШЕЙ
      // стороны (гало обеих строк стекает в зазор, но до нуля не доходит;
      // настоящий зазор даёт строки cntP ≈ 0). Глобальный максимум тут
      // неприменим — в полосе могут быть строки разного кегля.
      let lMax = 0, rMax = 0, zMin = Infinity;
      for (let q = p0; q < zs; q++) lMax = Math.max(lMax, rows[q].cntP);
      for (let q = ze + 1; q <= p1; q++) rMax = Math.max(rMax, rows[q].cntP);
      for (let q = zs; q <= ze; q++) zMin = Math.min(zMin, rows[q].cntP);
      if (ze - zs + 1 >= 2 && zs - p0 >= minH && p1 - ze >= minH &&
          zMin <= 0.1 * Math.min(lMax, rMax)) cut = [zs - 1, ze + 1];
      zs = -1; ze = -1;
    }
    if (cut) { splitRec(p0, cut[0], depth + 1); splitRec(cut[1], p1, depth + 1); return; }
    pushBox(p0, p1);
  };
  for (const b of bands) splitRec(b.y0, b.y1, 0);
  return out;
}

/**
 * Тесные боксы строк ВНУТРИ пузыря (v1.7.5, стирание «под копирку»
 * встроенного OCR). Та же проекция локального контраста, что у свободного
 * текста, но зона скана каждой строки зажата флуд-интерьером пузыря:
 * без зажима углы bbox интерьера (тёмная рамка эллипса) дают ложные полосы
 * — построчное стирание задевало бы рамку. Строка текста лежит внутри
 * диапазона флуда своей строки (флуд обтекает текст), угловые полосы при
 * зажиме схлопываются. Одна полоса на ≥60% площади интерьера — это
 * тон-текстура (скринтон), не строки: возвращаем [], вызывающий остаётся
 * на пресет-флуде (wholeErase). Пустой флуд (арт вместо пузыря) — обычная
 * проекция по всему боксу.
 */
export function visionBubbleLineBoxes(image, box, opts = {}) {
  const flood = bubbleFloodInterior(image, box);
  if (!flood) return visionLineBoxes(image, box, opts);
  // пер-строчные диапазоны флуда (min/max затопленного x в строке), ужатые
  // на 5px внутрь: крайние пиксели интерьера — сами по себе «доказательство»
  // локального контраста (их окно цепляет тёмную рамку пузыря), без ужатия
  // каждая строка флуда кажется текстовой и полосы сливаются в одну огромную
  const edge = opts.edgeInset ?? 5;
  const ext = [];
  for (let ry = 0; ry < flood.h; ry++) {
    let a0 = -1, a1 = -1;
    const base = ry * flood.w;
    for (let x = 0; x < flood.w; x++) {
      if (flood.flooded[base + x]) { if (a0 < 0) a0 = x; a1 = x; }
    }
    if (a0 < 0 || a1 - edge < a0 + edge) { ext.push(null); continue; }
    ext.push([flood.x + a0 + edge, flood.x + a1 - edge]);
  }
  const lines = visionLineBoxes(image, box, {
    ...opts,
    rowRange: y => (y >= flood.y && y < flood.y + flood.h ? ext[y - flood.y] : null),
  });
  // боксы строк не выходят из интерьера: пересекаем каждый бокс с флудом по
  // его КРАЙНИМ строкам (ext уже ужат на edge). Без зажима угол бокса у
  // широкой строки (протянутой мостиком/подчёркиванием к краю) тыкается в
  // сужающийся эллипс — кольцо маски видит рамку, и рамка по углу стирается.
  // Учитываются только «здравые» строки (ширина флуда ≥ половины
  // максимальной) — строка, запечатанная текстом наглухо (мостик до самого
  // края), даёт вырожденную щель и в зажиме не участвует.
  let floodMaxW = 0;
  for (let ry = 0; ry < flood.h; ry++) {
    const e = ext[ry];
    if (e && e[1] - e[0] > floodMaxW) floodMaxW = e[1] - e[0];
  }
  const extOf = y => {
    if (y < flood.y || y >= flood.y + flood.h) return null;
    const e = ext[y - flood.y];
    return e && e[1] - e[0] >= 0.5 * floodMaxW ? e : null;
  };
  const res = [];
  for (const b of lines) {
    let x0 = b[0], x1 = b[2];
    for (const y of [b[1], b[3]]) {
      const e = extOf(y);
      if (!e) continue;
      x0 = Math.max(x0, e[0]);
      x1 = Math.min(x1, e[1]);
    }
    if (x1 - x0 < 12) continue; // зажат в ноль у края — не строка
    res.push([x0, b[1], x1, b[3]]);
  }
  if (res.length === 1) {
    const b = res[0];
    if ((b[2] - b[0]) * (b[3] - b[1]) > 0.6 * (box[2] - box[0]) * (box[3] - box[1])) return [];
  }
  return res;
}

/**
 * Зачистка остатков после заливки: в области бокса ищем пиксели, ярко
 * выбивающиеся из медианы заполненной области (недостёртые штрихи,
 * антиалиасинг), и повторно заливаем их. Консервативно: если «остатков»
 * слишком много (> residualCap площади бокса) — это не текст, а фон/тон,
 * не трогаем. Вызывается ДО записи региона обратно в картинку.
 */
function residualCleanup(region, boxRect, mask, { margin = 70, cap = 0.3, dilate = 2, zone = null } = {}) {
  const w = region.width, h = region.height, d = region.data;
  const [bx0, by0, bx1, by1] = boxRect;
  // медиана яркости известной (незаполненной) части бокса
  const lums = [];
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      if (mask[y * w + x]) continue;
      if (zone && !zone[y * w + x]) continue;
      const i = (y * w + x) * 4;
      lums.push(lum(d[i], d[i + 1], d[i + 2]) | 0);
    }
  }
  if (lums.length < 100) return 0;
  lums.sort((a, b) => a - b);
  const med = lums[lums.length >> 1];

  const res = new Uint8Array(w * h);
  let cnt = 0;
  const area = (bx1 - bx0 + 1) * (by1 - by0 + 1);
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      if (zone && !zone[y * w + x]) continue;
      const i = (y * w + x) * 4;
      const L = lum(d[i], d[i + 1], d[i + 2]);
      if (Math.abs(L - med) > margin) { res[y * w + x] = 1; cnt++; }
    }
  }
  if (!cnt || cnt / area > cap) return 0;
  dilateMask(res, w, h, dilate);
  planarFill(region, res);
  inpaintTelea(region, res, 4);
  return cnt;
}

/**
 * Ужать абсолютный бокс минимум на minInset px или долю frac — добивающий
 * проход режима 'rect' (метод v1.2.2).
 */
function insetBoxAbs(box, frac = 0.06, minInset = 3) {
  const w = box[2] - box[0], h = box[3] - box[1];
  const dx = Math.max(minInset, Math.round(w * frac));
  const dy = Math.max(minInset, Math.round(h * frac));
  return [box[0] + dx, box[1] + dy, box[2] - dx, box[3] - dy];
}

/**
 * Добивающая маска пузыря: находим множество интерьера флуд-заливкой от
 * центра бокса (пиксели яркие, близкие к центру), затем внутри этого
 * множества маскируем тёмные выбросы — жирные слова, пропущенные боксами
 * строк. Для ИНВЕРТИРОВАННЫХ пузырей (белый текст на тёмном) полярность
 * обратная: флуд идёт по тёмному банду вокруг центра, текст = светлые
 * дырки. Маска строится по МНОЖЕСТВУ флуда, а не по его bbox: у bbox
 * углы всегда вне овала пузыря, кольцо там попадает на фон страницы —
 * из-за этого v1.2.2 заливала белый прямоугольник поверх пузыря и рамки.
 * Рамка и фон в множество флуда не попадают — недостижимы.
 * Возвращает { mask, x, y, w, h } в координатах картинки или null
 * (промежуточный тон без белого/тёмного центра, утечка флуда на фон,
 * слишком маленькая область).
 */
/**
 * Флуд-интерьер пузыря (v1.7.5, экстракт из buildBubbleCatchAllMask):
 * якорь — яркий пиксель возле центра (нет белого — тёмный, инвертированный
 * пузырь), заливка по порогу, критерий однородности (sd ≤ 20 — иначе утечка
 * сквозь рамку). Возвращает { flooded, dark, mean, sd, area, x, y, w, h }
 * или null (нет якоря, мелкая область, утечка). Используется пресет-маской
 * и зажимом проекции строк пузыря (visionBubbleLineBoxes).
 */
export function bubbleFloodInterior(img, box) {
  const W = img.width, H = img.height, d = img.data;
  const bx0 = Math.max(0, Math.round(box[0]));
  const by0 = Math.max(0, Math.round(box[1]));
  const bx1 = Math.min(W - 1, Math.round(box[2]));
  const by1 = Math.min(H - 1, Math.round(box[3]));
  const w = bx1 - bx0 + 1, h = by1 - by0 + 1;
  if (w < 24 || h < 24) return null;
  const lumAt = (x, y) => {
    const j = ((by0 + y) * W + (bx0 + x)) * 4;
    return 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  };
  // старт — яркий пиксель возле центра (текст в центре не мешает: ищем вокруг).
  // Яркого нет — ищем ТЁМНЫЙ: инвертированный пузырь (белый текст на тёмном).
  // Двумя проходами, чтобы текст в центре светлого пузыря не включил тёмный
  // режим: сначала ищем белый интерьер по всему радиусу, и только если его
  // нет вовсе — тёмный якорь.
  const cx = Math.round(w / 2), cy = Math.round(h / 2);
  let sx = -1, sy = -1, centerLum = 0, dark = false;
  const rad = Math.max(6, Math.round(Math.min(w, h) / 4));
  outer:
  for (let r = 0; r <= rad; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const L = lumAt(x, y);
        if (L >= 200) { sx = x; sy = y; centerLum = L; break outer; }
      }
    }
  }
  if (sx < 0) {
    outer2:
    for (let r = 0; r <= rad; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const L = lumAt(x, y);
          if (L <= 90) { sx = x; sy = y; centerLum = L; dark = true; break outer2; }
        }
      }
    }
  }
  if (sx < 0) return null; // нет ни белого, ни тёмного центра — арт, не трогаем

  // порог флуда. Светлый режим: чуть ниже яркости центра — светлый фон
  // страницы (серый) отсекается, тёмная рамка тем более. Тёмный режим: БАНД
  // вокруг яркости центра — рамка (ещё темнее) и фон страницы (светлее)
  // в множество флуда не попадают, текст = светлые дырки.
  const thr = dark ? 0 : Math.max(100, Math.min(205, centerLum - 25));
  const lo = dark ? Math.max(0, centerLum - 20) : 0;
  const hi = dark ? centerLum + 25 : 255;
  const inFlood = L => (dark ? L >= lo && L <= hi : L >= thr);
  const flooded = new Uint8Array(w * h);
  let area = 0, sum = 0, sumSq = 0;
  const stack = [sy * w + sx];
  flooded[sy * w + sx] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    area++;
    const L = lumAt(x, y);
    sum += L;
    sumSq += L * L;
    if (x > 0 && !flooded[i - 1] && inFlood(lumAt(x - 1, y))) { flooded[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && !flooded[i + 1] && inFlood(lumAt(x + 1, y))) { flooded[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && !flooded[i - w] && inFlood(lumAt(x, y - 1))) { flooded[i - w] = 1; stack.push(i - w); }
    if (y < h - 1 && !flooded[i + w] && inFlood(lumAt(x, y + 1))) { flooded[i + w] = 1; stack.push(i + w); }
  }
  if (area < 400) return null;
  // критерий утечки — разброс яркости флуда: чистый интерьер (белый или
  // тонированный) однородный, утечка сквозь рамку подмешивает серый фон
  // страницы (белое + серое → sd ~30). Сравнивать площадь с площадью бокса
  // нельзя: бокс детекции может быть меньше пузыря, флуд законно займёт
  // почти весь бокс.
  const meanLum = sum / area;
  const sd = Math.sqrt(Math.max(0, sumSq / area - meanLum * meanLum));
  if (sd > 20) return null;
  return { flooded, dark, mean: meanLum, sd, area, x: bx0, y: by0, w, h };
}

export function buildBubbleCatchAllMask(img, box, { textDelta = 70, dilate = 2 } = {}) {
  const W = img.width, H = img.height, d = img.data;
  const bx0 = Math.max(0, Math.round(box[0]));
  const by0 = Math.max(0, Math.round(box[1]));
  const bx1 = Math.min(W - 1, Math.round(box[2]));
  const by1 = Math.min(H - 1, Math.round(box[3]));
  const w = bx1 - bx0 + 1, h = by1 - by0 + 1;
  if (w < 24 || h < 24) return null;

  // флуд-интерьер (v1.7.5 экстракт: та же логика у проекции строк пузыря)
  const fl = bubbleFloodInterior(img, box);
  if (!fl) return null;
  const { flooded, dark } = fl;
  const meanLum = fl.mean;
  const area = fl.area;

  const lumAt = (x, y) => {
    const j = ((by0 + y) * W + (bx0 + x)) * 4;
    return 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
  };

  // якорь, порог флуда и заливка — в bubbleFloodInterior (v1.7.5)

  // текст = «дырки» флуда: компоненты НЕзатопленных пикселей, которые не
  // касаются края бокса и заметно темнее интерьера. Флуд не может пройти
  // сквозь тёмные штрихи, поэтому сами штрихи в flooded не попадают —
  // ищем их как компоненты дыр. Компоненты у края бокса — рамка/внешний
  // мир (бокс может включать край пузыря) — не трогаем.
  const mean = meanLum;
  const mask = new Uint8Array(w * h);
  const seen = new Uint8Array(w * h);
  // зона дочистки: флуд + «безопасные» компоненты дыр (не рамка, не фон).
  // Сюда попадает то, что компонентный критерий пропускает: антиалиасинг
  // текста, серый/тонкий текст, мелкие знаки (компонент < 20px).
  const zone = new Uint8Array(w * h);
  for (let i = 0; i < flooded.length; i++) if (flooded[i]) zone[i] = 1;
  let cnt = 0;
  for (let y0 = 0; y0 < h; y0++) {
    for (let x0 = 0; x0 < w; x0++) {
      const i0 = y0 * w + x0;
      if (flooded[i0] || seen[i0]) continue;
      // обход компонента незатопленных пикселей
      let n = 0, s = 0, touches = 0;
      let minX = x0, maxX = x0, minY = y0, maxY = y0;
      const pixels = [];
      const st = [i0];
      seen[i0] = 1;
      while (st.length) {
        const i = st.pop();
        const x = i % w, y = (i / w) | 0;
        n++;
        s += lumAt(x, y);
        pixels.push(i);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x === 0 || x === w - 1 || y === 0 || y === h - 1) touches = 1;
        if (x > 0 && !flooded[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; st.push(i - 1); }
        if (x < w - 1 && !flooded[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; st.push(i + 1); }
        if (y > 0 && !flooded[i - w] && !seen[i - w]) { seen[i - w] = 1; st.push(i - w); }
        if (y < h - 1 && !flooded[i + w] && !seen[i + w]) { seen[i + w] = 1; st.push(i + w); }
      }
      const compMean = s / n;
      // кольцо обводки пузыря — компонента, чей bbox тянется на 60%+ бокса
      // в обоих измерениях; слова текста компактны хотя бы по одному.
      // Светлый режим: текст темнее интерьера; тёмный: светлее (белый текст).
      const spansFrame = (maxX - minX + 1) > w * 0.6 && (maxY - minY + 1) > h * 0.6;
      const isText = dark ? compMean > mean + textDelta : compMean < mean - textDelta;
      if (!touches && !spansFrame) {
        for (const i of pixels) zone[i] = 1;
        if (isText && n >= 20) {
          for (const i of pixels) { mask[i] = 1; cnt++; }
        }
      }
    }
  }
  // v1.7.3: дочистка «мелочи» пер-пиксельным выбросом внутри зоны — тот же
  // механизм, что у тесных боксов строк встроенного OCR (outlierMargin 66
  // против фона интерьера): антиалиасинг вокруг глифов, серый/тонкий текст,
  // знаки меньше 20px. Скринтон (точки в пределах ~66 от фона) остаётся.
  // Флуд однороден (sd <= 20), поэтому фон флуда в выбросы не попадает.
  const sweepMargin = 66;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] || !zone[i]) continue;
    const L = lumAt(i % w, (i / w) | 0);
    if (dark ? L > mean + sweepMargin : L < mean - sweepMargin) { mask[i] = 1; cnt++; }
  }
  if (!cnt || cnt > area * 0.6) return null; // пусто или слишком много — ненадёжно
  dilateMask(mask, w, h, dilate);
  return { mask, flooded, zone, x: bx0, y: by0, w, h };
}

/**
 * Полная лестница для списка айтемов детекции.
 * items: [{ erase: [[x0,y0,x1,y1],...], box: [...], kind, ... }] —
 * стирание идёт по тесным erase-боксам строк текста (рамки пузырей и
 * фон не задеваются); если erase нет — по box. Для пузырей добавляется
 * добивающий проход по ужатому боксу пузыря: слова, которые боксы строк
 * OCR пропустили (жирные возгласы, подписи у края), стираются критерием
 * сильного выброса; скринтон и арт (близкие к фону яркости) остаются.
 * Возвращает НОВОЕ изображение (исходник не мутирует).
 */
/**
 * Маска «локального контраста»: пиксель — текст, если он сильно отличается
 * от среднего своей окрестности (интегральное изображение). В отличие от
 * критерия выброса против общего фона, работает и на арте/скринтоне, где
 * «фон» в принципе неоднороден: штрихи текста — сильные локальные
 * отклонения, точки тона и градиенты — слабые. Только для режима 'tight'.
 */
function buildLocalContrastMask(pixels, w, h, boxRect, { radius = 5, margin = 90, dilate = 2 } = {}) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rowSum += lum(pixels[i], pixels[i + 1], pixels[i + 2]);
      I[(y + 1) * (w + 1) + (x + 1)] = I[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  const rectMean = (x0, y0, x1, y1) => {
    const ix0 = Math.max(0, x0), iy0 = Math.max(0, y0);
    const ix1 = Math.min(w - 1, x1), iy1 = Math.min(h - 1, y1);
    const area = (ix1 - ix0 + 1) * (iy1 - iy0 + 1);
    if (area <= 0) return 255;
    const s = I[(iy1 + 1) * (w + 1) + (ix1 + 1)] - I[iy0 * (w + 1) + (ix1 + 1)] -
      I[(iy1 + 1) * (w + 1) + ix0] + I[iy0 * (w + 1) + ix0];
    return s / area;
  };
  const mask = new Uint8Array(w * h);
  let cnt = 0, areaN = 0;
  const [bx0, by0, bx1, by1] = boxRect;
  for (let y = Math.max(0, by0); y <= Math.min(h - 1, by1); y++) {
    for (let x = Math.max(0, bx0); x <= Math.min(w - 1, bx1); x++) {
      areaN++;
      const i = (y * w + x) * 4;
      const L = lum(pixels[i], pixels[i + 1], pixels[i + 2]);
      // среднее окрестности без самого пикселя (окно минус центр)
      const x0 = x - radius, y0 = y - radius, x1 = x + radius, y1 = y + radius;
      const n = (Math.min(h - 1, y1) - Math.max(0, y0) + 1) *
        (Math.min(w - 1, x1) - Math.max(0, x0) + 1) - 1;
      if (n <= 0) continue;
      const m = (rectMean(x0, y0, x1, y1) * (n + 1) - L) / n;
      if (Math.abs(L - m) > margin) { mask[y * w + x] = 1; cnt++; }
    }
  }
  const coverage = cnt / Math.max(1, areaN);
  if (coverage && coverage <= 0.5) dilateMask(mask, w, h, dilate);
  return { mask, coverage };
}

/**
 * Полная лестница для списка айтемов детекции.
 * opts.mode:
 *   'rect'  — прямоугольное стирание (по умолчанию): тесные erase-боксы строк
 *             плюс добивающий проход по ужатому боксу пузыря; ненадёжная маска
 *             → плоская заливка всего бокса (видимые прямоугольники на арте,
 *             зато предсказуемо и быстро). Соответствует «Стирать текст
 *             (прямоугольно)».
 *   'tight' — деликатное стирание: только тесные боксы строк, без добивающего
 *             бокса и без плоской заливки целого бокса. На арте/скринтоне
 *             (ненадёжное кольцо) текст ищется локальным контрастом; если и
 *             он неоднозначен — бокс пропускается (лучше оставить оригинал,
 *             чем залить прямоугольник). Заливка плоскостью только по ровному
 *             кольцу (пузыри), на арте — только Telea. Соответствует
 *             «Стирать текст».
 * items: [{ erase: [[x0,y0,x1,y1],...], box: [...], kind, ... }]
 * Возвращает НОВОЕ изображение (исходник не мутирует).
 */
export function inpaintLadder(img, items, opts = {}) {
  const rect = opts.mode !== 'tight';
  const out = {
    width: img.width,
    height: img.height,
    data: new Uint8ClampedArray(img.data),
  };
  const t0 = Date.now();
  let done = 0, skipped = 0;
  // задания: { box, mask } — mask передаётся в buildTextMask
  const jobs = [];
  for (const it of items) {
    const bb = (it?.kind === 'bubble' && Array.isArray(it?.box) && it.box.length === 4)
      ? it.box.map(Math.round)
      : null;
    const bOk = !!bb && bb.every(Number.isFinite) && bb[2] - bb[0] > 24 && bb[3] - bb[1] > 24;
    // wholeErase (Vision OCR / manga-OCR): тесных боксов строк нет, erase —
    // один интерьерный бокс. Прямоугольник по bbox овального пузыря всегда
    // перекрывает изгиб рамки у рёбер (углы bbox вне овала) — маска цепляет
    // обводку и граница стирается прямоугольником (баг v1.7.0–v1.7.1).
    // Поэтому первична пресет-маска флуда: текст = дырки внутри интерьера,
    // рамка и фон недостижимы по построению. Боксы — только если пресет
    // не построился (промежуточный тон, мелкая область).
    if (bOk && it?.wholeErase) {
      const preset = buildBubbleCatchAllMask(img, bb, opts.catchAll || {});
      if (preset) { jobs.push({ preset }); continue; }
    }
    const list = Array.isArray(it?.erase) && it.erase.length ? it.erase : [it?.box];
    for (const b of list) {
      if (!Array.isArray(b) || b.length !== 4) continue;
      const [x0, y0, x1, y1] = b.map(Math.round);
      if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) continue;
      jobs.push({ box: [x0, y0, x1, y1], mask: opts.mask, free: it?.kind !== 'bubble' });
    }
    // добивающий проход по пузырю (только для айтемов с тесными боксами
    // строк; wholeErase уже закрыт пресетом или своими боксами).
    // tight — preset-маска по множеству флуда интерьера. rect — метод
    // v1.2.2: ужатый бокс + фолбэк «весь бокс» — быстро, но стирает плоскими
    // прямоугольниками и может задевать рамку (осознанный компромисс);
    // v1.7.5: построчные Vision-пузыри (floodFinish) добираются пресетом и
    // в rect — ужатый бокс на «лучистом» арте ест рамку по углам бокса.
    if (bOk && !it?.wholeErase) {
      if (rect && !it?.floodFinish) {
        jobs.push({ box: insetBoxAbs(bb), mask: { ...(opts.mask || {}), outlierMargin: 80 } });
      } else {
        const preset = buildBubbleCatchAllMask(img, bb, opts.catchAll || {});
        if (preset) jobs.push({ preset });
      }
    }
  }
  for (const job of jobs) {
    // preset: маска уже готова и безопасна (внутри белого интерьера) —
    // фолбэки и rescues не нужны
    if (job.preset) {
      const { mask, x: px0, y: py0, w: pw, h: ph } = job.preset;
      const region = { width: pw, height: ph, data: new Uint8ClampedArray(pw * ph * 4) };
      for (let y = 0; y < ph; y++) {
        const off = ((py0 + y) * out.width + px0) * 4;
        region.data.set(out.data.subarray(off, off + pw * 4), y * pw * 4);
      }
      // кольцо маски — гарантированно белый интерьер: плоская заливка верна
      planarFill(region, mask);
      inpaintTelea(region, mask, opts.teleaRadius ?? 4);
      bilateralDenoise(region, mask, opts.bilateral || {});
      // residual — внутри ЗОНЫ ДОЧИСТКИ (флуд + безопасные компоненты дыр):
      // регион пресета включает рамку пузыря и фон, и без ограничения
      // медиана «зачистки» объявила бы тёмную рамку остатком и залила её
      // белым. Зона добавляет к флуду антиалиасинг и мелкие знаки — они
      // тоже дочищаются, как у тесных боксов строк OCR.
      residualCleanup(region, [0, 0, pw - 1, ph - 1], mask,
        { ...(rect ? (opts.residual || {}) : { margin: 90, cap: 0.08 }), zone: job.preset.zone || job.preset.flooded });
      for (let y = 0; y < ph; y++) {
        const dstOff = ((py0 + y) * out.width + px0) * 4;
        out.data.set(region.data.subarray(y * pw * 4, (y + 1) * pw * 4), dstOff);
      }
      done++;
      continue;
    }
    const maskOpts = { ...(job.mask || {}) };
    if (!rect) maskOpts.fallback = false;
    const built = buildTextMask(out, job.box, maskOpts);
    // суб-регион (с pad) уже вырезан в buildTextMask — копировать не нужно
    const region = { width: built.w, height: built.h, data: built.pixels };
    let mask = built.mask;
    let reliable = built.reliable;
    if (!rect) {
      // деликатный режим: никаких плоских прямоугольников
      // плотный текст на ровном белом пузыре доверяем маске даже при высоком
      // покрытии (кольцо ровное — всё, что не фон, это текст);
      // спасательный путь — для тонированных/артичных боксов
      // свободный текст (вне пузырей): маска, съевшая ≥90% бокса, — это не
      // плотная строка (настоящий текст оставляет промежутки), а промах
      // кольца — оно «плоское», но темнее/светлее самого бокса; плоская
      // заливка такого бокса видна прямоугольником на арте
      const wholeBox = job.free && built.coverage > 0.9;
      const flatRing = reliable && built.ringSd <= 26 && !wholeBox;
      if (!reliable || (!flatRing && built.coverage > 0.8)) {
        // v1.7.4: тесный бокс строки свободного текста гарантированно содержит
        // прочитанный текст, поэтому маска выбросов против кольца осмысленна
        // даже при «неоднородном» кольце — кольцо строки на арте всегда
        // смешанное (арт вокруг строки неоднороден), но текст от него
        // отстоит сильнее, чем арт от арта. lc такие строки оставляет
        // нетронутыми: сплошной текст шире окна локального контраста, и
        // lc-маска получается пустой → вся строка остаётся призраком.
        // Поэтому для free-боксов первична маска выбросов, lc — только если
        // она пустая (<2%) или взрывная (>80%).
        const covOk = job.free && built.coverage >= 0.02 && built.coverage <= 0.8;
        if (!covOk) {
          // кольцо неоднозначное (арт/скринтон) или маска съела почти весь
          // бокс — пробуем локальный контраст
          const lc = buildLocalContrastMask(
            built.pixels, built.w, built.h,
            [built.bx0, built.by0, built.bx1, built.by1],
            opts.localContrast || {},
          );
          if (lc.coverage > 0.5) { skipped++; continue; } // оставляем оригинал
          mask = lc.mask;
          reliable = false;
        }
      }
    }
    if (built.fallbackUsed) {
      // v1.7.5: фолбэк «весь бокс» — плоская заливка МЕДИАННЫМ цветом кольца
      // (60-я процентиль яркости, как bgLum маски). Планар здесь наклоняется
      // тёмной строкой в самом кольце (подчёркивание под боксом), а Telea
      // подтекает ею же в середину бокса («смаз»); константа от этого
      // независима.
      const ring = [];
      for (let y = 0; y < built.h; y++) {
        for (let x = 0; x < built.w; x++) {
          if (x >= built.bx0 && x <= built.bx1 && y >= built.by0 && y <= built.by1) continue;
          const j = (y * built.w + x) * 4;
          ring.push([0.299 * region.data[j] + 0.587 * region.data[j + 1] + 0.114 * region.data[j + 2], j]);
        }
      }
      ring.sort((a, b) => a[0] - b[0]);
      const pick = ring[Math.min(ring.length - 1, Math.floor(ring.length * 0.6))][1];
      const cr = region.data[pick], cg = region.data[pick + 1], cb = region.data[pick + 2];
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const j = i * 4;
        region.data[j] = cr; region.data[j + 1] = cg; region.data[j + 2] = cb; region.data[j + 3] = 255;
      }
    } else if (rect || (reliable && built.ringSd <= 26)) planarFill(region, mask);
    // v1.7.5: Telea НЕ запускается после фолбэка «весь бокс» — планар уже
    // заполнил бокс цветом кольца, а Telea строит заливку заново ИЗ КОЛЬЦА:
    // если в кольце есть тёмная строка (подчёркивание/мостик к рамке под
    // боксом), она серым подтекает в середину бокса — тот самый «смаз».
    if (!built.fallbackUsed) inpaintTelea(region, mask, opts.teleaRadius ?? 4);
    if (rect || reliable) bilateralDenoise(region, mask, opts.bilateral || {});
    // добираем недостёртые штрихи (только внутри бокса, консервативно);
    // в tight-режиме — только на пузырях и с жёсткими порогами
    if (rect) residualCleanup(region, [built.bx0, built.by0, built.bx1, built.by1], mask, opts.residual || {});
    else if (reliable) residualCleanup(region, [built.bx0, built.by0, built.bx1, built.by1], mask, { margin: 90, cap: 0.08, ...(opts.residual || {}) });
    // вставляем регион обратно
    for (let y = 0; y < built.h; y++) {
      const dstOff = ((built.y + y) * out.width + built.x) * 4;
      out.data.set(
        region.data.subarray(y * built.w * 4, (y + 1) * built.w * 4),
        dstOff,
      );
    }
    done++;
  }
  return { image: out, regions: done, skipped, ms: Date.now() - t0 };
}
