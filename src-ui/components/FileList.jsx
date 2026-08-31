import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n } from '../i18n';
import FileIcon from './FileIcon';
import ContextMenu from './ContextMenu';
import useMarquee from '../hooks/useMarquee';
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

const SORTERS = {
  name: (a, b) => a.name.localeCompare(b.name),
  size: (a, b) => {
    if (a.is_directory !== b.is_directory) return a.is_directory ? -1 : 1;
    return a.size - b.size;
  },
  modified: (a, b) => new Date(a.modified) - new Date(b.modified),
};

// Layout of each view mode: icon size, grid minimum column width (px) or null
// for single-column modes, and whether the item shows the size/date metadata.
const MODE_CONFIG = {
  table: { iconSize: 'text-base', gridMin: null, meta: false },
  list: { iconSize: 'text-base', gridMin: null, meta: false },
  content: { iconSize: 'text-3xl', gridMin: null, meta: true },
  tiles: { iconSize: 'text-4xl', gridMin: 200, meta: true },
  small: { iconSize: 'text-lg', gridMin: 88, meta: false },
  medium: { iconSize: 'text-3xl', gridMin: 110, meta: false },
  large: { iconSize: 'text-5xl', gridMin: 128, meta: false },
  xlarge: { iconSize: 'text-7xl', gridMin: 150, meta: false },
};

// Ctrl+wheel cycle order (ascending size, wraps around).
const MODE_ORDER = ['list', 'small', 'medium', 'large', 'xlarge', 'tiles', 'content', 'table'];

