import { createHash } from 'node:crypto';

import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';

import type { OperatorAuthAccessor } from '@omadia/plugin-api';
import {
  TRANSCRIPTION_AUDIO_MIME_TYPES,
  TRANSCRIPTION_EXTENSION_TO_MIME,
  TRANSCRIPTION_MAX_UPLOAD_BYTES,
  fileExtension,
  normalizeContentType,
} from '@omadia/transcription-api';

/**
 * #584 — multipart audio-upload endpoint for the transcription
 * ingestion path.
 *
 * `POST /` takes exactly ONE audio file (multipart field `file`), persists
 * the bytes to the shared blob store and answers with the manifest-line
 * fields the `[attachments-info]` producers need (`storage_key`,
 * `file_name`, `content_type`, `size_bytes`). No duration probe happens
 * here — the duration cap is enforced fail-closed at transcribe-tool time
 * (metering, #584); this endpoint only guards size, count, and format.
 *
 * Mounted by the plugin via `ctx.routes.register('/transcriptions', …)`
 * (Office-plugin precedent). The kernel injects NO auth around contributed
 * routers, so the router gates itself: operator-session only via
 * `OperatorAuthAccessor`, fail closed — a missing accessor answers 503 for
 * every request rather than silently serving unauthenticated
 * (`adminKeysRouter` precedent). Error responses use the `{code, message}`
 * envelope shape of `routes/datasets.ts`, with STABLE `transcription.*`
 * codes — multer's internal error vocabulary never leaks into the contract.
 *
 * Format allowlist, extension→MIME fallback and the 25 MB provider cap come
 * from `@omadia/transcription-api`, the single owner of the
 * `transcription@1` container-format contract.
 */

const STORAGE_KEY_PREFIX = 'transcription-uploads';

/** Content-types treated as "the client doesn't actually know" — these fall
 *  back to the extension instead of being rejected outright. */
const GENERIC_CONTENT_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/** Structural match for the kernel-published `tigrisStore` service (the
 *  `TigrisStore.put` signature) — duck-typed on purpose so this package
 *  needs no dependency on `@omadia/diagrams`/`@aws-sdk`
 *  (`AttachmentByteStore` precedent in the orchestrator). */
export interface TranscriptionUploadStore {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
}

export interface TranscriptionUploadRouterOptions {
  /** Kernel-published operator-session verifier. `undefined` (older kernel /
   *  narrow context) ⇒ the router fails closed: 503 on every request. */
  operatorAuth: OperatorAuthAccessor | undefined;
  /** Resolved lazily per request — the store service may be absent (blob
   *  storage unconfigured) or registered after this plugin activates. */
  getStore: () => TranscriptionUploadStore | undefined;
  log?: (msg: string) => void;
}

/**
 * The content-type the upload is accepted (and stored/echoed) as, or
 * `undefined` when it fails the allowlist. Specific allowed MIME types pass
 * through unchanged; a generic type falls back to the extension's canonical
 * MIME so downstream consumers never see `application/octet-stream`.
 */
function resolveUploadContentType(
  contentType: string | undefined,
  fileName: string | undefined,
): string | undefined {
  const ct = normalizeContentType(contentType);
  if (TRANSCRIPTION_AUDIO_MIME_TYPES.has(ct)) return ct;
  if (GENERIC_CONTENT_TYPES.has(ct)) {
    return TRANSCRIPTION_EXTENSION_TO_MIME[fileExtension(fileName)];
  }
  return undefined;
}

/** `<prefix>/<uploadIso>-<sha256-first-16><ext>` — the Teams attachment
 *  store's key style (timestamp + content hash, no uuid). */
function buildStorageKey(bytes: Buffer, fileName: string | undefined): string {
  const shortHash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const ext = fileExtension(fileName);
  return `${STORAGE_KEY_PREFIX}/${new Date().toISOString()}-${shortHash}${ext ? `.${ext}` : ''}`;
}

