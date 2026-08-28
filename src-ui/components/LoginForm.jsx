import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n, translateError } from '../i18n';

const STORAGE_KEY = 'nextcloud_client_last_server';

export default function LoginForm() {
  const { login, language, setLanguage } = useApp();
  const { t } = useI18n();
  const [server, setServer] = useState(() => localStorage.getItem(STORAGE_KEY) || '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await login({ server, username, password, remember });
      if (remember) {
        localStorage.setItem(STORAGE_KEY, server);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (err) {
      setError(translateError(t, err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-nc-bg">
      <form
        onSubmit={handleSubmit}
        className="relative w-96 rounded-xl border border-nc-border bg-nc-panel p-8 shadow-2xl"
      >
        <select
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="absolute right-4 top-4 rounded border border-nc-border bg-nc-bg px-2 py-1 text-xs text-nc-muted"
          aria-label={t('language')}
        >
          <option value="en">English</option>
          <option value="ru">Русский</option>
        </select>

        <div className="mb-6 text-center">
          <div className="text-3xl">☁️</div>
          <h1 className="mt-2 text-xl font-semibold text-nc-text">NextCloud Client</h1>
          <p className="text-sm text-nc-muted">{t('login.subtitle')}</p>
        </div>

        <label className="mb-1 block text-sm text-nc-muted">{t('login.serverUrl')}</label>
        <input
          type="text"
          value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder="https://cloud.example.com"
          className="mb-4 w-full rounded-lg border border-nc-border bg-nc-bg px-3 py-2 text-nc-text placeholder-nc-muted"
          required
        />

        <label className="mb-1 block text-sm text-nc-muted">{t('login.username')}</label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="username"
          className="mb-4 w-full rounded-lg border border-nc-border bg-nc-bg px-3 py-2 text-nc-text placeholder-nc-muted"
          required
          autoComplete="username"
        />

        <label className="mb-1 block text-sm text-nc-muted">{t('login.password')}</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className="mb-4 w-full rounded-lg border border-nc-border bg-nc-bg px-3 py-2 text-nc-text placeholder-nc-muted"
          required
          autoComplete="current-password"
        />

        <label className="mb-4 flex items-center gap-2 text-sm text-nc-muted">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-4 w-4 accent-nc-accent"
          />
          {t('login.rememberMe')}
        </label>

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-nc-accent px-4 py-2 font-medium text-white hover:bg-nc-accenthover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading && (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          )}
          {loading ? t('login.connecting') : t('login.connect')}
        </button>
      </form>
    </div>
  );
}