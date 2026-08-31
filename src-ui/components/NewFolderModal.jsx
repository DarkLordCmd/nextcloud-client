import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n, translateError } from '../i18n';

const inputCls =
  'w-full rounded-lg border border-nc-border bg-nc-bg px-3 py-2 text-nc-text placeholder-nc-muted';

export default function NewFolderModal({ onClose }) {
  const { createFolder } = useApp();
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      await createFolder(trimmed);
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
        className="w-[360px] rounded-xl border border-nc-border bg-nc-panel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-nc-text">{t('newFolder.title')}</h2>

        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('newFolder.placeholder')}
          className={`mb-4 ${inputCls}`}
          required
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
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
            {t('newFolder.cancel')}
          </button>
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-nc-accent px-4 py-2 text-sm text-white hover:bg-nc-accenthover disabled:opacity-60"
          >
            {t('newFolder.create')}
          </button>
        </div>
      </form>
    </div>
  );
}