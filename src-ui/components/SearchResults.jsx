import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n } from '../i18n';
import FileIcon from './FileIcon';
import ContextMenu from './ContextMenu';
import { previewKind } from '../previewTypes';

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

export default function SearchResults() {
  const {
    searchQuery,
    searchResults,
    searching,
    searchTruncated,
    searchError,
    clearSearch,
    navigate,
    downloadFile,
    openPreview,
    startDragOut,
    startTorrentFromCloud,
    selected,
    toggleSelect,
    replaceSelection,
  } = useApp();
  const { t } = useI18n();
  const [menu, setMenu] = useState(null); // {x, y, item}
  const lastClickIdx = useRef(null);

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const onClick = (e, item, index) => {
    // Clicking a folder result navigates into it (and exits the search).
    if (item.is_directory) {
      navigate(item.path);
      return;
    }
    if (e.shiftKey && lastClickIdx.current != null) {
      const from = Math.min(lastClickIdx.current, index);
      const to = Math.max(lastClickIdx.current, index);
      replaceSelection(searchResults.slice(from, to + 1).map((f) => f.path));
      return;
    }
    lastClickIdx.current = index;
    if (e.ctrlKey || e.metaKey) toggleSelect(item.path, true);
    else toggleSelect(item.path, false);
  };

  const onDoubleClick = (item) => {
    if (item.is_directory) navigate(item.path);
    else if (!item.is_directory && item.name.toLowerCase().endsWith('.torrent'))
      startTorrentFromCloud(item.path);
    else if (previewKind(item)) openPreview(item.path);
    else downloadFile(item.path);
  };

  const onContextMenu = (e, item) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, item });
  };

  const onDragStart = (e, item) => {
    const multi = selected.has(item.path) && selected.size > 1;
    const targets = multi
      ? searchResults
          .filter((f) => selected.has(f.path))
          .map((f) => ({ path: f.path, name: f.name, is_directory: f.is_directory }))
      : [{ path: item.path, name: item.name, is_directory: item.is_directory }];
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', item.name);
    startDragOut(targets);
  };

  const isSelected = (path) => selected.has(path);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-nc-bg">
      <div className="flex items-center gap-3 border-b border-nc-border px-4 py-2 text-sm">
        <span className="truncate font-medium">{t('search.resultsTitle', { q: searchQuery })}</span>
        <span className="shrink-0 text-xs text-nc-muted">
          {searchTruncated
            ? t('search.truncated', { count: searchResults.length })
            : t('search.count', { count: searchResults.length })}
        </span>
        <button
          className="ml-auto shrink-0 rounded-lg border border-nc-border px-2 py-1 text-xs hover:bg-nc-hover"
          onClick={clearSearch}
          title={t('search.clear')}
        >
          ✕ {t('search.clear')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {searching && (
          <div className="flex h-full items-center justify-center text-nc-muted">
            {t('search.loading')}
          </div>
        )}
        {!searching && searchError && (
          <div className="mx-4 mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {searchError}
          </div>
        )}
        {!searching && !searchError && searchResults.length === 0 && (
          <div className="flex h-full items-center justify-center text-nc-muted">
            {t('search.none')}
          </div>
        )}
        {!searching &&
          !searchError &&
          searchResults.map((item, index) => {
            const sel = isSelected(item.path);
            return (
              <div
                key={item.path}
                draggable
                onClick={(e) => onClick(e, item, index)}
                onDoubleClick={() => onDoubleClick(item)}
                onContextMenu={(e) => onContextMenu(e, item)}
                onDragStart={(e) => onDragStart(e, item)}
                className={`flex cursor-pointer items-center gap-3 px-4 py-1.5 ${
                  sel ? 'bg-nc-accent/25' : 'hover:bg-nc-hover'
                }`}
              >
                <span
                  className={`text-xs ${sel ? 'text-nc-accent' : 'text-transparent'}`}
                >
                  ✔
                </span>
                <FileIcon item={item} />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span
                  className="w-40 truncate text-right text-xs text-nc-muted"
                  title={item.path}
                >
                  {item.path}
                </span>
                <span className="w-20 text-right text-sm text-nc-muted">
                  {item.is_directory ? '—' : formatBytes(item.size)}
                </span>
              </div>
            );
          })}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          item={menu.item}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}