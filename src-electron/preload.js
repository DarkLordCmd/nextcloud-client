const { contextBridge, ipcRenderer } = require('electron');

// Read values passed via additionalArguments (sandboxed preloads still get
// process.argv with those arguments appended).
function arg(name) {
  const found = process.argv.find((a) => a.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : undefined;
}

contextBridge.exposeInMainWorld('nextcloud', {
  backendPort: arg('--backend-port') || '7842',
  backendToken: arg('--backend-token') || '',
  platform: process.platform,
  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (partial) => ipcRenderer.invoke('settings:update', partial),
  chooseDownloadDir: () => ipcRenderer.invoke('settings:choose-dir'),
  // Download via the main process (save dialog / default dir + speed limit).
  downloadFile: (payload) => ipcRenderer.invoke('download:file', payload),
  onDownloadProgress: (callback) => {
    const listener = (_e, data) => callback(data);
    ipcRenderer.on('download:progress', listener);
    return () => ipcRenderer.removeListener('download:progress', listener);
  },
  // Updates
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  onUpdateStatus: (callback) => {
    const listener = (_e, data) => callback(data);
    ipcRenderer.on('updates:status', listener);
    return () => ipcRenderer.removeListener('updates:status', listener);
  },
  // Accounts
  loadAccounts: () => ipcRenderer.invoke('accounts:load'),
  saveAccounts: (accounts, active) => ipcRenderer.invoke('accounts:save', { accounts, active }),
  // Drag-out of files into the OS
  startDrag: (paths) => ipcRenderer.send('drag:start', paths),
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
});