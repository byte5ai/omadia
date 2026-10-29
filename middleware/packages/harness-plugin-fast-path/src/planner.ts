import {
  FAST_MODEL_REASONING,
  forcedToolInput,
  type FastLlm,
  type FastLlmTool,
  type FastPathToolSpec,
} from './fastPath.js';
import { planToFetch, type LearnedPlan } from './learnedPlanStore.js';
import { MAX_COLUMNS, validatePlannedQuery, type PlannedQuery } from './triage.js';

/**
 * Fast-path PLANNER — ONE forced tool call (`plan_query`) whose input schema
 * IS the plan, so there is no prose path; `input`/`map` are free-form
 * objects (a tool input schema needs no `additionalProperties:false`).
 *
 * SPECULATIVE: triageTurn.ts starts it concurrently with the router (and, on
 * the canvas, the skeleton composer); its plan is used only when the router
 * decides "deterministic" with enough confidence for the same tool, and is
 * discarded otherwise. So it never sees the skeleton — the canvas binds the
 * plan to the skeleton's single data container afterwards.
 *
 * Prompt split (privacy latency): rules, the offered tools' full specs and
 * the learned plans (stored literal-stripped/masked) are the SYSTEM prompt —
 * fixed text, never masked. The user message is the shared, already-masked
 * turn message; the plan's strings are restored after parsing.
 */

export const PLANNER_TOOL = 'plan_query';
export const PLANNER_MAX_TOKENS = 1024;

/** The plan shape for "offene Posten" — an example of the SHAPE in the
 *  prompt ({count}, {sum:…}, currency_id, {currency}, labels in the user's
 *  language). Tests validate it. */
export const PLAN_EXAMPLE = {
  tool: 'odoo_query',
  input: {
    model: 'account.move',
    domain: [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['payment_state', 'in', ['not_paid', 'partial']],
    ],
    fields: ['name', 'partner_id', 'invoice_date_due', 'amount_residual', 'currency_id'],
    limit: 100,
    order: 'invoice_date_due asc',
  },
  map: { number: 'name', partner: 'partner_id.1', due_date: 'invoice_date_due', open_amount: 'amount_residual' },
  rowKey: 'id',
  itemsPath: 'records',
  labels: { number: 'Rechnungsnr.', partner: 'Kunde', due_date: 'Fällig am', open_amount: 'Offener Betrag' },
  summary: '{count} offene Posten, offener Betrag gesamt {sum:open_amount} {currency}.',
  locale: 'de-DE',
} as const;

export const PLANNER_SYSTEM = `You are the Omadia fast-path planner. Plan the ONE read query that answers the user's turn by calling ${PLANNER_TOOL} — never answer in text.
- "input": the EXACT tool input per the TOOL spec. "map": {fieldKey: record attribute} with short snake_case fieldKeys (at most ${MAX_COLUMNS}); a value may be a dot-path into the record (e.g. "partner_id.1"). "rowKey": an attribute with a stable id; "itemsPath": dot-path to the record array.
- "filter" only for what the tool cannot filter itself (e.g. a birthday MONTH): [{"field","datePart":"year"|"month"|"day","eq":<integer>} | {"field","eq":<string|number|boolean>}].
- Relative periods: a whole-string "{today}" / "{today-30d}" / "{today+7d}" — never the current date literally. A {sum:…} over money needs "currency_id" in the query's fields; write its currency as the token {currency} right after the total — never a symbol or code of your own.
- "labels": {fieldKey: column header in the user's language}. "summary": ONE plain sentence in the user's language with {count} (= number of rows) and/or {sum:<fieldKey>} (= total of a NUMERIC column); it states ONLY what the query guarantees, never invented figures. "locale": BCP-47 of the user's language (e.g. "de-DE").
- A follow-up may adapt the PREVIOUS QUERY: keep tool, input structure and map, change only values. Prefer adapting a VALIDATED EXAMPLE with the same intent; replace every {{text_N}}/{{email_N}}/{{id_N}} placeholder with the user's own value — a plan that still contains one is discarded.
- "tool": the ONE tool of the TOOLS below that answers the turn.
EXAMPLE ${PLANNER_TOOL} input for "offene Posten" (the SHAPE — plan the user's own query): ${JSON.stringify(PLAN_EXAMPLE)}`;

/** The forced tool: its input IS the plan; `tool` is one of the offered. */
export function plannerTool(tools: readonly string[]): FastLlmTool {
  const stringMap = { type: 'object', additionalProperties: { type: 'string' } };
  return {
    name: PLANNER_TOOL,
    description: 'Record the ONE read query that answers the user turn, and how to present its rows.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: [...tools] },
        input: { type: 'object', description: 'the EXACT tool input' },
        map: { ...stringMap, description: 'fieldKey → record attribute (dot-path allowed)' },
        filter: { type: 'array', items: { type: 'object' } },
        rowKey: { type: 'string' },
        itemsPath: { type: 'string' },
        labels: { ...stringMap, description: 'fieldKey → column header in the user language' },
        summary: { type: 'string', description: 'one sentence with {count} and/or {sum:<fieldKey>}' },
        locale: { type: 'string', description: 'BCP-47, e.g. de-DE' },
      },
      required: ['tool', 'input', 'map', 'summary', 'locale'],
    },
  };
}

