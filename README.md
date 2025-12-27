# Clipboard Hub - Pure & Elegant Clipboard Manager

A beautiful, lightweight, and powerful clipboard manager Chrome/Edge/Firefox extension that lets you collect multiple clipboard items (text, images, files) and paste them individually or all together as rich content.

![Screenshot preview](https://via.placeholder.com/800x600?text=Clipboard+Hub+Screenshot)  
*(Modern glassmorphism UI with floating action button and smooth drawer)*

## Features

- **Multi-item clipboard history** – Capture text, images, and files in one session.
- **Batch paste support** – Paste mixed content (images + text) at once via `Ctrl+V` when the hub is open.
- **Smart Paste button** – Uses the modern Clipboard API to read clipboard content even when the hub is closed (with permission).
- **Copy All as rich text** – Copies everything as both `text/html` and `text/plain`, so images and formatted text survive when pasting into Notion, Word, Gmail, etc.
- **Durable persistence** – Metadata stored in `storage.local`, large binary blobs (images/files) safely persisted in IndexedDB via background service worker → survives browser restarts.
- **Automatic image compression** – Large images are downscaled and converted to WebP to save space without noticeable quality loss.
- **De-duplication** – Prevents double entries from simultaneous paste events.
- **Elegant UI** – Glassmorphism drawer, floating action button with badge, smooth animations, dark-mode friendly, fully isolated in Shadow DOM.
- **Drag & drop support** – Drop files directly into the drawer.
- **Single-item copy/delete** – Quickly copy or remove individual entries.
- **Keyboard friendly** – Open with FAB, close with Esc, paste with Ctrl/Cmd+V.

## Installation

1. Download or clone this repository.
2. Open your browser's extension management page:
   - Chrome/Edge: `chrome://extensions`
   - Firefox: `about:debugging#/runtime/this-firefox`
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the folder containing the extension files (`manifest.json`, `background.js`, `content-script.js`).

The extension works on all websites (`<all_urls>`) and injects a floating button in the bottom-right corner.

## Permissions Explained

- `storage` – Save clipboard history and metadata.
- `clipboardRead`, `clipboardWrite` – Read/write clipboard content (only used when you explicitly interact with the hub).
- `<all_urls>` – Inject the content script on every page to capture pastes and show the UI.

No data is sent anywhere — everything stays local.

## Usage

1. Click the floating layers icon in the bottom-right.
2. The drawer slides in.
3. Paste (`Ctrl+V` / `⌘+V`) multiple times — all text, images, and files are collected.
   - Or use **Smart Paste** to grab the current clipboard without opening the drawer first.
   - Or drag & drop files into the drawer.
4. Click any item's copy button to put it back on the clipboard.
5. Click **Copy All** to copy everything as rich HTML (perfect for documents and rich editors).
6. Click **Clear** to wipe the history.

## Technical Highlights (v6 vs older versions)

- Binary blobs are no longer stored as data URLs in `storage.local` (which has strict quotas).
- Background service worker uses IndexedDB to reliably store large files/images across sessions.
- Robust de-duplication using a short time-window + ingest queue.
- Graceful fallback for browsers that block the modern Clipboard API.
- Automatic migration from v5 data format.
- Improved rich-text copying with sanitized HTML and inline styles for maximum compatibility.

## Files Overview

- `manifest.json` – Manifest V3 declaration.
- `background.js` – Service worker that manages IndexedDB storage for blobs.
- `content-script.js` – Main UI and logic (injected on every page).
- (Legacy `content-script.old.js` included for reference only)

## Development

Feel free to fork and improve! Common areas for contribution:

- Add search/filter in the list
- Keyboard shortcuts to navigate items
- Sync across devices (would require optional backend)
- Light theme variant

## License

MIT License – free to use, modify, and distribute.

Enjoy a cleaner, more powerful clipboard experience! 🚀
