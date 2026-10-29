import type { ChatTurnInput } from '@omadia/channel-sdk';
import { ODOO_QUERY_MAX_LIMIT, parseRefreshSource, type RefreshFilter, type RefreshSource } from '@omadia/fast-path';

/**
 * Suggested actions as recipe VARIANTS (LLM-free action turns).
 *
 * A suggested action on a table that has a refresh recipe may carry a
 * declarative `variant`: a constrained edit of that recipe. It is authored by
 * the agent (or derived here for fast-path tables) only as DATA — never code,
 * never a new tool or model. On the click the server validates it against
 * the table's CURRENT recipe and replays the result deterministically:
 *
 *   - `filter`  — post-filter clauses: replace the `eq` of an existing clause
 *                 on the same field (and datePart), or add a clause on an
 *                 attribute the recipe already maps/filters
 *   - `domain`  — swap the VALUE of an existing top-level domain condition
 *                 `[field, op, value]` (never add/remove a condition)
 *   - `limit`   — 1…ODOO_QUERY_MAX_LIMIT
 *
 * Same tool, same model — by construction and re-checked. Pure: no I/O.
 *
 * Wire (client → server): `action: { type: 'recipe_variant', payload:
 * { actionId, containerId } }` plus the live `canvasState`; the variant is
 * looked up server-side by (canvas session, container, action id).
 */

export const RECIPE_VARIANT_ACTION = 'recipe_variant';

type Scalar = string | number | boolean;
type DatePart = 'year' | 'month' | 'day';

export interface DomainSwap {
  field: string;
  /** narrows the match when the domain holds several conditions on `field` */
  op?: string;
  value: Scalar;
}

export interface RecipePatch {
  filter?: RefreshFilter[];
  domain?: DomainSwap[];
  limit?: number;
}

export interface RecipeVariant {
  patch: RecipePatch;
  /** plain-text heading for the table's view; applied only when present */
  heading?: string;
}

export type AppliedVariant = { ok: true; source: RefreshSource } | { ok: false; reason: string };

const MAX_CLAUSES = 4;
const MAX_HEADING = 120;
const PATCH_KEYS: ReadonlySet<string> = new Set(['filter', 'domain', 'limit']);
const DATE_RANGE: Readonly<Record<DatePart, readonly [number, number]>> = {
  year: [1900, 2100],
  month: [1, 12],
  day: [1, 31],
};

const isScalar = (v: unknown): v is Scalar =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseClause(raw: unknown): RefreshFilter | null {
  if (!isObject(raw) || typeof raw['field'] !== 'string' || raw['field'].length === 0) return null;
  const field = raw['field'];
  const eq = raw['eq'];
  if (raw['datePart'] === undefined) return isScalar(eq) ? { field, eq } : null;
  const part = raw['datePart'];
  if (part !== 'year' && part !== 'month' && part !== 'day') return null;
  const [lo, hi] = DATE_RANGE[part];
  return typeof eq === 'number' && Number.isInteger(eq) && eq >= lo && eq <= hi
    ? { field, datePart: part, eq }
    : null;
}

function parseSwap(raw: unknown): DomainSwap | null {
  if (!isObject(raw) || typeof raw['field'] !== 'string' || raw['field'].length === 0) return null;
  if (!isScalar(raw['value'])) return null;
  if (raw['op'] !== undefined && typeof raw['op'] !== 'string') return null;
  return {
    field: raw['field'],
    value: raw['value'],
    ...(typeof raw['op'] === 'string' ? { op: raw['op'] } : {}),
  };
}

