/**
 * LLM-free canvas refresh (omadia-ui#5, phase 2).
 *
 * At publish time the agent may declare a `source` refresh recipe on
 * `canvas_publish_rows`: the EXACT tool + input it just used plus a
 * fieldKey→attribute map. A later `canvas_refresh` then re-executes the
 * query via `ctx.tools.invoke` and maps the result deterministically —
 * no model in the seat. Time semantics live in the QUERY, not the clock:
 * the instruction requires relative date operators (FetchXML `next-week`,
 * `this-year`, …) for relative asks, so "Kurse nächste Woche" re-resolves
 * to the then-current week on every refresh, while explicit ranges
 * ("2025 vs 2026") replay literally.
 *
 * Recipes are in-memory per middleware process (LRU-capped); a canvas
 * without a recipe simply falls back to the silent agent-turn refresh.
 */

export interface RefreshSource {
  /** registered native tool name (e.g. dynamics_fetchxml) */
  tool: string;
  /** the EXACT input the publishing turn used — replayed verbatim */
  input: unknown;
  /** dot-path to the record array in the tool's JSON output (default:
   *  root array, else the first array-valued property) */
  itemsPath?: string;
  /** fieldKey → attribute name in each result record (a missing key is
   *  read as a dot-path: `department_id.1` = an Odoo many2one's name) */
  map: Record<string, string>;
  /** attribute carrying a stable row identity (optional) */
  rowKey?: string;
  /** deterministic post-filter on the RAW records, all clauses AND-ed —
   *  for what the source cannot filter server-side (Odoo has no
   *  birthday-month operator). Applied before mapping, on every replay. */
  filter?: RefreshFilter[];
}

/** One post-filter clause. `field` names a record attribute (dot-path
 *  allowed, like `map`). `datePart` reads the year/month/day of an ISO date
 *  or datetime string (`2024-01-15`, `2024-01-15 08:00:00`) WITHOUT a
 *  timezone shift — a birthday is a calendar date, not an instant. */
export type RefreshFilter =
  | { field: string; datePart: 'year' | 'month' | 'day'; eq: number }
  | { field: string; eq: string | number | boolean };

const MAX_RECIPE_BYTES = 32_768;
const MAX_FILTER_CLAUSES = 4;
const DATE_PARTS: ReadonlySet<string> = new Set(['year', 'month', 'day']);

function parseFilterClause(value: unknown): RefreshFilter | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const field = o['field'];
  const eq = o['eq'];
  if (typeof field !== 'string' || field.length === 0) return null;
  if (o['datePart'] !== undefined) {
    const part = o['datePart'];
    if (typeof part !== 'string' || !DATE_PARTS.has(part)) return null;
    if (typeof eq !== 'number' || !Number.isInteger(eq)) return null;
    return { field, datePart: part as 'year' | 'month' | 'day', eq };
  }
  if (typeof eq !== 'string' && typeof eq !== 'number' && typeof eq !== 'boolean') return null;
  return { field, eq };
}

/** Whitelist-parse a filter (one clause or a list). `undefined` = none
 *  declared; null = declared but invalid — the caller refuses the whole
 *  recipe, because one replaying UNFILTERED would show the wrong rows. */
function parseFilter(value: unknown): RefreshFilter[] | undefined | null {
  if (value === undefined) return undefined;
  const list: unknown[] = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.length > MAX_FILTER_CLAUSES) return null;
  const out: RefreshFilter[] = [];
  for (const clause of list) {
    const parsed = parseFilterClause(clause);
    if (!parsed) return null;
    out.push(parsed);
  }
  return out;
}

/** Whitelist-parse an agent-declared source recipe; null = not storable. */
export function parseRefreshSource(value: unknown): RefreshSource | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  if (typeof o['tool'] !== 'string' || o['tool'].length === 0) return null;
  if (typeof o['map'] !== 'object' || o['map'] === null) return null;
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(o['map'] as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length > 0) map[k] = v;
  }
  if (Object.keys(map).length === 0) return null;
  const filter = parseFilter(o['filter']);
  if (filter === null) return null;
  const source: RefreshSource = {
    tool: o['tool'],
    input: o['input'] ?? {},
    map,
    ...(typeof o['itemsPath'] === 'string' && o['itemsPath'].length > 0
      ? { itemsPath: o['itemsPath'] }
      : {}),
    ...(typeof o['rowKey'] === 'string' && o['rowKey'].length > 0 ? { rowKey: o['rowKey'] } : {}),
    ...(filter ? { filter } : {}),
  };
  try {
    if (JSON.stringify(source).length > MAX_RECIPE_BYTES) return null;
  } catch {
    return null;
  }
  return source;
}

