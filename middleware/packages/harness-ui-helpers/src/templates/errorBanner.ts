import { html, type HtmlFragment } from '../html.js';

/**
 * #1808 — the banner a library page shows when its data-source tool failed.
 *
 * The raw error used to go out in a `<code>` block under a hard-coded German
 * heading: for a tool called with missing input that was the tool's Zod issue
 * list (`[{"expected":"string","code":"invalid_type","path":["city"],…}]`),
 * shown to every end user. The banner now says what failed in one sentence;
 * a Zod issue list becomes the names of the missing / invalid fields, any
 * other message only its first line, bounded.
 */

const MAX_DETAIL_CHARS = 200;

interface ZodIssueLike {
  path?: unknown;
  message?: unknown;
}

function zodIssueFields(message: string): string[] | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const fields = parsed.map((issue: ZodIssueLike) =>
      Array.isArray(issue.path) && issue.path.length > 0
        ? issue.path.map(String).join('.')
        : '(input)',
    );
    return [...new Set(fields)];
  } catch {
    return null;
  }
}

/** One readable line for an end user. */
export function summarizeToolError(message: string): string {
  const fields = zodIssueFields(message);
  if (fields) {
    return `The page's data source was called without valid input for: ${fields.join(', ')}.`;
  }
  const firstLine = message.split('\n')[0]?.trim() ?? '';
  return firstLine.length > MAX_DETAIL_CHARS ? `${firstLine.slice(0, MAX_DETAIL_CHARS)}…` : firstLine;
}

export function renderErrorBanner(message: string): HtmlFragment {
  const detail = summarizeToolError(message);
  return html`<div class="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800" role="alert">
    <strong class="block text-sm font-semibold mb-1">The data could not be loaded</strong>
    ${detail ? html`<p class="break-words text-rose-900/80">${detail}</p>` : ''}
  </div>`;
}
