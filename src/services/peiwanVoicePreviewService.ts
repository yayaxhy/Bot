import { AttachmentBuilder } from 'discord.js';
import path from 'node:path';

const MAX_VOICE_PREVIEW_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const SUPPORTED_AUDIO_CONTENT_TYPES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/m4a',
  'audio/mp3',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/webm',
  'audio/x-m4a',
  'audio/x-wav',
]);

const SUPPORTED_AUDIO_EXTENSIONS = new Set([
  '.aac',
  '.flac',
  '.m4a',
  '.mp3',
  '.ogg',
  '.opus',
  '.wav',
  '.webm',
]);

const CONTENT_TYPE_EXTENSION_MAP: Record<string, string> = {
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'audio/m4a': '.m4a',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/wav': '.wav',
  'audio/webm': '.webm',
  'audio/x-m4a': '.m4a',
  'audio/x-wav': '.wav',
};

function normalizeContentType(contentType?: string | null) {
  return String(contentType ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
}

function hasSupportedAudioExtension(filename?: string | null) {
  const ext = path.extname(String(filename ?? '')).trim().toLowerCase();
  return SUPPORTED_AUDIO_EXTENSIONS.has(ext);
}

function isSupportedAudioContentType(contentType?: string | null) {
  return SUPPORTED_AUDIO_CONTENT_TYPES.has(normalizeContentType(contentType));
}

function sanitizeFilename(filename?: string | null) {
  const base = path.basename(String(filename ?? '').trim());
  return base.replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '');
}

function inferFilename(url: string, filename?: string | null, contentType?: string | null) {
  const sanitized = sanitizeFilename(filename);
  if (sanitized && hasSupportedAudioExtension(sanitized)) return sanitized;

  const pathname = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return '';
    }
  })();
  const fromUrl = sanitizeFilename(path.basename(pathname));
  if (fromUrl && hasSupportedAudioExtension(fromUrl)) return fromUrl;

  const ext = CONTENT_TYPE_EXTENSION_MAP[normalizeContentType(contentType)] ?? '.mp3';
  return `voice-preview${ext}`;
}

export async function buildStoredVoicePreviewAttachment(preview: {
  url?: string | null;
  filename?: string | null;
}) {
  const url = String(preview.url ?? '').trim();
  if (!url) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`voice_preview_fetch_failed:${response.status}`);
    }

    const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_VOICE_PREVIEW_BYTES) {
      throw new Error(`voice_preview_too_large:${contentLength}`);
    }

    const contentType = normalizeContentType(response.headers.get('content-type'));
    const filename = inferFilename(url, preview.filename, contentType);
    if (!isSupportedAudioContentType(contentType) && !hasSupportedAudioExtension(filename)) {
      throw new Error(`voice_preview_invalid_content_type:${contentType || 'unknown'}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength === 0) {
      throw new Error('voice_preview_empty_payload');
    }
    if (arrayBuffer.byteLength > MAX_VOICE_PREVIEW_BYTES) {
      throw new Error(`voice_preview_too_large:${arrayBuffer.byteLength}`);
    }

    return new AttachmentBuilder(Buffer.from(arrayBuffer), { name: filename });
  } finally {
    clearTimeout(timeout);
  }
}
