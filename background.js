/*
 * Clipboard Hub v6 - Background Service Worker
 *
 * Durable persistence for binary content (images/files) via IndexedDB.
 * Content scripts store lightweight metadata in storage.local and offload blob bytes here.
 */

const DB_NAME = 'clipboard_hub_v6';
const DB_VERSION = 1;
const STORE = 'blobs';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);

    Promise.resolve()
      .then(() => fn(store))
      .then((result) => {
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
      .catch(reject);
  });
}

async function putBlob({ id, buffer, mime, name, size, lastModified }) {
  const blob = new Blob([buffer], { type: mime || 'application/octet-stream' });
  await withStore('readwrite', (store) =>
    store.put({ id, blob, mime, name, size, lastModified, savedAt: Date.now() })
  );
  return { ok: true };
}

async function getBlob({ id }) {
  const record = await withStore('readonly', (store) => {
    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  });

  if (!record) return { ok: false, error: 'not_found' };

  const buffer = await record.blob.arrayBuffer();
  return {
    ok: true,
    id: record.id,
    buffer,
    mime: record.mime || record.blob.type || 'application/octet-stream',
    name: record.name || '',
    size: record.size ?? record.blob.size,
    lastModified: record.lastModified ?? 0
  };
}

async function deleteBlob({ id }) {
  await withStore('readwrite', (store) => store.delete(id));
  return { ok: true };
}

async function clearAll() {
  await withStore('readwrite', (store) => store.clear());
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || typeof msg !== 'object') return sendResponse({ ok: false, error: 'bad_request' });

      switch (msg.type) {
        case 'blob.put':
          return sendResponse(await putBlob(msg.payload));
        case 'blob.get':
          return sendResponse(await getBlob(msg.payload));
        case 'blob.delete':
          return sendResponse(await deleteBlob(msg.payload));
        case 'blob.clear':
          return sendResponse(await clearAll());
        case 'ping':
          return sendResponse({ ok: true, ts: Date.now() });
        default:
          return sendResponse({ ok: false, error: 'unknown_type' });
      }
    } catch (e) {
      return sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  // keep channel open
  return true;
});
