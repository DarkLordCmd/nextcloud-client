import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { api } from '../api';
import { previewKind, isZoomableKind } from '../previewTypes';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

const NAV_DEBOUNCE_MS = 400;

export default function PreviewPanel({ path, onClose }) {
  const { files, downloadFile } = useApp();

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

  // Load text / markdown / office content asynchronously.
  useEffect(() => {
    setText(null);
    setDocHtml(null);
    setTextError(null);
    if (!item) return;
    let cancelled = false;
    const fetchBlob = () => api.downloadBlob(item.path);

    if (kind === 'text' || kind === 'markdown') {
      fetchBlob()
        .then(async (blob) => {
          if (cancelled) return;
          setText(await blob.text());
        })
        .catch((e) => {
          if (!cancelled) setTextError(e.message);
        });
      return () => {
        cancelled = true;
      };
    }

    if (kind === 'document' || kind === 'spreadsheet') {
      fetchBlob()
        .then(async (blob) => {
          if (cancelled) return;
          const buf = await blob.arrayBuffer();
          if (kind === 'document') {
            const result = await mammoth.convertToHtml({ arrayBuffer: buf });
            if (!cancelled) setDocHtml(DOMPurify.sanitize(result.value));
          } else {
            const wb = XLSX.read(buf, { type: 'array' });
            const ws = wb.SheetNames.length > 0 ? wb.Sheets[wb.SheetNames[0]] : null;
            const html = ws ? XLSX.utils.sheet_to_html(ws, { editable: false }) : '<p>Лист пуст</p>';
            if (!cancelled) setDocHtml(DOMPurify.sanitize(html));
          }
        })
        .catch((e) => {
          if (!cancelled) setTextError(e.message);
        });
      return () => {
        cancelled = true;
      };
    }

    return undefined;
  }, [item && item.path, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const html = useMemo(() => {
    if (kind !== 'markdown' || text == null) return null;
    const parsed = marked.parse(text, { breaks: true });
    const raw = typeof parsed === 'string' ? parsed : '';
    return DOMPurify.sanitize(raw);
  }, [kind, text]);

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
            {textError ? `Ошибка загрузки: ${textError}` : text != null ? text : 'Загрузка…'}
          </pre>
        );
      case 'markdown':
        return textError ? (
          <div className="p-4 text-sm text-red-300">Ошибка загрузки: {textError}</div>
        ) : (
          <div
            className="md-body mx-auto max-w-3xl p-6 text-nc-text"
            style={{ fontSize: `${16 * zoom}px` }}
            dangerouslySetInnerHTML={{
              __html: html != null ? html : '<p>Загрузка…</p>',
            }}
          />
        );
      case 'document':
        return textError ? (
          <div className="p-4 text-sm text-red-300">Ошибка загрузки: {textError}</div>
        ) : (
          <div
            className="md-body mx-auto max-w-3xl p-6 text-nc-text"
            style={{ fontSize: `${16 * zoom}px` }}
            dangerouslySetInnerHTML={{
              __html: docHtml != null ? docHtml : '<p>Загрузка…</p>',
            }}
          />
        );
      case 'spreadsheet':
        return textError ? (
          <div className="p-4 text-sm text-red-300">Ошибка загрузки: {textError}</div>
        ) : (
          <div
            className="sheet-body mx-auto max-w-5xl p-4 text-nc-text"
            style={{ fontSize: `${13 * zoom}px` }}
            dangerouslySetInnerHTML={{
              __html: docHtml != null ? docHtml : '<p>Загрузка…</p>',
            }}
          />
        );
      case 'doc':
        return (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="text-4xl">📄</div>
            <div className="max-w-md text-sm text-nc-muted">
              Предпросмотр старых .doc файлов не поддерживается. Скачайте файл и откройте его в
              Word.
            </div>
            <button
              className="rounded bg-nc-accent px-4 py-2 text-sm text-white hover:bg-nc-accenthover"
              onClick={() => downloadFile(item.path)}
            >
              ⬇ Скачать
            </button>
          </div>
        );
      default:
        return <div className="p-6 text-nc-muted">Предпросмотр для этого типа недоступен.</div>;
    }
  };

  if (!item) {
    return (
      <div className="fixed inset-0 z-40 flex flex-col bg-nc-bg">
        <div className="flex items-center justify-between border-b border-nc-border bg-nc-panel px-4 py-2">
          <span className="text-sm font-medium">Предпросмотр</span>
          <button
            className="rounded px-3 py-1 text-sm text-nc-text hover:bg-nc-hover"
            onClick={onClose}
          >
            ✕ Закрыть
          </button>
        </div>
        <div className="flex flex-1 items-center justify-center text-nc-muted">
          Файл не найден
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
            title="Предыдущий (←)"
          >
            ◀
          </button>
          <button
            className="rounded px-2 py-1 text-nc-text hover:bg-nc-hover disabled:opacity-40"
            onClick={next}
            title="Следующий (→)"
          >
            ▶
          </button>
          <span className="truncate font-medium">{item.name}</span>
          {isZoomableKind(kind) && (
            <span className="hidden text-xs text-nc-muted sm:inline">· Ctrl+колесо — масштаб</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            className="rounded bg-nc-accent px-3 py-1 text-sm text-white hover:bg-nc-accenthover"
            onClick={() => downloadFile(item.path)}
          >
            ⬇ Скачать
          </button>
          <button
            className="rounded px-3 py-1 text-sm text-nc-text hover:bg-nc-hover"
            onClick={onClose}
          >
            ✕ Закрыть
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto" style={{ scrollbarGutter: 'stable' }}>
        {renderBody()}
      </div>

      <footer className="border-t border-nc-border bg-nc-panel px-4 py-1 text-center text-xs text-nc-muted">
        {index + 1} / {sameKindFiles.length} · колесо — переключение, Ctrl+колесо — масштаб
      </footer>
    </div>
  );
}