// modelstore.js — хранение моделей в Cache API (только браузер).
// Скачивание с прогрессом, получение буферов, удаление, оценка занятого места.

const CACHE_NAME = 'mt-models-v1';

function cache() {
  return caches.open(CACHE_NAME);
}

export async function hasModel(url) {
  const c = await cache();
  return (await c.match(url)) !== undefined;
}

/** Скачать файл модели с прогрессом (onProgress: received, total). */
export async function downloadModelFile(url, { onProgress, signal } = {}) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} при скачивании модели`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    const c = await cache();
    await c.put(url, new Response(buf, { headers: { 'content-length': String(buf.byteLength) } }));
    return buf.byteLength;
  }
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (onProgress) onProgress(received, total);
  }
  const buf = new Uint8Array(received);
  let off = 0;
  for (const ch of chunks) { buf.set(ch, off); off += ch.byteLength; }
  const c = await cache();
  await c.put(url, new Response(buf.slice().buffer, { headers: { 'content-length': String(received) } }));
  return received;
}

/** Получить ArrayBuffer скачанной модели (или null). */
export async function getModelBuffer(url) {
  const c = await cache();
  const hit = await c.match(url);
  if (!hit) return null;
  return await hit.arrayBuffer();
}

export async function deleteModelFiles(urls) {
  const c = await cache();
  await Promise.all(urls.map(u => c.delete(u)));
  await invalidateUsageCache();
}

// ---------- пользовательские OCR-модели (импорт ZIP / папки / файлов / HF) ----------
// Храним в IndexedDB ('mtl-custom-ocr', store 'files'), ключ '<id>/<имя>'.
// Cache API для этого не годится: cache.put() принимает только http(s),
// а синтетические ключи custom://ocr/<id>/<file> дают в Chrome ошибку
// "Request scheme 'custom' is unsupported" (регрессия v1.4.x–v1.5.x: любой
// импорт кастомной OCR падал уже после валидации).
// Индекс записей ведёт service worker в chrome.storage.local ('customOcr').

const CUSTOM_IDB = 'mtl-custom-ocr';
const CUSTOM_STORE = 'files';
const CUSTOM_FILES = ['det.onnx', 'rec.onnx', 'dict.txt', 'meta.json'];
const customKey = (id, name) => `${id}/${name}`;

function customIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CUSTOM_IDB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(CUSTOM_STORE)) req.result.createObjectStore(CUSTOM_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB недоступна'));
  });
}

/** Одна транзакция: fn(store) → IDBRequest; резолвится после complete. */
async function customTx(mode, fn) {
  const db = await customIdb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CUSTOM_STORE, mode);
      const req = fn(tx.objectStore(CUSTOM_STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB: транзакция прервана'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB: ошибка транзакции'));
    });
  } finally {
    db.close();
  }
}

export async function putCustomOcrFiles(id, files) {
  await customTx('readwrite', (st) => {
    for (const [name, data] of Object.entries(files)) {
      if (!data) continue;
      const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      st.put(buf, customKey(id, name));
    }
  });
}

export async function getCustomOcrFiles(id) {
  // один диапазон ключей '<id>/…' — читаем только файлы этой модели
  const range = IDBKeyRange.bound(customKey(id, ''), `${customKey(id, '')}\uffff`);
  const db = await customIdb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CUSTOM_STORE, 'readonly');
      const st = tx.objectStore(CUSTOM_STORE);
      const keysReq = st.getAllKeys(range);
      const bufsReq = st.getAll(range);
      tx.oncomplete = () => {
        const out = {};
        (keysReq.result || []).forEach((key, i) => {
          const name = key.slice(id.length + 1);
          if (CUSTOM_FILES.includes(name)) {
            out[name.replace('.onnx', '').replace('.txt', '').replace('.json', '')] = bufsReq.result[i];
          }
        });
        resolve(out);
      };
      tx.onabort = () => reject(tx.error || new Error('IndexedDB: транзакция прервана'));
      tx.onerror = () => reject(tx.error || new Error('IndexedDB: ошибка транзакции'));
    });
  } finally {
    db.close();
  }
}

export async function getCustomOcrDict(id) {
  const buf = await customTx('readonly', (st) => st.get(customKey(id, 'dict.txt')));
  return buf ? new TextDecoder().decode(buf) : '';
}

export async function deleteCustomOcrFiles(id) {
  await customTx('readwrite', (st) => {
    for (const name of CUSTOM_FILES) st.delete(customKey(id, name));
  });
  await invalidateUsageCache();
}

export async function clearAllModels() {
  await caches.delete(CACHE_NAME);
  await customTx('readwrite', (st) => st.clear()).catch(() => { /* IDB могла не создаться */ });
  await invalidateUsageCache();
}

/** Сбросить кэшированную оценку занятого места (после удаления моделей). */
export async function invalidateUsageCache() {
  try { await chrome.storage?.session?.remove('modelsUsage'); } catch (e) { /* не критично */ }
}

/**
 * Реальный занятый объём хранилища моделей.
 * navigator.storage.estimate() в MV3-воркерах расширений почти всегда
 * возвращает usage = 0 (известное поведение Chrome), поэтому размер
 * считаем сами: сумма content-length записей кэша моделей; для записей
 * без заголовка — потоковый подсчёт байт (тело в память не читается).
 * Результат кэшируется на 60 с, чтобы popup не пересчитывал гигабайты
 * при каждом открытии. { usageMB, quotaMB }
 */
export async function storageUsage() {
  // свежий кэш оценки?
  try {
    const { modelsUsage } = await chrome.storage?.session?.get('modelsUsage') || {};
    if (modelsUsage && Date.now() - modelsUsage.at < 60_000) {
      return { usageMB: modelsUsage.usageMB, quotaMB: modelsUsage.quotaMB };
    }
  } catch (e) { /* session недоступна — считаем без кэша */ }

  let bytes = 0;
  let counted = false;
  try {
    const c = await cache();
    const keys = await c.keys();
    counted = true;
    for (const req of keys) {
      const res = await c.match(req);
      if (!res) continue;
      const cl = Number(res.headers.get('content-length'));
      if (Number.isFinite(cl) && cl > 0) { bytes += cl; continue; }
      // без content-length — считаем потоково, память константная
      if (res.body) {
        for await (const chunk of res.body) bytes += chunk.byteLength;
      }
    }
  } catch (e) { /* Cache API недоступен */ }

  // файлы кастомных OCR лежат в IndexedDB — прибавляем их к кэшу моделей
  try {
    const db = await customIdb();
    const bytesIdb = await new Promise((resolve, reject) => {
      const tx = db.transaction(CUSTOM_STORE, 'readonly');
      const req = tx.objectStore(CUSTOM_STORE).getAll();
      tx.oncomplete = () => resolve((req.result || []).reduce((s, b) => s + (b?.byteLength || 0), 0));
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    bytes += bytesIdb;
    counted = true;
  } catch (e) { /* IDB недоступна */ }

  if (!counted) {
    // последний шанс — estimate() (врёт, но лучше, чем ничего)
    try {
      const est = await navigator.storage.estimate();
      return { usageMB: (est.usage || 0) / 1048576, quotaMB: (est.quota || 0) / 1048576 };
    } catch (e2) {
      return { usageMB: 0, quotaMB: 0 };
    }
  }

  let quotaMB = 0;
  try {
    const est = await navigator.storage.estimate();
    quotaMB = (est.quota || 0) / 1048576;
  } catch (e) { /* квоту не узнали — покажем только занятое */ }

  const usageMB = bytes / 1048576;
  try { await chrome.storage?.session?.set({ modelsUsage: { at: Date.now(), usageMB, quotaMB } }); } catch (e) { /* не критично */ }
  return { usageMB, quotaMB };
}
