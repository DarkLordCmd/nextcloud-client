// Settings persistence and file downloads handled in the main process.
// Kept in a separate module so both the app and tests use the same code.
const { app, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

let getMainWindow = () => null;

function initDownloadsModule(windowGetter) {
  getMainWindow = windowGetter || (() => null);

  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:update', (_e, partial) => {
    settings = { ...loadSettings(), ...(partial || {}) };
    saveSettings();
    return settings;
  });
  ipcMain.handle('settings:choose-dir', async () => {
    const win = getMainWindow();
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled || !res.filePaths || !res.filePaths[0] ? null : res.filePaths[0];
  });
  ipcMain.handle('download:file', (e, { url, name }) => downloadFileToDisk(e.sender, url, name));
  ipcMain.handle('accounts:load', () => loadSettings().accounts || []);
  ipcMain.handle('accounts:save', (_e, { accounts, active }) => {
    const s = loadSettings();
    s.accounts = Array.isArray(accounts) ? accounts : [];
    saveSettings();
    return s.accounts;
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

let settings = null;
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function defaultSettings() {
  return {
    downloadDir: '',
    askDownloadLocation: true,
    uploadSpeedLimit: 0,
    downloadSpeedLimit: 0,
    language: 'en',
    accounts: [],
  };
}
function loadSettings() {
  if (settings) return settings;
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    settings = { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {
    settings = defaultSettings();
  }
  return settings;
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to save settings', e);
  }
}

// Append " (1)", " (2)"... to avoid overwriting existing files.
function uniquePath(p) {
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  const dir = path.dirname(p);
  let candidate = p;
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i += 1;
  }
  return candidate;
}

// Download a file to disk with an optional speed cap (bytes/sec) and live
// progress events sent back to the renderer.
function downloadFileToDisk(sender, url, name) {
  const s = loadSettings();
  return (async () => {
    let savePath;
    if (s.askDownloadLocation) {
      const defaultPath = path.join(s.downloadDir || app.getPath('downloads'), name || 'download');
      const res = await dialog.showSaveDialog(getMainWindow(), { defaultPath });
      if (res.canceled || !res.filePath) return { canceled: true };
      savePath = res.filePath;
    } else {
      const dir = s.downloadDir || app.getPath('downloads');
      savePath = uniquePath(path.join(dir, name || 'download'));
    }
    await fs.promises.mkdir(path.dirname(savePath), { recursive: true });

    const mod = url.startsWith('https') ? https : http;
    const id = `download-${Date.now()}`;
    const rate = s.downloadSpeedLimit || 0; // bytes/sec, 0 = unlimited
    return new Promise((resolve, reject) => {
      const req = mod.get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          sender.send('download:progress', { id, name, error: `HTTP ${res.statusCode}` });
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        const ws = fs.createWriteStream(savePath);
        const state = { sent: 0, start: Date.now() };
        const emit = () => {
          const percent = total > 0 ? Math.min(100, Math.round((state.sent / total) * 100)) : 0;
          sender.send('download:progress', { id, name, bytes: state.sent, total, percent });
        };
        (async () => {
          try {
            // Async iteration drains the response correctly; throttle by
            // pacing writes to the configured bytes/sec rate, and honor write
            // backpressure via 'drain' so no chunk is ever dropped.
            for await (const chunk of res) {
              state.sent += chunk.length;
              if (rate > 0) {
                const needed = state.sent / rate; // seconds that should have elapsed
                const elapsed = (Date.now() - state.start) / 1000;
                if (elapsed < needed) {
                  await new Promise((r) => setTimeout(r, (needed - elapsed) * 1000));
                }
              }
              if (!ws.write(chunk)) {
                await new Promise((resolve) => ws.once('drain', resolve));
              }
              emit();
            }
            await new Promise((resolve) => ws.end(resolve));
            sender.send('download:progress', { id, name, done: true, bytes: state.sent, total });
            resolve({ saved: savePath });
          } catch (err) {
            ws.destroy();
            sender.send('download:progress', { id, name, error: err.message });
            reject(err);
          }
        })();
      });
      req.on('error', (err) => {
        sender.send('download:progress', { id, name, error: err.message });
        reject(err);
      });
    });
  })();
}

module.exports = { initDownloadsModule, downloadFileToDisk, loadSettings, saveSettings };