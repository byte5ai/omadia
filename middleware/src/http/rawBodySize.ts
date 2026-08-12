/**
 * How many bytes a request's body ACTUALLY carried on the wire.
 *
 * Route-level size gates that run after `express.json` can only measure
 * `JSON.stringify(req.body)`, and that is not the same number. JSON is mostly
 * insignificant whitespace: `{ "a": 1 }` padded with 9 MB of spaces
 * re-serialises to 8 bytes. A gate written against the re-serialised length
 * therefore waves through a body that was megabytes on the wire — and a chunked
 * request carries no `Content-Length` to catch it either.
 *
 * `express.json`'s `verify` hook is handed the raw buffer before parsing, which
 * is the one place the real figure exists. Recording it there lets a downstream
 * gate measure what was received instead of what survived parsing.
 *
 * NOTE this does not make the parse itself cheaper: the global parser still
 * reads and allocates up to its own `limit` before any route — including any
 * authentication — runs. Lowering that ceiling is a separate, application-wide
 * decision; this module only stops the per-route gate from being fooled.
 */

import type { Request } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Shape stamped onto the request by {@link recordRawBodyBytes}. */
export interface WithRawBodyBytes {
  rawBodyBytes?: number;
}

/**
 * `express.json({ verify })` hook. Records the byte length and nothing else —
 * it must never throw, because a throw here is body-parser's own rejection path
 * and would turn a size question into a 400 for every route at once.
 */
export function recordRawBodyBytes(
  req: IncomingMessage,
  _res: ServerResponse,
  buf: Buffer,
): void {
  (req as IncomingMessage & WithRawBodyBytes).rawBodyBytes = buf.length;
}

/** The recorded figure, or `undefined` when this request did not pass through a
 *  parser wired with {@link recordRawBodyBytes} (a test fake, a raw-body route).
 *  Callers must treat `undefined` as "unknown", never as "zero". */
export function rawBodyBytes(req: Request): number | undefined {
  const n = (req as Request & WithRawBodyBytes).rawBodyBytes;
  return typeof n === 'number' ? n : undefined;
}