/** Operator-session gate, fail closed (adminKeysRouter precedent): missing
 *  accessor ⇒ 503, absent/invalid session ⇒ 401, verifier rejection ⇒ 401. */
function operatorSessionGate(
  operatorAuth: OperatorAuthAccessor | undefined,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!operatorAuth) {
      res.status(503).json({
        code: 'transcription.operator_auth_unavailable',
        message:
          'Operator-Session-Verifier nicht verfügbar — Endpoint verweigert fail-closed jeden Zugriff.',
      });
      return;
    }
    const cookieHeader = req.headers.cookie;
    void operatorAuth.hasValidSession(cookieHeader).then(
      (valid) => {
        if (valid) {
          next();
          return;
        }
        res.status(401).json(
          cookieHeader
            ? { code: 'transcription.auth_invalid', message: 'Operator-Session ungültig oder abgelaufen.' }
            : { code: 'transcription.auth_required', message: 'Operator-Login erforderlich.' },
        );
      },
      () => {
        res.status(401).json({
          code: 'transcription.auth_invalid',
          message: 'Operator-Session konnte nicht verifiziert werden.',
        });
      },
    );
  };
}

export function createTranscriptionUploadRouter(
  opts: TranscriptionUploadRouterOptions,
): Router {
  const router = Router();
  const log = opts.log ?? ((): void => undefined);

  // Auth first — nothing (not even multipart parsing) is served without a
  // valid operator session.
  router.use(operatorSessionGate(opts.operatorAuth));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: TRANSCRIPTION_MAX_UPLOAD_BYTES, files: 1 },
  });

  router.post(
    '/',
    (req: Request, res: Response, next: NextFunction) => {
      upload.single('file')(req, res, (err: unknown) => {
        if (!err) {
          next();
          return;
        }
        // Multer's internal codes are mapped to STABLE public envelope
        // codes here — the library's error vocabulary is not part of this
        // endpoint's contract.
        const multerCode = err instanceof multer.MulterError ? err.code : undefined;
        const { code, status } =
          multerCode === 'LIMIT_FILE_SIZE'
            ? { code: 'transcription.too_large', status: 413 }
            : multerCode === 'LIMIT_FILE_COUNT' || multerCode === 'LIMIT_UNEXPECTED_FILE'
              ? { code: 'transcription.too_many_files', status: 400 }
              : { code: 'transcription.multipart_invalid', status: 400 };
        const message = err instanceof Error ? err.message : String(err);
        res.status(status).json({ code, message });
      });
    },
    async (req: Request, res: Response) => {
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        res.status(400).json({
          code: 'transcription.no_file',
          message: "Multipart-Feld 'file' fehlt.",
        });
        return;
      }
      const contentType = resolveUploadContentType(file.mimetype, file.originalname);
      if (!contentType) {
        res.status(422).json({
          code: 'transcription.unsupported_type',
          message:
            'Nur die neun Provider-Audio-Formate werden akzeptiert: flac/mp3/mp4/mpeg/mpga/m4a/ogg/wav/webm.',
        });
        return;
      }
      const store = opts.getStore();
      if (!store) {
        res.status(503).json({
          code: 'transcription.storage_unavailable',
          message: 'Blob-Store (tigrisStore) nicht konfiguriert — Upload nicht möglich.',
        });
        return;
      }
      try {
        const storageKey = buildStorageKey(file.buffer, file.originalname);
        await store.put(storageKey, file.buffer, contentType);
        log(
          `[transcription] upload persisted (key=${storageKey}, bytes=${String(file.buffer.length)})`,
        );
        res.status(201).json({
          storage_key: storageKey,
          file_name: file.originalname,
          content_type: contentType,
          size_bytes: file.buffer.length,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`[transcription] upload failed — ${message}`);
        res.status(500).json({ code: 'transcription.internal_error', message });
      }
    },
  );

  return router;
}
