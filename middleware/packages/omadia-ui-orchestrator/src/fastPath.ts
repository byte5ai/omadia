import type { FastPathToolSpec } from './composition.js';
import { applyRefreshSource, isTruncatedOutput, type RefreshSource } from './refreshRecipes.js';

/**
 * Deterministic canvas fast path — the building blocks.
 *
 * A simple canvas ask ("Geburtstage im Januar") does not need the agent loop
 * (main model → sub-agent → main model, ~15 s+ before any verifier): the
 * skeleton composer already reads the request, so for an allow-listed read
 * tool it also plans the ONE query that fills each container (a `fetch`
 * refresh recipe, see refreshRecipes.ts) and a prose template. The plugin
 * then runs the query itself, maps the rows deterministically and publishes
 * them through the same synthesis path the LLM-free refresh uses. No model
 * ever sees the rows. Any miss falls back to the agent path unchanged.
 */

/** Allow-list when `fast_path_tools` is not configured at all. */
export const DEFAULT_FAST_PATH_TOOLS: readonly string[] = ['odoo_query'];

/**
 * Compact composer-facing input specs. `ToolsAccessor` exposes no spec
 * lookup, so a tool can be planned only when its spec is known here; an
 * allow-listed tool without one is ignored (logged at activation). Mirrors
 * `odooQueryToolSpec` in omadia-integration-odoo (odooReadTools.ts): the
 * output envelope `{ model, scope, count, truncated, records }`, limit capped
 * at 100, many2one values as `[id, "Display Name"]`, empty values as false.
 */
export const FAST_PATH_TOOL_SPECS: Readonly<Record<string, string>> = {
  odoo_query:
    'odoo_query — Odoo search_read (read-only). input: { "model": string (e.g. "hr.employee", ' +
    '"res.partner", "account.move", "hr.leave"), "domain"?: Odoo domain e.g. ' +
    '[["department_id.name","ilike","Sales"]] (archived records are excluded by default), ' +
    '"fields"?: string[], "limit"?: 1–100 (default 20 — set 100 when a filter post-filters), ' +
    '"order"?: e.g. "name asc" }. output: { "records": [ { field: value } ], "truncated": boolean } ' +
    '→ itemsPath "records", rowKey "id". many2one fields are [id, "Name"] → map them as ' +
    '"<field>.1". hr.employee fields: name, job_title, department_id, parent_id, work_email, ' +
    'work_phone, birthday (date "YYYY-MM-DD" — the month needs a datePart filter, Odoo cannot ' +
    'filter it). HR wage/bank/private fields are blocked.',
};

/** Parse the `fast_path_tools` setup field: unset → the default allow-list;
 *  an explicit empty value disables the fast path. */
export function parseFastPathTools(raw: string | undefined): string[] {
  if (raw === undefined) return [...DEFAULT_FAST_PATH_TOOLS];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The allow-listed tools the composer can plan for (spec known). */
export function plannableTools(allowed: readonly string[]): FastPathToolSpec[] {
  return allowed.flatMap((name) => {
    const spec = FAST_PATH_TOOL_SPECS[name];
    return spec === undefined ? [] : [{ name, spec }];
  });
}

/** Fill the composer's prose template. */
export function renderSummary(template: string, count: number): string {
  return template.split('{count}').join(String(count));
}

export type ToolInvoke = (name: string, input: unknown) => Promise<string>;

export type RecipeFetch =
  | { ok: true; rows: Array<Record<string, unknown>>; ms: number }
  | {
      ok: false;
      reason: 'tool-unavailable' | 'invoke-error' | 'tool-error' | 'truncated' | 'unmappable';
      detail?: string;
    };

/** Native-registry miss as thrown by the kernel's `ctx.tools.invoke`. */
const UNAVAILABLE = /unknown or handler-less/;

/**
 * Replay one recipe and map its rows — shared by `canvas_refresh` and the
 * fast path. Never throws. `rejectTruncated` refuses a result the tool flags
 * as capped (the fast path's prose states a count, which a prefix would get
 * wrong); a recipe with a `filter` refuses it either way (applyRefreshSource).
 */
export async function fetchRecipeRows(
  invoke: ToolInvoke,
  recipe: RefreshSource,
  opts: { rejectTruncated?: boolean } = {},
): Promise<RecipeFetch> {
  const t0 = Date.now();
  let raw: string;
  try {
    raw = await invoke(recipe.tool, recipe.input);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: UNAVAILABLE.test(detail) ? 'tool-unavailable' : 'invoke-error', detail };
  }
  // tools report failures as an `Error: …` string result, not a throw
  if (/^\s*Error\b/.test(raw)) return { ok: false, reason: 'tool-error', detail: raw.slice(0, 200) };
  if (opts.rejectTruncated === true && isTruncatedOutput(raw)) return { ok: false, reason: 'truncated' };
  const rows = applyRefreshSource(raw, recipe);
  if (rows === null) {
    return { ok: false, reason: recipe.filter && isTruncatedOutput(raw) ? 'truncated' : 'unmappable' };
  }
  return { ok: true, rows, ms: Date.now() - t0 };
}
