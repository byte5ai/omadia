import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import type { StoredTurnAttachment } from '@omadia/channel-sdk';
import { bindingForRawScope, bindingsEqual } from '@omadia/orchestrator';
import type { AttachmentBindingStore, ChatSessionStore } from '@omadia/orchestrator';

import { mayUseChatSession, type LegacyChatOwner } from './chatSessionAccess.js';

/**
 * #2336 (ADR-0310) — file uploads of the web chat.
 *
 * The web chat is the kernel's own channel, so this module plays the part a
 * channel adapter plays for Teams or Telegram (ADR-0178): it stores the bytes,
 * binds the key to the chat at upload, and later states the upload as
 * structured `storedAttachments` of the turn that carries it. A storage key
 * a request names is only an index into what this route stored: the turn
 * accepts it only when its key belongs to the chat and its binding row says
 * so; anything else is refused before the turn starts.
 *
 * Every upload is filed in the ADR-0187 ledger under the account and the chat
 * (producer {@link WEB_CHAT_UPLOAD_PRODUCER}), so deleting the chat or purging
 * the person deletes the file.
 */

/** Producer name of web-chat uploads in the `generated_objects` ledger. */
export const WEB_CHAT_UPLOAD_PRODUCER = 'web-chat-upload';

/** Largest upload: the transcription provider's limit and below the web-ui
 *  proxy's body limit (`web-ui/app/_lib/proxyBodyLimit.ts`, 26 MiB). */
export const WEB_CHAT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** Most uploads one message may carry. */
export const WEB_CHAT_UPLOADS_PER_TURN = 10;

/** Most uploads one chat may hold; a further upload is refused (429). */
export const WEB_CHAT_UPLOADS_PER_CHAT = 100;

const KEY_PREFIX = 'web-chat';
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const UPLOAD_ID_RE = /^[0-9a-f-]{36}$/;
const MAX_FILE_NAME_LENGTH = 120;

/**
 * Accepted files by extension, with the content type the kernel states for
 * them. The extension decides, never the browser's type: browsers send
 * `application/octet-stream` for many of these, and the type the turn states
 * must come from the kernel, not from the request.
 */
