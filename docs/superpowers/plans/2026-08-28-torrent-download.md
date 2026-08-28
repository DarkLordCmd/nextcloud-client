# Torrent Download to Nextcloud (aria2c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add torrent downloads (magnet / .torrent) via bundled `aria2c`, then auto-upload the downloaded files into a chosen Nextcloud folder preserving folder structure.

**Architecture:** Electron main spawns `aria2c` with JSON-RPC on localhost, manages downloads via RPC polling, and after completion uploads files to Nextcloud through the existing Rust backend (`/api/files/upload`, `/api/files/mkdir`). Renderer gets a new Torrents panel (add form + list with pause/resume/cancel/progress).

**Tech Stack:** Electron 33 (main process), React 18, aria2c 1.37.0 (win-64, bundled), existing Rust backend. No new npm dependencies.

## Global Constraints

- aria2c binary: `build/aria2c.exe` (already downloaded) → bundled to `resources/bin/aria2c.exe`.
- RPC listens only on `127.0.0.1`, free port (like backend).
- Downloads dir: `app.getPath('temp')/nextcloud-torrents`.
- After torrent completes, files upload to Nextcloud preserving subfolder structure, then local copies are removed.
- UI strings go through `t()` (EN/RU).
- No release / no version bump / commits only.

---

### Task 1: Bundle aria2c into the build

**Files:**
- Modify: `electron-builder.yml`
- Modify: `package.json` (optional; no-op here)

**Interfaces:**
- Produces: packaged app has `resources/bin/aria2c.exe`; dev search covers `build/aria2c.exe`.

- [ ] **Step 1: Add extraResources for aria2c**

In `electron-builder.yml`, extend `extraResources`:

```yaml
extraResources:
  - from: src-rust/target/release/nextcloud-client.exe
    to: bin/nextcloud-client.exe
  - from: build/aria2c.exe
    to: bin/aria2c.exe
```

- [ ] **Step 2: Verify `build/aria2c.exe` exists**

Run: `Test-Path build/aria2c.exe`
Expected: `True` (already copied, 5.6 MB).

- [ ] **Step 3: Commit**

```bash
git add electron-builder.yml build/aria2c.exe
git commit -m "build: bundle aria2c into the installer"
```

---

### Task 2: Electron main — aria2c manager module `src-electron/torrents.js`

**Files:**
- Create: `src-electron/torrents.js`

**Interfaces:**
- Consumes: `app`, `dialog`, `BrowserWindow` (getter), `backendPort`/`backendToken` accessors.
- Produces:
  - `initTorrentsModule({ getMainWindow, backendPort, backendToken })`
  - IPC: `torrent:add`, `torrent:pause`, `torrent:unpause`, `torrent:remove`, `torrent:list`, `torrent:pick-torrent`
  - `webContents.send('torrent:status', payload)` events
  - Uploads completed files via backend `/api/files/mkdir` + `/api/files/upload`, emitting `download:progress`.
  - `shutdownTorrents()` to kill aria2c.

- [ ] **Step 1: Create `src-electron/torrents.js`**

