/**
 * Bounded, in-memory ring buffer of recent client-side errors — feeds the
 * opt-in "attach recent errors" diagnostics excerpt on the Create Issue
 * flow (issue #433). Captures exactly two sources:
 *
 *   - `window` `error` events (uncaught exceptions)
 *   - `window` `unhandledrejection` events (unhandled promise rejections)
 *
 * Deliberately does NOT hook every failed API call (issue #433 review). An
 * earlier version recorded every `ApiError` via a hook in the API client's
 * constructor, which meant any failed request anywhere in the admin UI —
 * including a secrets/vault-config PATCH on /admin/settings — silently fed
 * this buffer, and an operator could later attach that unrelated captured
 * content to a PUBLIC GitHub issue on a completely different bug report.
 * `window` error/unhandledrejection events are page-level crashes, not the
 * outcome of one specific admin action, so they don't have that problem.
 * See api.ts's ApiError doc comment and api.test.ts for the invariant this
 * enforces.
 *
 * In-memory only, never persisted, never sent anywhere on its own — it only
 * accumulates text that CreateIssueButton later offers, opt-in, as part of
 * a filed issue. The server independently re-sanitizes and truncates
 * whatever is submitted (see issuesRouter.ts `buildDiagnosticsBlock`), so
 * this module does not attempt redaction; it just keeps a readable,
 * bounded excerpt.
 *
 * `formatDiagnosticsExcerpt()` also caps its OWN output length
 * (MAX_EXCERPT_LEN) safely under the server's `MAX_DIAGNOSTICS_INPUT_LEN`
 * (20000 chars, issuesRouter.ts `parseDiagnosticsField`). A realistic worst
 * case here — MAX_ENTRIES entries each near MAX_MESSAGE_LEN + MAX_STACK_LEN —
 * can otherwise reach ~120000 chars, which the server would reject outright
 * with `invalid_diagnostics` even though this is exactly the "lots of
 * recent errors" scenario the feature exists for.
 */

export type DiagnosticSource = 'window-error' | 'unhandled-rejection';

export interface DiagnosticEntry {
  timestamp: string;
  source: DiagnosticSource;
  message: string;
  stack?: string;
}

const MAX_ENTRIES = 20;
const MAX_MESSAGE_LEN = 2000;
const MAX_STACK_LEN = 4000;
// Stays comfortably under the server's MAX_DIAGNOSTICS_INPUT_LEN (20000
// chars) so a well-formed request built from this excerpt can never trip
// the server's oversized-payload rejection — see the module doc comment.
const MAX_EXCERPT_LEN = 18000;
const TRUNCATION_MARKER = '[…older diagnostics entries truncated…]\n\n';

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

/** True once anything has been captured — gates the opt-in checkbox. */
export function hasDiagnostics(): boolean {
  return entries.length > 0;
}

function formatEntry(e: DiagnosticEntry): string {
  const header = `[${e.timestamp}] ${e.source}: ${e.message}`;
  return e.stack ? `${header}\n${e.stack}` : header;
}

/**
 * Formats the buffer into the plain-text excerpt sent to the server,
 * oldest first. The server independently truncates to its own byte cap and
 * redacts secrets; this only produces readable, chronological text.
 *
 * The result is additionally capped at MAX_EXCERPT_LEN, tail-truncated (the
 * newest — most useful — entries are kept, the oldest are dropped) with a
 * leading marker, so this module's own worst case never exceeds what the
 * server accepts as input.
 */
export function formatDiagnosticsExcerpt(): string {
  const full = entries.map(formatEntry).join('\n\n');
  if (full.length <= MAX_EXCERPT_LEN) return full;
  const budget = MAX_EXCERPT_LEN - TRUNCATION_MARKER.length;
  return `${TRUNCATION_MARKER}${full.slice(full.length - budget)}`;
}
