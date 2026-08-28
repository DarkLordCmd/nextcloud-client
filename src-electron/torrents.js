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
const pendingTargets = new Map();

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
  aria2 = spawn(
    aria2Path(),
    [
      '--enable-rpc',
      '--rpc-listen-all=false',
      `--rpc-listen-port=${aria2Port}`,
      `--dir=${downloadsDir()}`,
      '--seed-time=0',
      '--bt-save-metadata=false',
      '--console-log-level=warn',
      '--file-allocation=none',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  aria2.stderr.on('data', (c) => console.error('[aria2]', c.toString().trim()));
  aria2.on('exit', (code) => {
    aria2 = null;
    console.log('[aria2] exited', code);
  });
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
  pendingTargets.set(gid, { targetDir });
  return gid;
}

// Download a .torrent from Nextcloud into a temp file, then hand it to aria2.
function downloadCloudFile(url, dest) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws);
      ws.on('finish', () => resolve(dest));
      ws.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function addCloudTorrent(cloudPath, targetDir) {
  const tempFile = path.join(downloadsDir(), `cloud-${Date.now()}.torrent`);
  const url =
    `http://127.0.0.1:${getBackendPort()}/api/files/download?path=${encodeURIComponent(
      cloudPath
    )}&token=${encodeURIComponent(getBackendToken())}`;
  await downloadCloudFile(url, tempFile);
  try {
    return await addTorrent(tempFile, targetDir);
  } finally {
    try {
      fs.unlinkSync(tempFile);
    } catch (_) {}
  }
}

function statusPayload(st) {
  const p = {
    gid: st.gid,
    name:
      st.bittorrent && st.bittorrent.info && st.bittorrent.info.name
        ? st.bittorrent.info.name
        : st.files && st.files[0] && st.files[0].path
          ? path.basename(st.files[0].path)
          : st.gid,
    status: st.status,
    totalLength: parseInt(st.totalLength || '0', 10),
    completedLength: parseInt(st.completedLength || '0', 10),
    downloadSpeed: parseInt(st.downloadSpeed || '0', 10),
    uploadSpeed: parseInt(st.uploadSpeed || '0', 10),
    numSeeders: parseInt(st.numSeeders || '0', 10),
    connections: parseInt(st.connections || '0', 10),
    seeder: st.seeder === true,
    files: st.files ? st.files.map((f) => f.path) : [],
  };
  p.percent = p.totalLength > 0 ? Math.round((p.completedLength / p.totalLength) * 100) : 0;
  p.eta =
    p.downloadSpeed > 0 ? Math.round((p.totalLength - p.completedLength) / p.downloadSpeed) : null;
  return p;
}

async function poll() {
  if (!aria2) return;
  try {
    const active = (await rpc('aria2.tellActive')) || [];
    const waiting = (await rpc('aria2.tellWaiting', [0, 100])) || [];
    const stopped = (await rpc('aria2.tellStopped', [0, 100])) || [];
    const items = [...active, ...waiting].map((st) => statusPayload(st));
    const win = getMainWindow();
    if (win) {
      win.webContents.send('torrent:status', {
        active: items,
        stopped: stopped.map(statusPayload),
      });
    }
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
    try {
      fs.unlinkSync(filePath);
    } catch (_) {}
  }
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch (_) {}
  await rpc('aria2.remove', [st.gid]).catch(() => {});
}

async function ensureRemoteDir(dirPath) {
  const url = `http://127.0.0.1:${getBackendPort()}/api/files/mkdir?path=${encodeURIComponent(
    dirPath
  )}&token=${encodeURIComponent(getBackendToken())}`;
  await postEmpty(url).catch(() => {});
}

function postEmpty(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST' }, (res) => {
      res.resume();
      resolve();
    });
    req.on('error', reject);
    req.end();
  });
}

async function uploadFileToNextcloud(filePath, destDir, name, win) {
  const stat = fs.statSync(filePath);
  const id = `torrent-upload-${Date.now()}-${name}`;
  const send = (payload) => {
    if (win) win.webContents.send('download:progress', payload);
  };
  send({ id, name, bytes: 0, total: stat.size, percent: 0 });
  const url = `http://127.0.0.1:${getBackendPort()}/api/files/upload?path=${encodeURIComponent(
    destDir
  )}&name=${encodeURIComponent(name)}&token=${encodeURIComponent(getBackendToken())}`;
  await new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
        },
      },
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
  ipcMain.handle('torrent:add-cloud', async (_e, { path, targetDir }) => {
    if (!path) throw new Error('No path');
    const gid = await addCloudTorrent(path, targetDir);
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
    try {
      aria2.kill();
    } catch (_) {}
    aria2 = null;
  }
}

module.exports = { initTorrentsModule, shutdownTorrents };