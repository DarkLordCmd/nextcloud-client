import React from 'react';
import { useApp } from '../context/AppContext';
import { useI18n } from '../i18n';

function OperationRow({ op }) {
  const { dismissOperation } = useApp();
  const { t } = useI18n();
  const percent = op.percent ?? 0;
  const label = op.filename || t('progress.operation');

  if (op.status === 'error') {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm">
        <span className="text-red-300">⚠️</span>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-red-200">{label}</span>
          <span className="text-red-300/80"> — {op.error || t('progress.failed')}</span>
        </span>
        <button
          className="rounded border border-red-500/40 px-2 py-0.5 text-xs text-red-200 hover:bg-red-500/20"
          onClick={() => dismissOperation(op.id)}
        >
          {t('progress.retry')}
        </button>
      </div>
    );
  }

  if (op.status === 'done') {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-1.5 text-sm">
        <span>✅</span>
        <span className="truncate text-green-200">{label}</span>
        <span className="ml-auto text-xs text-green-300/70">{t('progress.done')}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-nc-border bg-nc-panel px-3 py-1.5 text-sm">
      <span className="truncate">{label}</span>
      <span className="ml-auto shrink-0 text-xs text-nc-muted">{percent}%</span>
      <div className="h-2 w-40 shrink-0 overflow-hidden rounded-full bg-nc-bg">
        <div
          className="h-full rounded-full bg-nc-accent transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

export default function ProgressPanel() {
  const { operations } = useApp();

  if (operations.length === 0) return null;

  return (
    <footer className="flex flex-col gap-1.5 border-t border-nc-border bg-nc-panel px-3 py-2">
      <div className="max-h-40 overflow-y-auto">
        {operations.map((op) => (
          <OperationRow key={op.id} op={op} />
        ))}
      </div>
    </footer>
  );
}