```js
// Torrent manager: runs a bundled aria2c via JSON-RPC, polls progress, and
// uploads completed downloads into Nextcloud through the local backend.
const { app, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

let getMainWindow = () => null;
let getBackendPort = () => 7842;
let getBackendToken = () => '';
let aria2 = null;
let aria2Port = 0;
let pollTimer = null;
const downloadsDir = () => path.join(app.getPath('temp'), 'nextcloud-torrents');

function aria2Path() {
  if (process.env.NODE_ENV === 'development') {
    const candidates = [
      path.join(__dirname, '..', 'build', 'aria2c.exe'),
      path.join(__dirname, '..', '..', 'build', 'aria2c.exe'),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
  }
  const bundled = path.join(process.resourcesPath, 'bin', 'aria2c.exe');
  if (fs.existsSync(bundled)) return bundled;
  return 'aria2c';
}

function findFreePort(start) {
  const net = require('net');
  let port = start;
  while (true) {
    try {
      const srv = net.createServer();
      srv.listen(port, '127.0.0.1');
      srv.close();
      return port;
    } catch {
      port += 1;
    }
  }
}

function startAria2() {
  aria2Port = findFreePort(6800);
  fs.mkdirSync(downloadsDir(), { recursive: true });
  aria2 = spawn(aria2Path(), [
    '--enable-rpc',
    '--rpc-listen-all=false',
    `--rpc-listen-port=${aria2Port}`,
    `--dir=${downloadsDir()}`,
    '--seed-time=0',
    '--bt-save-metadata=false',
    '--console-log-level=warn',
    '--file-allocation=none',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  aria2.stderr.on('data', (c) => console.error('[aria2]', c.toString().trim()));
  aria2.on('exit', (code) => { aria2 = null; console.log('[aria2] exited', code); });
}

// ---- JSON-RPC ----
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'nc', method, params: params || [] });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: aria2Port,
        path: '/jsonrpc',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed && parsed.error) reject(new Error(parsed.error.message || 'aria2 error'));
            else resolve(parsed ? parsed.result : undefined);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function addTorrent(source, targetDir) {
  let gid;
  if (source.startsWith('magnet:')) {
    gid = await rpc('aria2.addUri', [[source], { dir: downloadsDir() }]);
  } else {
    const b64 = fs.readFileSync(source).toString('base64');
    gid = await rpc('aria2.addTorrent', [b64, [], { dir: downloadsDir() }]);
  }
  // Remember the Nextcloud target dir keyed by gid.
  pendingTargets.set(gid, { targetDir });
  return gid;
}

const pendingTargets = new Map();

function statusPayload(st) {
  return {
    gid: st.gid,
    name: st.bittorrent && st.bittorrent.info && st.bittorrent.info.name
      ? st.bittorrent.info.name
      : (st.files && st.files[0] && st.files[0].path ? path.basename(st.files[0].path) : st.gid),
    status: st.status,
    totalLength: parseInt(st.totalLength || '0', 10),
    completedLength: parseInt(st.completedLength || '0', 10),
    downloadSpeed: parseInt(st.downloadSpeed || '0', 10),
    files: st.files ? st.files.map((f) => f.path) : [],
  };
}

async function poll() {
  if (!aria2) return;
  try {
    const active = (await rpc('aria2.tellActive')) || [];
    const waiting = (await rpc('aria2.tellWaiting', [0, 100])) || [];
    const stopped = (await rpc('aria2.tellStopped', [0, 100])) || [];
    const items = [...active, ...waiting].map((st) => statusPayload(st));
    for (const it of items) {
      it.percent = it.totalLength > 0 ? Math.round((it.completedLength / it.totalLength) * 100) : 0;
    }
    const win = getMainWindow();
    if (win) {
      win.webContents.send('torrent:status', { active: items, stopped: stopped.map(statusPayload) });
    }
    // Handle completed downloads (not yet uploading).
    for (const st of stopped) {
      if (st.status === 'complete' && pendingTargets.has(st.gid)) {
        await handleComplete(st);
      }
    }
  } catch (e) {
    // aria2 not ready yet; ignore.
  }
}

// Upload a completed torrent's files into Nextcloud, then clean up.
async function handleComplete(st) {
  const win = getMainWindow();
  const targetDir = (pendingTargets.get(st.gid) || {}).targetDir || '/';
  pendingTargets.delete(st.gid);
  const files = st.files ? st.files.map((f) => f.path) : [];
  const base = downloadsDir();
  for (const filePath of files) {
    if (!filePath.startsWith(base)) continue;
    const rel = path.relative(base, filePath).split(path.sep).join('/');
    const destDir = rel.includes('/') ? `${targetDir}/${path.posix.dirname(rel)}` : targetDir;
    const name = path.posix.basename(rel);
    await ensureRemoteDir(destDir);
    await uploadFileToNextcloud(filePath, destDir, name, win);
    try { fs.unlinkSync(filePath); } catch (_) {}
  }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
  await rpc('aria2.remove', [st.gid]).catch(() => {});
}

async function ensureRemoteDir(dirPath) {
  const url = `http://127.0.0.1:${getBackendPort()}/api/files/mkdir?path=${encodeURIComponent(dirPath)}&token=${encodeURIComponent(getBackendToken())}`;
  await postEmpty(url).catch(() => {});
}

