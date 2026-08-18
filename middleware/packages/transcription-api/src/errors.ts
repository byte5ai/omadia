/**
 * Error class for the `transcription@1` capability. Everything a
 * {@link TranscriptionService} throws is a {@link TranscriptionError}, so
 * callers do a single `instanceof` check at the boundary and branch on
 * `code` (error-class-per-capability pattern, cf. the web-search plugin's
 * `WebSearchError` hierarchy).
 */

import type { TranscriptionUsage } from './types.js';

export type TranscriptionErrorCode =
  | 'auth'
  | 'unsupported-format'
  | 'too-large'
  | 'session-limit'
  | 'provider'
  | 'aborted';

export class TranscriptionError extends Error {
  readonly code: TranscriptionErrorCode;
  /**
   * Partial usage at failure time — a dropped realtime stream or a
   * retried-then-failed batch call has still been billed; metering must see
   * it even on the error path (an AsyncIterable can't yield after it
   * throws). Undefined when the failure happened before any provider call.
   */
  readonly usage?: TranscriptionUsage;

  constructor(
    code: TranscriptionErrorCode,
    message: string,
    options?: { usage?: TranscriptionUsage; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TranscriptionError';
    this.code = code;
    this.usage = options?.usage;
  }
}
