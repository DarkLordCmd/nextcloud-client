import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n } from '../i18n';

export default function SearchField() {
  const { runSearch, clearSearch } = useApp();
  const { t } = useI18n();
  const [value, setValue] = useState('');
  const ref = useRef(null);

  // Ctrl+F focuses the field from anywhere.
  useEffect(() => {
    const focus = () => {
      if (ref.current) {
        ref.current.focus();
        ref.current.select();
      }
    };
    window.addEventListener('nc:focus-search', focus);
    return () => window.removeEventListener('nc:focus-search', focus);
  }, []);

  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      runSearch(value);
    } else if (e.key === 'Escape') {
      setValue('');
      clearSearch();
      if (ref.current) ref.current.blur();
    }
  };

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-nc-muted">
        🔍
      </span>
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('search.placeholder')}
        title={t('search.hint')}
        className="w-56 rounded-lg border border-nc-border bg-nc-bg py-1.5 pl-8 pr-2 text-sm placeholder:text-nc-muted"
      />
    </div>
  );
}