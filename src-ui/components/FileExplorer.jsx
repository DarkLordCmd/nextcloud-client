import React, { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n } from '../i18n';
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

function FolderNode({ path, name, depth }) {
  const { treeNodes, ensureNode, navigate, currentPath } = useApp();
  const [expanded, setExpanded] = useState(false);
  const children = treeNodes[path] || [];

  useEffect(() => {
    if (expanded && treeNodes[path] === undefined) ensureNode(path);
  }, [expanded, path]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = currentPath === path;

  return (
    <div>
      <div
        className={`flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-sm ${
          active ? 'bg-nc-accent/25 text-nc-text' : 'text-nc-text hover:bg-nc-hover'
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => {
          setExpanded((v) => !v);
          navigate(path);
        }}
      >
        <span className="w-4 text-xs text-nc-muted">
          {children.some((c) => c.is_directory) ? (expanded ? '▼' : '▶') : ''}
        </span>
        <FileIcon item={{ is_directory: true }} size="text-sm" />
        <span className="truncate">{name}</span>
      </div>
      {expanded &&
        children
          .filter((c) => c.is_directory)
          .map((c) => <FolderNode key={c.path} path={c.path} name={c.name} depth={depth + 1} />)}
    </div>
  );
}

function QuotaBar() {
  const { quota } = useApp();
  const { t } = useI18n();

  if (!quota) {
    return <div className="px-3 py-2 text-xs text-nc-muted">{t('quota.loading')}</div>;
  }
  const pct =
    quota.unlimited || quota.quota <= 0 ? null : Math.min(100, Math.round((quota.used / quota.quota) * 100));
  const used = formatBytes(quota.used);
  const label = quota.unlimited
    ? t('quota.used', { used })
    : t('quota.of', { used, total: formatBytes(quota.quota), pct });

  return (
    <div className="px-3 py-2">
      <div className="h-2 w-full overflow-hidden rounded-full bg-nc-panel">
        <div
          className={`h-full rounded-full ${pct != null && pct >= 90 ? 'bg-red-500' : 'bg-nc-accent'}`}
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>
      <div className="mt-1 truncate text-xs text-nc-muted" title={label}>
        {label}
      </div>
    </div>
  );
}

export default function FileExplorer() {
  const { treeNodes, ensureNode, currentPath, navigate, trashView, openTrash } = useApp();
  const { t } = useI18n();
  const rootChildren = treeNodes['/'] || [];

  useEffect(() => {
    if (treeNodes['/'] === undefined) ensureNode('/');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-nc-border bg-nc-panel md:flex">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-nc-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-nc-muted">
          {t('folders.title')}
        </div>
        <div
          className={`mt-1 flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-sm ${
            currentPath === '/' ? 'bg-nc-accent/25' : 'hover:bg-nc-hover'
          }`}
          onClick={() => navigate('/')}
        >
          <span className="text-xs">☁️</span>
          <span>{t('folders.root')}</span>
        </div>
        {rootChildren
          .filter((c) => c.is_directory)
          .map((c) => (
            <FolderNode key={c.path} path={c.path} name={c.name} depth={1} />
          ))}
      </div>

      <div className="shrink-0 border-t border-nc-border">
        <div
          className={`mt-1 flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-sm ${
            trashView ? 'bg-nc-accent/25 text-nc-text' : 'text-nc-text hover:bg-nc-hover'
          }`}
          onClick={openTrash}
        >
          <span className="text-xs">🗑</span>
          <span>{t('trash.title')}</span>
        </div>
        <QuotaBar />
      </div>
    </aside>
  );
}