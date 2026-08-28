const { contextBridge } = require('electron');

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
});