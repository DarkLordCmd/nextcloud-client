import React, { useState } from 'react';
import { useApp } from '../context/AppContext';

const BTN =
  'flex items-center gap-1.5 rounded-lg border border-nc-border bg-nc-bg px-3 py-1.5 text-sm hover:bg-nc-hover disabled:cursor-not-allowed disabled:opacity-50';

export default function Toolbar() {
  const {
    openUploadDialog,
    createFolder,
    downloadFile,
    deleteSelected,
    refresh,
    selected,
    files,
    currentPath,
  } = useApp();
  const [creating, setCreating] = useState(false);

  const selectedItems = files.filter((f) => selected.has(f.path));
  const canDelete = selected.size > 0;
  const canDownload = selectedItems.some((f) => !f.is_directory);

  const handleNewFolder = async () => {
    const name = window.prompt('Folder name:');
    if (!name || !name.trim()) return;
    setCreating(true);
    try {
      await createFolder(name.trim());
    } catch (e) {
      window.alert(e.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    const names = selectedItems.map((f) => f.name);
    const ok = window.confirm(
      `Delete ${names.length} item(s)?\n\n${names.join('\n')}`
    );
    if (!ok) return;
    try {
      await deleteSelected();
    } catch (e) {
      window.alert(e.message);
    }
  };

  const handleDownload = async () => {
    const fileItem = selectedItems.find((f) => !f.is_directory);
    if (!fileItem) return;
    try {
      await downloadFile(fileItem.path);
    } catch (e) {
      window.alert(e.message);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button className={BTN} onClick={openUploadDialog} title="Upload (Ctrl+U)">
        ⬆ Upload
      </button>
      <button className={BTN} onClick={handleNewFolder} disabled={creating}>
        📁 New Folder
      </button>
      <button className={BTN} onClick={handleDownload} disabled={!canDownload} title="Download">
        ⬇ Download
      </button>
      <button className={BTN} onClick={handleDelete} disabled={!canDelete} title="Delete (Del)">
        🗑 Delete
      </button>
      <button className={BTN} onClick={refresh} title="Refresh (F5)">
        🔄
      </button>
      <span className="ml-2 text-xs text-nc-muted">
        {selected.size > 0 ? `${selected.size} selected` : currentPath}
      </span>
    </div>
  );
}