function postEmpty(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST' }, (res) => { res.resume(); resolve(); });
    req.on('error', reject);
    req.end();
  });
}

async function uploadFileToNextcloud(filePath, destDir, name, win) {
  const stat = fs.statSync(filePath);
  const id = `torrent-upload-${Date.now()}-${name}`;
  const send = (payload) => { if (win) win.webContents.send('download:progress', payload); };
  send({ id, name, bytes: 0, total: stat.size, percent: 0 });
  const url = `http://127.0.0.1:${getBackendPort()}/api/files/upload?path=${encodeURIComponent(destDir)}&name=${encodeURIComponent(name)}&token=${encodeURIComponent(getBackendToken())}`;
  await new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size } },
      (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`HTTP ${res.statusCode}`));
      }
    );
    req.on('error', reject);
    const rs = fs.createReadStream(filePath);
    let sent = 0;
    rs.on('data', (c) => {
      sent += c.length;
      const percent = stat.size > 0 ? Math.round((sent / stat.size) * 100) : 100;
      send({ id, name, bytes: sent, total: stat.size, percent });
    });
    rs.pipe(req);
  });
  send({ id, name, done: true, bytes: stat.size, total: stat.size, percent: 100 });
}

// ---- IPC ----
function initTorrentsModule(opts) {
  getMainWindow = opts.getMainWindow || getMainWindow;
  getBackendPort = opts.backendPort || getBackendPort;
  getBackendToken = opts.backendToken || getBackendToken;
  startAria2();
  pollTimer = setInterval(poll, 1000);

  ipcMain.handle('torrent:add', async (_e, { source, targetDir }) => {
    if (!source) throw new Error('No source');
    const gid = await addTorrent(source, targetDir);
    return { gid };
  });
  ipcMain.handle('torrent:pause', (_e, gid) => rpc('aria2.pause', [gid]));
  ipcMain.handle('torrent:unpause', (_e, gid) => rpc('aria2.unpause', [gid]));
  ipcMain.handle('torrent:remove', async (_e, gid) => {
    pendingTargets.delete(gid);
    await rpc('aria2.remove', [gid]).catch(() => {});
  });
  ipcMain.handle('torrent:list', async () => {
    const active = (await rpc('aria2.tellActive')) || [];
    const waiting = (await rpc('aria2.tellWaiting', [0, 100])) || [];
    const stopped = (await rpc('aria2.tellStopped', [0, 100])) || [];
    return [...active, ...waiting].map(statusPayload);
  });
  ipcMain.handle('torrent:pick-torrent', async () => {
    const win = getMainWindow();
    const res = await dialog.showOpenDialog(win, {
      filters: [{ name: 'Torrent', extensions: ['torrent'] }],
      properties: ['openFile'],
    });
    return res.canceled || !res.filePaths || !res.filePaths[0] ? null : res.filePaths[0];
  });
}

function shutdownTorrents() {
  if (pollTimer) clearInterval(pollTimer);
  if (aria2) {
    try { aria2.kill(); } catch (_) {}
    aria2 = null;
  }
}

module.exports = { initTorrentsModule, shutdownTorrents };
```

- [ ] **Step 2: Syntax check**

Run: `node --check src-electron/torrents.js`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src-electron/torrents.js
git commit -m "feat: torrent manager (aria2c JSON-RPC) in main process"
```

---

### Task 3: Wire torrents module into main.js + preload

**Files:**
- Modify: `src-electron/main.js`
- Modify: `src-electron/preload.js`

**Interfaces:**
- Consumes: `initTorrentsModule`, `shutdownTorrents` from Task 2.
- Produces: preload bridge `torrentAdd`, `torrentPause`, `torrentUnpause`, `torrentRemove`, `torrentList`, `torrentPick`, `onTorrentStatus`.

