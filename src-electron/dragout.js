// Drag-and-drop of files out of the app into the OS (Windows/Explorer).
// Downloads the requested paths to a temp dir, then hands the local files
// to the OS via webContents.startDrag.
const { app, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

let getMainWindow = () => null;
let getBackendPort = () => 7842;
let getBackendToken = () => '';

function initDragOutModule(opts) {
  getMainWindow = opts.getMainWindow || getMainWindow;
  getBackendPort = opts.backendPort || getBackendPort;
  getBackendToken = opts.backendToken || getBackendToken;

  ipcMain.on('drag:start', (event, paths) => {
    const win = getMainWindow();
    if (!win) return;
    if (!Array.isArray(paths) || paths.length === 0) return;
    // Pass the exact webContents that originated the drag so startDrag()
    // targets the live drag operation (event.sender, not win.webContents).
    console.log('[dragout] drag:start', JSON.stringify(paths));
    handleDrag(event.sender, paths);
  });
}

function downloadToFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      const ws = fs.createWriteStream(dest);
      let sent = 0;
      res.on('data', (chunk) => {
        sent += chunk.length;
        if (!ws.write(chunk)) res.pause();
      });
      ws.on('drain', () => res.resume());
      res.on('end', () => {
        ws.end();
        if (onProgress) onProgress(sent, total);
        resolve(dest);
      });
      res.on('error', (err) => {
        ws.destroy();
        reject(err);
      });
      ws.on('error', (err) => {
        res.destroy();
        reject(err);
      });
    });
    req.on('error', reject);
  });
}

async function handleDrag(sender, paths) {
  const dir = path.join(app.getPath('temp'), `nextcloud-drag-${Date.now()}`);
  const id = `drag-${Date.now()}`;
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const localFiles = [];
    for (const item of paths) {
      const safeName = String(item.name || 'download').replace(/[\\/:*?"<>|]/g, '_');
      const isFolder = item.is_directory === true;
      const finalName = isFolder ? `${safeName}.zip` : safeName;
      const dest = path.join(dir, finalName);
      const url =
        `http://127.0.0.1:${getBackendPort()}/api/files/export?path=${encodeURIComponent(
          item.path
        )}&token=${encodeURIComponent(getBackendToken())}`;
      sender.send('download:progress', {
        id,
        name: finalName,
        bytes: 0,
        total: 0,
        percent: 0,
        preparing: true,
      });
      await downloadToFile(url, dest, (bytes, total) => {
        const percent = total > 0 ? Math.min(100, Math.round((bytes / total) * 100)) : 0;
        sender.send('download:progress', { id, name: finalName, bytes, total, percent });
      });
      localFiles.push(dest);
      sender.send('download:progress', {
        id,
        name: finalName,
        done: true,
        bytes: 0,
        total: 0,
        percent: 100,
      });
    }
    // All files ready: hand them to the OS. Use the originating webContents
    // so the file drag replaces the still-live HTML5 drag operation.
    const icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    );
    console.log('[dragout] startDrag with files:', JSON.stringify(localFiles));
    sender.startDrag({ files: localFiles, icon });
    console.log('[dragout] startDrag called OK');
  } catch (err) {
    sender.send('download:progress', { id, name: '', error: err.message, bytes: 0, total: 0 });
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
}

function cleanupDragDirs() {
  const temp = app.getPath('temp');
  try {
    for (const entry of fs.readdirSync(temp)) {
      if (entry.startsWith('nextcloud-drag-')) {
        try {
          fs.rmSync(path.join(temp, entry), { recursive: true, force: true });
        } catch (_) {
          /* ignore */
        }
      }
    }
  } catch (_) {
    /* ignore */
  }
}

module.exports = { initDragOutModule, cleanupDragDirs };