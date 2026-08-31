import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n } from '../i18n';

const MODES = ['content', 'tiles', 'table', 'list', 'small', 'medium', 'large', 'xlarge'];

const MENU_ITEM =
  'w-full px-4 py-2 text-left text-sm hover:bg-nc-hover disabled:cursor-not-allowed disabled:opacity-50';

export default function ViewModeMenu() {
  const { viewMode, setViewMode } = useApp();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        className="flex items-center gap-1.5 rounded-lg border border-nc-border bg-nc-bg px-3 py-1.5 text-sm hover:bg-nc-hover"
        onClick={() => setOpen((v) => !v)}
        title={t('viewmode.title')}
      >
        ▦
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg border border-nc-border bg-nc-panel py-1 shadow-2xl">
          {MODES.map((mode) => (
            <button
              key={mode}
              className={MENU_ITEM}
              onClick={() => {
                setOpen(false);
                setViewMode(mode);
              }}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate">{t(`viewmode.${mode}`)}</span>
                {viewMode === mode && <span className="text-nc-accent">✔</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}