/** The planner's system prompt: rules + the offered tools' specs + learned
 *  plans of those tools — fixed text, no user-derived values. */
export function buildPlannerSystem(opts: { tools: readonly FastPathToolSpec[]; examples?: readonly LearnedPlan[] }): string {
  const names = new Set(opts.tools.map((t) => t.name));
  const lines = [PLANNER_SYSTEM, `TOOLS:\n${opts.tools.map((t) => `- ${t.spec}`).join('\n')}`];
  const examples = (opts.examples ?? []).filter((p) => names.has(p.tool));
  if (examples.length > 0) {
    lines.push(
      `VALIDATED EXAMPLES (learned from verified answers in this workspace):\n${examples
        .map((p) => `- user asked "${p.examples[0] ?? ''}" → ${JSON.stringify(planToFetch(p))}`)
        .join('\n')}`,
    );
  }
  return lines.join('\n');
}

export type PlanOutcome = { ok: true; plan: PlannedQuery; ms: number } | { ok: false; reason: string; ms: number };

/** `value` with `restore` applied to every string leaf (keys stay). */
function restoreStrings(value: unknown, restore: (s: string) => string): unknown {
  if (typeof value === 'string') return restore(value);
  if (Array.isArray(value)) return value.map((v) => restoreStrings(v, restore));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreStrings(v, restore)]));
  }
  return value;
}

/** The planner answer as a validated plan. */
export function parsePlan(
  value: Record<string, unknown>,
  opts: { allowedTools: ReadonlySet<string>; question?: string },
): { ok: true; plan: PlannedQuery } | { ok: false; reason: string } {
  const { tool, input, map, filter, rowKey, itemsPath, ...rest } = value;
  const fetch = {
    tool,
    input,
    map,
    ...(filter !== undefined ? { filter } : {}),
    ...(rowKey !== undefined ? { rowKey } : {}),
    ...(itemsPath !== undefined ? { itemsPath } : {}),
  };
  return validatePlannedQuery({ ...rest, fetch }, opts.allowedTools, {
    ...(opts.question !== undefined ? { question: opts.question } : {}),
  });
}

/** Plan the ONE query over the offered `tools`. Never throws. */
export async function planQuery(opts: {
  llm: FastLlm;
  model: string;
  channel: string;
  /** the turn message (triageTurn.ts) — already masked when a shield runs */
  message: string;
  /** the RAW user question — only for the default summary's language */
  question: string;
  tools: readonly FastPathToolSpec[];
  allowedTools: ReadonlySet<string>;
  examples?: readonly LearnedPlan[];
  /** the per-turn privacy run's restore — applied to the plan's strings */
  restore?: (text: string) => string;
  log: (message: string) => void;
}): Promise<PlanOutcome> {
  const t0 = Date.now();
  const fail = (reason: string): PlanOutcome => ({ ok: false, reason, ms: Date.now() - t0 });
  let res: Awaited<ReturnType<FastLlm['complete']>>;
  try {
    res = await opts.llm.complete({
      model: opts.model,
      system: buildPlannerSystem(opts),
      messages: [{ role: 'user', content: opts.message }],
      maxTokens: PLANNER_MAX_TOKENS,
      ...FAST_MODEL_REASONING,
      tools: [plannerTool(opts.tools.map((t) => t.name))],
      toolChoice: { name: PLANNER_TOOL },
    });
  } catch (err) {
    opts.log(`[fast-path] planner failed channel=${opts.channel}: ${err instanceof Error ? err.message : String(err)}`);
    return fail('planner-error');
  }
  const answer = forcedToolInput(res, PLANNER_TOOL);
  // real values back into the plan's string leaves, after parsing: a
  // restored value cannot break the structure
  const restore = opts.restore;
  const value = answer && restore ? restoreStrings(answer.value, restore) : answer?.value;
  const parsed =
    value !== undefined && typeof value === 'object' && value !== null
      ? parsePlan(value as Record<string, unknown>, { allowedTools: opts.allowedTools, question: opts.question })
      : ({ ok: false, reason: 'no-plan' } as const);
  const ms = Date.now() - t0;
  if (!parsed.ok) {
    opts.log(`[fast-path] planner channel=${opts.channel} invalid=${parsed.reason} ms=${ms}`);
    return { ok: false, reason: `planner-invalid:${parsed.reason}`, ms };
  }
  opts.log(
    `[fast-path] planner channel=${opts.channel} tool=${parsed.plan.fetch.tool} ok ms=${ms}` +
      (parsed.plan.summaryDefaulted === true ? ' summary=default' : '') +
      (answer?.via === 'text' ? ' via=text' : ''),
  );
  return { ok: true, plan: parsed.plan, ms };
}