export interface RecipeStore {
  get(canvasSessionId: string, containerId: string): RefreshSource | undefined;
  set(canvasSessionId: string, containerId: string, source: RefreshSource): void;
}

const MAX_SESSIONS = 200;

/** In-memory recipe store, LRU-capped by canvas session (insertion order). */
export function createRecipeStore(): RecipeStore {
  const sessions = new Map<string, Map<string, RefreshSource>>();
  return {
    get(canvasSessionId, containerId) {
      return sessions.get(canvasSessionId)?.get(containerId);
    },
    set(canvasSessionId, containerId, source) {
      let containers = sessions.get(canvasSessionId);
      if (!containers) {
        containers = new Map();
        sessions.set(canvasSessionId, containers);
        if (sessions.size > MAX_SESSIONS) {
          const oldest = sessions.keys().next().value;
          if (oldest !== undefined) sessions.delete(oldest);
        }
      }
      containers.set(containerId, source);
    },
  };
}

/** Locate the record array in a parsed tool output. */
function findRecords(parsed: unknown, itemsPath?: string): unknown[] | null {
  if (itemsPath) {
    let cur: unknown = parsed;
    for (const seg of itemsPath.split('.')) {
      if (typeof cur !== 'object' || cur === null) return null;
      cur = (cur as Record<string, unknown>)[seg];
    }
    return Array.isArray(cur) ? cur : null;
  }
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === 'object' && parsed !== null) {
    for (const value of Object.values(parsed)) {
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

/** Read a record attribute. The literal key wins (Dynamics annotation keys
 *  like `x@OData.Community.Display.V1.FormattedValue` contain dots); only a
 *  missing key is read as a dot-path — `department_id.1` takes the display
 *  name of an Odoo many2one pair `[id, "Name"]`. */
function readAttr(rec: Record<string, unknown>, attr: string): unknown {
  if (attr in rec) return rec[attr];
  let cur: unknown = rec;
  for (const seg of attr.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

function matchesClause(rec: Record<string, unknown>, clause: RefreshFilter): boolean {
  const v = readAttr(rec, clause.field);
  if ('datePart' in clause) {
    const m = typeof v === 'string' ? ISO_DATE.exec(v) : null;
    if (!m) return false; // Odoo sends `false` for an empty date — no match
    const part = clause.datePart === 'year' ? m[1] : clause.datePart === 'month' ? m[2] : m[3];
    return Number(part) === clause.eq;
  }
  return v === clause.eq;
}

/** `true` when the tool flags its result as a capped prefix of the real set
 *  (odoo_query: `truncated: true`). Filtering a prefix yields a wrong subset
 *  and a wrong count, so filtered recipes and the fast path refuse it. */
export function isTruncatedOutput(raw: string): boolean {
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as Record<string, unknown>)['truncated'] === true
    );
  } catch {
    return false;
  }
}

/**
 * Deterministically map a tool's raw string output onto publishable rows.
 * Returns null when the output cannot be mapped (non-JSON, no record array,
 * no mapped field present, a truncated result under a filter) — the caller
 * then falls back to the agent path. An empty record array — or a filter
 * matching nothing — maps to [] (a genuinely empty data set).
 */
export function applyRefreshSource(
  raw: string,
  source: RefreshSource,
): Array<Record<string, unknown>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const records = findRecords(parsed, source.itemsPath);
  if (!records) return null;
  if (source.filter && isTruncatedOutput(raw)) return null;
  const rows: Array<Record<string, unknown>> = [];
  for (const rec of records) {
    if (typeof rec !== 'object' || rec === null) return null;
    const r = rec as Record<string, unknown>;
    const row: Record<string, unknown> = {};
    let mappedAny = false;
    for (const [fieldKey, attr] of Object.entries(source.map)) {
      const v = readAttr(r, attr);
      if (v !== undefined) mappedAny = true;
      row[fieldKey] =
        v === undefined || v === null
          ? ''
          : typeof v === 'object'
            ? JSON.stringify(v)
            : (v as string | number | boolean);
    }
    if (!mappedAny) return null; // wrong shape — refuse rather than render blanks
    // filtered AFTER the shape check: a wrong-shaped output is refused even
    // when the filter would have dropped every record
    if (source.filter && !source.filter.every((c) => matchesClause(r, c))) continue;
    if (source.rowKey !== undefined) {
      const key = r[source.rowKey];
      if (key !== undefined && key !== null) row['rowKey'] = String(key);
    }
    rows.push(row);
  }
  return rows;
}
