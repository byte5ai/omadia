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
  /** fieldKey → attribute name in each result record */
  map: Record<string, string>;
  /** attribute carrying a stable row identity (optional) */
  rowKey?: string;
}

const MAX_RECIPE_BYTES = 32_768;

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
  const source: RefreshSource = {
    tool: o['tool'],
    input: o['input'] ?? {},
    map,
    ...(typeof o['itemsPath'] === 'string' && o['itemsPath'].length > 0
      ? { itemsPath: o['itemsPath'] }
      : {}),
    ...(typeof o['rowKey'] === 'string' && o['rowKey'].length > 0 ? { rowKey: o['rowKey'] } : {}),
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

/**
 * Deterministically map a tool's raw string output onto publishable rows.
 * Returns null when the output cannot be mapped (non-JSON, no record array,
 * no mapped field present) — the caller then falls back to the agent path.
 * An empty record array maps to [] (a genuinely empty, refreshed data set).
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
  const rows: Array<Record<string, unknown>> = [];
  for (const rec of records) {
    if (typeof rec !== 'object' || rec === null) return null;
    const r = rec as Record<string, unknown>;
    const row: Record<string, unknown> = {};
    let mappedAny = false;
    for (const [fieldKey, attr] of Object.entries(source.map)) {
      const v = r[attr];
      if (v !== undefined) mappedAny = true;
      row[fieldKey] =
        v === undefined || v === null
          ? ''
          : typeof v === 'object'
            ? JSON.stringify(v)
            : (v as string | number | boolean);
    }
    if (!mappedAny) return null; // wrong shape — refuse rather than render blanks
    if (source.rowKey !== undefined) {
      const key = r[source.rowKey];
      if (key !== undefined && key !== null) row['rowKey'] = String(key);
    }
    rows.push(row);
  }
  return rows;
}
