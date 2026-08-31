import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n, translateError } from '../i18n';
import FileIcon from './FileIcon';

function formatBytes(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function TrashPanel() {
  const {
    trashItems,
    trashLoading,
    trashError,
    restoreTrashItem,
    deleteTrashItem,
    emptyTrash,
  } = useApp();
  const { t, language } = useI18n();
  const [busy, setBusy] = useState(null); // trash path currently being processed

  const formatDate = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(language, { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const handleRestore = async (item) => {
    setBusy(item.path);
    try {
      await restoreTrashItem(item.path, item.original_location);
    } catch (e) {
      window.alert(translateError(t, e));
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (item) => {
    if (!window.confirm(t('trash.deleteConfirm', { name: item.name }))) return;
    setBusy(item.path);
    try {
      await deleteTrashItem(item.path);
    } catch (e) {
      window.alert(translateError(t, e));
    } finally {
      setBusy(null);
    }
  };

  const handleEmpty = async () => {
    if (trashItems.length === 0) return;
    if (!window.confirm(t('trash.emptyConfirm'))) return;
    try {
      await emptyTrash();
    } catch (e) {
      window.alert(translateError(t, e));
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-nc-bg">
      <div className="flex items-center gap-3 border-b border-nc-border px-4 py-2 text-sm">
        <span className="truncate font-medium">🗑 {t('trash.title')}</span>
        <span className="shrink-0 text-xs text-nc-muted">
          {t('trash.count', { count: trashItems.length })}
        </span>
        <button
          className="ml-auto shrink-0 rounded-lg border border-red-500/40 px-2 py-1 text-xs text-red-300 hover:bg-red-500/20 disabled:opacity-50"
          onClick={handleEmpty}
          disabled={trashItems.length === 0 || trashLoading}
          title={t('trash.emptyAll')}
        >
          {t('trash.emptyAll')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {trashLoading && (
          <div className="flex h-full items-center justify-center text-nc-muted">
            {t('trash.loading')}
          </div>
        )}
        {!trashLoading && trashError && (
          <div className="mx-4 mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {trashError}
          </div>
        )}
        {!trashLoading && !trashError && trashItems.length === 0 && (
          <div className="flex h-full items-center justify-center text-nc-muted">
            {t('trash.empty')}
          </div>
        )}
        {!trashLoading &&
          !trashError &&
          trashItems.map((item) => {
            const working = busy === item.path;
            return (
              <div
                key={item.path}
                className="flex cursor-default items-center gap-3 px-4 py-1.5 hover:bg-nc-hover"
              >
                <FileIcon item={{ is_directory: item.is_directory, mime_type: item.mime_type, name: item.name }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{item.name}</div>
                  <div className="truncate text-xs text-nc-muted" title={item.original_location}>
                    {t('trash.deleted')}: {formatDate(item.deleted_at)} · {item.original_location || '—'}
                  </div>
                </div>
                <span className="w-20 text-right text-sm text-nc-muted">
                  {item.is_directory ? '—' : formatBytes(item.size)}
                </span>
                <div className="flex shrink-0 gap-1">
                  <button
                    className="rounded-lg border border-nc-border px-2 py-1 text-xs hover:bg-nc-hover disabled:opacity-50"
                    onClick={() => handleRestore(item)}
                    disabled={working}
                  >
                    ↩ {t('trash.restore')}
                  </button>
                  <button
                    className="rounded-lg border border-red-500/40 px-2 py-1 text-xs text-red-300 hover:bg-red-500/20 disabled:opacity-50"
                    onClick={() => handleDelete(item)}
                    disabled={working}
                  >
                    {t('trash.delete')}
                  </button>
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}