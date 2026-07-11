/**
 * Bounded, in-memory ring buffer of recent client-side errors — feeds the
 * opt-in "attach recent errors" diagnostics excerpt on the Create Issue
 * flow (issue #433). Captures three sources:
 *
 *   - `window` `error` events (uncaught exceptions)
 *   - `window` `unhandledrejection` events (unhandled promise rejections)
 *   - `ApiError` occurrences, recorded by the API client via
 *     `recordApiErrorDiagnostic` (most callers catch `ApiError` and render
 *     an in-page message, so it never becomes an uncaught error)
 *
 * In-memory only, never persisted, never sent anywhere on its own — it only
 * accumulates text that CreateIssueButton later offers, opt-in, as part of
 * a filed issue. The server independently re-sanitizes and truncates
 * whatever is submitted (see issuesRouter.ts `buildDiagnosticsBlock`), so
 * this module does not attempt redaction; it just keeps a readable,
 * bounded excerpt.
 */

export type DiagnosticSource = 'window-error' | 'unhandled-rejection' | 'api-error';

export interface DiagnosticEntry {
  timestamp: string;
  source: DiagnosticSource;
  message: string;
  stack?: string;
}

const MAX_ENTRIES = 20;
const MAX_MESSAGE_LEN = 2000;
const MAX_STACK_LEN = 4000;

const entries: DiagnosticEntry[] = [];
let capturing = false;

function truncate(value: string, maxLen: number): string {
  return value.length > maxLen ? `${value.slice(0, maxLen)}…` : value;
}

function push(entry: DiagnosticEntry): void {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
}

/**
 * Registers the window-level listeners exactly once per page load — safe
 * to call repeatedly (e.g. React strict-mode double-invoking effects) and
 * safe to call during SSR, where it no-ops for lack of `window`.
 */
export function initDiagnosticsCapture(): void {
  if (capturing || typeof window === 'undefined') return;
  capturing = true;

  window.addEventListener('error', (event: ErrorEvent) => {
    const err = event.error;
    push({
      timestamp: new Date().toISOString(),
      source: 'window-error',
      message: truncate(event.message || 'Unknown error', MAX_MESSAGE_LEN),
      stack:
        err instanceof Error && err.stack
          ? truncate(err.stack, MAX_STACK_LEN)
          : undefined,
    });
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason;
    const message =
      reason instanceof Error ? reason.message : String(reason ?? 'Unhandled rejection');
    push({
      timestamp: new Date().toISOString(),
      source: 'unhandled-rejection',
      message: truncate(message, MAX_MESSAGE_LEN),
      stack:
        reason instanceof Error && reason.stack
          ? truncate(reason.stack, MAX_STACK_LEN)
          : undefined,
    });
  });
}

/**
 * Records a failed API call. Called from the API client's `ApiError`
 * constructor so every failed request lands here regardless of whether the
 * caller re-throws, swallows, or maps it to a UI message.
 */
export function recordApiErrorDiagnostic(input: {
  status: number;
  message: string;
  detail?: string;
}): void {
  if (typeof window === 'undefined') return;
  const text = input.detail ? `${input.message}\n${input.detail}` : input.message;
  push({
    timestamp: new Date().toISOString(),
    source: 'api-error',
    message: truncate(`${input.status} ${text}`, MAX_MESSAGE_LEN),
  });
}

/** True once anything has been captured — gates the opt-in checkbox. */
export function hasDiagnostics(): boolean {
  return entries.length > 0;
}

/**
 * Formats the buffer into the plain-text excerpt sent to the server,
 * oldest first. The server independently truncates to its own byte cap and
 * redacts secrets; this only produces readable, chronological text.
 */
export function formatDiagnosticsExcerpt(): string {
  return entries
    .map((e) => {
      const header = `[${e.timestamp}] ${e.source}: ${e.message}`;
      return e.stack ? `${header}\n${e.stack}` : header;
    })
    .join('\n\n');
}
