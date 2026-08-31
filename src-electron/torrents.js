// Torrent manager: runs a bundled aria2c via JSON-RPC, polls progress, and
// uploads completed downloads into Nextcloud through the local backend.
const { app, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let getMainWindow = () => null;
let getBackendPort = () => 7842;
let getBackendToken = () => '';
let aria2 = null;
let aria2Port = 0;
let pollTimer = null;
let restartTimer = null;
let consecutiveFailures = 0;
let shuttingDown = false;
let restarting = false;
let starting = false;
const pendingTargets = new Map();
// Gids currently being uploaded; prevents overlapping poll ticks from
// processing the same completed torrent twice (duplicate uploads / HTTP 423).
const handlingGids = new Set();

// Per-session RPC secret. Every RPC call carries `token:<secret>`; a stale or
// foreign aria2 sharing our port will answer "Unauthorized", which lets us
// detect and move away from it instead of silently talking to the wrong one.
const RPC_SECRET = crypto.randomBytes(16).toString('hex');
const RPC_TIMEOUT_MS = 5000;
const RPC_FAIL_LIMIT = 3;

const downloadsDir = () => path.join(app.getPath('temp'), 'nextcloud-torrents');

// Durable diagnostic log (packaged apps have no visible console). Written to
// the app's userData dir so a failed torrent upload is never silent.
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log('[torrent]', ...args);
  try {
    const p = path.join(app.getPath('userData'), 'torrents.log');
    fs.appendFileSync(p, line + '\n');
  } catch (_) {}
}

function aria2Path() {
  const exe = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c';
  if (process.env.NODE_ENV === 'development') {
    const candidates = [
      path.join(__dirname, '..', 'build', exe),
      path.join(__dirname, '..', '..', 'build', exe),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
  }
  const bundled = path.join(process.resourcesPath, 'bin', exe);
  if (fs.existsSync(bundled)) return bundled;
  return exe;
}

function findFreePort(start) {
  const net = require('net');
  let port = start;
  while (true) {
    try {
      const srv = net.createServer();
      // `exclusive: true` prevents two aria2 instances (or a stale one) from
      // silently sharing the same port via SO_REUSEADDR overlap.
      srv.listen({ port, host: '127.0.0.1', exclusive: true });
      srv.close();
      return port;
    } catch {
      port += 1;
    }
  }
}

function waitForRpcReady(timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = async () => {
      if (Date.now() - started > timeoutMs) return resolve(false);
      try {
        await rpc('aria2.getVersion');
        return resolve(true);
      } catch {
        setTimeout(tick, 300);
      }
    };
    tick();
  });
}

