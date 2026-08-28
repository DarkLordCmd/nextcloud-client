const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { initDownloadsModule } = require('./downloads');
const { initUpdater, checkForUpdates } = require('./updater');

let rustProcess = null;
let backendPort = 7842;
let backendToken = '';
let mainWindow = null;

function isDev() {
  return process.env.NODE_ENV === 'development';
}

// 1. Determine the path to the Rust binary.
function rustBinaryPath() {
  const exeName = process.platform === 'win32' ? 'nextcloud-client.exe' : 'nextcloud-client';
  // Production: bundled into resources/bin via electron-builder extraResources.
  if (!isDev()) {
    const bundled = path.join(process.resourcesPath, 'bin', exeName);
    if (fs.existsSync(bundled)) return bundled;
  }
  // Development / unpackaged run: use the debug build.
  const dev = path.join(__dirname, '..', 'src-rust', 'target', 'debug', exeName);
  if (fs.existsSync(dev)) return dev;
  // Fallback to the release build.
  const release = path.join(__dirname, '..', 'src-rust', 'target', 'release', exeName);
  if (fs.existsSync(release)) return release;
  return dev;
}

// 2. Spawn the Rust backend.
function startBackend() {
  const bin = rustBinaryPath();
  if (!fs.existsSync(bin)) {
    dialog.showErrorBox(
      'Backend not found',
      `Could not find the Rust backend binary at:\n${bin}\n\nRun "npm run build:rust" first.`
    );
    return;
  }
  rustProcess = spawn(bin, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  rustProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    // Parse READY:<port>:<token> to learn the actual backend port and the
    // per-session auth token.
    const match = text.match(/READY:(\d+)(?::(\S+))?/);
    if (match) {
      backendPort = parseInt(match[1], 10);
      if (match[2]) backendToken = match[2];
      onBackendReady();
    } else {
      console.log('[rust]', text.trim());
    }
  });

  rustProcess.stderr.on('data', (chunk) => {
    console.error('[rust:stderr]', chunk.toString().trim());
  });

  rustProcess.on('exit', (code) => {
    console.log('[rust] exited with code', code);
    rustProcess = null;
  });

  rustProcess.on('error', (err) => {
    dialog.showErrorBox('Backend error', `Failed to start Rust backend: ${err.message}`);
  });

  // 3. Fallback polling of /api/auth/status while waiting for READY.
  pollBackend();
}

let backendReady = false;
function pollBackend() {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (backendReady) {
      clearInterval(timer);
      return;
    }
    if (Date.now() - startedAt > 10000) {
      clearInterval(timer);
      console.error('Timed out waiting for backend to become ready.');
      return;
    }
    checkHealth((ok) => {
      if (ok) {
        clearInterval(timer);
        onBackendReady();
      }
    });
  }, 200);
}

function checkHealth(callback) {
  const req = http.get(
    { host: '127.0.0.1', port: backendPort, path: '/health', timeout: 1000 },
    (res) => {
      res.resume();
      callback(res.statusCode >= 200 && res.statusCode < 500);
    }
  );
  req.on('error', () => callback(false));
  req.setTimeout(1000, () => {
    req.destroy();
    callback(false);
  });
}

function onBackendReady() {
  backendReady = true;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  } else {
    mainWindow.loadURL(uiUrl());
  }
}

// UI URL: Vite dev server in development, built files in production.
function uiUrl() {
  if (isDev()) {
    return 'http://localhost:5173';
  }
  return path.join(__dirname, '..', 'src-ui', 'dist', 'index.html');
}

// 4. Create the BrowserWindow.
function createWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'NextCloud Client',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [
        `--backend-port=${backendPort}`,
        `--backend-token=${backendToken}`,
      ],
    },
  });

  // Load the UI: Vite dev server in development, built files in production.
  // The backend port is passed to the renderer via preload additionalArguments.
  const url = uiUrl();
  if (isDev()) {
    mainWindow.loadURL(url);
  } else {
    mainWindow.loadFile(url);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Forward renderer console output to the terminal for debugging.
  mainWindow.webContents.on('console-message', (_e, _level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  initDownloadsModule(() => mainWindow);
  initUpdater(() => mainWindow);

  ipcMain.handle('updates:check', () => checkForUpdates());

  startBackend();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Check for updates shortly after startup (packaged builds only).
  setTimeout(() => {
    if (app.isPackaged && mainWindow) {
      checkForUpdates();
    }
  }, 6000);
});

// 5. On close, kill the Rust process.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  killBackend();
});

app.on('will-quit', () => {
  killBackend();
});

function killBackend() {
  if (rustProcess && !rustProcess.killed) {
    try {
      rustProcess.kill();
    } catch (e) {
      // ignore
    }
    rustProcess = null;
  }
}