const ACCEPTED_TYPES: Readonly<Record<string, string>> = {
  // Recordings (transcribe_recording).
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'audio/webm',
  flac: 'audio/flac',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  // Documents (inlined by the ingest, read_attachment).
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  // Spreadsheets (structured dataset import).
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // Images (vision).
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** The accepted extensions, for error messages and tests. */
export const WEB_CHAT_UPLOAD_EXTENSIONS: readonly string[] = Object.keys(ACCEPTED_TYPES);

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

/** Content type the kernel states for `fileName`, or undefined when not accepted. */
export function webChatUploadContentType(fileName: string): string | undefined {
  return ACCEPTED_TYPES[extensionOf(fileName)];
}

/**
 * A file name safe as the last key segment and in the model's attachment
 * block: no path, no control or separator characters, bounded length, the
 * extension kept.
 */
export function sanitizeUploadFileName(raw: string): string {
  // NFC first: macOS hands out decomposed names (`u` + combining diaeresis).
  const base = (raw.normalize('NFC').split(/[\\/]/).pop() ?? '');
  const cleaned = base.replace(/[^\p{L}\p{M}\p{N}._ -]/gu, '_').trim();
  // Code points, not UTF-16 units: a cut must never split a surrogate pair.
  const chars = Array.from(cleaned.replace(/^\.+/, ''));
  if (chars.length <= MAX_FILE_NAME_LENGTH) return chars.join('');
  const ext = extensionOf(chars.join(''));
  const keep = MAX_FILE_NAME_LENGTH - (ext ? ext.length + 1 : 0);
  return ext ? `${chars.slice(0, keep).join('')}.${ext}` : chars.slice(0, MAX_FILE_NAME_LENGTH).join('');
}

/** `web-chat/<sessionId>/<uploadId>/<fileName>`. */
export function webChatUploadKey(sessionId: string, uploadId: string, fileName: string): string {
  return `${KEY_PREFIX}/${sessionId}/${uploadId}/${fileName}`;
}

/** The parts of a web-chat upload key, or undefined for any other key. */
export function parseWebChatUploadKey(
  key: string,
): { sessionId: string; uploadId: string; fileName: string } | undefined {
  const parts = key.split('/');
  if (parts.length !== 4 || parts[0] !== KEY_PREFIX) return undefined;
  const [, sessionId, uploadId, fileName] = parts as [string, string, string, string];
  if (!SESSION_ID_RE.test(sessionId) || !UPLOAD_ID_RE.test(uploadId)) return undefined;
  if (fileName === '' || sanitizeUploadFileName(fileName) !== fileName) return undefined;
  return { sessionId, uploadId, fileName };
}

/** Structural view of the kernel's `tigrisStore` the route writes through. */
export interface UploadObjectStore {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

export interface ChatUploadDeps {
  /** Resolved per request: the store may be absent (no bucket configured). */
  store: () => UploadObjectStore | undefined;
  bindings: AttachmentBindingStore;
  /** Files the key in the ADR-0187 ledger under account and chat. May throw. */
  recordUpload: (storageKey: string, owner: UploadOwner) => Promise<void>;
  /** The keys this account uploaded into this chat (ledger rows). */
  uploadsOf: (owner: UploadOwner) => Promise<string[]>;
  /** Deletes one upload of this account and chat now (file and ledger row). */
  releaseUpload: (storageKey: string, owner: UploadOwner) => Promise<void>;
  getChatSessionStore?: () => ChatSessionStore | undefined;
  legacyChatOwner?: LegacyChatOwner;
  newUploadId?: () => string;
}

/** The account and chat an upload is filed under in the ledger. */
export interface UploadOwner {
  ownerOmadiaUserId: string;
  scope: string;
}

/** What the upload route answers and what the client sends back with its turn. */
export interface WebChatUpload {
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

type UploadRefusal = { status: number; code: string; message: string };

function refuse(res: Response, refusal: UploadRefusal): void {
  res.status(refusal.status).json({ code: refusal.code, message: refusal.message });
}

/** `POST /chat/uploads` (mounted under `/api`, behind the session gate). */
export function createChatUploadsRouter(deps: ChatUploadDeps): Router {
  const router = Router();
  const single = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: WEB_CHAT_UPLOAD_MAX_BYTES, files: 1, fields: 2 },
  }).single('file');

  router.post(
    '/chat/uploads',
    (req, res, next) => {
      single(req, res, (err: unknown) => {
        if (!err) {
          next();
          return;
        }
        const code = err instanceof multer.MulterError ? err.code : 'multipart';
        if (code === 'LIMIT_FILE_SIZE') {
          refuse(res, {
            status: 413,
            code: 'chat_upload.too_large',
            message: `file exceeds ${String(WEB_CHAT_UPLOAD_MAX_BYTES)} bytes`,
          });
          return;
        }
        refuse(res, { status: 400, code: 'chat_upload.bad_request', message: 'malformed multipart body' });
      });
    },
    async (req: Request, res: Response) => {
      try {
        const result = await storeUpload(req, deps);
        if ('status' in result) {
          refuse(res, result);
          return;
        }
        res.status(201).json({ upload: result });
      } catch (err) {
        console.error('[chat-uploads] upload failed:', err instanceof Error ? err.message : String(err));
        refuse(res, { status: 500, code: 'chat_upload.failed', message: 'upload failed' });
      }
    },
  );

  // A file removed from the composer before sending: deleted at once instead
  // of waiting for the chat's deletion. Only the account's own upload of this
  // chat; anything else answers like a missing one.
  router.delete('/chat/uploads', async (req: Request, res: Response) => {
    try {
      const refusal = await removeUpload(req, deps);
      if (refusal) {
        refuse(res, refusal);
        return;
      }
      res.status(204).end();
    } catch (err) {
      console.error('[chat-uploads] delete failed:', err instanceof Error ? err.message : String(err));
      refuse(res, { status: 500, code: 'chat_upload.failed', message: 'delete failed' });
    }
  });

  return router;
}

async function removeUpload(req: Request, deps: ChatUploadDeps): Promise<UploadRefusal | undefined> {
  const notFound: UploadRefusal = { status: 404, code: 'not_found', message: 'upload not found' };
  const owner = req.session?.omadia_user_id;
  if (typeof owner !== 'string' || owner === '') {
    return { status: 401, code: 'chat_upload.no_account', message: 'sign in with an account' };
  }
  const sessionId = typeof req.query['sessionId'] === 'string' ? req.query['sessionId'] : '';
  const storageKey = typeof req.query['storageKey'] === 'string' ? req.query['storageKey'] : '';
  const parsed = parseWebChatUploadKey(storageKey);
  if (!SESSION_ID_RE.test(sessionId) || parsed?.sessionId !== sessionId) return notFound;
  if (!(await mayUseChatSession(req, deps.getChatSessionStore?.(), sessionId, deps.legacyChatOwner))) {
    return notFound;
  }
  const uploadOwner = { ownerOmadiaUserId: owner, scope: sessionId };
  if (!(await deps.uploadsOf(uploadOwner)).includes(storageKey)) return notFound;
  await deps.releaseUpload(storageKey, uploadOwner);
  return undefined;
}

