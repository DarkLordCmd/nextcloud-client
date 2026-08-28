import React, { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';

const inputCls =
  'w-full rounded-lg border border-nc-border bg-nc-bg px-3 py-2 text-nc-text placeholder-nc-muted';

export default function SettingsModal({ onClose }) {
  const { settings, updateSettings } = useApp();
  const [uploadKb, setUploadKb] = useState(0);
  const [downloadKb, setDownloadKb] = useState(0);
  const [downloadDir, setDownloadDir] = useState('');
  const [ask, setAsk] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (settings) {
      setUploadKb(settings.uploadSpeedLimit ? Math.round(settings.uploadSpeedLimit / 1024) : 0);
      setDownloadKb(
        settings.downloadSpeedLimit ? Math.round(settings.downloadSpeedLimit / 1024) : 0
      );
      setDownloadDir(settings.downloadDir || '');
      setAsk(settings.askDownloadLocation !== false);
    }
  }, [settings]);

  const handleBrowse = async () => {
    if (!window.nextcloud || !window.nextcloud.chooseDownloadDir) return;
    const dir = await window.nextcloud.chooseDownloadDir();
    if (dir) setDownloadDir(dir);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateSettings({
        uploadSpeedLimit: (parseInt(uploadKb, 10) || 0) * 1024,
        downloadSpeedLimit: (parseInt(downloadKb, 10) || 0) * 1024,
        downloadDir: downloadDir.trim(),
        askDownloadLocation: ask,
      });
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[500px] rounded-xl border border-nc-border bg-nc-panel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-nc-text">Settings</h2>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-nc-muted">
              Upload speed limit (KB/s, 0 = unlimited)
            </label>
            <input
              type="number"
              min="0"
              value={uploadKb}
              onChange={(e) => setUploadKb(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-nc-muted">
              Download speed limit (KB/s, 0 = unlimited)
            </label>
            <input
              type="number"
              min="0"
              value={downloadKb}
              onChange={(e) => setDownloadKb(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-nc-muted">Default download location</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={downloadDir}
                onChange={(e) => setDownloadDir(e.target.value)}
                placeholder="System downloads folder"
                className={inputCls}
              />
              <button
                type="button"
                className="shrink-0 rounded-lg border border-nc-border bg-nc-bg px-3 py-2 text-sm text-nc-text hover:bg-nc-hover"
                onClick={handleBrowse}
              >
                Browse…
              </button>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-nc-text">
            <input
              type="checkbox"
              checked={ask}
              onChange={(e) => setAsk(e.target.checked)}
              className="h-4 w-4 accent-nc-accent"
            />
            Ask where to save each download
          </label>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-nc-border px-4 py-2 text-sm text-nc-text hover:bg-nc-hover"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded-lg bg-nc-accent px-4 py-2 text-sm text-white hover:bg-nc-accenthover disabled:opacity-60"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}