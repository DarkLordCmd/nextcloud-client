import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n } from '../i18n';
import AddAccountModal from './AddAccountModal';

const MENU_ITEM =
  'w-full px-4 py-2 text-left text-sm hover:bg-nc-hover disabled:cursor-not-allowed disabled:opacity-50';

export default function AccountMenu() {
  const { auth, switchAccount, logout } = useApp();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const accounts = auth?.accounts || [];
  const active = auth?.active || null;
  const label = auth?.username || '';

  return (
    <div className="relative" ref={ref}>
      <button
        className="flex items-center gap-1.5 rounded-lg border border-nc-border bg-nc-bg px-3 py-1.5 text-sm hover:bg-nc-hover"
        onClick={() => setOpen((v) => !v)}
        title={t('accounts.switchHint')}
      >
        👤 {label}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-60 overflow-hidden rounded-lg border border-nc-border bg-nc-panel py-1 shadow-2xl">
          {accounts.length === 0 && (
            <div className="px-4 py-2 text-sm text-nc-muted">{t('accounts.empty')}</div>
          )}
          {accounts.map((acc) => {
            const isActive =
              active && active.server === acc.server && active.username === acc.username;
            return (
              <button
                key={`${acc.server}|${acc.username}`}
                className={MENU_ITEM}
                onClick={() => {
                  setOpen(false);
                  if (!isActive) switchAccount(acc.server, acc.username);
                }}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate">
                    {acc.username}
                    <span className="block truncate text-xs text-nc-muted">{acc.server}</span>
                  </span>
                  {isActive && <span className="text-nc-accent">✔</span>}
                </span>
              </button>
            );
          })}
          <div className="my-1 border-t border-nc-border" />
          <button className={MENU_ITEM} onClick={() => { setOpen(false); setShowAdd(true); }}>
            ➕ {t('accounts.add')}
          </button>
          <button
            className={`${MENU_ITEM} text-red-300 hover:bg-red-500/20`}
            onClick={() => { setOpen(false); logout(); }}
          >
            🚪 {t('accounts.logout')}
          </button>
        </div>
      )}

      {showAdd && <AddAccountModal onClose={() => setShowAdd(false)} />}
    </div>
  );
}