function parseList<T>(raw: unknown, parse: (v: unknown) => T | null): T[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CLAUSES) return null;
  const out: T[] = [];
  for (const item of raw) {
    const parsed = parse(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

/** Whitelist-parse an agent-declared variant; null = not a valid variant. */
export function parseVariant(raw: unknown): RecipeVariant | null {
  if (!isObject(raw) || !isObject(raw['patch'])) return null;
  const p = raw['patch'];
  if (Object.keys(p).some((k) => !PATCH_KEYS.has(k))) return null;
  const filter = parseList(p['filter'], parseClause);
  const domain = parseList(p['domain'], parseSwap);
  if (filter === null || domain === null) return null;
  const limit = p['limit'];
  if (
    limit !== undefined &&
    !(typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= ODOO_QUERY_MAX_LIMIT)
  ) {
    return null;
  }
  if (filter === undefined && domain === undefined && limit === undefined) return null;
  const heading = typeof raw['heading'] === 'string' ? raw['heading'].replace(/\s+/g, ' ').trim() : '';
  return {
    patch: {
      ...(filter ? { filter } : {}),
      ...(domain ? { domain } : {}),
      ...(typeof limit === 'number' ? { limit } : {}),
    },
    ...(heading.length > 0 ? { heading: heading.slice(0, MAX_HEADING) } : {}),
  };
}

const sameClauseSlot = (a: RefreshFilter, b: RefreshFilter): boolean =>
  a.field === b.field && ('datePart' in a ? a.datePart : undefined) === ('datePart' in b ? b.datePart : undefined);

function patchFilter(base: RefreshSource, patch: RefreshFilter[]): RefreshFilter[] | string {
  const known = new Set([...Object.values(base.map), ...(base.filter ?? []).map((c) => c.field)]);
  const next = [...(base.filter ?? [])];
  for (const clause of patch) {
    const at = next.findIndex((c) => sameClauseSlot(c, clause));
    if (at >= 0) {
      next[at] = clause;
      continue;
    }
    // a NEW clause: only a date part of an attribute the table already shows
    // (or filters) — "Geburtstage im November" on a birthday column
    if (!('datePart' in clause) || !known.has(clause.field)) return 'filter-field-unknown';
    next.push(clause);
  }
  return next.length > MAX_CLAUSES ? 'filter-too-long' : next;
}

function patchDomain(domain: unknown, swaps: DomainSwap[]): unknown[] | string {
  if (!Array.isArray(domain)) return 'domain-condition-unknown';
  const next = domain.map((c: unknown) => (Array.isArray(c) ? [...(c as unknown[])] : c));
  for (const swap of swaps) {
    const hits = next.filter(
      (c): c is unknown[] =>
        Array.isArray(c) && c.length === 3 && c[0] === swap.field && (swap.op === undefined || c[1] === swap.op),
    );
    // exactly ONE existing condition, and only its scalar value changes
    if (hits.length !== 1) return 'domain-condition-unknown';
    const hit = hits[0] as unknown[];
    if (!isScalar(hit[2])) return 'domain-value-not-scalar';
    hit[2] = swap.value;
  }
  return next;
}

/** Apply a parsed variant to the table's CURRENT recipe. Never mutates `base`. */
export function applyVariant(base: RefreshSource, variant: RecipeVariant): AppliedVariant {
  const { patch } = variant;
  if (!isObject(base.input)) return { ok: false, reason: 'input-not-object' };
  let input: Record<string, unknown> = structuredClone(base.input);
  let filter = base.filter;
  if (patch.filter) {
    const f = patchFilter(base, patch.filter);
    if (typeof f === 'string') return { ok: false, reason: f };
    filter = f;
  }
  if (patch.domain) {
    const d = patchDomain(input['domain'], patch.domain);
    if (typeof d === 'string') return { ok: false, reason: d };
    input = { ...input, domain: d };
  }
  if (patch.limit !== undefined) input = { ...input, limit: patch.limit };
  const candidate = parseRefreshSource({ ...base, input, ...(filter && filter.length > 0 ? { filter } : {}) });
  if (!candidate) return { ok: false, reason: 'invalid-recipe' };
  // defence in depth: the patch grammar cannot reach these — re-checked anyway
  if (candidate.tool !== base.tool) return { ok: false, reason: 'tool-changed' };
  if ((candidate.input as { model?: unknown }).model !== base.input['model']) {
    return { ok: false, reason: 'model-changed' };
  }
  return { ok: true, source: candidate };
}

/** The variant action a click turn names, or undefined. */
export function variantActionRef(input: ChatTurnInput): { actionId: string; containerId: string } | undefined {
  if (input.action?.type !== RECIPE_VARIANT_ACTION) return undefined;
  const p = input.action.payload;
  if (!isObject(p)) return undefined;
  const { actionId, containerId } = p;
  return typeof actionId === 'string' && actionId.length > 0 && typeof containerId === 'string' && containerId.length > 0
    ? { actionId, containerId }
    : undefined;
}

const MONTHS: Readonly<Record<'de' | 'en', readonly string[]>> = {
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};

export interface VariantAction {
  id: string;
  label: string;
  variant: RecipeVariant;
}

/**
 * Deterministic variants for a recipe filtered by ONE datePart-month clause:
 * previous / next month (wrapping the year). Anything else → none.
 */
export function monthVariantActions(source: RefreshSource, lang: 'de' | 'en'): VariantAction[] {
  const months = (source.filter ?? []).filter(
    (c): c is Extract<RefreshFilter, { datePart: DatePart }> => 'datePart' in c && c.datePart === 'month',
  );
  const clause = months[0];
  if (months.length !== 1 || clause === undefined) return [];
  const names = MONTHS[lang];
  const shifted = (delta: number): number => ((clause.eq - 1 + delta + 12) % 12) + 1;
  const action = (id: string, word: string, month: number): VariantAction => ({
    id,
    label: `${word} (${names[month - 1] ?? String(month)})`,
    variant: { patch: { filter: [{ field: clause.field, datePart: 'month', eq: month }] } },
  });
  return [
    action('variant-prev-month', lang === 'de' ? 'Vormonat' : 'Previous month', shifted(-1)),
    action('variant-next-month', lang === 'de' ? 'Folgemonat' : 'Next month', shifted(1)),
  ];
}

/** JSON pointer of the heading that titles `tableId`: the nearest preceding
 *  `heading` sibling in the table's parent `children`. */
export function headingContentPath(tree: unknown, tableId: string, base = ''): string | undefined {
  if (!isObject(tree)) return undefined;
  const children = tree['children'];
  if (Array.isArray(children)) {
    const at = children.findIndex((c) => isObject(c) && c['id'] === tableId);
    if (at >= 0) {
      for (let i = at - 1; i >= 0; i--) {
        const c: unknown = children[i];
        if (isObject(c) && c['type'] === 'heading') return `${base}/children/${i}/content`;
      }
      return undefined;
    }
  }
  for (const [key, value] of Object.entries(tree)) {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const hit = headingContentPath(value[i], tableId, `${base}/${key}/${i}`);
        if (hit !== undefined) return hit;
      }
    } else if (isObject(value)) {
      const hit = headingContentPath(value, tableId, `${base}/${key}`);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/**
 * Server-side registry of the variants a canvas's tables offer, keyed by
 * (canvas session, container, action id). In-process and bounded: a variant
 * lost to a restart (or eviction) simply misses → the agent path.
 */
export interface VariantRegistry {
  set(canvasSessionId: string, containerId: string, actionId: string, variant: RecipeVariant): void;
  get(canvasSessionId: string, containerId: string, actionId: string): RecipeVariant | undefined;
}

export const MAX_VARIANT_SESSIONS = 500;
export const MAX_VARIANTS_PER_SESSION = 64;

export function createVariantRegistry(): VariantRegistry {
  const sessions = new Map<string, Map<string, RecipeVariant>>();
  const key = (containerId: string, actionId: string): string => `${containerId}\u0000${actionId}`;
  return {
    set(sid, containerId, actionId, variant) {
      const entries = sessions.get(sid) ?? new Map<string, RecipeVariant>();
      sessions.delete(sid);
      sessions.set(sid, entries);
      const k = key(containerId, actionId);
      entries.delete(k);
      entries.set(k, variant);
      while (entries.size > MAX_VARIANTS_PER_SESSION) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      while (sessions.size > MAX_VARIANT_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
    },
    get(sid, containerId, actionId) {
      return sessions.get(sid)?.get(key(containerId, actionId));
    },
  };
}
