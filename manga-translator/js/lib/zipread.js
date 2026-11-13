// zipread.js — чтение ZIP-архивов без внешних зависимостей.
// Распаковка: метод 0 (STORE) и метод 8 (DEFLATE) через нативный
// DecompressionStream('deflate-raw') (Chrome 103+, Node 18+).
// Используется для импорта пользовательских PP-OCR моделей (customocr.js).

/** CRC-32 (IEEE 802.3), little-endian полином 0xEDB88320. */
export function crc32(u8) {
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
export async function readZipEntries(buf) {
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
