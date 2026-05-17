/**
 * renderListCard (B.12) — list-of-cards Tailwind-html-template for the
 * `library` render-mode. Operator picks this template in the Workspace's
 * Pages-Tab; codegen emits an Express UiRouter that calls this helper with
 * the bound tool-output as `items`.
 *
 * Each item-template field (title, subtitle, meta, url) is a `${path}`-
 * expression interpolated via `interpolate()` — see interpolate.ts for the
 * narrow expression grammar. XSS-safe by construction (escapeHtml runs on
 * every resolved value).
 */

import { html, safe, type HtmlFragment } from '../html.js';
import { interpolate } from './interpolate.js';

export interface ListCardItemTemplate {
  /** Required. `${path}`-template producing the bold first-line text. */
  readonly title: string;
  /** Optional secondary line under the title. */
  readonly subtitle?: string;
  /** Optional tertiary line (timestamps, label-lists, etc.). */
  readonly meta?: string;
  /** Optional href — when set, the whole card becomes a link. */
  readonly url?: string;
}

export interface ListCardOptions {
  /** Tool output or array. The renderer accepts:
   *    - a raw array → used as-is
   *    - an object with exactly one array-valued property → auto-unwrapped
   *      (covers `{ items: [...] }`, `{ data: [...] }`, `{ prs: [...] }`,
   *      `{ results: [...] }` and similar 80%-case wrapper shapes)
   *    - object with explicit `items` / `data` / `results` key → preferred
   *      auto-unwrap target even when more arrays are present
   *    - anything else → renders the empty-state
   *
   *  This auto-unwrap is operator-convenience: many tools return metadata
   *  alongside their payload (`{ prs: [...], total_count: N }`); without
   *  this, the operator would need to wire an `output_transform_slot`
   *  even for the obvious shapes. */
  readonly items: unknown;
  readonly itemTemplate: ListCardItemTemplate;
  /** Default: 'Keine Daten.' */
  readonly emptyMessage?: string;
  /** When set, renders the error banner instead of items. */
  readonly fetchError?: string | null;
}

const DEFAULT_EMPTY_MESSAGE = 'Keine Daten.';
const PREFERRED_UNWRAP_KEYS = ['items', 'data', 'results', 'rows'] as const;

/**
 * Coerces an arbitrary tool output into the array shape the renderer
 * needs. See `ListCardOptions.items` for the accepted shapes. Pure
 * function, no side effects.
 *
 * Heuristic order:
 *   1. Raw array → return as-is.
 *   2. Preferred well-known wrapper keys (`items` / `data` / `results`
 *      / `rows`) — if present and array-valued, win.
 *   3. First non-empty array of objects in the wrapper. Skips
 *      metadata-shaped arrays like `org_scope_applied: []` or
 *      `tags: ['foo', 'bar']` so a payload `prs: [{…}, {…}]` is
 *      chosen even when it isn't the first array-valued property.
 *   4. Fallback: first array-valued property (covers the
 *      single-empty-array case so we don't return `[]` when there's
 *      genuinely no data).
 */
export function unwrapItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object') return [];

  const obj = value as Record<string, unknown>;
  // 1. Preferred well-known keys
  for (const key of PREFERRED_UNWRAP_KEYS) {
    const v = obj[key];
    if (Array.isArray(v)) return v;
  }
  // 2. First non-empty array OF OBJECTS — beats incidental metadata
  //    arrays like `org_scope_applied: []` (empty + primitive-typed)
  //    when the actual payload (e.g. `prs: [{…}]`) lives later in the
  //    object. Live-bug found in github-prs-Plugin where the tool
  //    returns `{ org_scope_applied: [], prs: [{…}] }` and the
  //    insertion-order-only walk picked the empty metadata array.
  for (const v of Object.values(obj)) {
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      typeof v[0] === 'object' &&
      v[0] !== null
    ) {
      return v;
    }
  }
  // 3. Fallback: first array-valued property (insertion order). Keeps
  //    behaviour for the legitimate-empty case.
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) return v;
  }
  return [];
}

export function renderListCard(opts: ListCardOptions): HtmlFragment {
  if (opts.fetchError !== null && opts.fetchError !== undefined && opts.fetchError.length > 0) {
    return renderErrorBanner(opts.fetchError);
  }
  const items = unwrapItems(opts.items);
  if (items.length === 0) {
    const msg = opts.emptyMessage ?? DEFAULT_EMPTY_MESSAGE;
    return html`<p class="text-sm text-slate-400 italic">${msg}</p>`;
  }

  const normalised = normaliseItemTemplate(opts.itemTemplate);
  const rows = items.map((item) => renderItem(item, normalised));
  return html`<ul class="space-y-2">${rows}</ul>`;
}

/**
 * Operator-convenience: if a field value contains no `${...}` marker AND
 * looks like a bare property name (or dotted path), auto-wrap it as
 * `${item.<value>}`. Without this, `{ title: "title" }` would render the
 * literal word "title" on every card (a common mistake the Builder-Agent
 * was caught making in the live GitHub-PR draft).
 *
 * Triggers ONLY when the value is a pure identifier-path (alphanumeric +
 * underscores + dots). Anything else (literal text, partial templates,
 * etc.) passes through unchanged.
 */
const BARE_PATH_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*$/;
function promoteBareIdentifier(value: string): string {
  if (value.includes('${')) return value; // already templated
  if (!BARE_PATH_RE.test(value)) return value; // literal text, passes through
  return `\${item.${value}}`;
}

function normaliseItemTemplate(t: ListCardItemTemplate): ListCardItemTemplate {
  return {
    title: promoteBareIdentifier(t.title),
    ...(t.subtitle !== undefined
      ? { subtitle: promoteBareIdentifier(t.subtitle) }
      : {}),
    ...(t.meta !== undefined ? { meta: promoteBareIdentifier(t.meta) } : {}),
    ...(t.url !== undefined ? { url: promoteBareIdentifier(t.url) } : {}),
  };
}

function renderItem(item: unknown, template: ListCardItemTemplate): HtmlFragment {
  const scope = { item };
  const title = interpolate(template.title, { scope });
  const subtitle = template.subtitle ? interpolate(template.subtitle, { scope }) : '';
  const meta = template.meta ? interpolate(template.meta, { scope }) : '';
  const url = template.url ? interpolate(template.url, { scope }) : '';

  const body = safe(
    `
      <div class="text-sm font-medium text-slate-900">${title}</div>
      ${subtitle ? `<div class="mt-0.5 text-xs text-slate-500">${subtitle}</div>` : ''}
      ${meta ? `<div class="mt-1 text-xs text-slate-400">${meta}</div>` : ''}
    `.trim(),
  );

  if (url.length > 0) {
    return html`<li class="rounded-lg border border-slate-200 bg-white hover:bg-slate-50">
      <a href="${url}" target="_blank" rel="noopener noreferrer" class="block p-3">${body}</a>
    </li>`;
  }
  return html`<li class="rounded-lg border border-slate-200 bg-white p-3">${body}</li>`;
}

function renderErrorBanner(message: string): HtmlFragment {
  return html`<div class="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">
    <strong class="block text-sm font-semibold mb-1">Daten konnten nicht gelesen werden</strong>
    <code class="block break-all text-rose-900/80">${message}</code>
  </div>`;
}
