import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n, translateError } from '../i18n';
import AccountMenu from './AccountMenu';
import SettingsModal from './SettingsModal';

const BTN =
  'flex items-center gap-1.5 rounded-lg border border-nc-border bg-nc-bg px-3 py-1.5 text-sm hover:bg-nc-hover disabled:cursor-not-allowed disabled:opacity-50';

export default function Toolbar() {
  const {
    openUploadDialog,
    createFolder,
    downloadMany,
    deleteSelected,
    refresh,
    selected,
    files,
    currentPath,
  } = useApp();
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const selectedItems = files.filter((f) => selected.has(f.path));
  const canDelete = selected.size > 0;
  const canDownload = selectedItems.some((f) => !f.is_directory);

  const handleNewFolder = async () => {
    const name = window.prompt(t('toolbar.folderName'));
    if (!name || !name.trim()) return;
    setCreating(true);
    try {
      await createFolder(name.trim());
    } catch (e) {
      window.alert(translateError(t, e));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    const names = selectedItems.map((f) => f.name);
    const ok = window.confirm(
      t('toolbar.deleteConfirm', { count: names.length, names: names.join('\n') })
    );
    if (!ok) return;
    try {
      await deleteSelected();
    } catch (e) {
      window.alert(translateError(t, e));
    }
  };

  const handleDownload = async () => {
    const filePaths = selectedItems.filter((f) => !f.is_directory).map((f) => f.path);
    if (filePaths.length === 0) return;
    try {
      await downloadMany(filePaths);
    } catch (e) {
      window.alert(translateError(t, e));
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button className={BTN} onClick={openUploadDialog} title={t('toolbar.uploadTitle')}>
        ⬆ {t('toolbar.upload')}
      </button>
      <button className={BTN} onClick={handleNewFolder} disabled={creating}>
        📁 {t('toolbar.newFolder')}
      </button>
      <button className={BTN} onClick={handleDownload} disabled={!canDownload} title={t('toolbar.downloadTitle')}>
        ⬇ {t('toolbar.download')}
      </button>
      <button className={BTN} onClick={handleDelete} disabled={!canDelete} title={t('toolbar.deleteTitle')}>
        🗑 {t('toolbar.delete')}
      </button>
      <button className={BTN} onClick={refresh} title={t('toolbar.refreshTitle')}>
        🔄
      </button>
      <AccountMenu />
      <button className={BTN} onClick={() => setShowSettings(true)} title={t('toolbar.settingsTitle')}>
        ⚙️
      </button>
      <span className="ml-2 text-xs text-nc-muted">
        {selected.size > 0 ? t('toolbar.selected', { count: selected.size }) : currentPath}
      </span>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  );
}