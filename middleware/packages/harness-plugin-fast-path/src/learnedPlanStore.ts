import { createHash } from 'node:crypto';

import { FAST_PATH_TOOL_SPECS, type FastPathToolSpec } from './fastPath.js';
import { jaccard, questionTokens, stripLiterals, templateShape } from './literalStripping.js';
import { parseRefreshSource, type RefreshFilter, type RefreshSort, type RefreshSource } from './refreshRecipes.js';

/**
 * Learned fast path — the tenant-wide plan store.
 *
 * A plan is the ONE read query an agent turn used to fill a canvas table,
 * literal-stripped (literalStripping.ts) so every user of the instance can
 * reuse it. It becomes ACTIVE only after two agent turns solved the same
 * intent with a structurally identical plan, both not verifier-blocked and
 * error-free; two consecutive fast-path execution failures deactivate it
 * again. Persisted as one schema-versioned JSON file in the plugin's own
 * memory scope, bounded (LRU by lastUsed), tolerant to a corrupt file.
 * Never holds row data or tool results.
 */

export const PLANS_PATH = 'fastpath/plans.json';
export const PLANS_SCHEMA_VERSION = 1;
export const MAX_PLANS = 500;
export const MAX_EXAMPLES = 5;
/** agent successes before a plan is used */
export const ACTIVATION_SUCCESSES = 2;
/** consecutive fast-path failures before a plan is deactivated */
export const DEACTIVATION_FAILURES = 2;

export interface LearnedPlan {
  id: string;
  tool: string;
  /** literal-stripped tool input of the latest success */
  inputTemplate: unknown;
  map: Record<string, string>;
  filter?: RefreshFilter[];
  /** post-fetch order (field names + directions — structure, never stripped) */
  sort?: RefreshSort[];
  /** top-N of the latest success — the user's N, adapted by the planner */
  take?: number;
  rowKey?: string;
  itemsPath?: string;
  /** stripped, normalised questions (newest first, ≤ MAX_EXAMPLES) */
  examples: string[];
  successes: number;
  /** CONSECUTIVE fast-path failures */
  failures: number;
  active: boolean;
  createdAt: string;
  lastUsed: string;
}

/** A candidate derived from one agent turn (already stripped). */
export interface PlanCandidate {
  tool: string;
  inputTemplate: unknown;
  map: Record<string, string>;
  filter?: RefreshFilter[];
  sort?: RefreshSort[];
  take?: number;
  rowKey?: string;
  itemsPath?: string;
  /** the privacy-masked, stripped question; absent when it could not be
   *  masked safely — the success then counts only for a plan that already
   *  has a stored example (the caller checks) */
  example?: string;
}

/** The narrow slice of `ctx.memory` the store needs. */
export interface PlanMemory {
  readFile(relPath: string): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
}

/** Stable plan id from the plan's STRUCTURE (tool, input shape, map, filter
 *  shape, itemsPath, rowKey, sort clauses, whether it takes a top-N) — equal
 *  structure ⇒ equal id. The take VALUE is not structure ("top 5" and
 *  "top 10" are one plan). A plan without sort/take hashes exactly as before
 *  they existed, so ids stored by older releases stay stable. */
export function planId(p: Omit<PlanCandidate, 'example'>): string {
  const sortedMap = Object.fromEntries(Object.entries(p.map).sort(([a], [b]) => a.localeCompare(b)));
  const filterShape = p.filter?.map((c) =>
    'datePart' in c ? { field: c.field, datePart: c.datePart } : templateShape({ field: c.field, eq: c.eq }),
  );
  const ranked = p.sort !== undefined || p.take !== undefined;
  const shape = JSON.stringify([
    p.tool,
    templateShape(p.inputTemplate),
    sortedMap,
    filterShape ?? null,
    p.itemsPath ?? null,
    p.rowKey ?? null,
    ...(ranked ? [p.sort?.map((s) => [s.field, s.dir]) ?? null, p.take !== undefined ? '<take>' : null] : []),
  ]);
  return createHash('sha256').update(shape).digest('hex').slice(0, 12);
}

/** The plan as a composer-facing refresh recipe (placeholders still in). */
export function planToFetch(p: LearnedPlan): RefreshSource {
  return {
    tool: p.tool,
    input: p.inputTemplate,
    map: p.map,
    ...(p.itemsPath !== undefined ? { itemsPath: p.itemsPath } : {}),
    ...(p.rowKey !== undefined ? { rowKey: p.rowKey } : {}),
    ...(p.filter !== undefined ? { filter: p.filter } : {}),
    ...(p.sort !== undefined ? { sort: p.sort } : {}),
    ...(p.take !== undefined ? { take: p.take } : {}),
  };
}

