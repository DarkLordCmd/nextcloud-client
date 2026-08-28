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
});