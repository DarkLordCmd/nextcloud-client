import React, { useEffect, useState } from 'react';
import { useApp } from '../context/AppContext';
import FileIcon from './FileIcon';

function FolderNode({ path, name, depth }) {
  const { treeNodes, ensureNode, navigate, currentPath } = useApp();
  const [expanded, setExpanded] = useState(false);
  const children = treeNodes[path] || [];

  useEffect(() => {
    if (treeNodes[path] === undefined) ensureNode(path);
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

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

export default function FileExplorer() {
  const { treeNodes, ensureNode, currentPath, navigate } = useApp();
  const rootChildren = treeNodes['/'] || [];

  useEffect(() => {
    if (treeNodes['/'] === undefined) ensureNode('/');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside className="hidden w-64 shrink-0 flex-col overflow-y-auto border-r border-nc-border bg-nc-panel md:flex">
      <div className="border-b border-nc-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-nc-muted">
        Folders
      </div>
      <div
        className={`mt-1 flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-sm ${
          currentPath === '/' ? 'bg-nc-accent/25' : 'hover:bg-nc-hover'
        }`}
        onClick={() => navigate('/')}
      >
        <span className="text-xs">☁️</span>
        <span>Root</span>
      </div>
      {rootChildren
        .filter((c) => c.is_directory)
        .map((c) => (
          <FolderNode key={c.path} path={c.path} name={c.name} depth={1} />
        ))}
    </aside>
  );
}