export default function FileList() {
  const {
    files,
    loading,
    error,
    selected,
    toggleSelect,
    replaceSelection,
    clearSelection,
    navigate,
    downloadFile,
    openPreview,
    startDragOut,
    startTorrentFromCloud,
    viewMode,
    setViewMode,
  } = useApp();
  const { t, language } = useI18n();
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState(1);
  const [menu, setMenu] = useState(null); // {x, y, item}
  const lastClickIdx = useRef(null);
  const rootRef = useRef(null);
  const scrollRef = useRef(null);

  const cfg = MODE_CONFIG[viewMode] || MODE_CONFIG.table;

  const formatDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(language, { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const metaLine = (item) => {
    const size = item.is_directory ? '—' : formatBytes(item.size);
    return `${size} · ${formatDate(item.modified)}`;
  };

  const sorted = useMemo(() => {
    const combined = [...files].sort((a, b) => {
      if (a.is_directory !== b.is_directory) return a.is_directory ? -1 : 1;
      return SORTERS[sortKey](a, b) * sortDir;
    });
    return combined;
  }, [files, sortKey, sortDir]);

  const marqueeStyle = useMarquee({
    containerRef: scrollRef,
    getItems: () => {
      const container = scrollRef.current;
      if (!container) return [];
      return Array.from(container.querySelectorAll('[data-item]')).map((el) => ({
        path: el.dataset.path,
        element: el,
      }));
    },
    getSelection: () => Array.from(selected),
    onReplace: replaceSelection,
    onClear: clearSelection,
  });

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => -d);
    else {
      setSortKey(key);
      setSortDir(1);
    }
  };

  const onRowClick = (e, item, index) => {
    // Single click on a folder navigates into it (per spec).
    if (item.is_directory) {
      navigate(item.path);
      return;
    }
    if (e.shiftKey && lastClickIdx.current != null) {
      const from = Math.min(lastClickIdx.current, index);
      const to = Math.max(lastClickIdx.current, index);
      replaceSelection(sorted.slice(from, to + 1).map((f) => f.path));
      return;
    }
    lastClickIdx.current = index;
    if (e.ctrlKey || e.metaKey) {
      toggleSelect(item.path, true);
    } else {
      toggleSelect(item.path, false);
    }
  };

  const onRowDoubleClick = (item) => {
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
    // Do NOT preventDefault: canceling the default HTML5 drag
    // ends the drag operation, so a later startDrag() (after
    // the file finishes downloading) has no live drag to hand
    // over to the OS. Instead, seed the dataTransfer so the
    // drag stays active while the file downloads, then the main
    // process calls startDrag() to replace it with a file drag.
    const multi = selected.has(item.path) && selected.size > 1;
    const targets = multi
      ? sorted
          .filter((f) => selected.has(f.path))
          .map((f) => ({
            path: f.path,
            name: f.name,
            is_directory: f.is_directory,
          }))
      : [
          {
            path: item.path,
            name: item.name,
            is_directory: item.is_directory,
          },
        ];
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', item.name);
    startDragOut(targets);
  };

  const itemHandlers = (item, index) => ({
    onClick: (e) => onRowClick(e, item, index),
    onDoubleClick: () => onRowDoubleClick(item),
    onContextMenu: (e) => onContextMenu(e, item),
    onDragStart: (e) => onDragStart(e, item),
  });

  const isSelected = (path) => selected.has(path);

  // Ctrl+wheel cycles through the view modes. Attached natively (non-passive)
  // so preventDefault works and Electron does not zoom the whole UI instead.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const idx = MODE_ORDER.indexOf(viewMode);
      const next =
        e.deltaY < 0
          ? MODE_ORDER[(idx + 1) % MODE_ORDER.length]
          : MODE_ORDER[(idx - 1 + MODE_ORDER.length) % MODE_ORDER.length];
      setViewMode(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewMode, setViewMode]);

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const gridContainerStyle = cfg.gridMin
    ? { gridTemplateColumns: `repeat(auto-fill, minmax(${cfg.gridMin}px, 1fr))` }
    : null;

  const checkmark = (sel) => (
    <span
      className={`text-xs ${sel ? 'text-nc-accent' : 'text-transparent group-hover:text-nc-muted'}`}
    >
      ✔
    </span>
  );

  const renderItem = (item, index) => {
    const sel = isSelected(item.path);
    const handlers = itemHandlers(item, index);

    if (viewMode === 'table') {
      return (
        <div
          key={item.path}
          data-item
          data-path={item.path}
          draggable
          {...handlers}
          className={`flex cursor-pointer items-center gap-3 px-4 py-1.5 ${
            sel ? 'bg-nc-accent/25' : 'hover:bg-nc-hover'
          }`}
        >
          {checkmark(sel)}
          <FileIcon item={item} />
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          <span className="w-24 text-right text-sm text-nc-muted">
            {item.is_directory ? '—' : formatBytes(item.size)}
          </span>
          <span className="w-40 text-right text-sm text-nc-muted">{formatDate(item.modified)}</span>
        </div>
      );
    }

    if (viewMode === 'list') {
      return (
        <div
          key={item.path}
          data-item
          data-path={item.path}
          draggable
          {...handlers}
          className={`flex cursor-pointer items-center gap-3 px-4 py-1 ${
            sel ? 'bg-nc-accent/25' : 'hover:bg-nc-hover'
          }`}
        >
          {checkmark(sel)}
          <FileIcon item={item} />
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
        </div>
      );
    }

    if (viewMode === 'content') {
      return (
        <div
          key={item.path}
          data-item
          data-path={item.path}
          draggable
          {...handlers}
          className={`flex cursor-pointer items-start gap-3 border-b border-nc-border/40 px-4 py-2 ${
            sel ? 'bg-nc-accent/25' : 'hover:bg-nc-hover'
          }`}
        >
          {checkmark(sel)}
          <FileIcon item={item} size={cfg.iconSize} />
          <div className="min-w-0 flex-1">
            <div className="truncate">{item.name}</div>
            <div className="text-xs text-nc-muted">{metaLine(item)}</div>
          </div>
        </div>
      );
    }

    // Grid modes (small..xlarge) and tiles.
    const isTile = viewMode === 'tiles';
    return (
      <div
        key={item.path}
        data-item
        data-path={item.path}
        draggable
        {...handlers}
        className={`relative flex cursor-pointer items-center gap-3 rounded-lg p-2 ${
          isTile ? 'flex-row' : 'flex-col text-center'
        } ${sel ? 'bg-nc-accent/25 outline outline-1 outline-nc-accent' : 'hover:bg-nc-hover'}`}
      >
        {sel && <span className="absolute left-1 top-1 text-xs text-nc-accent">✔</span>}
        <FileIcon item={item} size={cfg.iconSize} />
        <div className={`min-w-0 flex-1 ${isTile ? '' : 'w-full'}`}>
          <div className={`${isTile ? 'truncate text-sm font-medium' : 'break-words text-sm leading-tight line-clamp-2'}`}>
            {item.name}
          </div>
          {cfg.meta && <div className="text-xs text-nc-muted">{metaLine(item)}</div>}
        </div>
      </div>
    );
  };

  return (
    <div ref={rootRef} className="flex min-w-0 flex-1 flex-col bg-nc-bg">
      {viewMode === 'table' && (
        <div className="flex items-center gap-4 border-b border-nc-border px-4 py-2 text-xs font-medium uppercase tracking-wide text-nc-muted">
          <button className="flex-1 text-left hover:text-nc-text" onClick={() => toggleSort('name')}>
            {t('filelist.name')} {sortKey === 'name' && (sortDir === 1 ? '▲' : '▼')}
          </button>
          <button className="w-24 text-right hover:text-nc-text" onClick={() => toggleSort('size')}>
            {t('filelist.size')} {sortKey === 'size' && (sortDir === 1 ? '▲' : '▼')}
          </button>
          <button
            className="w-40 text-right hover:text-nc-text"
            onClick={() => toggleSort('modified')}
          >
            {t('filelist.modified')} {sortKey === 'modified' && (sortDir === 1 ? '▲' : '▼')}
          </button>
        </div>
      )}

      <div ref={scrollRef} className="relative min-h-0 flex-1 select-none overflow-y-auto">
        {loading && (
          <div className="flex h-full items-center justify-center text-nc-muted">
            {t('filelist.loading')}
          </div>
        )}
        {error && (
          <div className="mx-4 mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
        {!loading && !error && sorted.length === 0 && (
          <div className="flex h-full items-center justify-center text-nc-muted">
            {t('filelist.empty')}
          </div>
        )}
        {!loading &&
          (cfg.gridMin ? (
            <div className="grid gap-3 px-4 py-3" style={gridContainerStyle}>
              {sorted.map((item, index) => renderItem(item, index))}
            </div>
          ) : (
            sorted.map((item, index) => renderItem(item, index))
          ))}
        {marqueeStyle && (
          <div
            className="pointer-events-none absolute z-10 rounded-sm border border-nc-accent bg-nc-accent/20"
            style={marqueeStyle}
          />
        )}
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