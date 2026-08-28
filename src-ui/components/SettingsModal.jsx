import React, { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n } from '../i18n';

const inputCls =
  'w-full rounded-lg border border-nc-border bg-nc-bg px-3 py-2 text-nc-text placeholder-nc-muted';

export default function SettingsModal({ onClose }) {
  const { settings, updateSettings, language, setLanguage } = useApp();
  const { t } = useI18n();
  const [uploadKb, setUploadKb] = useState(0);
  const [downloadKb, setDownloadKb] = useState(0);
  const [downloadDir, setDownloadDir] = useState('');
  const [ask, setAsk] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [updateStatus, setUpdateStatus] = useState('idle'); // idle|checking|none|available|downloading|error

  useEffect(() => {
    if (window.nextcloud && window.nextcloud.onUpdateStatus) {
      return window.nextcloud.onUpdateStatus((s) => setUpdateStatus(s.status || 'idle'));
    }
    return undefined;
  }, []);

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

  const handleCheckUpdates = async () => {
    setUpdateStatus('checking');
    const res = await window.nextcloud.checkForUpdates();
    if (res) setUpdateStatus(res.status || 'none');
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
        <h2 className="mb-4 text-lg font-semibold text-nc-text">{t('settings.title')}</h2>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-nc-muted">{t('settings.language')}</label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className={inputCls}
            >
              <option value="en">English</option>
              <option value="ru">Русский</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm text-nc-muted">
              {t('settings.uploadLimit')}
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
              {t('settings.downloadLimit')}
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
            <label className="mb-1 block text-sm text-nc-muted">{t('settings.downloadDir')}</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={downloadDir}
                onChange={(e) => setDownloadDir(e.target.value)}
                placeholder={t('settings.downloadDir')}
                className={inputCls}
              />
              <button
                type="button"
                className="shrink-0 rounded-lg border border-nc-border bg-nc-bg px-3 py-2 text-sm text-nc-text hover:bg-nc-hover"
                onClick={handleBrowse}
              >
                {t('settings.browse')}
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
            {t('settings.askSave')}
          </label>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="mt-6 flex items-center justify-between">
          <div className="text-sm">
            {updateStatus === 'checking' && <span className="text-nc-muted">{t('settings.checking')}</span>}
            {updateStatus === 'none' && <span className="text-green-300">{t('settings.upToDate')}</span>}
            {updateStatus === 'available' && (
              <span className="text-nc-accent">{t('settings.available')}</span>
            )}
            {updateStatus === 'downloading' && (
              <span className="text-nc-accent">{t('settings.downloading')}</span>
            )}
            {updateStatus === 'error' && (
              <span className="text-red-300">{t('settings.checkError')}</span>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-lg border border-nc-border px-4 py-2 text-sm text-nc-text hover:bg-nc-hover"
              onClick={handleCheckUpdates}
              disabled={updateStatus === 'checking' || updateStatus === 'downloading'}
            >
              {t('settings.checkUpdates')}
            </button>
            <button
              type="button"
              className="rounded-lg border border-nc-border px-4 py-2 text-sm text-nc-text hover:bg-nc-hover"
              onClick={onClose}
            >
              {t('settings.cancel')}
            </button>
            <button
              type="button"
              className="rounded-lg bg-nc-accent px-4 py-2 text-sm text-white hover:bg-nc-accenthover disabled:opacity-60"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? t('settings.saving') : t('settings.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}