function parsePlan(raw: unknown): LearnedPlan | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const recipe = parseRefreshSource({
    tool: o['tool'],
    input: o['inputTemplate'],
    map: o['map'],
    itemsPath: o['itemsPath'],
    rowKey: o['rowKey'],
    filter: o['filter'],
    // absent in files written before plans carried a ranking → undefined
    sort: o['sort'],
    take: o['take'],
  });
  if (!recipe || typeof o['id'] !== 'string') return null;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
  const examples = Array.isArray(o['examples'])
    ? o['examples'].filter((e): e is string => typeof e === 'string').slice(0, MAX_EXAMPLES)
    : [];
  const now = new Date(0).toISOString();
  return {
    id: o['id'],
    tool: recipe.tool,
    inputTemplate: recipe.input,
    map: recipe.map,
    ...(recipe.filter ? { filter: recipe.filter } : {}),
    ...(recipe.sort ? { sort: recipe.sort } : {}),
    ...(recipe.take !== undefined ? { take: recipe.take } : {}),
    ...(recipe.rowKey ? { rowKey: recipe.rowKey } : {}),
    ...(recipe.itemsPath ? { itemsPath: recipe.itemsPath } : {}),
    examples,
    successes: num(o['successes']),
    failures: num(o['failures']),
    active: o['active'] === true,
    createdAt: str(o['createdAt'], now),
    lastUsed: str(o['lastUsed'], now),
  };
}

export interface ScoredPlan {
  plan: LearnedPlan;
  score: number;
}

export interface LearnedPlanStore {
  /** Load once (idempotent); a missing/corrupt file starts empty. */
  load(): Promise<void>;
  /** An agent turn solved an intent with this plan. */
  recordSuccess(c: PlanCandidate): Promise<{ plan: LearnedPlan; activated: boolean }>;
  /** A fast-path execution of an active plan finished. */
  recordExecution(id: string, ok: boolean, reason?: string): Promise<{ deactivated: boolean }>;
  get(id: string): LearnedPlan | undefined;
  active(): LearnedPlan[];
  /** Active plans ranked by question overlap (score > 0), best first. */
  rank(question: string, k: number): ScoredPlan[];
  /** Merge a legacy plans file (same schema) — plans whose id is already
   *  known are kept as they are. Resolves to the number of plans added;
   *  an unreadable document adds none. */
  importPlans(raw: string): Promise<number>;
}