- [ ] **Step 1: main.js — init + shutdown**

In `src-electron/main.js`:
1. Add require at top: `const { initTorrentsModule, shutdownTorrents } = require('./torrents');`
2. In `app.whenReady().then(...)`, after `initDragOutModule(...)`, add:

```js
  initTorrentsModule({
    getMainWindow: () => mainWindow,
    backendPort: () => backendPort,
    backendToken: () => backendToken,
  });
```

3. In `app.on('before-quit', ...)` (existing handler), add `shutdownTorrents();` alongside `cleanupDragDirs()`.

- [ ] **Step 2: preload.js — bridge**

In `src-electron/preload.js`, inside `contextBridge.exposeInMainWorld('nextcloud', {...})`, add:

```js
  // Torrents
  torrentAdd: (payload) => ipcRenderer.invoke('torrent:add', payload),
  torrentPause: (gid) => ipcRenderer.invoke('torrent:pause', gid),
  torrentUnpause: (gid) => ipcRenderer.invoke('torrent:unpause', gid),
  torrentRemove: (gid) => ipcRenderer.invoke('torrent:remove', gid),
  torrentList: () => ipcRenderer.invoke('torrent:list'),
  torrentPick: () => ipcRenderer.invoke('torrent:pick-torrent'),
  onTorrentStatus: (callback) => {
    const listener = (_e, data) => callback(data);
    ipcRenderer.on('torrent:status', listener);
    return () => ipcRenderer.removeListener('torrent:status', listener);
  },
```

- [ ] **Step 3: Syntax check**

Run: `node --check src-electron/main.js; node --check src-electron/preload.js`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src-electron/main.js src-electron/preload.js
git commit -m "feat: wire torrent manager into app lifecycle and preload"
```

---

### Task 4: i18n keys for torrents

**Files:**
- Modify: `src-ui/i18n.jsx`

**Interfaces:**
- Produces keys (EN/RU): `torrents.title`, `torrents.add`, `torrents.magnet`, `torrents.torrentFile`, `torrents.browse`, `torrents.targetDir`, `torrents.cancel`, `torrents.pause`, `torrents.resume`, `torrents.remove`, `torrents.statusDownloading`, `torrents.statusUploading`, `torrents.statusDone`, `torrents.statusError`, `torrents.statusPaused`, `torrents.statusSeeding`, `torrents.noTorrents`, `torrents.adding`.

- [ ] **Step 1: Add keys to `en` dictionary**

```js
    'torrents.title': 'Torrents',
    'torrents.add': 'Add torrent',
    'torrents.magnet': 'Magnet link',
    'torrents.torrentFile': 'Torrent file',
    'torrents.browse': 'Browse…',
    'torrents.targetDir': 'Nextcloud folder',
    'torrents.cancel': 'Cancel',
    'torrents.pause': 'Pause',
    'torrents.resume': 'Resume',
    'torrents.remove': 'Remove',
    'torrents.statusDownloading': 'Downloading',
    'torrents.statusUploading': 'Uploading to cloud…',
    'torrents.statusDone': 'Done',
    'torrents.statusError': 'Error',
    'torrents.statusPaused': 'Paused',
    'torrents.statusSeeding': 'Seeding',
    'torrents.noTorrents': 'No torrents yet',
    'torrents.adding': 'Adding…',
```

- [ ] **Step 2: Add keys to `ru` dictionary**

```js
    'torrents.title': 'Торренты',
    'torrents.add': 'Добавить торрент',
    'torrents.magnet': 'Magnet-ссылка',
    'torrents.torrentFile': 'Файл .torrent',
    'torrents.browse': 'Обзор…',
    'torrents.targetDir': 'Папка в Nextcloud',
    'torrents.cancel': 'Отмена',
    'torrents.pause': 'Пауза',
    'torrents.resume': 'Продолжить',
    'torrents.remove': 'Удалить',
    'torrents.statusDownloading': 'Скачивание',
    'torrents.statusUploading': 'Загрузка в облако…',
    'torrents.statusDone': 'Готово',
    'torrents.statusError': 'Ошибка',
    'torrents.statusPaused': 'Пауза',
    'torrents.statusSeeding': 'Раздача',
    'torrents.noTorrents': 'Торрентов пока нет',
    'torrents.adding': 'Добавление…',
