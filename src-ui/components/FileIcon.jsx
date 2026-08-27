import React from 'react';

const ICONS = {
  directory: '📁',
  image: '🖼',
  video: '🎬',
  audio: '🎵',
  pdf: '📕',
  text: '📄',
  archive: '🗜',
};

export default function FileIcon({ item, size = 'text-base' }) {
  let icon = '📎';
  if (item.is_directory) {
    icon = ICONS.directory;
  } else if (item.mime_type) {
    const mime = item.mime_type.toLowerCase();
    if (mime.startsWith('image/')) icon = ICONS.image;
    else if (mime.startsWith('video/')) icon = ICONS.video;
    else if (mime.startsWith('audio/')) icon = ICONS.audio;
    else if (mime === 'application/pdf') icon = ICONS.pdf;
    else if (mime.startsWith('text/')) icon = ICONS.text;
    else if (mime.includes('zip') || mime.includes('compressed') || mime.includes('tar')) {
      icon = ICONS.archive;
    }
  } else {
    const ext = (item.name.split('.').pop() || '').toLowerCase();
    const zipExts = ['zip', 'rar', '7z', 'gz', 'tar', 'bz2', 'xz'];
    const textExts = ['txt', 'md', 'log', 'csv', 'json', 'xml', 'yml', 'yaml', 'conf', 'ini'];
    if (zipExts.includes(ext)) icon = ICONS.archive;
    else if (textExts.includes(ext)) icon = ICONS.text;
    else if (['pdf'].includes(ext)) icon = ICONS.pdf;
    else if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(ext)) {
      icon = ICONS.image;
    } else if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'mp3', 'wav', 'flac', 'ogg'].includes(ext)) {
      icon = ['mp3', 'wav', 'flac', 'ogg'].includes(ext) ? ICONS.audio : ICONS.video;
    }
  }
  return <span className={size}>{icon}</span>;
}