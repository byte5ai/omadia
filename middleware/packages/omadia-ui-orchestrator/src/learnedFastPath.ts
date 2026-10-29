import {
  containsPlaceholder,
  defaultSummary,
  extractFirstJsonObject,
  FAST_MODEL_REASONING,
  jaccard,
  OUTPUT_FORMAT_INSTRUCTION,
  parseRefreshSource,
  parseSummary,
  planToFetch,
  questionTokens,
  supportedLocale,
  type FastLlm,
  type LearnedPlanStore,
  type RefreshSource,
  type ScoredPlan,
  type StoredTextPrivacyRun,
} from '@omadia/fast-path';

/**
 * Learned fast path — using active plans.
 *
 * New canvas: the top-K active plans ride in the composer's existing single
 * call as validated examples; their tools join the fetch whitelist with the
 * learned input template as spec. In place (a follow-up in an EXISTING
 * canvas, e.g. "und im Februar?"): when an active plan fits the visible table
 * and the question, ONE fast-model call re-plans that table's query, and the
 * plugin re-fills the table deterministically — no agent turn.
 */

/** Active plans offered to the composer per new-canvas turn. */
export const COMPOSER_TOP_K = 5;
/** Active plans offered to the in-place planner. */
export const IN_PLACE_TOP_K = 3;
/** Question overlap that counts as a match without a column match. */
export const IN_PLACE_MIN_SCORE = 0.35;
/** Bonus when a plan's columns are exactly a visible table's columns. */
const COLUMN_MATCH_BONUS = 0.5;

export interface CanvasTable {
  containerId: string;
  title?: string;
  fieldKeys: string[];
}

/** Every table of a live canvas tree with its columns (structure only — no
 *  rows ever leave this function). */
export function canvasTables(tree: unknown): CanvasTable[] {
  const out: CanvasTable[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (typeof n !== 'object' || n === null) return;
    const node = n as Record<string, unknown>;
    if (node['type'] === 'table' && typeof node['id'] === 'string' && Array.isArray(node['columns'])) {
      const fieldKeys = (node['columns'] as Array<Record<string, unknown>>)
        .map((c) => c?.['fieldKey'])
        .filter((k): k is string => typeof k === 'string');
      if (fieldKeys.length > 0) {
        out.push({
          containerId: node['id'],
          ...(typeof node['title'] === 'string' ? { title: node['title'] } : {}),
          fieldKeys,
        });
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'rows' && typeof value === 'object' && value !== null) walk(value);
    }
  };
  walk(tree);
  return out;
}

const sameKeys = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((k) => b.includes(k));

/** Active plans that fit a follow-up: their columns are a visible table's,
 *  or the question overlaps one of their examples well enough. */
export function matchInPlacePlans(
  store: LearnedPlanStore,
  question: string,
  tables: readonly CanvasTable[],
  k: number = IN_PLACE_TOP_K,
): ScoredPlan[] {
  const q = questionTokens(question);
  return store
    .active()
    .map((plan) => {
      const overlap = Math.max(0, ...plan.examples.map((e) => jaccard(q, questionTokens(e))));
      const columns = tables.some((t) => sameKeys(Object.keys(plan.map), t.fieldKeys));
      return { plan, score: overlap + (columns ? COLUMN_MATCH_BONUS : 0), columns, overlap };
    })
    .filter((s) => s.columns || s.overlap >= IN_PLACE_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ plan, score }) => ({ plan, score }));
}

const IN_PLACE_SYSTEM = `You are the Omadia UI in-place fast-path planner. The user asks a FOLLOW-UP in a canvas that already shows the tables below. Decide whether ONE read query can re-fill ONE of those tables (same columns) to answer it — typically the same query with changed values (another month, year, partner, status).
Emit ONLY a raw JSON object, either
{ "containerId": <id of the table to re-fill>, "fetch": { "tool", "input", "map": { fieldKey: <record attribute> }, "rowKey"?, "itemsPath"?, "filter"? }, "summary": <ONE sentence in the user's language with {count} and/or {sum:<fieldKey>} — REQUIRED>, "locale": <BCP-47 of the user's language> }
or { "none": true }.
RULES: "map" covers EXACTLY the table's fieldKeys. Adapt the CURRENT QUERY of the table or a VALIDATED EXAMPLE — keep tool, input structure and map; change only values. Replace every {{text_N}}/{{email_N}}/{{id_N}} placeholder with the user's value. Relative periods: a whole-string "{today}" / "{today-30d}". When the follow-up needs another view, other columns, reasoning, joins, several queries or you are unsure → { "none": true }. A wrong fetch is worse than none.
Output ONLY the JSON object — no code fences, no prose before or after it.`;

