const { contextBridge } = require('electron');

// Read the backend port passed via additionalArguments.
function getBackendPort() {
  const arg = process.argv.find((a) => a.startsWith('--backend-port='));
  return arg ? arg.split('=')[1] : '7842';
}

contextBridge.exposeInMainWorld('nextcloud', {
  backendPort: getBackendPort(),
  platform: process.platform,
});
