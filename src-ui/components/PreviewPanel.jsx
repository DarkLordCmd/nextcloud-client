import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { useI18n } from '../i18n';
import { api } from '../api';
import { previewKind, isZoomableKind } from '../previewTypes';

const NAV_DEBOUNCE_MS = 400;

// Returns true when the wheel event target sits inside an element that can
// actually scroll vertically (has a scrollbar). Such events must scroll the
// content natively instead of switching to the next/previous file.
function isScrollableTarget(target) {
  let el = target instanceof Element ? target : null;
  while (el && el !== document.documentElement) {
    const overflowY = window.getComputedStyle(el).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
      if (el.scrollHeight > el.clientHeight + 1) return true;
    }
    el = el.parentElement;
  }
  return false;
}

export default function PreviewPanel({ path, onClose }) {
  const { files, downloadFile } = useApp();
  const { t } = useI18n();

  const sameKindFiles = useMemo(
    () => files.filter((f) => !f.is_directory && previewKind(f) !== null),
    [files]
  );

  const [index, setIndex] = useState(() => {
    const i = sameKindFiles.findIndex((f) => f.path === path);
    return i === -1 ? 0 : i;
  });
  const [zoom, setZoom] = useState(1);
  const [text, setText] = useState(null);
  const [docHtml, setDocHtml] = useState(null);
  const [textError, setTextError] = useState(null);
  const lastWheel = useRef(0);

  const item = sameKindFiles[index];
  const kind = item ? previewKind(item) : null;
  const inlineUrl = item ? api.inlineDownloadUrl(item.path) : null;

  const prev = useCallback(() => {
    setIndex((i) => (i - 1 + sameKindFiles.length) % sameKindFiles.length);
  }, [sameKindFiles.length]);

  const next = useCallback(() => {
    setIndex((i) => (i + 1) % sameKindFiles.length);
  }, [sameKindFiles.length]);

  const zoomBy = useCallback((delta) => {
    setZoom((z) => Math.min(4, Math.max(0.25, Math.round((z + delta) * 100) / 100)));
  }, []);

  // Load text / markdown / office content asynchronously. Heavy libraries
  // (marked, dompurify, mammoth, xlsx) are imported lazily so they only load
  // when a preview actually needs them (Vite code-splits them out of the bundle).
  useEffect(() => {
    setText(null);
    setDocHtml(null);
    setTextError(null);
    if (!item) return;
    let cancelled = false;
    const fetchBlob = () => api.downloadBlob(item.path);

    const loadDoc = async () => {
      try {
        const blob = await fetchBlob();
        if (cancelled) return;
        const buf = await blob.arrayBuffer();
        if (kind === 'markdown') {
          const [{ marked }, { default: DOMPurify }] = await Promise.all([
            import('marked'),
            import('dompurify'),
          ]);
          if (cancelled) return;
          const text = new TextDecoder().decode(buf);
          const parsed = marked.parse(text, { breaks: true });
          const raw = typeof parsed === 'string' ? parsed : '';
          setDocHtml(DOMPurify.sanitize(raw));
        } else if (kind === 'text') {
          setText(new TextDecoder().decode(buf));
        } else if (kind === 'document') {
          const [{ default: mammoth }, { default: DOMPurify }] = await Promise.all([
            import('mammoth'),
            import('dompurify'),
          ]);
          if (cancelled) return;
          const result = await mammoth.convertToHtml({ arrayBuffer: buf });
          setDocHtml(DOMPurify.sanitize(result.value));
        } else if (kind === 'spreadsheet') {
          const [{ default: DOMPurify }, XLSX] = await Promise.all([
            import('dompurify'),
            import('xlsx'),
          ]);
          if (cancelled) return;
          const wb = XLSX.read(buf, { type: 'array' });
          const ws = wb.SheetNames.length > 0 ? wb.Sheets[wb.SheetNames[0]] : null;
          const html = ws
            ? XLSX.utils.sheet_to_html(ws, { editable: false })
            : `<p>${t('preview.emptySheet')}</p>`;
          setDocHtml(DOMPurify.sanitize(html));
        }
      } catch (e) {
        if (!cancelled) setTextError(e.message);
      }
    };
    loadDoc();

    return () => {
      cancelled = true;
    };
  }, [item && item.path, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const html = useMemo(() => {
    if (kind !== 'markdown' || docHtml == null) return null;
    return docHtml;
  }, [kind, docHtml]);

  // Reset zoom when switching files.
  useEffect(() => {
    setZoom(1);
  }, [item && item.path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard: Esc closes, arrows navigate.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, prev, next]);

  // Mouse wheel: Ctrl+wheel zooms (image/text/md/pdf), plain wheel switches files.
  // Wheel over the media element itself is ignored so it never flips files
  // (accidental scroll over a video looked like "vibration" / jumping).
  useEffect(() => {
    const onWheel = (e) => {
      const target = e.target;
      if (target instanceof HTMLVideoElement || target instanceof HTMLAudioElement) return;
      if (e.ctrlKey) {
        if (item && isZoomableKind(kind)) {
          e.preventDefault();
          zoomBy(e.deltaY < 0 ? 0.1 : -0.1);
        }
        return;
      }
      // If the wheel is over an inner scrollable area (e.g. a long text or
      // zoomed image), let it scroll natively instead of switching files.
      if (isScrollableTarget(target)) return;
      const now = Date.now();
      if (now - lastWheel.current < NAV_DEBOUNCE_MS) return;
      lastWheel.current = now;
      if (e.deltaY < 0) prev();
      else next();
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [item, kind, prev, next, zoomBy]);

  const renderBody = () => {
    switch (kind) {
      case 'image':
        return (
          <div className="flex h-full items-center justify-center">
            <img
              src={inlineUrl}
              alt={item.name}
              className="max-h-full max-w-full object-contain"
              style={{ transform: `scale(${zoom})` }}
            />
          </div>
        );
      case 'video':
        return (
          <div className="flex h-full items-center justify-center">
            <video
              key={item.path}
              src={inlineUrl}
              controls
              autoPlay
              className="m-auto max-h-full max-w-full object-contain"
            />
          </div>
        );
      case 'audio':
        return (
          <div className="flex h-full items-center justify-center">
            <audio key={item.path} src={inlineUrl} controls autoPlay />
          </div>
        );
      case 'pdf':
        return (
          <div className="flex h-full items-center justify-center">
            <iframe key={item.path} src={inlineUrl} title={item.name} className="h-full w-full" style={{ zoom }} />
          </div>
        );
      case 'text':
        return (
          <pre
            className="whitespace-pre-wrap break-words p-4 font-mono text-nc-text"
            style={{ fontSize: `${14 * zoom}px`, lineHeight: 1.5 }}
          >
            {textError ? t('preview.loadError', { error: textError }) : text != null ? text : t('preview.loading')}
          </pre>
        );
      case 'markdown':
        return textError ? (
          <div className="p-4 text-sm text-red-300">{t('preview.loadError', { error: textError })}</div>
        ) : (
          <div
            className="md-body mx-auto max-w-3xl p-6 text-nc-text"
            style={{ fontSize: `${16 * zoom}px` }}
            dangerouslySetInnerHTML={{
              __html: html != null ? html : `<p>${t('preview.loading')}</p>`,
            }}
          />
        );
      case 'document':
        return textError ? (
          <div className="p-4 text-sm text-red-300">{t('preview.loadError', { error: textError })}</div>
        ) : (
          <div
            className="md-body mx-auto max-w-3xl p-6 text-nc-text"
            style={{ fontSize: `${16 * zoom}px` }}
            dangerouslySetInnerHTML={{
              __html: docHtml != null ? docHtml : `<p>${t('preview.loading')}</p>`,
            }}
          />
        );
      case 'spreadsheet':
        return textError ? (
          <div className="p-4 text-sm text-red-300">{t('preview.loadError', { error: textError })}</div>
        ) : (
          <div
            className="sheet-body mx-auto max-w-5xl p-4 text-nc-text"
            style={{ fontSize: `${13 * zoom}px` }}
            dangerouslySetInnerHTML={{
              __html: docHtml != null ? docHtml : `<p>${t('preview.loading')}</p>`,
            }}
          />
        );
      case 'doc':
        return (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="text-4xl">📄</div>
            <div className="max-w-md text-sm text-nc-muted">
              {t('preview.docUnsupported')}
            </div>
            <button
              className="rounded bg-nc-accent px-4 py-2 text-sm text-white hover:bg-nc-accenthover"
              onClick={() => downloadFile(item.path)}
            >
              ⬇ {t('preview.docDownload')}
            </button>
          </div>
        );
      default:
        return <div className="p-6 text-nc-muted">{t('preview.unavailable')}</div>;
    }
  };

  if (!item) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col bg-nc-bg">
        <div className="flex items-center justify-between border-b border-nc-border bg-nc-panel px-4 py-2">
          <span className="text-sm font-medium">{t('preview.title')}</span>
          <button
            className="rounded px-3 py-1 text-sm text-nc-text hover:bg-nc-hover"
            onClick={onClose}
          >
            ✕ {t('preview.close')}
          </button>
        </div>
        <div className="flex flex-1 items-center justify-center text-nc-muted">
          {t('preview.notFound')}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-nc-bg">
      <header className="flex items-center justify-between gap-3 border-b border-nc-border bg-nc-panel px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
            className="rounded px-2 py-1 text-nc-text hover:bg-nc-hover disabled:opacity-40"
            onClick={prev}
            title={t('preview.prev')}
          >
            ◀
          </button>
          <button
            className="rounded px-2 py-1 text-nc-text hover:bg-nc-hover disabled:opacity-40"
            onClick={next}
            title={t('preview.next')}
          >
            ▶
          </button>
          <span className="truncate font-medium">{item.name}</span>
          {isZoomableKind(kind) && (
            <span className="hidden text-xs text-nc-muted sm:inline">· {t('preview.zoomHint')}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            className="rounded bg-nc-accent px-3 py-1 text-sm text-white hover:bg-nc-accenthover"
            onClick={() => downloadFile(item.path)}
          >
            ⬇ {t('preview.download')}
          </button>
          <button
            className="rounded px-3 py-1 text-sm text-nc-text hover:bg-nc-hover"
            onClick={onClose}
          >
            ✕ {t('preview.close')}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto" style={{ scrollbarGutter: 'stable' }}>
        {renderBody()}
      </div>

      <footer className="border-t border-nc-border bg-nc-panel px-4 py-1 text-center text-xs text-nc-muted">
        {t('preview.footer', { index: index + 1, total: sameKindFiles.length })}
      </footer>
    </div>
  );
}