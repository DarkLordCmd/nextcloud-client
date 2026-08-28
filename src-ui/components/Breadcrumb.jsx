import React from 'react';
import { useApp } from '../context/AppContext';
import { useI18n } from '../i18n';

export default function Breadcrumb() {
  const { currentPath, navigate } = useApp();
  const { t } = useI18n();

  const segments = currentPath.split('/').filter(Boolean);

  return (
    <nav className="flex min-w-0 items-center gap-1 text-sm">
      <button
        onClick={() => navigate('/')}
        className="rounded px-2 py-1 font-medium hover:bg-nc-hover"
        title={t('breadcrumb.rootTitle')}
      >
        ☁️
      </button>
      {segments.map((seg, i) => {
        const path = `/${segments.slice(0, i + 1).join('/')}`;
        const isLast = i === segments.length - 1;
        return (
          <React.Fragment key={path}>
            <span className="text-nc-muted">/</span>
            <button
              onClick={() => navigate(path)}
              className={`max-w-[180px] truncate rounded px-2 py-1 hover:bg-nc-hover ${
                isLast ? 'font-semibold text-nc-text' : 'text-nc-muted'
              }`}
            >
              {seg}
            </button>
          </React.Fragment>
        );
      })}
    </nav>
  );
}