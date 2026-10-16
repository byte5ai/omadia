import { ApiError } from './api';

/**
 * Read what the server actually said out of a failed API call.
 *
 * `ApiError.message` is the client's own transport line (`PATCH settings
 * failed: 400`), and `ApiError.body` is the unparsed response text. Pages kept
 * picking the wrong one of the two: some showed only the transport line and
 * dropped the server's reason (#1330), others printed the raw JSON body at the
 * operator (#1338). These helpers parse the middleware's error envelope once:
 *
 *   { code, message }                      — the common shape
 *   { code, errors: [{ key, message, code? }] } — per-field validation (settings)
 *   { error: '…' } / { error: { message } } — older routes
 *
 * They only READ. Turning a code into localized copy stays with the caller
 * (`errorHelp.ts` or a page-local map), because only the caller knows which
 * codes it can explain. The server's `message` is untranslated English (or
 * whatever the route wrote), so per web-ui/CLAUDE.md it belongs behind a
 * localized headline, or as the last resort when no code is known.
 */

/** One rejected field from a validation envelope. */
export interface ApiFieldError {
  readonly key: string;
  readonly message: string;
  /** Machine code for this field's rejection, when the server sent one. */
  readonly code?: string;
}

function parseBody(err: unknown): Record<string, unknown> | null {
  if (!(err instanceof ApiError) || err.body.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(err.body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The server's human-readable `message` from an `ApiError`'s JSON body, or
 * `null` when the error is not an `ApiError`, the body is not JSON, or it
 * carries no message. Never returns the raw body.
 */
export function serverErrorMessage(err: unknown): string | null {
  const body = parseBody(err);
  if (!body) return null;
  const direct = nonEmpty(body['message']);
  if (direct) return direct;
  const error = body['error'];
  if (typeof error === 'string') return nonEmpty(error);
  if (typeof error === 'object' && error !== null) {
    return nonEmpty((error as Record<string, unknown>)['message']);
  }
  return null;
}

/**
 * The per-field rejections from a validation envelope (`errors: [{ key,
 * message }]`), e.g. a 400 `settings.invalid_values`. Empty when there are
 * none; malformed entries are skipped rather than guessed at.
 */
export function serverFieldErrors(err: unknown): ApiFieldError[] {
  const body = parseBody(err);
  const raw = body?.['errors'];
  if (!Array.isArray(raw)) return [];
  const out: ApiFieldError[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const key = nonEmpty(rec['key']);
    const message = nonEmpty(rec['message']);
    if (key === null || message === null) continue;
    const code = nonEmpty(rec['code']);
    out.push(code === null ? { key, message } : { key, message, code });
  }
  return out;
}
