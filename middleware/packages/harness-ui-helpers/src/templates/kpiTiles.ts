/**
 * renderKpiTiles (B.12) — small grid of KPI tiles for the `library`
 * render-mode. Each tile has a label, a value (number or string), and an
 * optional one-line hint. Layout adapts to the tile-count via Tailwind's
 * grid utilities — 1-tile centred, 2-tile two-column, 3+ wraps to 2 cols
 * on mobile / 3-4 cols on wider viewports.
 *
 * Operator binds tiles to a tool output via spec.ui_routes.data_binding;
 * the bound tool must produce a `Tile[]` shape directly (no item-template
 * interpolation here — values land verbatim, html-escaped at render-time).
 */

import { html, type HtmlFragment } from '../html.js';

export interface KpiTile {
  readonly label: string;
  readonly value: number | string;
  /** Optional one-line context under the value (e.g. "vs. letzte Woche: +12"). */
  readonly hint?: string;
}

export interface KpiTilesOptions {
  /** Tool output. Accepts a raw KpiTile[] OR a wrapper-object with one
   *  array-valued property (`{ tiles: [...] }`, `{ data: [...] }`,
   *  `{ kpis: [...] }`, etc.). Same auto-unwrap convention as
   *  ListCardOptions.items — see listCard.ts:unwrapItems. */
  readonly tiles: unknown;
  /** Default: 'Keine Daten.' */
  readonly emptyMessage?: string;
  readonly fetchError?: string | null;
}

const DEFAULT_EMPTY_MESSAGE = 'Keine Daten.';
const PREFERRED_UNWRAP_KEYS = ['tiles', 'kpis', 'items', 'data', 'results'] as const;

function unwrapTiles(value: unknown): KpiTile[] {
  if (Array.isArray(value)) return value as KpiTile[];
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object') return [];
  const obj = value as Record<string, unknown>;
  // 1. Preferred wrapper keys
  for (const key of PREFERRED_UNWRAP_KEYS) {
    const v = obj[key];
    if (Array.isArray(v)) return v as KpiTile[];
  }
  // 2. First non-empty array of objects — same heuristic as listCard
  //    unwrap, beats incidental metadata-arrays in the wrapper.
  for (const v of Object.values(obj)) {
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      typeof v[0] === 'object' &&
      v[0] !== null
    ) {
      return v as KpiTile[];
    }
  }
  // 3. Fallback: first array-valued property (preserves empty-case)
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) return v as KpiTile[];
  }
  return [];
}

export function renderKpiTiles(opts: KpiTilesOptions): HtmlFragment {
  if (opts.fetchError !== null && opts.fetchError !== undefined && opts.fetchError.length > 0) {
    return renderErrorBanner(opts.fetchError);
  }
  const tiles = unwrapTiles(opts.tiles);
  if (tiles.length === 0) {
    const msg = opts.emptyMessage ?? DEFAULT_EMPTY_MESSAGE;
    return html`<p class="text-sm text-slate-400 italic">${msg}</p>`;
  }

  const cols = gridClassFor(tiles.length);
  const tileEls = tiles.map((t) => renderTile(t));
  return html`<div class="${cols}">${tileEls}</div>`;
}

function gridClassFor(count: number): string {
  if (count === 1) return 'flex justify-center';
  if (count === 2) return 'grid grid-cols-2 gap-3';
  if (count === 3) return 'grid grid-cols-1 sm:grid-cols-3 gap-3';
  // 4+ — clamp to 4 cols on wide viewports
  return 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3';
}

function renderTile(tile: KpiTile): HtmlFragment {
  return html`<div class="rounded-lg border border-slate-200 bg-white p-4">
    <div class="text-xs font-medium text-slate-500 uppercase tracking-wide">${tile.label}</div>
    <div class="mt-1 text-2xl font-semibold text-slate-900">${tile.value}</div>
    ${tile.hint ? html`<div class="mt-1 text-xs text-slate-400">${tile.hint}</div>` : ''}
  </div>`;
}

function renderErrorBanner(message: string): HtmlFragment {
  return html`<div class="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">
    <strong class="block text-sm font-semibold mb-1">Daten konnten nicht gelesen werden</strong>
    <code class="block break-all text-rose-900/80">${message}</code>
  </div>`;
}
