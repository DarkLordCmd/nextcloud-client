import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

const inputCls =
  'w-full rounded-lg border border-nc-border bg-nc-bg px-3 py-2 text-nc-text placeholder-nc-muted';

export default function TorrentsPanel({ onClose }) {
  const { t } = useI18n();
  const [magnet, setMagnet] = useState('');
  const [torrentFile, setTorrentFile] = useState('');
  const [targetDir, setTargetDir] = useState('/');
  const [active, setActive] = useState([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    refresh();
    let off = () => {};
    if (window.nextcloud && window.nextcloud.onTorrentStatus) {
      off = window.nextcloud.onTorrentStatus((data) => {
        if (data && Array.isArray(data.active)) setActive(data.active);
      });
    }
    return off;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = async () => {
    if (window.nextcloud && window.nextcloud.torrentList) {
      const list = await window.nextcloud.torrentList().catch(() => []);
      setActive(list || []);
    }
  };

  const pickFile = async () => {
    if (window.nextcloud && window.nextcloud.torrentPick) {
      const p = await window.nextcloud.torrentPick();
      if (p) setTorrentFile(p);
    }
  };

  const handleAdd = async () => {
    const source = magnet.trim() || torrentFile;
    if (!source) return;
    setAdding(true);
    setError(null);
    try {
      await window.nextcloud.torrentAdd({ source, targetDir: targetDir.trim() || '/' });
      setMagnet('');
      setTorrentFile('');
      refresh();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setAdding(false);
    }
  };

  const statusLabel = (s) => {
    switch (s.status) {
      case 'downloading':
        return t('torrents.statusDownloading');
      case 'paused':
        return t('torrents.statusPaused');
      case 'seeding':
        return t('torrents.statusSeeding');
      case 'complete':
        return t('torrents.statusUploading');
      case 'error':
        return t('torrents.statusError');
      default:
        return s.status;
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="flex h-[520px] w-[640px] max-w-[90vw] flex-col rounded-xl border border-nc-border bg-nc-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-nc-border px-4 py-2">
          <h2 className="text-lg font-semibold text-nc-text">⚡ {t('torrents.title')}</h2>
          <button className="rounded px-3 py-1 text-sm text-nc-text hover:bg-nc-hover" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="space-y-3 border-b border-nc-border p-4">
          <div>
            <label className="mb-1 block text-sm text-nc-muted">{t('torrents.magnet')}</label>
            <input
              type="text"
              value={magnet}
              onChange={(e) => setMagnet(e.target.value)}
              placeholder="magnet:?xt=urn:btih:..."
              className={inputCls}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-nc-muted">{t('torrents.torrentFile')}</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={torrentFile}
                onChange={(e) => setTorrentFile(e.target.value)}
                placeholder="*.torrent"
                className={inputCls}
              />
              <button
                type="button"
                className="shrink-0 rounded-lg border border-nc-border bg-nc-bg px-3 py-2 text-sm text-nc-text hover:bg-nc-hover"
                onClick={pickFile}
              >
                {t('torrents.browse')}
              </button>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm text-nc-muted">{t('torrents.targetDir')}</label>
            <input
              type="text"
              value={targetDir}
              onChange={(e) => setTargetDir(e.target.value)}
              placeholder="/"
              className={inputCls}
            />
          </div>
          {error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-lg border border-nc-border px-4 py-2 text-sm text-nc-text hover:bg-nc-hover"
              onClick={onClose}
            >
              {t('torrents.cancel')}
            </button>
            <button
              type="button"
              disabled={adding}
              className="rounded-lg bg-nc-accent px-4 py-2 text-sm text-white hover:bg-nc-accenthover disabled:opacity-60"
              onClick={handleAdd}
            >
              {adding ? t('torrents.adding') : t('torrents.add')}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {active.length === 0 && (
            <div className="py-8 text-center text-sm text-nc-muted">{t('torrents.noTorrents')}</div>
          )}
          {active.map((tor) => {
            const percent = tor.percent || 0;
            return (
              <div key={tor.gid} className="mb-2 rounded-lg border border-nc-border bg-nc-bg px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm text-nc-text">{tor.name}</span>
                  <span className="shrink-0 text-xs text-nc-muted">{statusLabel(tor)}</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-nc-panel">
                    <div
                      className="h-full rounded-full bg-nc-accent"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <span className="shrink-0 text-xs text-nc-muted">{percent}%</span>
                </div>
                <div className="mt-1 flex items-center justify-between text-xs text-nc-muted">
                  <span>
                    {tor.downloadSpeed > 0
                      ? `${(tor.downloadSpeed / 1024 / 1024).toFixed(1)} MB/s`
                      : ''}
                  </span>
                  <div className="flex gap-1">
                    <button
                      className="rounded border border-nc-border px-2 py-0.5 hover:bg-nc-hover"
                      onClick={() => {
                        if (tor.status === 'paused') window.nextcloud.torrentUnpause(tor.gid);
                        else window.nextcloud.torrentPause(tor.gid);
                      }}
                    >
                      {tor.status === 'paused' ? t('torrents.resume') : t('torrents.pause')}
                    </button>
                    <button
                      className="rounded border border-red-500/40 px-2 py-0.5 text-red-300 hover:bg-red-500/20"
                      onClick={() => window.nextcloud.torrentRemove(tor.gid).then(refresh)}
                    >
                      {t('torrents.remove')}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}