async function storeUpload(req: Request, deps: ChatUploadDeps): Promise<WebChatUpload | UploadRefusal> {
  const owner = req.session?.omadia_user_id;
  if (typeof owner !== 'string' || owner === '') {
    return { status: 401, code: 'chat_upload.no_account', message: 'sign in with an account to upload' };
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : '';
  if (!SESSION_ID_RE.test(sessionId)) {
    return { status: 400, code: 'chat_upload.bad_request', message: 'sessionId is required' };
  }
  const file = req.file;
  if (!file || file.size === 0) {
    return { status: 400, code: 'chat_upload.empty', message: 'no file or an empty file' };
  }
  const chats = deps.getChatSessionStore?.();
  if (!(await mayUseChatSession(req, chats, sessionId, deps.legacyChatOwner))) {
    return { status: 404, code: 'not_found', message: `chat session ${sessionId} not found` };
  }
  // multer decodes the multipart file name as latin1; browsers send UTF-8.
  const fileName = sanitizeUploadFileName(Buffer.from(file.originalname, 'latin1').toString('utf8'));
  const contentType = webChatUploadContentType(fileName);
  if (!contentType) {
    return {
      status: 415,
      code: 'chat_upload.unsupported_type',
      message: `accepted: ${WEB_CHAT_UPLOAD_EXTENSIONS.join(', ')}`,
    };
  }
  const store = deps.store();
  if (!store) {
    return { status: 503, code: 'chat_upload.store_unavailable', message: 'no attachment store configured' };
  }
  const binding = bindingForRawScope(sessionId);
  if (!binding) {
    return { status: 400, code: 'chat_upload.bad_request', message: 'sessionId is not a chat' };
  }
  const uploadOwner = { ownerOmadiaUserId: owner, scope: sessionId };
  if ((await deps.uploadsOf(uploadOwner)).length >= WEB_CHAT_UPLOADS_PER_CHAT) {
    return {
      status: 429,
      code: 'chat_upload.chat_limit',
      message: `a chat holds at most ${String(WEB_CHAT_UPLOADS_PER_CHAT)} uploads`,
    };
  }

  const storageKey = webChatUploadKey(sessionId, (deps.newUploadId ?? randomUUID)(), fileName);
  await store.put(storageKey, file.buffer, contentType);
  try {
    // ADR-0178: bound at upload, to the chat, before any turn can name it.
    await deps.bindings.bindIfAbsent(storageKey, binding);
    // ADR-0187: deleted with the chat or the person.
    await deps.recordUpload(storageKey, uploadOwner);
  } catch (err) {
    // Without its binding the file is unreadable, without its record it is
    // never deleted: do not keep it.
    await store.delete?.(storageKey).catch(() => undefined);
    throw err;
  }
  return { storageKey, fileName, contentType, sizeBytes: file.size };
}

/** A turn's reference to an earlier upload, as the client sends it. */
export interface TurnUploadRef {
  storageKey: string;
}

export type TurnUploadResolution =
  | { ok: true; stored: StoredTurnAttachment[]; modelBlock: string }
  | { ok: false; refusal: UploadRefusal };

/**
 * The turn's `storedAttachments`, from the references the client sends.
 *
 * A reference counts only when its key is a web-chat upload key of this chat
 * AND its binding row (written by the upload route, ADR-0178) names this chat.
 * File name and content type come from the key, never from the request. One
 * reference that fails refuses the turn, so a user never believes a file was
 * read that was not.
 */
export async function resolveTurnUploads(
  refs: readonly TurnUploadRef[] | undefined,
  sessionId: string | undefined,
  bindings: AttachmentBindingStore | undefined,
): Promise<TurnUploadResolution> {
  if (!refs || refs.length === 0) return { ok: true, stored: [], modelBlock: '' };
  const unknown: UploadRefusal = {
    status: 400,
    code: 'chat_upload.unknown_attachment',
    message: 'an attachment does not belong to this chat or no longer exists',
  };
  const chatBinding = sessionId ? bindingForRawScope(sessionId) : undefined;
  if (!sessionId || !chatBinding || !bindings) return { ok: false, refusal: unknown };

  const stored: StoredTurnAttachment[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.storageKey)) continue;
    seen.add(ref.storageKey);
    const parsed = parseWebChatUploadKey(ref.storageKey);
    const contentType = parsed ? webChatUploadContentType(parsed.fileName) : undefined;
    if (!parsed || parsed.sessionId !== sessionId || !contentType) return { ok: false, refusal: unknown };
    const bound = await bindings.get(ref.storageKey);
    if (!bound || !bindingsEqual(bound, chatBinding)) return { ok: false, refusal: unknown };
    stored.push({ fileName: parsed.fileName, contentType, storageKey: ref.storageKey });
  }
  return { ok: true, stored, modelBlock: attachmentsInfoBlock(stored) };
}

/**
 * The human-readable upload note for the model, in the form the channel
 * adapters use (the kernel never parses it, ADR-0178): it is how the model
 * learns the `storage_key` that `read_attachment` and `transcribe_recording`
 * take.
 */
export function attachmentsInfoBlock(stored: readonly StoredTurnAttachment[]): string {
  if (stored.length === 0) return '';
  const lines = [
    '',
    '---',
    `[attachments-info] ${String(stored.length)} Datei(en) in diesem Turn hochgeladen + persistiert:`,
  ];
  for (const a of stored) {
    const size = typeof a.sizeBytes === 'number' ? `, ${String(Math.round(a.sizeBytes / 1024))} KB` : '';
    lines.push(`- ${a.fileName} (${a.contentType}${size}) · storage_key=${a.storageKey}`);
  }
  return lines.join('\n');
}