export type InPlacePlan =
  | {
      ok: true;
      containerId: string;
      fetch: RefreshSource;
      summary: string;
      locale?: string;
      /** the planner's summary was missing/unusable — `summary` is the
       *  deterministic count sentence */
      summaryDefaulted?: true;
    }
  | { ok: false; reason: string };

/** Validate the planner's answer against the visible tables and the
 *  whitelist; anything off is a reasoned miss, never a partial plan. A
 *  missing or unusable summary is not "off": the plan keeps a deterministic
 *  count sentence (planner locale, else a guess from `opts.question`). */
export function parseInPlacePlan(
  raw: string,
  tables: readonly CanvasTable[],
  allowedTools: ReadonlySet<string>,
  opts: { question?: string } = {},
): InPlacePlan {
  const extracted = extractFirstJsonObject(raw);
  if (!extracted.ok) return { ok: false, reason: 'unparseable' };
  const obj = extracted.value;
  if (obj['none'] === true) return { ok: false, reason: 'planner-none' };
  const table = tables.find((t) => t.containerId === obj['containerId']);
  if (!table) return { ok: false, reason: 'unknown-container' };
  const fetch = parseRefreshSource(obj['fetch']);
  if (!fetch) return { ok: false, reason: 'invalid-fetch' };
  if (!allowedTools.has(fetch.tool)) return { ok: false, reason: 'tool-not-allowed' };
  if (containsPlaceholder(fetch)) return { ok: false, reason: 'unfilled-placeholder' };
  if (!sameKeys(Object.keys(fetch.map), table.fieldKeys)) return { ok: false, reason: 'map-mismatch' };
  const locale = supportedLocale(obj['locale']);
  const parsedSummary = parseSummary(obj['summary']);
  return {
    ok: true,
    containerId: table.containerId,
    fetch,
    summary: parsedSummary ?? defaultSummary(locale, opts.question),
    ...(locale ? { locale } : {}),
    ...(parsedSummary === undefined ? { summaryDefaulted: true as const } : {}),
  };
}

/** ONE fast-model call: re-plan a visible table's query for a follow-up.
 *  Gets table STRUCTURE, the tables' current recipes and the matched plans —
 *  never row data. Never throws. */
export async function planInPlace(opts: {
  llm: FastLlm;
  model: string;
  question: string;
  tables: readonly CanvasTable[];
  /** containerId → the recipe that filled it (in-memory refresh store) */
  currentQueries: ReadonlyMap<string, RefreshSource>;
  plans: readonly ScoredPlan[];
  allowedTools: ReadonlySet<string>;
  log: (message: string) => void;
  /** #1540 — with a privacy guard running, the prompt (question + table
   *  titles) reaches the model masked and its plan is restored; a refused
   *  mask skips the call (the in-place agent path runs instead). */
  privacy?: StoredTextPrivacyRun;
}): Promise<InPlacePlan> {
  const tableLines = opts.tables.map((t) => {
    const current = opts.currentQueries.get(t.containerId);
    return (
      `- table "${t.containerId}"${t.title ? ` (${t.title})` : ''} columns ${JSON.stringify(t.fieldKeys)}` +
      (current ? ` CURRENT QUERY: ${JSON.stringify(current)}` : '')
    );
  });
  const exampleLines = opts.plans.map(
    ({ plan }) => `- user asked "${plan.examples[0] ?? ''}" → "fetch": ${JSON.stringify(planToFetch(plan))}`,
  );
  // Fixed text (rules + learned plans, stored literal-stripped/masked) is the
  // SYSTEM prompt and never masked; only the user-derived part — the tables'
  // titles and current queries, the follow-up — goes through the shield.
  const system = `${IN_PLACE_SYSTEM}\nVALIDATED EXAMPLES:\n${exampleLines.join('\n')}`;
  const user = `TABLES:\n${tableLines.join('\n')}\nFOLLOW-UP: ${opts.question}\n${OUTPUT_FORMAT_INSTRUCTION}`;
  let content = user;
  if (opts.privacy !== undefined) {
    const masked = await opts.privacy.mask(user);
    if (!masked.send) {
      opts.log(`[ui-orchestrator] in-place planner skipped (privacy: ${masked.reason})`);
      return { ok: false, reason: 'privacy-refused' };
    }
    content = masked.text;
  }
  const t0 = Date.now();
  try {
    const res = await opts.llm.complete({
      model: opts.model,
      system,
      messages: [{ role: 'user', content }],
      maxTokens: 1024,
      ...FAST_MODEL_REASONING,
    });
    opts.log(`[ui-orchestrator] in-place planner call: ${Date.now() - t0}ms, ${res.text.length} chars`);
    const text = opts.privacy !== undefined ? opts.privacy.restore(res.text) : res.text;
    return parseInPlacePlan(text, opts.tables, opts.allowedTools, { question: opts.question });
  } catch (err) {
    opts.log(`[ui-orchestrator] in-place planner failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, reason: 'planner-error' };
  }
}
