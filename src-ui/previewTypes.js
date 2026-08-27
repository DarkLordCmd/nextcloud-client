// File-type detection for the built-in preview panel.

const EXT_KINDS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'],
  video: ['mp4', 'webm', 'ogg', 'mov', '3gp'],
  audio: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'opus', 'oga'],
  pdf: ['pdf'],
  markdown: ['md', 'markdown'],
  text: ['txt'],
  document: ['docx'],
  spreadsheet: ['xlsx', 'xls'],
  doc: ['doc'],
};

export function previewKind(item) {
  if (!item || item.is_directory) return null;

  const mime = (item.mime_type || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/msword') return 'doc';
  if (mime.includes('wordprocessingml')) return 'document';
  if (mime.includes('spreadsheetml') || mime === 'application/vnd.ms-excel') return 'spreadsheet';
  if (mime.startsWith('text/markdown') || mime === 'text/x-markdown') return 'markdown';
  if (mime.startsWith('text/')) return 'text';

  const ext = (item.name.split('.').pop() || '').toLowerCase();
  for (const [kind, exts] of Object.entries(EXT_KINDS)) {
    if (exts.includes(ext)) return kind;
  }
  return null;
}

export function isZoomableKind(kind) {
  return (
    kind === 'image' ||
    kind === 'text' ||
    kind === 'markdown' ||
    kind === 'pdf' ||
    kind === 'document' ||
    kind === 'spreadsheet'
  );
}