async function startAria2() {
  starting = true;
  fs.mkdirSync(downloadsDir(), { recursive: true });
  // Public trackers so single-tracker torrents still find peers. Without
  // these, a torrent whose only tracker is dead/empty stays at 0 peers even
  // though the same torrent downloads fine in qBittorrent (which bundles DHT).
  const TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://exodus.desync.com:6969/announce',
    'http://tracker.opentrackr.org:1337/announce',
  ].join(',');

  aria2Port = findFreePort(6800);
  for (let attempt = 0; attempt < 5; attempt++) {
    const proc = spawn(
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
        '--enable-dht=true',
        '--bt-tracker=' + TRACKERS,
        `--rpc-secret=${RPC_SECRET}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    proc.stderr.on('data', (c) => console.error('[aria2]', c.toString().trim()));
    proc.on('exit', (code) => {
      if (aria2 === proc) aria2 = null;
      log('aria2 exited', code);
      if (!shuttingDown && !restarting && !starting) {
        log('scheduling aria2 restart');
        restartTimer = setTimeout(() => startAria2(), 2000);
      }
    });
    aria2 = proc;

    // Make sure the RPC we reach is OUR aria2 (secret matches) and that the
    // port wasn't shared with a stale process before accepting it.
    const ok = await waitForRpcReady(RPC_TIMEOUT_MS);
    if (ok) {
      log('aria2 ready on port', aria2Port);
      starting = false;
      return;
    }
    log('aria2 RPC not reachable on port', aria2Port, '- trying the next port');
    try {
      proc.kill();
    } catch (_) {}
    aria2 = null;
    // Continue the scan from the next port: on Windows an `exclusive` bind
    // probe can still succeed against a wedged/stale listener, so a fresh
    // findFreePort(6800) would keep returning the same broken port.
    aria2Port = findFreePort(aria2Port + 1);
  }
  log('ERROR: could not start aria2 after 5 attempts');
  starting = false;
}

// ---- JSON-RPC ----
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    // aria2 requires the secret as the first parameter of every call when
    // --rpc-secret is set. A stale/foreign aria2 on our port answers with an
    // "Unauthorized" error, which is how we detect the conflict.
    const args = [`token:${RPC_SECRET}`].concat(params || []);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'nc', method, params: args });
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
    // A wedged aria2 must not block the poll forever — time out and let the
    // caller (poll) decide to restart the process.
    req.setTimeout(RPC_TIMEOUT_MS, () => req.destroy(new Error('aria2 RPC timed out')));
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
  log('torrent added', gid, 'targetDir=', JSON.stringify(targetDir));
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
    errorCode: st.errorCode ? parseInt(st.errorCode, 10) : null,
    errorMessage: st.errorMessage || null,
  };
  p.percent = p.totalLength > 0 ? Math.round((p.completedLength / p.totalLength) * 100) : 0;
  p.eta =
    p.downloadSpeed > 0 ? Math.round((p.totalLength - p.completedLength) / p.downloadSpeed) : null;
  return p;
}

async function poll() {
  // Skip while aria2 is starting (or was just killed) so a still-booting RPC
  // never trips the failure counter into a premature restart.
  if (!aria2 || starting || restarting) return;
  try {
    const active = (await rpc('aria2.tellActive')) || [];
    const waiting = (await rpc('aria2.tellWaiting', [0, 100])) || [];
    const stopped = (await rpc('aria2.tellStopped', [0, 100])) || [];
    consecutiveFailures = 0;
    const items = [...active, ...waiting].map((st) => statusPayload(st));
    const win = getMainWindow();
    if (win) {
      win.webContents.send('torrent:status', {
        active: items,
        stopped: stopped.map(statusPayload),
      });
    }
    for (const st of stopped) {
      if (st.status === 'error' && pendingTargets.has(st.gid)) {
        log('torrent failed:', st.gid, 'code=', st.errorCode, 'err=', st.errorMessage);
      }
      if (st.status === 'complete' && pendingTargets.has(st.gid) && !handlingGids.has(st.gid)) {
        log('poll: torrent complete, uploading', st.gid, 'files=', JSON.stringify((st.files || []).map((f) => f.path)));
        handlingGids.add(st.gid);
        try {
          await handleComplete(st);
        } finally {
          handlingGids.delete(st.gid);
        }
      }
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    consecutiveFailures += 1;
    log('poll RPC failed (' + consecutiveFailures + 'x):', msg);
    // aria2 got wedged (RPC unresponsive) — restart it so completed torrents
    // are detected and uploaded again instead of failing silently forever.
    if (consecutiveFailures >= RPC_FAIL_LIMIT) {
      log('aria2 RPC unhealthy, restarting aria2...');
      consecutiveFailures = 0;
      await restartAria2();
    }
  }
}

async function restartAria2() {
  restarting = true;
  if (aria2) {
    try {
      aria2.kill();
    } catch (_) {}
    aria2 = null;
  }
  await startAria2();
  restarting = false;
}

// Upload a completed torrent's files into Nextcloud, then clean up.
async function handleComplete(st) {
  const win = getMainWindow();
  const meta = pendingTargets.get(st.gid) || {};
  const targetDir = meta.targetDir || '/';
  meta.attempts = (meta.attempts || 0) + 1;
  const files = st.files ? st.files.map((f) => f.path) : [];
  // aria2 reports file paths with forward slashes even on Windows, while
  // downloadsDir() returns backslashes. Normalize both so the guard below
  // actually matches — otherwise every file is skipped and nothing is
  // uploaded (the original symptom).
  const base = downloadsDir().replace(/\\/g, '/');
  const uploaded = [];
  try {
    for (const rawPath of files) {
      const filePath = String(rawPath).replace(/\\/g, '/');
      if (!filePath.startsWith(base + '/')) {
        log('WARN: file outside download dir, skipping', filePath, 'base=', base);
        continue;
      }
      if (!fs.existsSync(filePath)) {
        log('WARN: file missing, skipping', filePath);
        continue;
      }
      const rel = path.posix.relative(base, filePath);
      const destDir = rel.includes('/') ? `${targetDir}/${path.posix.dirname(rel)}` : targetDir;
      const name = path.posix.basename(rel);
      log('uploading', filePath, '->', destDir + '/' + name);
      await ensureRemoteDir(destDir);
      await uploadFileToNextcloud(filePath, destDir, name, win);
      log('uploaded OK', filePath);
      uploaded.push(filePath);
      try {
        fs.unlinkSync(filePath);
      } catch (_) {}
    }
    pendingTargets.delete(st.gid);
    await rpc('aria2.remove', [st.gid]).catch(() => {});
    // Let the renderer refresh the file list so a just-uploaded file shows up
    // without a manual F5.
    if (win) {
      win.webContents.send('torrent:uploaded', { targetDir });
    }
  } catch (e) {
    if (meta.attempts < 3) {
      // Likely transient — retry on the next poll without losing data.
      log('upload FAILED attempt', meta.attempts, 'will retry:', e.message);
      return;
    }
    pendingTargets.delete(st.gid);
    // Give up: log the failure and surface it in the UI. The downloaded
    // files stay on disk (we never deleted them), so nothing is lost.
    log('upload FAILED after retries:', e.message);
    if (win) {
      win.webContents.send('torrent:status', {
        active: [{ ...statusPayload(st), status: 'error', error: e.message }],
        stopped: [],
      });
    }
  }
  // Remove empty directories the upload left behind, but never the whole
  // download dir — other torrents may still be downloading/uploading there.
  for (const filePath of uploaded) {
    let d = path.posix.dirname(filePath);
    while (d.length > base.length) {
      try {
        fs.rmdirSync(d);
      } catch (_) {
        break;
      }
      d = path.posix.dirname(d);
    }
  }
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
  shuttingDown = true;
  if (pollTimer) clearInterval(pollTimer);
  if (restartTimer) clearTimeout(restartTimer);
  if (aria2) {
    try {
      aria2.kill();
    } catch (_) {}
    aria2 = null;
  }
}

module.exports = { initTorrentsModule, shutdownTorrents };