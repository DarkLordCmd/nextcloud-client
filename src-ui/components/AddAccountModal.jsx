import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n, translateError } from '../i18n';

const inputCls =
  'w-full rounded-lg border border-nc-border bg-nc-bg px-3 py-2 text-nc-text placeholder-nc-muted';

export default function AddAccountModal({ onClose }) {
  const { login } = useApp();
  const { t } = useI18n();
  const [server, setServer] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login({ server, username, password });
      onClose();
    } catch (err) {
      setError(translateError(t, err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        className="w-[420px] rounded-xl border border-nc-border bg-nc-panel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-nc-text">{t('accounts.add')}</h2>

        <label className="mb-1 block text-sm text-nc-muted">{t('accounts.serverUrl')}</label>
        <input
          type="text"
          value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder="https://cloud.example.com"
          className={`mb-4 ${inputCls}`}
          required
        />

        <label className="mb-1 block text-sm text-nc-muted">{t('accounts.username')}</label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username"
          className={`mb-4 ${inputCls}`}
          required
          autoComplete="username"
        />

        <label className="mb-1 block text-sm text-nc-muted">{t('accounts.password')}</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className={`mb-4 ${inputCls}`}
          required
          autoComplete="current-password"
        />

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-nc-border px-4 py-2 text-sm text-nc-text hover:bg-nc-hover"
            onClick={onClose}
          >
            {t('accounts.cancel')}
          </button>
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-nc-accent px-4 py-2 text-sm text-white hover:bg-nc-accenthover disabled:opacity-60"
          >
            {loading ? t('accounts.adding') : t('accounts.add')}
          </button>
        </div>
      </form>
    </div>
  );
}