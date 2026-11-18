import type { FetchResult } from './fetcher.js';

/**
 * #1343 / #1344 — a tool call that analysed nothing must fail, and say why.
 *
 * The thrown error carries the name `ToolRefusalError`. A host on plugin-api
 * 1.28.0 or later passes its message to the model instead of the withheld
 * error notice. The error is built by hand instead of importing the class, so
 * the plugin still loads on an older host, which withholds the message like
 * any other error.
 */
const TOOL_REFUSAL_ERROR_NAME = 'ToolRefusalError';

export function toolRefusal(message: string): Error {
  const err = new Error(message);
  err.name = TOOL_REFUSAL_ERROR_NAME;
  return err;
}

/**
 * Throws when the response for the URL a tool was asked about never arrived:
 * `ctx.http` refused the host (audit mode or allow-list), or the host could
 * not be reached. A report built on that response would describe a site
 * nobody contacted.
 */
export function assertFetched(res: FetchResult, url: string, auditMode: string): void {
  if (res.blocked !== undefined) {
    throw toolRefusal(
      `${res.blocked} (audit mode: ${auditMode}). The requested URL was NOT ` +
        'analysed — ask the operator to widen the audit mode or add the host ' +
        'to the allow-list.',
    );
  }
  if (res.status === 0) {
    throw toolRefusal(
      `fetch failed for ${url} — the host could not be reached, so nothing was analysed.`,
    );
  }
}
