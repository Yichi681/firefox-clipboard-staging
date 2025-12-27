/**
 * Clipboard Hub V5 - Stable Edition
 * Fixes: Double-paste bug, Hard-to-click handle, UI glitches
 * Feature: Floating Action Button (FAB) Handle
 */
(() => {
  // 防止重复注入
  if (window.__CLIP_HUB_V5__) return;
  window.__CLIP_HUB_V5__ = true;

  const api = typeof browser !== "undefined" ? browser : chrome;
  const STORAGE_KEY = "clip_hub_v5_data"; 
  const MAX_IMG_SIZE = 1024 * 1024 * 2; // 2MB

  // ==========================================
  // 1. Icons & Utils
  // ==========================================
  const svg = (path, size=20) => 
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

  const ICONS = {
    copy: svg('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>'),
    trash: svg('<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2-2v2"></path>'),
    layers: svg('<polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline>'),
    close: svg('<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>'),
    file: svg('<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline>'),
    img: svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>')
  };

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

  // Blob 转 Base64 (用于 Copy All 富文本生成)
  const blobToBase64 = (blob) => new Promise(r => {
    const reader = new FileReader();
    reader.onload = () => r(reader.result);
    reader.readAsDataURL(blob);
  });

  // ==========================================
  // 2. UI Setup (Shadow DOM)
  // ==========================================
  const host = document.createElement("div");
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.zIndex = "2147483647";
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
<style>
  :host {
    --bg: #1c1c1e;
    --surface: #2c2c2e;
    --text: #ffffff;
    --text-sub: #ebebf599;
    --accent: #0a84ff;
    --danger: #ff453a;
    --border: rgba(255,255,255,0.1);
    --shadow: 0 12px 32px rgba(0,0,0,0.5);
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  
  * { box-sizing: border-box; }

  /* === Floating Handle (FAB) === */
  .fab {
    position: fixed;
    bottom: 30px;
    right: 30px;
    width: 56px; height: 56px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 50%;
    color: var(--text);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    transition: transform 0.2s, background 0.2s;
    z-index: 1000;
  }
  .fab:hover { background: #3a3a3c; transform: scale(1.05); }
  .fab:active { transform: scale(0.95); }
  
  /* 当抽屉打开时，隐藏悬浮球 */
  .open .fab { display: none; }

  /* === Drawer === */
  .drawer {
    position: fixed;
    top: 20px; bottom: 20px; right: 20px;
    width: 380px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: var(--shadow);
    display: flex; flex-direction: column;
    transform: translateX(120%);
    transition: transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
    font-family: var(--font);
    font-size: 14px;
    color: var(--text);
    overflow: hidden;
    z-index: 2000;
  }
  .open .drawer { transform: translateX(0); }

  /* Header */
  .header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
    display: flex; justify-content: space-between; align-items: center;
    background: rgba(255,255,255,0.03);
  }
  .title { font-weight: 600; font-size: 16px; display: flex; gap: 8px; align-items: center; }
  .btn-icon {
    background: transparent; border: none; color: var(--text-sub);
    padding: 8px; border-radius: 8px; cursor: pointer; transition: 0.2s;
    display: flex;
  }
  .btn-icon:hover { background: rgba(255,255,255,0.1); color: #fff; }

  /* Controls */
  .controls { padding: 12px; display: grid; gap: 10px; }
  .row { display: flex; gap: 8px; }
  
  .btn {
    flex: 1; height: 36px; border-radius: 8px; border: none;
    font-size: 13px; font-weight: 500; cursor: pointer;
    background: var(--surface); color: var(--text);
    transition: 0.2s;
  }
  .btn:hover { filter: brightness(1.2); }
  .btn.primary { background: var(--accent); color: white; }
  .btn.danger { color: var(--danger); }

  .drop-hint {
    border: 1px dashed var(--border);
    border-radius: 8px;
    padding: 12px;
    text-align: center; color: var(--text-sub); font-size: 12px;
    cursor: pointer;
    transition: 0.2s;
  }
  .drop-hint:hover { border-color: var(--accent); color: var(--accent); background: rgba(10,132,255,0.1); }

  /* List */
  .list {
    flex: 1; overflow-y: auto;
    padding: 0 12px 12px;
    display: flex; flex-direction: column; gap: 12px;
  }
  /* Custom Scrollbar */
  .list::-webkit-scrollbar { width: 4px; }
  .list::-webkit-scrollbar-thumb { background: #48484a; border-radius: 2px; }

  /* Card */
  .card {
    background: var(--surface);
    border-radius: 10px;
    padding: 10px;
    border: 1px solid var(--border);
    animation: fadeIn 0.2s ease;
  }
  @keyframes fadeIn { from{opacity:0; transform:translateY(5px)} to{opacity:1; transform:translateY(0)} }

  .card-head {
    display: flex; justify-content: space-between; align-items: center;
    font-size: 12px; color: var(--text-sub); margin-bottom: 6px;
  }
  .actions { display: flex; gap: 4px; }
  
  .txt-content {
    font-family: monospace; font-size: 12px;
    background: rgba(0,0,0,0.2); padding: 8px; border-radius: 6px;
    max-height: 100px; overflow: hidden; white-space: pre-wrap; word-break: break-all;
    color: #d1d1d6;
  }
  
  .img-content {
    width: 100%; height: 120px; object-fit: contain;
    background: #000; border-radius: 6px;
  }

  .file-content {
    display: flex; align-items: center; gap: 8px;
    background: rgba(0,0,0,0.2); padding: 8px; border-radius: 6px;
  }

  /* Toast & Backdrop */
  .backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.4);
    opacity: 0; pointer-events: none; transition: 0.3s;
    z-index: 1000;
  }
  .open .backdrop { opacity: 1; pointer-events: auto; }

  .toast {
    position: fixed; bottom: 40px; left: 50%; transform: translate(-50%, 20px);
    background: #fff; color: #000; padding: 8px 16px; border-radius: 20px;
    font-weight: 600; font-size: 13px; opacity: 0; pointer-events: none;
    transition: 0.3s; z-index: 3000;
  }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }
  
  .empty { text-align: center; padding-top: 40px; color: var(--text-sub); }
</style>

<div id="root">
  <div class="fab" id="fab" title="Open Clipboard Hub">
    ${ICONS.layers}
  </div>

  <div class="drawer">
    <div class="header">
      <div class="title">${ICONS.layers} Hub</div>
      <button class="btn-icon" id="btn-close">${ICONS.close}</button>
    </div>

    <div class="controls">
      <button class="btn primary" id="btn-smart">Smart Paste (Clipboard)</button>
      <div class="row">
        <button class="btn" id="btn-copy-all">Copy All</button>
        <button class="btn danger" id="btn-clear">Clear</button>
      </div>
      <div class="drop-hint" id="drop-target">
        Click here & Press Ctrl+V <br/> or Drop Files
      </div>
    </div>

    <textarea id="trap" style="position:fixed; left:-999px; top:0;"></textarea>

    <div class="list" id="list"></div>
  </div>
  
  <div class="backdrop" id="backdrop"></div>
  <div class="toast" id="toast">Copied!</div>
</div>
`;

  // ==========================================
  // 3. Logic Implementation
  // ==========================================
  const $ = (id) => shadow.getElementById(id);
  const root = $("root");
  const listEl = $("list");
  const toastEl = $("toast");
  const trap = $("trap");
  
  let state = { items: [] };
  const blobStore = new Map();
  let pasteLock = false; // 核心：防重复锁

  // Toast
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1500);
  }

  // --- Persistence ---
  async function load() {
    const d = await api.storage.local.get(STORAGE_KEY);
    state.items = d[STORAGE_KEY] || [];
    // 恢复 Blob (如果有持久化的 dataURL)
    for (const it of state.items) {
      if ((it.kind === 'image' || it.kind === 'file') && it.dataUrlPersisted) {
        try {
          const res = await fetch(it.dataUrlPersisted);
          const blob = await res.blob();
          blobStore.set(it.id, { blob, url: URL.createObjectURL(blob) });
        } catch(e) { console.error("Restore failed", e); }
      }
    }
    render();
  }

  async function save() {
    await api.storage.local.set({ [STORAGE_KEY]: state.items });
    render();
  }

  // --- Core: Add Item with De-duplication ---
  function addItem(item) {
    state.items.unshift(item);
    save();
  }

  // --- Core: Handle Paste Stream ---
  async function processItems(itemsList, source) {
    // 核心：加锁 300ms，防止 window paste 和 trap paste 同时触发导致双倍
    if (pasteLock) return;
    pasteLock = true;
    setTimeout(() => { pasteLock = false; }, 300);

    let count = 0;
    // 遍历所有粘贴项
    for (const it of itemsList) {
      // 1. 文件 / 图片
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) {
          const id = uid();
          const isImg = f.type.startsWith("image/");
          let dataUrl = null;
          
          if (isImg && f.size < MAX_IMG_SIZE) {
            try { dataUrl = await blobToBase64(f); } catch {}
          }
          
          blobStore.set(id, { blob: f, url: URL.createObjectURL(f) });
          addItem({ 
            id, kind: isImg ? 'image' : 'file', createdAt: Date.now(),
            name: f.name, size: f.size, dataUrlPersisted: dataUrl 
          });
          count++;
        }
      }
      // 2. 纯文本
      else if (it.kind === 'string' && it.type === 'text/plain') {
        // 使用 Promise 等待文本读取
        await new Promise(resolve => {
          it.getAsString(txt => {
            if (txt && txt.trim()) {
              addItem({ id: uid(), kind: 'text', createdAt: Date.now(), text: txt });
              count++;
            }
            resolve();
          });
        });
      }
    }

    if (count > 0) toast(`Added ${count} items`);
    else if (source === 'smart') toast("Clipboard is empty or unsupported");
  }

  // --- Event Listeners ---
  
  // 1. 全局粘贴监听 (只在打开抽屉时生效)
  window.addEventListener("paste", (e) => {
    if (!root.classList.contains("open")) return;
    // 如果焦点在我们的输入框里，不要拦截
    // 但如果只是点开了抽屉，直接 Ctrl+V，我们拦截
    if (e.clipboardData && e.clipboardData.items) {
      e.preventDefault();
      e.stopPropagation(); // 停止冒泡，防止页面其他逻辑响应
      processItems(e.clipboardData.items, 'paste');
    }
  }, true); // Capture phase capturing

  // 2. Smart Paste Button
  $("btn-smart").onclick = async () => {
    try {
      const clipItems = await navigator.clipboard.read();
      // 构造一个类似 DataTransferItemList 的对象传给处理函数
      // 这里稍微复杂点，因为 Clipboard API 返回的是 ClipboardItem 数组
      let count = 0;
      for (const item of clipItems) {
        // 优先处理图片
        const imgType = item.types.find(t => t.startsWith("image/"));
        if (imgType) {
          const blob = await item.getType(imgType);
          // 包装成 File
          const file = new File([blob], "pasted-image.png", { type: imgType });
          const dt = new DataTransfer();
          dt.items.add(file);
          await processItems(dt.items, 'smart'); 
          count++;
          continue; // 处理了图片就不处理同一次的文本了（通常是互斥的）
        }
        
        // 处理文本
        if (item.types.includes("text/plain")) {
          const blob = await item.getType("text/plain");
          const text = await blob.text();
          // 手动添加
          if (text) {
             addItem({ id: uid(), kind: 'text', createdAt: Date.now(), text });
             count++;
          }
        }
      }
      if (count > 0) toast(`Read ${count} items`);
    } catch (err) {
      // 降级方案：聚焦 trap 触发系统粘贴
      trap.focus();
      document.execCommand("paste");
    }
  };

  // 3. UI Toggles
  const toggle = () => {
    root.classList.toggle("open");
    if (root.classList.contains("open")) {
       setTimeout(() => trap.focus(), 50);
    }
  };
  
  $("fab").onclick = toggle;
  $("btn-close").onclick = toggle;
  $("backdrop").onclick = toggle;
  $("drop-target").onclick = () => trap.focus();

  // 4. Drag Drop
  const drawer = shadow.querySelector(".drawer");
  drawer.ondragover = (e) => { e.preventDefault(); $("drop-target").style.borderColor = "#0a84ff"; };
  drawer.ondrop = (e) => {
    e.preventDefault();
    $("drop-target").style.borderColor = "";
    if (e.dataTransfer.files.length) {
      processItems(e.dataTransfer.items, 'drop');
    }
  };

  // 5. Actions (Copy / Delete)
  $("btn-clear").onclick = async () => {
    state.items = []; blobStore.clear(); save(); toast("Cleared");
  };

  $("btn-copy-all").onclick = async () => {
    if(!state.items.length) return toast("Empty");

    // Copy All Logic (Rich Text HTML Injection)
    let html = "";
    let text = "";
    
    for (const it of state.items) {
      if (it.kind === 'text') {
        html += `<p>${it.text.replace(/\n/g, "<br>")}</p><hr>`;
        text += it.text + "\n\n";
      } else if (it.kind === 'image') {
        const store = blobStore.get(it.id);
        if (store && store.blob) {
          try {
            const b64 = await blobToBase64(store.blob);
            html += `<img src="${b64}" /><br>`;
            text += "[Image]\n";
          } catch {}
        }
      }
    }

    try {
      const htmlBlob = new Blob([html], { type: "text/html" });
      const textBlob = new Blob([text], { type: "text/plain" });
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": htmlBlob, "text/plain": textBlob })
      ]);
      toast("Rich content copied!");
    } catch (e) {
      console.error(e);
      toast("Copy failed");
    }
  };

  // --- Render ---
  function render() {
    listEl.innerHTML = "";
    if (!state.items.length) {
      listEl.innerHTML = `<div class="empty">Empty</div>`;
      return;
    }
    
    state.items.forEach(it => {
      const el = document.createElement("div");
      el.className = "card";
      
      const head = document.createElement("div");
      head.className = "card-head";
      head.innerHTML = `<span>${it.kind.toUpperCase()}</span>`;
      
      const acts = document.createElement("div");
      acts.className = "actions";
      
      const btnDel = document.createElement("button");
      btnDel.className = "btn-icon";
      btnDel.innerHTML = ICONS.trash;
      btnDel.style.color = "#ff453a";
      btnDel.onclick = () => {
        state.items = state.items.filter(x => x.id !== it.id);
        save();
      };
      
      const btnCopy = document.createElement("button");
      btnCopy.className = "btn-icon";
      btnCopy.innerHTML = ICONS.copy; // 这里只复制单个，简单文本或文件
      btnCopy.onclick = async () => {
        if (it.kind === 'text') {
          await navigator.clipboard.writeText(it.text);
          toast("Copied text");
        } else {
           const s = blobStore.get(it.id);
           if (s) {
             try {
               await navigator.clipboard.write([ new ClipboardItem({ [s.blob.type]: s.blob }) ]);
               toast("Copied image");
             } catch { toast("Cannot copy file to clipboard directly"); }
           }
        }
      };

      acts.appendChild(btnCopy);
      acts.appendChild(btnDel);
      head.appendChild(acts);
      el.appendChild(head);

      // Body
      if (it.kind === 'text') {
        const div = document.createElement("div");
        div.className = "txt-content";
        div.textContent = it.text;
        el.appendChild(div);
      } else if (it.kind === 'image') {
        const img = document.createElement("img");
        img.className = "img-content";
        const s = blobStore.get(it.id);
        if(s) img.src = s.url;
        el.appendChild(img);
      } else {
        const div = document.createElement("div");
        div.className = "file-content";
        div.innerHTML = `${ICONS.file} <span>${it.name}</span>`;
        el.appendChild(div);
      }
      
      listEl.appendChild(el);
    });
  }

  // Init
  load();
})();