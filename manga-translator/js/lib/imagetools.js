// imagetools.js — чистые операции над пиксельными массивами, без DOM/canvas.
// Работает одинаково в браузере (ImageData) и в Node (pngjs).
// Формат изображения: { width, height, data: Uint8ClampedArray|Uint8Array } в RGBA.

/** Кроп с клампом границ. */
export function cropImage(src, x, y, w, h) {
  const W = src.width, H = src.height;
  x = Math.max(0, Math.min(W - 1, Math.round(x)));
  y = Math.max(0, Math.min(H - 1, Math.round(y)));
  w = Math.max(1, Math.min(W - x, Math.round(w)));
  h = Math.max(1, Math.min(H - y, Math.round(h)));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcOff = ((y + row) * W + x) * 4;
    out.set(src.data.subarray(srcOff, srcOff + w * 4), row * w * 4);
  }
  return { width: w, height: h, data: out };
}

/** Билинейный ресайз RGBA → RGBA. */
export function resizeImage(src, dstW, dstH) {
  dstW = Math.max(1, Math.round(dstW));
  dstH = Math.max(1, Math.round(dstH));
  const { width: srcW, height: srcH, data } = src;
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy = Math.min(srcH - 1, (dy + 0.5) * yRatio - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(srcH - 1, y0 + 1);
    const fy = sy - y0;
    for (let dx = 0; dx < dstW; dx++) {
      const sx = Math.min(srcW - 1, (dx + 0.5) * xRatio - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const fx = sx - x0;
      const i00 = (y0 * srcW + x0) * 4;
      const i01 = (y0 * srcW + x1) * 4;
      const i10 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;
      const o = (dy * dstW + dx) * 4;
      for (let c = 0; c < 4; c++) {
        const top = data[i00 + c] * (1 - fx) + data[i01 + c] * fx;
        const bot = data[i10 + c] * (1 - fx) + data[i11 + c] * fx;
        out[o + c] = top * (1 - fy) + bot * fy;
      }
    }
  }
  return { width: dstW, height: dstH, data: out };
}

/** Уменьшить, если длинная сторона больше maxSide (пропорционально). */
export function fitLongSide(src, maxSide) {
  const long = Math.max(src.width, src.height);
  if (long <= maxSide) return src;
  const k = maxSide / long;
  return resizeImage(src, Math.round(src.width * k), Math.round(src.height * k));
}

/** Поворот на 180°. */
export function rotate180(src) {
  const { width: W, height: H, data } = src;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = ((H - 1 - y) * W + (W - 1 - x)) * 4;
      const d = (y * W + x) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { width: W, height: H, data: out };
}

/** Поворот на 90° по часовой (вертикальный текст → горизонтальный, обратный порядок). */
export function rotate90cw(src) {
  const { width: W, height: H, data } = src;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 4;
      const d = ((W - 1 - x) * H + y) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { width: H, height: W, data: out };
}

/** Поворот на 90° против часовой (вертикальный текст → горизонтальный). */
export function rotate90ccw(src) {
  const { width: W, height: H, data } = src;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 4;
      const d = (x * H + (H - 1 - y)) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { width: H, height: W, data: out };
}

/**
 * RGBA → NCHW float32 с нормализацией: (v/255 - mean) / std для каждого канала RGB.
 * mean/std — массивы длины 3.
 */
export function toCHWNormalized(src, mean, std) {
  const { width: W, height: H, data } = src;
  const plane = W * H;
  const out = new Float32Array(3 * plane);
  const mr = 1 / std[0], mg = 1 / std[1], mb = 1 / std[2];
  for (let p = 0; p < plane; p++) {
    const i4 = p * 4;
    out[p] = (data[i4] / 255 - mean[0]) * mr;
    out[plane + p] = (data[i4 + 1] / 255 - mean[1]) * mg;
    out[2 * plane + p] = (data[i4 + 2] / 255 - mean[2]) * mb;
  }
  return out;
}

/** Пересчёт бокса [x0,y0,x1,y1] из координат одного изображения в другое. */
export function remapBox(box, fromW, fromH, toW, toH) {
  const kx = toW / fromW, ky = toH / fromH;
  return [box[0] * kx, box[1] * ky, box[2] * kx, box[3] * ky];
}

/** Кламп бокса в границы. */
export function clampBox(box, W, H) {
  const x0 = Math.max(0, Math.min(W - 1, box[0]));
  const y0 = Math.max(0, Math.min(H - 1, box[1]));
  const x1 = Math.max(x0 + 1, Math.min(W, box[2]));
  const y1 = Math.max(y0 + 1, Math.min(H, box[3]));
  return [x0, y0, x1, y1];
}

/** IoU двух боксов [x0,y0,x1,y1]. */
export function boxIoU(a, b) {
  const ix0 = Math.max(a[0], b[0]), iy0 = Math.max(a[1], b[1]);
  const ix1 = Math.min(a[2], b[2]), iy1 = Math.min(a[3], b[3]);
  const iw = Math.max(0, ix1 - ix0), ih = Math.max(0, iy1 - iy0);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter);
}

// ---------------- передача пикселей через chrome.runtime ----------------
// TypedArray в chrome.runtime.sendMessage доезжает не всегда: если хоп
// сериализует сообщение как JSON, Uint8ClampedArray превращается в обычный
// объект {0:..,1:..} — индексный доступ ещё работает, а .subarray в cropImage
// падает («src.data.subarray is not a function»). Поэтому пиксели передаются
// base64-строкой: она переживает любой сериализатор одинаково.

/** RGBA-данные (Uint8ClampedArray|Uint8Array|Array) → base64. */
export function encodeRgbaB64(data) {
  const u8 = (data instanceof Uint8ClampedArray || data instanceof Uint8Array)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data.length ? data : Object.values(data || {}));
  let s = '';
  const CH = 0x8000; // порциями, чтобы не упереться в лимит аргументов apply
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
  }
  return btoa(s);
}

/** base64 → Uint8Array пикселей. */
export function decodeRgbaB64(b64) {
  const s = atob(String(b64 || ''));
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
