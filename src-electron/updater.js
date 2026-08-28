// Auto-update via electron-updater (GitHub Releases provider). Only active in
// packaged builds; in development the module is inert.
const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

let getMainWindow = () => null;
let checking = false;

function initUpdater(windowGetter) {
  getMainWindow = windowGetter || (() => null);
  if (!app.isPackaged) {
    console.log('[updater] disabled (development mode)');
    return;
  }

  autoUpdater.autoDownload = false; // ask before downloading
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on('update-available', (info) => {
    checking = false;
    const win = getMainWindow();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'info',
      title: 'Update available',
      message: `Version ${info.version} is available`,
      detail: `You have ${app.getVersion()}. Download and install the update now?`,
      buttons: ['Update now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) {
      autoUpdater.downloadUpdate();
    } else {
      const w = getMainWindow();
      if (w) w.webContents.send('updates:status', { status: 'deferred' });
    }
  });

  autoUpdater.on('update-not-available', () => {
    checking = false;
    const win = getMainWindow();
    if (win) win.webContents.send('updates:status', { status: 'none' });
  });

  autoUpdater.on('download-progress', (p) => {
    const win = getMainWindow();
    if (win) {
      win.webContents.send('updates:status', {
        status: 'downloading',
        percent: Math.round(p.percent || 0),
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    checking = false;
    const win = getMainWindow();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'info',
      title: 'Update ready',
      message: `Version ${info.version} has been downloaded.`,
      detail: 'Install it now? The app will close and restart with the update.',
      buttons: ['Install and restart', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0) {
      setImmediate(() => autoUpdater.quitAndInstall());
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err && err.message ? err.message : err);
    checking = false;
    const win = getMainWindow();
    if (win) {
      win.webContents.send('updates:status', {
        status: 'error',
        error: String((err && err.message) || err),
      });
    }
  });
}

async function checkForUpdates() {
  if (!app.isPackaged) return { status: 'dev' };
  if (checking) return { status: 'checking' };
  checking = true;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result && result.updateInfo) {
      const available = result.updateInfo.version;
      const current = app.getVersion();
      // updateInfo is always returned (even when already up to date), so only
      // report "available" when the fetched version is actually newer.
      if (available && available !== current) {
        return { status: 'available', version: available };
      }
      return { status: 'none' };
    }
    return { status: 'none' };
  } catch (e) {
    checking = false;
    console.error('[updater] check failed:', e && e.message ? e.message : e);
    return { status: 'error', error: String((e && e.message) || e) };
  }
}

module.exports = { initUpdater, checkForUpdates };