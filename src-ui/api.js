// All fetch calls to the Rust backend. The backend runs on the local port
// reported by the preload bridge (defaults to 7842).
const BACKEND =
  (typeof window !== 'undefined' && window.nextcloud && window.nextcloud.backendPort)
    ? `http://127.0.0.1:${window.nextcloud.backendPort}`
    : 'http://127.0.0.1:7842';

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(`${BACKEND}${path}`, options);
  } catch (e) {
    throw new Error('Cannot reach the local backend. Please restart the app.');
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { success: false, error: text || `HTTP ${res.status}` };
  }
  if (!res.ok || body.success === false) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body.data;
}

export const api = {
  login(creds) {
    return request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
  },
  authStatus() {
    return request('/api/auth/status');
  },
  logout() {
    return request('/api/auth/logout', { method: 'POST' });
  },
  list(path) {
    return request(`/api/files?path=${encodeURIComponent(path)}`);
  },
  downloadUrl(path) {
    return `${BACKEND}/api/files/download?path=${encodeURIComponent(path)}`;
  },
  inlineDownloadUrl(path) {
    return `${BACKEND}/api/files/download?path=${encodeURIComponent(path)}&inline=1`;
  },
  async downloadBlob(path) {
    const res = await fetch(this.downloadUrl(path));
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    return res.blob();
  },
  upload(path, file) {
    // Send the raw file body so the browser streams it and the backend
    // forwards it to NextCloud without buffering the whole file in memory.
    return request(
      `/api/files/upload?path=${encodeURIComponent(path)}&name=${encodeURIComponent(file.name)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      }
    );
  },
  mkdir(path) {
    return request(`/api/files/mkdir?path=${encodeURIComponent(path)}`, {
      method: 'POST',
    });
  },
  remove(path) {
    return request(`/api/files?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    });
  },
  rename(path, newName) {
    return request('/api/files/rename', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, new_name: newName }),
    });
  },
  progressUrl() {
    return `${BACKEND}/api/files/progress`;
  },
};