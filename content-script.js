/**
 * Clipboard Hub v6 - Pure & Elegant
 *
 * Requirements implemented:
 * - Multi-type / batch paste: iterates all clipboard items (files/images/text/html) and supports mixed content.
 * - Smart "Copy All": writes a ClipboardItem with BOTH text/html and text/plain so Word / Notion / Mail can paste images + text together.
 * - Durable persistence: metadata in storage.local; binary blobs persisted via background IndexedDB (service worker).
 * - Double paste bug: strong de-dupe (time-window signature) + single ingest queue.
 * - UI/UX: bottom-right floating FAB, glassmorphism drawer, smooth animations, Shadow DOM isolation, overflow-safe text rendering.
 */
(() => {
  // Prevent double injection
  if (window.__CLIPBOARD_HUB_V6__) return;
  window.__CLIPBOARD_HUB_V6__ = true;

  const ext = (typeof browser !== 'undefined') ? browser : chrome;

  // ---------------------------
  // Promise helpers (Chrome/Firefox compatible)
  // ---------------------------
  const isPromiseAPI = !!(typeof browser !== 'undefined' && browser?.storage?.local?.get);
  const storageGet = (key) =>
    isPromiseAPI
      ? ext.storage.local.get(key)
      : new Promise((resolve) => ext.storage.local.get(key, resolve));

  const storageSet = (obj) =>
    isPromiseAPI
      ? ext.storage.local.set(obj)
      : new Promise((resolve) => ext.storage.local.set(obj, resolve));

  const runtimeSend = (type, payload) => {
    // Firefox (browser.*) returns a promise; Chrome uses callback + lastError
    try {
      const maybePromise = ext.runtime.sendMessage({ type, payload });
      if (maybePromise && typeof maybePromise.then === 'function') return maybePromise;
    } catch (_) {}
    return new Promise((resolve, reject) => {
      ext.runtime.sendMessage({ type, payload }, (resp) => {
        const err = ext.runtime.lastError;
        if (err) return reject(err);
        resolve(resp);
      });
    });
  };

  // ---------------------------
  // Constants
  // ---------------------------
  const STORAGE_KEY = 'clip_hub_v6_state';
  const OLD_KEY = 'clip_hub_v5_data';
  const INGEST_DEDUP_WINDOW_MS = 900;
  const IMAGE_SOFT_LIMIT = 2 * 1024 * 1024; // compress candidates above this
  const IMAGE_MAX_DIM = 2048;

  // ---------------------------
  // Small utilities
  // ---------------------------
  const uid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2));
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  function formatBytes(bytes = 0) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes;
    let u = 0;
    while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
    const v = (u === 0) ? String(Math.round(n)) : n.toFixed(1);
    return `${v} ${units[u]}`;
  }

  // FNV-1a 32-bit hash (fast, good enough for de-dupe)
  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  // Very lightweight sanitizer: strips scripts/styles + inline handlers.
  function sanitizeHtml(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc.querySelectorAll('script, style, link[rel="stylesheet"]').forEach((n) => n.remove());
      doc.querySelectorAll('*').forEach((el) => {
        [...el.attributes].forEach((a) => {
          if (a.name.startsWith('on')) el.removeAttribute(a.name);
        });
      });
      return doc.body.innerHTML || '';
    } catch (_) {
      return '';
    }
  }

  async function readDTString(dtItem) {
    return new Promise((resolve) => dtItem.getAsString((s) => resolve(s ?? '')));
  }

  async function blobToDataUrl(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(blob);
    });
  }

  async function maybeCompressImage(blob) {
    if (!blob || !blob.type || !blob.type.startsWith('image/')) return blob;
    if (blob.size <= IMAGE_SOFT_LIMIT) return blob;

    try {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      URL.revokeObjectURL(url);

      const maxDim = Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);
      const scale = clamp(IMAGE_MAX_DIM / maxDim, 0.15, 1);

      if (scale >= 0.999) return blob;

      const w = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
      const h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return blob;
      ctx.drawImage(img, 0, 0, w, h);

      const out = await new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b), 'image/webp', 0.88);
      });

      if (out && out.size && out.size < blob.size) return out;
      return blob;
    } catch (_) {
      return blob;
    }
  }

  // ---------------------------
  // Shadow DOM UI
  // ---------------------------
  const host = document.createElement('div');
  host.style.all = 'initial';
  host.style.position = 'fixed';
  host.style.zIndex = '2147483647';
  host.style.inset = '0';
  host.style.pointerEvents = 'none'; // re-enable on internal root
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  const svg = (p, s = 20) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

  const ICONS = {
    layers: svg('<polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline>'),
    close: svg('<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>'),
    copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>'),
    trash: svg('<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>'),
    img: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>'),
    file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>'),
    wand: svg('<path d="M15 4l5 5"></path><path d="M13 6l5 5"></path><path d="M3 21l9-9"></path><path d="M12 12l3 3"></path>'),
    paste: svg('<path d="M19 21H8a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"></path><path d="M14 3h4a2 2 0 0 1 2 2v4"></path><rect x="10" y="3" width="4" height="4" rx="1"></rect>')
  };

  shadow.innerHTML = `
<style>
  :host {
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;

    --text: rgba(255,255,255,0.92);
    --sub: rgba(235,235,245,0.65);
    --border: rgba(255,255,255,0.12);
    --shadow: 0 22px 60px rgba(0,0,0,0.55);

    --panel: rgba(28,28,30,0.70);
    --panel2: rgba(44,44,46,0.60);

    --accent: #0a84ff;
    --danger: #ff453a;
    --good: #30d158;
  }

  * { box-sizing: border-box; }

  #hub-root { pointer-events: auto; font-family: var(--font); }

  /* Backdrop */
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.40);
    opacity: 0;
    pointer-events: none;
    transition: opacity 220ms ease;
  }
  .open .backdrop {
    opacity: 1;
    pointer-events: auto;
  }

  /* FAB */
  .fab {
    position: fixed;
    right: 22px;
    bottom: 22px;
    width: 58px;
    height: 58px;
    border-radius: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    user-select: none;

    color: var(--text);
    background: linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.04));
    border: 1px solid var(--border);
    box-shadow: 0 12px 34px rgba(0,0,0,0.35);
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);

    transition: transform 140ms ease, filter 140ms ease;
  }
  .fab:hover { transform: translateY(-1px) scale(1.04); filter: brightness(1.06); }
  .fab:active { transform: scale(0.96); }
  .open .fab { display: none; }

  .badge {
    position: absolute;
    top: -6px;
    right: -6px;
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    border-radius: 999px;
    display: none;
    align-items: center;
    justify-content: center;
    background: var(--accent);
    color: white;
    font-size: 12px;
    font-weight: 700;
    box-shadow: 0 10px 18px rgba(10,132,255,0.35);
  }
  .badge.show { display: flex; }

  /* Drawer */
  .drawer {
    position: fixed;
    right: 16px;
    top: 16px;
    bottom: 16px;
    width: 400px;
    max-width: calc(100vw - 28px);

    border-radius: 20px;
    border: 1px solid var(--border);
    box-shadow: var(--shadow);

    background: var(--panel);
    backdrop-filter: blur(22px) saturate(160%);
    -webkit-backdrop-filter: blur(22px) saturate(160%);

    overflow: hidden;

    display: flex;
    flex-direction: column;

    transform: translateX(120%);
    opacity: 0.98;
    transition: transform 320ms cubic-bezier(0.2, 0.85, 0.2, 1), opacity 280ms ease;
  }
  .open .drawer { transform: translateX(0); opacity: 1; }

  /* Header */
  .header {
    padding: 16px 16px 12px;
    border-bottom: 1px solid rgba(255,255,255,0.10);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 700;
    letter-spacing: 0.2px;
    color: var(--text);
    font-size: 15px;
  }
  .subtitle {
    font-size: 12px;
    color: var(--sub);
    margin-top: 3px;
    font-weight: 500;
  }
  .title-wrap { display: flex; flex-direction: column; }
  .iconbtn {
    width: 36px;
    height: 36px;
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.10);
    background: rgba(255,255,255,0.04);
    color: var(--text);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 140ms ease, background 160ms ease;
  }
  .iconbtn:hover { background: rgba(255,255,255,0.08); transform: translateY(-1px); }
  .iconbtn:active { transform: scale(0.97); }

  /* Controls */
  .controls {
    padding: 12px 16px 10px;
    display: grid;
    gap: 10px;
  }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

  .btn {
    height: 38px;
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.10);
    background: rgba(255,255,255,0.06);
    color: var(--text);
    font-size: 13px;
    font-weight: 650;
    cursor: pointer;
    transition: transform 140ms ease, filter 140ms ease, background 160ms ease;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .btn:hover { filter: brightness(1.06); transform: translateY(-1px); background: rgba(255,255,255,0.09); }
  .btn:active { transform: scale(0.98); }
  .btn.primary {
    border-color: rgba(10,132,255,0.45);
    background: rgba(10,132,255,0.22);
  }
  .btn.danger { color: #ffd6d3; border-color: rgba(255,69,58,0.45); background: rgba(255,69,58,0.14); }

  .drop {
    border: 1px dashed rgba(255,255,255,0.22);
    border-radius: 14px;
    padding: 12px;
    text-align: center;
    color: var(--sub);
    font-size: 12px;
    line-height: 1.35;
    background: rgba(255,255,255,0.03);
    cursor: pointer;
    transition: border-color 140ms ease, background 140ms ease, color 140ms ease;
  }
  .drop:hover {
    border-color: rgba(10,132,255,0.65);
    background: rgba(10,132,255,0.10);
    color: rgba(235,235,245,0.82);
  }

  /* List */
  .list {
    flex: 1;
    padding: 10px 16px 16px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .list::-webkit-scrollbar { width: 6px; }
  .list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.16); border-radius: 999px; }
  .list::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }

  .empty {
    margin-top: 36px;
    text-align: center;
    color: var(--sub);
    font-size: 13px;
  }

  /* Card */
  .card {
    border-radius: 16px;
    border: 1px solid rgba(255,255,255,0.10);
    background: rgba(255,255,255,0.06);
    overflow: hidden;
    box-shadow: 0 10px 26px rgba(0,0,0,0.18);
    animation: rise 180ms ease;
  }
  @keyframes rise {
    from { transform: translateY(6px); opacity: 0.0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .card-head {
    padding: 10px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  .meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .kind {
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.3px;
    color: rgba(255,255,255,0.86);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .when {
    font-size: 12px;
    color: var(--sub);
  }
  .card-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }
  .mini {
    width: 34px;
    height: 34px;
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.10);
    background: rgba(255,255,255,0.04);
    color: rgba(255,255,255,0.88);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 140ms ease, background 160ms ease;
  }
  .mini:hover { background: rgba(255,255,255,0.08); transform: translateY(-1px); }
  .mini:active { transform: scale(0.98); }
  .mini.danger { color: #ffd6d3; border-color: rgba(255,69,58,0.35); background: rgba(255,69,58,0.10); }

  .body { padding: 12px; }

  .text-box {
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.45;
    color: rgba(235,235,245,0.88);
    background: rgba(0,0,0,0.18);
    border: 1px solid rgba(255,255,255,0.06);
    border-radius: 12px;
    padding: 10px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .text-box.clamp {
    display: -webkit-box;
    -webkit-line-clamp: 7;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .text-more {
    margin-top: 8px;
    font-size: 12px;
    color: rgba(10,132,255,0.95);
    cursor: pointer;
    user-select: none;
  }

  .img {
    width: 100%;
    max-height: 220px;
    object-fit: contain;
    border-radius: 12px;
    background: rgba(0,0,0,0.22);
    border: 1px solid rgba(255,255,255,0.06);
  }

  .file-row {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 10px;
    border-radius: 12px;
    background: rgba(0,0,0,0.16);
    border: 1px solid rgba(255,255,255,0.06);
    color: rgba(235,235,245,0.88);
    min-width: 0;
  }
  .file-row .name {
    font-weight: 700;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-row .sub {
    font-size: 12px;
    color: var(--sub);
  }
  .file-text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }

  /* Toast */
  .toast {
    position: fixed;
    left: 50%;
    bottom: 32px;
    transform: translate(-50%, 14px);
    opacity: 0;
    pointer-events: none;
    transition: transform 180ms ease, opacity 180ms ease;
    padding: 10px 14px;
    border-radius: 999px;
    background: rgba(255,255,255,0.92);
    color: rgba(0,0,0,0.86);
    font-weight: 800;
    font-size: 13px;
    box-shadow: 0 16px 40px rgba(0,0,0,0.35);
  }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }
</style>

<div id="hub-root">
  <div class="backdrop" id="backdrop"></div>

  <div class="fab" id="fab" title="Clipboard Hub">
    ${ICONS.layers}
    <div class="badge" id="badge">0</div>
  </div>

  <div class="drawer" role="dialog" aria-label="Clipboard Hub">
    <div class="header">
      <div class="title-wrap">
        <div class="title">${ICONS.layers} Clipboard Hub</div>
        <div class="subtitle" id="subtitle">Paste multiple items, then Copy All as rich content.</div>
      </div>
      <button class="iconbtn" id="btn-close" title="Close">${ICONS.close}</button>
    </div>

    <div class="controls">
      <button class="btn primary" id="btn-smart" title="Read from Clipboard API">${ICONS.wand} Smart Paste (Clipboard)</button>
      <div class="row">
        <button class="btn" id="btn-copy-all">${ICONS.copy} Copy All</button>
        <button class="btn danger" id="btn-clear">${ICONS.trash} Clear</button>
      </div>
      <div class="drop" id="drop-target">
        Click here and press <b>Ctrl/⌘ + V</b><br/>
        or drop files/images here
      </div>
    </div>

    <textarea id="trap" aria-hidden="true" style="position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;"></textarea>
    <div class="list" id="list"></div>
  </div>

  <div class="toast" id="toast">Copied</div>
</div>
`;

  const $ = (id) => shadow.getElementById(id);
  const root = $('hub-root');
  const listEl = $('list');
  const trap = $('trap');
  const toastEl = $('toast');
  const badgeEl = $('badge');
  const subtitleEl = $('subtitle');

  // ---------------------------
  // State
  // ---------------------------
  /** @type {{ items: Array<any> }} */
  const state = { items: [] };

  /** blob cache: blobId -> { blob, url } */
  const blobCache = new Map();

  // ---------------------------
  // Toast
  // ---------------------------
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1400);
  }

  function setSubtitle(msg) {
    subtitleEl.textContent = msg;
  }

  // ---------------------------
  // Persistence (metadata in storage.local; blobs in background IDB)
  // ---------------------------
  async function persistMetadata() {
    const serializable = state.items.map((it) => {
      const { expanded, pending, error, ...rest } = it;
      return rest;
    });
    try {
      await storageSet({ [STORAGE_KEY]: serializable });
    } catch (e) {
      console.error('storageSet failed', e);
      toast('Storage quota hit');
    }
  }

  async function restoreBlobs(items) {
    for (const it of items) {
      if (!it.blobId) continue;
      if (blobCache.has(it.blobId)) continue;
      try {
        const resp = await runtimeSend('blob.get', { id: it.blobId });
        if (!resp?.ok || !resp?.buffer) continue;
        const blob = new Blob([resp.buffer], { type: resp.mime || it.mime || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        blobCache.set(it.blobId, { blob, url });
        it.mime = it.mime || resp.mime;
        it.size = it.size || resp.size;
      } catch (e) {
        console.warn('restore blob failed', it.blobId, e);
      }
    }
  }

  async function load() {
    // v6 state
    const res = await storageGet([STORAGE_KEY, OLD_KEY]);
    const items = res?.[STORAGE_KEY] || [];
    state.items = Array.isArray(items) ? items : [];

    // one-time migration from v5 (best-effort)
    if (!state.items.length && Array.isArray(res?.[OLD_KEY]) && res[OLD_KEY].length) {
      const migrated = [];
      for (const it of res[OLD_KEY]) {
        if (!it || typeof it !== 'object') continue;
        if (it.kind === 'text') {
          migrated.push({
            id: uid(),
            kind: 'text',
            createdAt: it.createdAt || Date.now(),
            text: it.text || '',
            html: it.html || ''
          });
        } else if (it.kind === 'image') {
          const dataUrl = it.dataUrlPersisted || it.dataUrl || '';
          migrated.push({
            id: uid(),
            kind: 'image',
            createdAt: it.createdAt || Date.now(),
            name: it.name || 'image',
            mime: it.mime || '',
            size: it.size || 0,
            dataUrl
          });
        }
        // v5 file items usually weren't persistable; we skip to avoid broken entries.
      }
      state.items = migrated;
      await persistMetadata();
      toast('Migrated v5 items');
    }

    await restoreBlobs(state.items);
    render();
  }

  // ---------------------------
  // Item operations
  // ---------------------------
  function addItemLocal(it) {
    state.items.unshift(it);
    render();
    persistMetadata();
  }

  function removeItem(id) {
    const idx = state.items.findIndex((x) => x.id === id);
    if (idx < 0) return;

    const it = state.items[idx];
    state.items.splice(idx, 1);

    if (it?.blobId && blobCache.has(it.blobId)) {
      try { URL.revokeObjectURL(blobCache.get(it.blobId).url); } catch (_) {}
      blobCache.delete(it.blobId);
      runtimeSend('blob.delete', { id: it.blobId }).catch(() => {});
    }

    render();
    persistMetadata();
  }

  async function clearAll() {
    // cleanup URLs
    for (const [_, v] of blobCache) {
      try { URL.revokeObjectURL(v.url); } catch (_) {}
    }
    blobCache.clear();
    state.items = [];
    render();
    await persistMetadata();
    runtimeSend('blob.clear', {}).catch(() => {});
    toast('Cleared');
  }

  // Store blob in background IDB; fallback to dataUrl if background is unavailable
  async function persistBlobToBackground(id, fileLike) {
    const buf = await fileLike.arrayBuffer();
    const resp = await runtimeSend('blob.put', {
      id,
      buffer: buf,
      mime: fileLike.type || 'application/octet-stream',
      name: fileLike.name || '',
      size: fileLike.size || buf.byteLength,
      lastModified: fileLike.lastModified || 0
    });
    if (!resp?.ok) throw new Error(resp?.error || 'blob_put_failed');
  }

  async function addBlob({ blob, name = '', kindHint = 'file' }) {
    const id = uid();

    // Keep filename if provided; after compression we may lose File-ness, so re-wrap.
    const originalName = name || (blob && 'name' in blob ? blob.name : '') || '';

    let working = blob;
    if (blob?.type?.startsWith('image/')) {
      working = await maybeCompressImage(blob);
    }

    const mime = working?.type || blob?.type || 'application/octet-stream';
    const fileName =
      originalName ||
      (mime.startsWith('image/') ? `image.${(mime.split('/')[1] || 'png')}` : 'file');

    const fileToPersist =
      (working instanceof File)
        ? working
        : new File([working], fileName, { type: mime, lastModified: Date.now() });

    const url = URL.createObjectURL(fileToPersist);
    blobCache.set(id, { blob: fileToPersist, url });

    const kind = mime.startsWith('image/') ? 'image' : kindHint;

    const item = {
      id,
      blobId: id,
      kind,
      createdAt: Date.now(),
      name: fileName,
      mime,
      size: fileToPersist.size || 0,
      pending: true
    };

    addItemLocal(item);

    try {
      await persistBlobToBackground(id, fileToPersist);
      item.pending = false;
      render();
      persistMetadata();
    } catch (e) {
      console.error('persist blob failed', e);
      item.pending = false;
      item.error = 'persist_failed';

      // Fallback: store as dataURL in metadata (quota-limited)
      try {
        const dataUrl = await blobToDataUrl(fileToPersist);
        item.dataUrl = dataUrl;
        render();
        persistMetadata();
        toast('Saved (fallback)');
      } catch (_) {
        toast('Saved (session only)');
      }
    }
  }

  function addText({ text, html }) {
    const t = (text || '').trimEnd();
    const h = (html || '').trimEnd();
    if (!t && !h) return;

    addItemLocal({
      id: uid(),
      kind: 'text',
      createdAt: Date.now(),
      text: t || '',
      html: h || ''
    });
  }

  // ---------------------------
  // Ingest (paste) - robust de-dupe & queue
  // ---------------------------
  let lastIngest = { sig: '', at: 0 };
  let ingestQueue = Promise.resolve();

  function enqueueIngest(fn) {
    ingestQueue = ingestQueue.then(fn).catch((e) => console.error('ingest error', e));
    return ingestQueue;
  }

  async function ingestCandidates(candidates, sourceLabel) {
    // candidates: [{type:'text', plain?, html?} | {type:'file', file:File}]
    // Build signature (reads small parts only; avoids heavy work)
    const sigParts = [];
    for (const c of candidates) {
      if (c.type === 'file') {
        const f = c.file;
        sigParts.push(`F:${f.type}|${f.size}|${f.name || ''}`);
      } else {
        const p = (c.plain || '').slice(0, 256);
        const h = (c.html || '').slice(0, 256);
        sigParts.push(`T:${hash32(p)}:${hash32(h)}:${(c.plain || '').length}:${(c.html || '').length}`);
      }
    }
    const sig = hash32(sigParts.join('||'));
    const now = Date.now();
    if (sig === lastIngest.sig && (now - lastIngest.at) < INGEST_DEDUP_WINDOW_MS) {
      return; // drop duplicate batch
    }
    lastIngest = { sig, at: now };

    let added = 0;
    for (const c of candidates) {
      if (c.type === 'file') {
        const f = c.file;
        if (!f) continue;
        await addBlob({ blob: f, name: f.name || '', kindHint: 'file' });
        added++;
      } else {
        const plain = c.plain || '';
        const html = c.html || '';
        if (!plain && !html) continue;
        addText({ text: plain, html });
        added++;
      }
    }

    if (added) toast(`Added ${added} item${added > 1 ? 's' : ''}`);
    else if (sourceLabel) toast('Nothing to add');
  }

  async function ingestFromPasteEvent(e) {
    const dt = e.clipboardData;
    if (!dt || !dt.items || !dt.items.length) return;

    const raw = Array.from(dt.items);

    // Convert dt.items to ordered candidates:
    // - Merge adjacent text/plain + text/html into a single text candidate (prefer to keep both).
    const candidates = [];
    let pendingText = { plain: '', html: '' };

    for (const it of raw) {
      if (it.kind === 'file') {
        if (pendingText.plain || pendingText.html) {
          candidates.push({ type: 'text', plain: pendingText.plain, html: pendingText.html });
          pendingText = { plain: '', html: '' };
        }
        const file = it.getAsFile();
        if (file) candidates.push({ type: 'file', file });
        continue;
      }

      if (it.kind === 'string') {
        if (it.type === 'text/plain') pendingText.plain = (await readDTString(it)) || pendingText.plain;
        else if (it.type === 'text/html') pendingText.html = (await readDTString(it)) || pendingText.html;
        else if (it.type === 'text/uri-list') {
          const url = (await readDTString(it)).trim();
          if (url) pendingText.plain = pendingText.plain ? (pendingText.plain + '\n' + url) : url;
        }
      }
    }

    if (pendingText.plain || pendingText.html) candidates.push({ type: 'text', plain: pendingText.plain, html: pendingText.html });

    await ingestCandidates(candidates, 'paste');
  }

  async function smartPasteFromClipboardAPI() {
    // Requires user gesture (button click).
    // We intentionally extract *all* types per ClipboardItem to support mixed content.
    const items = await navigator.clipboard.read();

    /** @type {Array<any>} */
    const candidates = [];

    for (const clipItem of items) {
      const types = Array.isArray(clipItem.types) ? clipItem.types : [];

      // text
      let html = '';
      let plain = '';
      if (types.includes('text/html')) {
        try {
          const b = await clipItem.getType('text/html');
          html = await b.text();
        } catch (_) {}
      }
      if (types.includes('text/plain')) {
        try {
          const b = await clipItem.getType('text/plain');
          plain = await b.text();
        } catch (_) {}
      }
      if (plain || html) {
        candidates.push({ type: 'text', plain, html });
      }

      // images + other binary types
      for (const t of types) {
        if (t.startsWith('image/')) {
          try {
            const blob = await clipItem.getType(t);
            const extGuess = t.split('/')[1] || 'png';
            candidates.push({ type: 'file', file: new File([blob], `clipboard-image.${extGuess}`, { type: t }) });
          } catch (_) {}
          continue;
        }
        if (t === 'text/plain' || t === 'text/html') continue;

        // best-effort: treat other binary formats as file
        if (!t.startsWith('text/')) {
          try {
            const blob = await clipItem.getType(t);
            const extGuess = (t.split('/')[1] || 'bin').replace(/[^a-z0-9]+/gi, '');
            candidates.push({ type: 'file', file: new File([blob], `clipboard.${extGuess || 'bin'}`, { type: t }) });
          } catch (_) {}
        }
      }
    }

    await ingestCandidates(candidates, 'smart');
  }

  // ---------------------------
  // Copy logic
  // ---------------------------
  async function copySingle(it) {
    if (!it) return;

    if (it.kind === 'text') {
      const s = it.text || '';
      await navigator.clipboard.writeText(s);
      toast('Copied text');
      return;
    }

    const blobId = it.blobId || it.id;
    const cache = blobCache.get(blobId);
    const blob = cache?.blob;

    if (!blob && it.dataUrl) {
      // fallback restore
      const r = await fetch(it.dataUrl);
      const b = await r.blob();
      await navigator.clipboard.write([new ClipboardItem({ [b.type || 'application/octet-stream']: b })]);
      toast('Copied');
      return;
    }

    if (!blob) return toast('Missing blob');

    try {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'application/octet-stream']: blob })]);
      toast(it.kind === 'image' ? 'Copied image' : 'Copied file');
    } catch (e) {
      // Some platforms disallow arbitrary file mime on clipboard
      try {
        const dataUrl = await blobToDataUrl(blob);
        await navigator.clipboard.writeText(dataUrl);
        toast('Copied as data URL');
      } catch (_) {
        toast('Copy blocked');
      }
    }
  }

  async function copyAll() {
    if (!state.items.length) return toast('Empty');

    // Build HTML with minimal inline styles to survive across apps.
    let htmlParts = [];
    let textParts = [];

    htmlParts.push(`<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;color:#111;">`);

    for (const it of [...state.items].reverse()) {
      // reverse so the oldest appears first when pasting
      if (it.kind === 'text') {
        const safeHtml = it.html ? sanitizeHtml(it.html) : '';
        const block = safeHtml
          ? `<div style="margin:0 0 10px 0;">${safeHtml}</div>`
          : `<div style="margin:0 0 10px 0;white-space:pre-wrap;">${escapeHtml(it.text || '').replaceAll('\n', '<br>')}</div>`;
        htmlParts.push(block);
        textParts.push(it.text || (it.html ? '[Rich Text]' : ''));
        continue;
      }

      const blobId = it.blobId || it.id;
      const cache = blobCache.get(blobId);
      let blob = cache?.blob;

      if (!blob && it.dataUrl) {
        try { blob = await (await fetch(it.dataUrl)).blob(); } catch (_) {}
      }

      if (it.kind === 'image') {
        if (blob) {
          const dataUrl = await blobToDataUrl(blob);
          htmlParts.push(
            `<div style="margin:0 0 10px 0;">` +
              `<img src="${dataUrl}" alt="" style="max-width:100%;height:auto;border-radius:10px;border:1px solid rgba(0,0,0,0.08);" />` +
            `</div>`
          );
        } else {
          htmlParts.push(`<div style="margin:0 0 10px 0;color:#666;">[Image missing]</div>`);
        }
        textParts.push('[Image]');
        continue;
      }

      // file
      const name = escapeHtml(it.name || 'file');
      const meta = escapeHtml(`${formatBytes(it.size || 0)} · ${it.mime || 'application/octet-stream'}`);
      htmlParts.push(
        `<div style="margin:0 0 10px 0;padding:10px 12px;border-radius:12px;border:1px solid rgba(0,0,0,0.08);background:#f7f7f8;">` +
          `<div style="font-weight:700;margin-bottom:2px;">📎 ${name}</div>` +
          `<div style="font-size:12px;color:#666;">${meta}</div>` +
        `</div>`
      );
      textParts.push(`[File] ${it.name || ''} (${formatBytes(it.size || 0)})`);
    }

    htmlParts.push(`</div>`);

    const html = htmlParts.join('');
    const text = textParts.join('\n\n');

    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' })
        })
      ]);
      toast('Copied (rich)');
    } catch (e) {
      console.error('copyAll failed', e);
      try {
        await navigator.clipboard.writeText(text);
        toast('Copied (text only)');
      } catch (_) {
        toast('Copy blocked');
      }
    }
  }

  // ---------------------------
  // Render
  // ---------------------------
  function timeAgo(ts) {
    const d = Date.now() - ts;
    const s = Math.floor(d / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const days = Math.floor(h / 24);
    return `${days}d ago`;
  }

  function updateBadge() {
    const n = state.items.length;
    badgeEl.textContent = String(n);
    badgeEl.classList.toggle('show', n > 0);
  }

  function render() {
    updateBadge();
    listEl.innerHTML = '';

    if (!state.items.length) {
      listEl.innerHTML = `<div class="empty">Empty. Open the hub and paste (Ctrl/⌘+V), or use Smart Paste.</div>`;
      return;
    }

    for (const it of state.items) {
      const card = document.createElement('div');
      card.className = 'card';

      const head = document.createElement('div');
      head.className = 'card-head';

      const meta = document.createElement('div');
      meta.className = 'meta';

      const kindIcon = it.kind === 'image' ? ICONS.img : (it.kind === 'file' ? ICONS.file : ICONS.paste);
      meta.innerHTML = `
        <div class="kind">${kindIcon}<span>${(it.kind || '').toUpperCase()}${it.pending ? ' · Saving…' : ''}${it.error ? ' · ⚠' : ''}</span></div>
        <div class="when">${timeAgo(it.createdAt || Date.now())}</div>
      `;

      const acts = document.createElement('div');
      acts.className = 'card-actions';

      const bCopy = document.createElement('button');
      bCopy.className = 'mini';
      bCopy.title = 'Copy';
      bCopy.innerHTML = ICONS.copy;
      bCopy.onclick = () => copySingle(it);

      const bDel = document.createElement('button');
      bDel.className = 'mini danger';
      bDel.title = 'Delete';
      bDel.innerHTML = ICONS.trash;
      bDel.onclick = () => removeItem(it.id);

      acts.appendChild(bCopy);
      acts.appendChild(bDel);

      head.appendChild(meta);
      head.appendChild(acts);

      const body = document.createElement('div');
      body.className = 'body';

      if (it.kind === 'text') {
        const box = document.createElement('div');
        box.className = 'text-box clamp';
        const t = (it.text || '').trim();
        box.textContent = t || (it.html ? '[Rich text]' : '');
        body.appendChild(box);

        if ((it.text || '').length > 280 || (it.text || '').split('\n').length > 8) {
          const more = document.createElement('div');
          more.className = 'text-more';
          more.textContent = it.expanded ? 'Collapse' : 'Show more';
          more.onclick = () => {
            it.expanded = !it.expanded;
            box.classList.toggle('clamp', !it.expanded);
            more.textContent = it.expanded ? 'Collapse' : 'Show more';
          };
          body.appendChild(more);
        }
      } else if (it.kind === 'image') {
        const img = document.createElement('img');
        img.className = 'img';
        const cache = blobCache.get(it.blobId || it.id);
        img.src = cache?.url || it.dataUrl || '';
        body.appendChild(img);
      } else {
        const row = document.createElement('div');
        row.className = 'file-row';

        row.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.10);">
            ${ICONS.file}
          </div>
          <div class="file-text">
            <div class="name">${escapeHtml(it.name || 'file')}</div>
            <div class="sub">${escapeHtml(formatBytes(it.size || 0))} · ${escapeHtml(it.mime || 'application/octet-stream')}</div>
          </div>
        `;
        body.appendChild(row);
      }

      card.appendChild(head);
      card.appendChild(body);
      listEl.appendChild(card);
    }
  }

  // ---------------------------
  // UI toggles + events
  // ---------------------------
  const toggleOpen = (open) => {
    const isOpen = root.classList.contains('open');
    const next = (typeof open === 'boolean') ? open : !isOpen;
    root.classList.toggle('open', next);
    if (next) {
      setTimeout(() => trap.focus(), 0);
      setSubtitle('Paste multiple items (Ctrl/⌘+V) — images + text are supported together.');
    }
  };

  $('fab').onclick = () => toggleOpen(true);
  $('btn-close').onclick = () => toggleOpen(false);
  $('backdrop').onclick = () => toggleOpen(false);
  $('drop-target').onclick = () => trap.focus();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.classList.contains('open')) toggleOpen(false);
  }, true);

  // Paste capture: only while open; capture phase to beat page handlers.
  window.addEventListener('paste', (e) => {
    if (!root.classList.contains('open')) return;

    // Ignore pastes that are targeting editable elements outside the hub.
    const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
    const isHubTarget = path.includes(host) || path.includes(trap);
    if (!isHubTarget) {
      // If the user is typing into a page input, don't steal paste.
      const t = e.target;
      const isEditable = !!(t && (t.isContentEditable || ['INPUT', 'TEXTAREA'].includes(t.tagName)));
      if (isEditable) return;
    }

    if (e.clipboardData?.items?.length) {
      e.preventDefault();
      e.stopPropagation();
      enqueueIngest(() => ingestFromPasteEvent(e));
    }
  }, true);

  // Drag & drop
  const drawer = shadow.querySelector('.drawer');
  drawer.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  drawer.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    enqueueIngest(async () => {
      const candidates = files.map((f) => ({ type: 'file', file: f }));
      await ingestCandidates(candidates, 'drop');
    });
  });

  // Buttons
  $('btn-clear').onclick = () => clearAll();
  $('btn-copy-all').onclick = () => copyAll();
  $('btn-smart').onclick = () => enqueueIngest(async () => {
    try {
      await smartPasteFromClipboardAPI();
    } catch (e) {
      console.warn('Smart paste failed, fallback to manual paste', e);
      toast('Smart Paste blocked — use Ctrl/⌘+V');
      trap.focus();
    }
  });

  // Init
  load();

})();