```

- [ ] **Step 3: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src-ui/i18n.jsx
git commit -m "feat: i18n keys for torrents panel"
```

---

### Task 5: Torrents panel component

**Files:**
- Create: `src-ui/components/TorrentsPanel.jsx`

**Interfaces:**
- Consumes: `window.nextcloud.torrentAdd/Pause/Unpause/Remove/List/Pick/onTorrentStatus`, `useI18n()`.
- Produces: `<TorrentsPanel onClose={...} />`.

- [ ] **Step 1: Create `TorrentsPanel.jsx`**

```jsx
import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

const inputCls =
  'w-full rounded-lg border border-nc-border bg-nc-bg px-3 py-2 text-nc-text placeholder-nc-muted';

export default function TorrentsPanel({ onClose }) {
  const { t } = useI18n();
  const [magnet, setMagnet] = useState('');
  const [torrentFile, setTorrentFile] = useState('');
  const [targetDir, setTargetDir] = useState('/');
  const [active, setActive] = useState([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    refresh();
    let off = () => {};
    if (window.nextcloud && window.nextcloud.onTorrentStatus) {
      off = window.nextcloud.onTorrentStatus((data) => {
        if (data && Array.isArray(data.active)) setActive(data.active);
      });
    }
    return off;
  }, []);

  const refresh = async () => {
    if (window.nextcloud && window.nextcloud.torrentList) {
      const list = await window.nextcloud.torrentList().catch(() => []);
      setActive(list || []);
    }
  };

  const pickFile = async () => {
    if (window.nextcloud && window.nextcloud.torrentPick) {
      const p = await window.nextcloud.torrentPick();
      if (p) setTorrentFile(p);
    }
  };

  const handleAdd = async () => {
    const source = magnet.trim() || torrentFile;
    if (!source) return;
    setAdding(true);
    setError(null);
    try {
      await window.nextcloud.torrentAdd({ source, targetDir: targetDir.trim() || '/' });
      setMagnet('');
      setTorrentFile('');
      refresh();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setAdding(false);
    }
  };

  const statusLabel = (s) => {
    switch (s.status) {
      case 'downloading': return t('torrents.statusDownloading');
      case 'paused': return t('torrents.statusPaused');
      case 'seeding': return t('torrents.statusSeeding');
      case 'complete': return t('torrents.statusUploading');
      case 'error': return t('torrents.statusError');
      default: return s.status;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="flex h-[520px] w-[640px] max-w-[90vw] flex-col rounded-xl border border-nc-border bg-nc-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-nc-border px-4 py-2">
          <h2 className="text-lg font-semibold text-nc-text">🔄 {t('torrents.title')}</h2>
          <button className="rounded px-3 py-1 text-sm text-nc-text hover:bg-nc-hover" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="space-y-3 border-b border-nc-border p-4">
          <div>
            <label className="mb-1 block text-sm text-nc-muted">{t('torrents.magnet')}</label>
            <input
              type="text"
              value={magnet}
              onChange={(e) => setMagnet(e.target.value)}
              placeholder="magnet:?xt=urn:btih:..."
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-nc-muted">{t('torrents.torrentFile')}</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={torrentFile}
                onChange={(e) => setTorrentFile(e.target.value)}
                placeholder="*.torrent"
                className={inputCls}
              />
              <button
                type="button"
                className="shrink-0 rounded-lg border border-nc-border bg-nc-bg px-3 py-2 text-sm text-nc-text hover:bg-nc-hover"
                onClick={pickFile}
              >
                {t('torrents.browse')}
              </button>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm text-nc-muted">{t('torrents.targetDir')}</label>
            <input
              type="text"
              value={targetDir}
              onChange={(e) => setTargetDir(e.target.value)}
              placeholder="/"
              className={inputCls}
            />
          </div>
          {error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-lg border border-nc-border px-4 py-2 text-sm text-nc-text hover:bg-nc-hover"
              onClick={onClose}
            >
              {t('torrents.cancel')}
            </button>
            <button
              type="button"
              disabled={adding}
              className="rounded-lg bg-nc-accent px-4 py-2 text-sm text-white hover:bg-nc-accenthover disabled:opacity-60"
              onClick={handleAdd}
            >
              {adding ? t('torrents.adding') : t('torrents.add')}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {active.length === 0 && (
            <div className="py-8 text-center text-sm text-nc-muted">{t('torrents.noTorrents')}</div>
          )}
          {active.map((tor) => {
            const percent = tor.percent || 0;
            return (
              <div key={tor.gid} className="mb-2 rounded-lg border border-nc-border bg-nc-bg px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm text-nc-text">{tor.name}</span>
                  <span className="shrink-0 text-xs text-nc-muted">{statusLabel(tor)}</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-nc-panel">
                    <div
                      className="h-full rounded-full bg-nc-accent"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <span className="shrink-0 text-xs text-nc-muted">{percent}%</span>
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-nc-muted">
                  <span>
                    {tor.downloadSpeed > 0 ? `${(tor.downloadSpeed / 1024 / 1024).toFixed(1)} MB/s` : ''}
                  </span>
                  <div className="flex gap-1">
                    <button
                      className="rounded border border-nc-border px-2 py-0.5 hover:bg-nc-hover"
                      onClick={() => {
                        if (tor.status === 'paused') window.nextcloud.torrentUnpause(tor.gid);
                        else window.nextcloud.torrentPause(tor.gid);
                      }}
                    >
                      {tor.status === 'paused' ? t('torrents.resume') : t('torrents.pause')}
                    </button>
                    <button
                      className="rounded border border-red-500/40 px-2 py-0.5 text-red-300 hover:bg-red-500/20"
                      onClick={() => window.nextcloud.torrentRemove(tor.gid).then(refresh)}
                    >
                      {t('torrents.remove')}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src-ui/components/TorrentsPanel.jsx
git commit -m "feat: torrents panel UI"
```