export function createLearnedPlanStore(opts: {
  memory?: PlanMemory;
  log: (message: string) => void;
  now?: () => Date;
  maxPlans?: number;
}): LearnedPlanStore {
  const plans = new Map<string, LearnedPlan>();
  const now = (): string => (opts.now?.() ?? new Date()).toISOString();
  const maxPlans = opts.maxPlans ?? MAX_PLANS;
  let loading: Promise<void> | undefined;
  let writes: Promise<void> = Promise.resolve();

  async function readFromMemory(): Promise<void> {
    const memory = opts.memory;
    if (!memory) {
      opts.log('[fast-path] learned plans: no ctx.memory — kept in-process only');
      return;
    }
    try {
      if (!(await memory.exists(PLANS_PATH))) return;
      const parsed: unknown = JSON.parse(await memory.readFile(PLANS_PATH));
      const doc = parsed as { schemaVersion?: unknown; plans?: unknown };
      if (doc?.schemaVersion !== PLANS_SCHEMA_VERSION || !Array.isArray(doc.plans)) {
        opts.log(`[fast-path] learned plans: unsupported file (schemaVersion=${String(doc?.schemaVersion)}) — starting empty`);
        return;
      }
      for (const raw of doc.plans) {
        const p = parsePlan(raw);
        if (p) plans.set(p.id, p);
      }
      opts.log(`[fast-path] learned plans loaded: ${plans.size} (${[...plans.values()].filter((p) => p.active).length} active)`);
    } catch (err) {
      opts.log(`[fast-path] learned plans: unreadable file — starting empty: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Writes serialise behind each other; a failed write is logged, never thrown. */
  function persist(): Promise<void> {
    const memory = opts.memory;
    if (!memory) return Promise.resolve();
    const content = JSON.stringify({ schemaVersion: PLANS_SCHEMA_VERSION, plans: [...plans.values()] });
    writes = writes
      .then(() => memory.writeFile(PLANS_PATH, content))
      .catch((err: unknown) => {
        opts.log(`[fast-path] learned plans: write failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    return writes;
  }

  function evict(): void {
    if (plans.size <= maxPlans) return;
    const byAge = [...plans.values()].sort((a, b) => a.lastUsed.localeCompare(b.lastUsed));
    for (const p of byAge.slice(0, plans.size - maxPlans)) plans.delete(p.id);
  }

  return {
    load() {
      loading ??= readFromMemory();
      return loading;
    },

    async recordSuccess(c) {
      const id = planId(c);
      const t = now();
      const prev = plans.get(id);
      const successes = (prev?.successes ?? 0) + 1;
      const activated = prev?.active !== true && successes >= ACTIVATION_SUCCESSES;
      const plan: LearnedPlan = {
        id,
        tool: c.tool,
        inputTemplate: c.inputTemplate,
        map: c.map,
        ...(c.filter ? { filter: c.filter } : {}),
        ...(c.sort ? { sort: c.sort } : {}),
        ...(c.take !== undefined ? { take: c.take } : {}),
        ...(c.rowKey ? { rowKey: c.rowKey } : {}),
        ...(c.itemsPath ? { itemsPath: c.itemsPath } : {}),
        examples: (c.example === undefined
          ? (prev?.examples ?? [])
          : [c.example, ...(prev?.examples ?? []).filter((e) => e !== c.example)]
        ).slice(0, MAX_EXAMPLES),
        successes,
        failures: 0,
        active: prev?.active === true || activated,
        createdAt: prev?.createdAt ?? t,
        lastUsed: t,
      };
      plans.delete(id); // re-insert: Map order doubles as recency
      plans.set(id, plan);
      evict();
      opts.log(`[fast-path] learned candidate plan=${id} tool=${c.tool} successes=${successes}`);
      if (activated) opts.log(`[fast-path] learned plan activated plan=${id} tool=${c.tool}`);
      await persist();
      return { plan, activated };
    },

    async recordExecution(id, ok, reason) {
      const prev = plans.get(id);
      if (!prev) return { deactivated: false };
      const failures = ok ? 0 : prev.failures + 1;
      const deactivated = !ok && prev.active && failures >= DEACTIVATION_FAILURES;
      plans.set(id, {
        ...prev,
        failures,
        lastUsed: now(),
        ...(deactivated ? { active: false, successes: 0 } : {}),
      });
      if (deactivated) {
        opts.log(`[fast-path] learned plan deactivated plan=${id} tool=${prev.tool} failures=${failures} reason=${reason ?? 'n/a'}`);
      }
      await persist();
      return { deactivated };
    },

    get: (id) => plans.get(id),

    active: () => [...plans.values()].filter((p) => p.active),

    async importPlans(raw) {
      loading ??= readFromMemory();
      await loading;
      let doc: { schemaVersion?: unknown; plans?: unknown };
      try {
        doc = JSON.parse(raw) as { schemaVersion?: unknown; plans?: unknown };
      } catch {
        return 0;
      }
      if (doc?.schemaVersion !== PLANS_SCHEMA_VERSION || !Array.isArray(doc.plans)) return 0;
      let added = 0;
      for (const rawPlan of doc.plans) {
        const p = parsePlan(rawPlan);
        if (!p || plans.has(p.id)) continue;
        plans.set(p.id, p);
        added += 1;
      }
      if (added > 0) {
        evict();
        opts.log(`[fast-path] learned plans imported: ${added}`);
        await persist();
      }
      return added;
    },

    rank(question, k) {
      const q = questionTokens(question);
      return [...plans.values()]
        .filter((p) => p.active)
        .map((plan) => ({
          plan,
          score: Math.max(0, ...plan.examples.map((e) => jaccard(q, questionTokens(e)))),
        }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || b.plan.lastUsed.localeCompare(a.plan.lastUsed))
        .slice(0, k);
    },
  };
}

/** Planner spec of a learned tool without a built-in one: its learned input
 *  template IS the spec — the planner may only adapt an example. */
export function learnedToolSpec(plan: LearnedPlan): string {
  return (
    `${plan.tool} — learned read tool, NO free-form spec: plan it ONLY by adapting one of its ` +
    `VALIDATED EXAMPLES below (input shape e.g. ${JSON.stringify(plan.inputTemplate)}; records at ` +
    `itemsPath ${plan.itemsPath !== undefined ? `"${plan.itemsPath}"` : '(first array)'}` +
    `${plan.rowKey !== undefined ? `, rowKey "${plan.rowKey}"` : ''}).`
  );
}

/** The built-in plannable tools plus a spec for every learned tool of the
 *  offered plans that has none. */
export function offeredTools(
  builtIn: readonly FastPathToolSpec[],
  offered: readonly LearnedPlan[],
): FastPathToolSpec[] {
  const out = [...builtIn];
  for (const p of offered) {
    if (out.some((t) => t.name === p.tool)) continue;
    out.push({ name: p.tool, spec: FAST_PATH_TOOL_SPECS[p.tool] ?? learnedToolSpec(p) });
  }
  return out;
}

/** The ACTIVE learned plan a concrete fetch was adapted from — the fetch,
 *  literal-stripped again, has the plan's structure — else undefined. */
export function attributePlan(store: LearnedPlanStore, fetch: RefreshSource): LearnedPlan | undefined {
  const { template } = stripLiterals({ input: fetch.input, filter: fetch.filter ?? null });
  const t = template as { input: unknown; filter: RefreshFilter[] | null };
  const id = planId({
    tool: fetch.tool,
    inputTemplate: t.input,
    map: fetch.map,
    ...(t.filter ? { filter: t.filter } : {}),
    ...(fetch.sort ? { sort: fetch.sort } : {}),
    ...(fetch.take !== undefined ? { take: fetch.take } : {}),
    ...(fetch.rowKey ? { rowKey: fetch.rowKey } : {}),
    ...(fetch.itemsPath ? { itemsPath: fetch.itemsPath } : {}),
  });
  const plan = store.get(id);
  return plan?.active === true ? plan : undefined;
}
