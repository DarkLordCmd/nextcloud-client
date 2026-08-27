import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
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

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const SORTERS = {
  name: (a, b) => a.name.localeCompare(b.name),
  size: (a, b) => {
    if (a.is_directory !== b.is_directory) return a.is_directory ? -1 : 1;
    return a.size - b.size;
  },
  modified: (a, b) => new Date(a.modified) - new Date(b.modified),
};

export default function FileList() {
  const {
    files,
    loading,
    error,
    selected,
    toggleSelect,
    replaceSelection,
    navigate,
    downloadFile,
    openPreview,
  } = useApp();
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState(1);
  const [menu, setMenu] = useState(null); // {x, y, item}
  const lastClickIdx = useRef(null);

  const sorted = useMemo(() => {
    const dirs = files.filter((f) => f.is_directory).sort(SORTERS[sortKey]);
    const others = files
      .filter((f) => !f.is_directory)
      .sort(SORTERS[sortKey]);
    const combined = [...dirs, ...others];
    if (sortKey !== 'name') {
      combined.sort((a, b) => {
        if (a.is_directory !== b.is_directory) return a.is_directory ? -1 : 1;
        return SORTERS[sortKey](a, b) * sortDir;
      });
    } else {
      combined.sort((a, b) => {
        if (a.is_directory !== b.is_directory) return a.is_directory ? -1 : 1;
        return SORTERS[sortKey](a, b) * sortDir;
      });
    }
    return combined;
  }, [files, sortKey, sortDir]);

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
    else if (previewKind(item)) openPreview(item.path);
    else downloadFile(item.path);
  };

  const onContextMenu = (e, item) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, item });
  };

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const isSelected = (path) => selected.has(path);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-nc-bg">
      <div className="flex items-center gap-4 border-b border-nc-border px-4 py-2 text-xs font-medium uppercase tracking-wide text-nc-muted">
        <button className="flex-1 text-left hover:text-nc-text" onClick={() => toggleSort('name')}>
          Name {sortKey === 'name' && (sortDir === 1 ? '▲' : '▼')}
        </button>
        <button className="w-24 text-right hover:text-nc-text" onClick={() => toggleSort('size')}>
          Size {sortKey === 'size' && (sortDir === 1 ? '▲' : '▼')}
        </button>
        <button
          className="w-40 text-right hover:text-nc-text"
          onClick={() => toggleSort('modified')}
        >
          Modified {sortKey === 'modified' && (sortDir === 1 ? '▲' : '▼')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && (
          <div className="flex h-full items-center justify-center text-nc-muted">Loading…</div>
        )}
        {error && (
          <div className="mx-4 mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
        {!loading && !error && sorted.length === 0 && (
          <div className="flex h-full items-center justify-center text-nc-muted">
            This folder is empty
          </div>
        )}
        {!loading &&
          sorted.map((item, index) => {
            const sel = isSelected(item.path);
            return (
              <div
                key={item.path}
                onClick={(e) => onRowClick(e, item, index)}
                onDoubleClick={() => onRowDoubleClick(item)}
                onContextMenu={(e) => onContextMenu(e, item)}
                className={`flex cursor-pointer items-center gap-3 px-4 py-1.5 ${
                  sel ? 'bg-nc-accent/25' : 'hover:bg-nc-hover'
                }`}
              >
                <span
                  className={`text-xs ${
                    sel ? 'text-nc-accent' : 'text-transparent group-hover:text-nc-muted'
                  }`}
                >
                  ✔
                </span>
                <FileIcon item={item} />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="w-24 text-right text-sm text-nc-muted">
                  {item.is_directory ? '—' : formatBytes(item.size)}
                </span>
                <span className="w-40 text-right text-sm text-nc-muted">
                  {formatDate(item.modified)}
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