---

### Task 6: Toolbar button opens TorrentsPanel

**Files:**
- Modify: `src-ui/components/Toolbar.jsx`

**Interfaces:**
- Consumes: `<TorrentsPanel />` from Task 5.

- [ ] **Step 1: Add button + state in Toolbar**

In `src-ui/components/Toolbar.jsx`:
1. Add import: `import TorrentsPanel from './TorrentsPanel';`
2. Add state: `const [showTorrents, setShowTorrents] = useState(false);`
3. Add button before `<AccountMenu />`:

```jsx
      <button className={BTN} onClick={() => setShowTorrents(true)} title="Torrents">
        ⚡
      </button>
```

4. Near `{showSettings && <SettingsModal .../>}`, add:

```jsx
      {showTorrents && <TorrentsPanel onClose={() => setShowTorrents(false)} />}
```

- [ ] **Step 2: Verify build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add src-ui/components/Toolbar.jsx
git commit -m "feat: torrents panel button in toolbar"
```

---

### Task 7: Final build + smoke verification

**Files:**
- None (verification only).

- [ ] **Step 1: Full UI build**

Run: `npm run build:ui`
Expected: succeeds.

- [ ] **Step 2: Rust build unchanged**

Run: `cargo build --release --manifest-path src-rust/Cargo.toml`
Expected: `Finished` (no changes, should be fast).

- [ ] **Step 3: Syntax check**

Run: `node --check src-electron/torrents.js; node --check src-electron/main.js; node --check src-electron/preload.js`
Expected: no errors.

- [ ] **Step 4: Packaged smoke**

Run: `npx electron-builder --dir`, then verify `dist\win-unpacked\resources\bin\aria2c.exe` exists and app launches without main-process crash.

- [ ] **Step 5: Confirm no release**

Verify no new git tag and `package.json` version unchanged.