import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n, translateError } from '../i18n';
import { previewKind } from '../previewTypes';

const MENU_ITEM =
  'w-full px-4 py-2 text-left text-sm hover:bg-nc-hover disabled:cursor-not-allowed disabled:opacity-50';

export default function ContextMenu({ x, y, item, onClose }) {
  const { downloadFile, renameItem, deleteSelected, toggleSelect, refresh, openPreview, startTorrentFromCloud } =
    useApp();
  const { t } = useI18n();
  const [pos, setPos] = useState({ x, y });
  const ref = useRef(null);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(item.name);

  useEffect(() => {
    // Keep the menu inside the window bounds.
    const menuWidth = 200;
    const menuHeight = 180;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      x: x + menuWidth > vw ? vw - menuWidth - 8 : x,
      y: y + menuHeight > vh ? vh - menuHeight - 8 : y,
    });
  }, [x, y]);

  // Ensure the item is selected before acting.
  useEffect(() => {
    toggleSelect(item.path, false);
  }, [item.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDownload = async () => {
    onClose();
    try {
      await downloadFile(item.path);
    } catch (e) {
      window.alert(translateError(t, e));
    }
  };

  const handleRename = async () => {
    if (!renaming) {
      setRenaming(true);
      return;
    }
    if (!newName.trim() || newName === item.name) {
      setRenaming(false);
      onClose();
      return;
    }
    onClose();
    try {
      await renameItem(item.path, newName.trim());
    } catch (e) {
      window.alert(translateError(t, e));
    }
  };

  const handleDelete = async () => {
    onClose();
    const ok = window.confirm(t('menu.deleteConfirm', { name: item.name }));
    if (!ok) return;
    try {
      await deleteSelected();
    } catch (e) {
      window.alert(translateError(t, e));
    }
  };

  return (
    <div
      ref={ref}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 w-48 overflow-hidden rounded-lg border border-nc-border bg-nc-panel py-1 shadow-2xl"
      onMouseLeave={onClose}
    >
      <button className={MENU_ITEM} onClick={handleDownload} disabled={item.is_directory}>
        ⬇ {t('menu.download')}
      </button>
      {!item.is_directory && item.name.toLowerCase().endsWith('.torrent') && (
        <button
          className={MENU_ITEM}
          onClick={() => {
            onClose();
            startTorrentFromCloud(item.path);
          }}
        >
          ⚡ {t('torrents.add')}
        </button>
      )}
      <button
        className={MENU_ITEM}
        disabled={item.is_directory || !previewKind(item)}
        onClick={() => {
          onClose();
          openPreview(item.path);
        }}
      >
        👁 {t('menu.preview')}
      </button>
      <button className={MENU_ITEM} onClick={handleRename}>
        ✏️ {t('menu.rename')}
      </button>
      <div className="my-1 border-t border-nc-border" />
      <button className={`${MENU_ITEM} text-red-300 hover:bg-red-500/20`} onClick={handleDelete}>
        🗑 {t('menu.delete')}
      </button>
      <button className={MENU_ITEM} onClick={() => { onClose(); refresh(); }}>
        🔄 {t('menu.refresh')}
      </button>
      {renaming && (
        <div className="border-t border-nc-border px-3 py-2">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename();
              if (e.key === 'Escape') {
                setRenaming(false);
                onClose();
              }
            }}
            className="w-full rounded border border-nc-border bg-nc-bg px-2 py-1 text-sm"
          />
          <button
            className="mt-1 w-full rounded bg-nc-accent px-2 py-1 text-sm text-white hover:bg-nc-accenthover"
            onClick={handleRename}
          >
            {t('menu.save')}
          </button>
        </div>
      )}
    </div>
  );
}