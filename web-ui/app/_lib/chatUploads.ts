/**
 * #2336 (ADR-0310) — file uploads of the web chat, client side.
 *
 * Files are uploaded as soon as they are attached (`POST /bot-api/chat/uploads`)
 * and the turn later names them by their storage key. The middleware is
 * authoritative for type and size; the lists here only let the browser refuse
 * early and set the file picker's `accept`. Keep them in step with
 * `middleware/src/routes/chatUploads.ts`.
 */

/** Same as `WEB_CHAT_UPLOAD_MAX_BYTES` in the middleware (25 MiB). */
export const CHAT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** Same as `WEB_CHAT_UPLOADS_PER_TURN` in the middleware. */
export const CHAT_UPLOADS_PER_MESSAGE = 10;

export const CHAT_UPLOAD_EXTENSIONS: readonly string[] = [
  'mp3', 'm4a', 'wav', 'ogg', 'oga', 'opus', 'webm', 'flac', 'aac', 'mp4',
  'pdf', 'docx', 'txt', 'md',
  'csv', 'xlsx',
  'png', 'jpg', 'jpeg', 'gif', 'webp',
];

/** `accept` attribute of the file picker. */
export const CHAT_UPLOAD_ACCEPT = CHAT_UPLOAD_EXTENSIONS.map((ext) => `.${ext}`).join(',');

/** Why an upload did not go through; each maps to a `chat.uploads.error.*` key. */
export type ChatUploadError =
  | 'tooLarge'
  | 'unsupportedType'
  | 'tooMany'
  | 'empty'
  | 'storeUnavailable'
  | 'chatLimit'
  | 'accountLimit'
  | 'contentMismatch'
  | 'noAccount'
  | 'failed';

export interface UploadedFile {
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

/** One file in the composer: uploading, ready to send, or failed. */
export interface ComposerUpload {
  localId: string;
  fileName: string;
  sizeBytes: number;
  status: 'uploading' | 'ready' | 'error';
  uploaded?: UploadedFile;
  error?: ChatUploadError;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The reason the browser refuses `file` before uploading, or undefined. */
export function precheckUpload(file: { name: string; size: number }): ChatUploadError | undefined {
  if (!CHAT_UPLOAD_EXTENSIONS.includes(extensionOf(file.name))) return 'unsupportedType';
  if (file.size === 0) return 'empty';
  if (file.size > CHAT_UPLOAD_MAX_BYTES) return 'tooLarge';
  return undefined;
}

/** The client error for a refused upload response. */
export function uploadErrorFromResponse(status: number, code: string | undefined): ChatUploadError {
  switch (code) {
    case 'chat_upload.too_large':
      return 'tooLarge';
    case 'chat_upload.unsupported_type':
      return 'unsupportedType';
    case 'chat_upload.empty':
      return 'empty';
    case 'chat_upload.store_unavailable':
      return 'storeUnavailable';
    case 'chat_upload.no_account':
      return 'noAccount';
    case 'chat_upload.chat_limit':
      return 'chatLimit';
    case 'chat_upload.account_limit':
      return 'accountLimit';
    case 'chat_upload.content_mismatch':
      return 'contentMismatch';
    default:
      return status === 413 ? 'tooLarge' : 'failed';
  }
}

export type UploadOutcome = { ok: true; file: UploadedFile } | { ok: false; error: ChatUploadError };

/** Upload one file into the chat `sessionId`. Never throws. */
export async function uploadChatFile(
  sessionId: string,
  file: File,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadOutcome> {
  const form = new FormData();
  form.set('sessionId', sessionId);
  form.set('file', file, file.name);
  try {
    const res = await fetchImpl('/bot-api/chat/uploads', { method: 'POST', body: form });
    const body = (await res.json().catch(() => ({}))) as { upload?: UploadedFile; code?: string };
    if (res.ok && body.upload) return { ok: true, file: body.upload };
    return { ok: false, error: uploadErrorFromResponse(res.status, body.code) };
  } catch {
    return { ok: false, error: 'failed' };
  }
}

/**
 * Delete an upload that will not be sent (removed from the composer). Best
 * effort: a failure leaves the file to the chat's deletion. Never throws.
 */
export async function deleteChatUpload(
  sessionId: string,
  storageKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const query = new URLSearchParams({ sessionId, storageKey });
  try {
    const res = await fetchImpl(`/bot-api/chat/uploads?${query.toString()}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

/** The files of the composer that a message can carry. */
export function readyUploads(uploads: readonly ComposerUpload[]): UploadedFile[] {
  return uploads.flatMap((u) => (u.status === 'ready' && u.uploaded ? [u.uploaded] : []));
}

/** The files a pasted clipboard or a drop carries. */
export function filesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files);
}
