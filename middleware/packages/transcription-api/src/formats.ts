/**
 * Container-format contract of `transcription@1` (#584): the nine audio
 * container formats a provider accepts for `transcribeFile`, the accepted
 * MIME spellings, and the provider file cap. Every consumer (the upload
 * endpoint in `@omadia/plugin-transcription`, the orchestrator's audio
 * skip-guard, the web-ui's client-side mirror) derives its allowlist from
 * THIS module, so a provider-side format change lands in exactly one place.
 */

/** Provider file cap for `transcribeFile` audio (mirrored client-side). */
export const TRANSCRIPTION_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Canonical MIME per container extension — the nine provider formats
 *  (flac/mp3/mp4/mpeg/mpga/m4a/ogg/wav/webm). Used as the extension
 *  fallback for clients that report a generic content-type, e.g.
 *  `application/octet-stream` for an .m4a voice note. */
export const TRANSCRIPTION_EXTENSION_TO_MIME: Readonly<Record<string, string>> = {
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  mpga: 'audio/mpeg',
  mpeg: 'audio/mpeg',
  mp4: 'audio/mp4',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'audio/webm',
};

/** The nine container extensions, as a set (lowercased, no dot). */
export const TRANSCRIPTION_AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(TRANSCRIPTION_EXTENSION_TO_MIME),
);

/**
 * MIME allowlist for the nine container formats, including the common
 * browser/OS spellings. mp4/webm/mpeg recordings legitimately arrive as
 * `video/*` — the provider accepts the container either way.
 */
export const TRANSCRIPTION_AUDIO_MIME_TYPES: ReadonlySet<string> = new Set([
  'audio/flac',
  'audio/x-flac',
  'audio/mpeg',
  'audio/mp3',
  'audio/mpga',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/ogg',
  'application/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/vnd.wave',
  'audio/webm',
  'video/mp4',
  'video/webm',
  'video/mpeg',
]);

/** `content-type` header → bare lowercased MIME (parameters stripped),
 *  or '' when absent. */
export function normalizeContentType(contentType: string | undefined): string {
  if (!contentType) return '';
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

/** Lowercased file extension (without the dot), or '' when absent. */
export function fileExtension(fileName: string | undefined): string {
  if (!fileName) return '';
  const idx = fileName.lastIndexOf('.');
  if (idx < 0 || idx === fileName.length - 1) return '';
  return fileName.slice(idx + 1).toLowerCase();
}
