import {
  FAST_MODEL_REASONING,
  forcedToolInput,
  type FastLlm,
  type FastLlmTool,
  type FastPathToolSpec,
} from './fastPath.js';
import { planToFetch, type LearnedPlan } from './learnedPlanStore.js';
import { previousSummary } from './router.js';
import type { StoredTextPrivacyRun } from './storedTextPrivacy.js';
import { MAX_COLUMNS, validatePlannedQuery, type PlannedQuery, type PreviousQuery } from './triage.js';

/**
 * Fast-path PLANNER — called only after the router decided "deterministic"
 * with enough confidence. ONE forced tool call (`plan_query`) whose input
 * schema IS the plan, so there is no prose path; `input`/`map` are free-form
 * objects (a tool input schema needs no `additionalProperties:false`).
 *
 * It sees the chosen tool's full spec, learned plans of that tool as
 * examples, the previous fast-path query and — on the canvas — the
 * skeleton's data containers, so the plan fills the right `containerId` with
 * exactly its fieldKeys. The result passes the same whitelist as every
 * fast-path plan (`validatePlannedQuery`); anything off is a miss with a
 * reason and the agent answers unchanged.
 */

export const PLANNER_TOOL = 'plan_query';
export const PLANNER_MAX_TOKENS = 1024;

/** A canvas data container the plan may fill (the skeleton's requirement). */
export interface PlannerContainer {
  containerId: string;
  description: string;
  fields: ReadonlyArray<{ fieldKey: string; label: string }>;
}

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
- DATA CONTAINERS (canvas, when listed): set "containerId" to the container the rows fill and use EXACTLY its fieldKeys as the "map" keys.
EXAMPLE ${PLANNER_TOOL} input for "offene Posten" (the SHAPE — plan the user's own query): ${JSON.stringify(PLAN_EXAMPLE)}`;

/** The forced tool: its input IS the plan. */
export function plannerTool(tool: string, containers: readonly PlannerContainer[] = []): FastLlmTool {
  const stringMap = { type: 'object', additionalProperties: { type: 'string' } };
  return {
    name: PLANNER_TOOL,
    description: 'Record the ONE read query that answers the user turn, and how to present its rows.',
    inputSchema: {
      type: 'object',
      properties: {
        ...(containers.length > 0
          ? { containerId: { type: 'string', enum: containers.map((c) => c.containerId) } }
          : {}),
        tool: { type: 'string', enum: [tool] },
        input: { type: 'object', description: 'the EXACT tool input' },
        map: { ...stringMap, description: 'fieldKey → record attribute (dot-path allowed)' },
        filter: { type: 'array', items: { type: 'object' } },
        rowKey: { type: 'string' },
        itemsPath: { type: 'string' },
        labels: { ...stringMap, description: 'fieldKey → column header in the user language' },
        summary: { type: 'string', description: 'one sentence with {count} and/or {sum:<fieldKey>}' },
        locale: { type: 'string', description: 'BCP-47, e.g. de-DE' },
      },
      required: ['tool', 'input', 'map', 'summary', 'locale', ...(containers.length > 0 ? ['containerId'] : [])],
    },
  };
}

export function buildPlannerPrompt(opts: {
  question: string;
  tool: FastPathToolSpec;
  examples?: readonly LearnedPlan[];
  previous?: PreviousQuery;
  containers?: readonly PlannerContainer[];
}): string {
  const lines = [`TOOL:\n- ${opts.tool.spec}`];
  const examples = (opts.examples ?? []).filter((p) => p.tool === opts.tool.name);
  if (examples.length > 0) {
    lines.push(
      `VALIDATED EXAMPLES (learned from verified answers in this workspace):\n${examples
        .map((p) => `- user asked "${p.examples[0] ?? ''}" → ${JSON.stringify(planToFetch(p))}`)
        .join('\n')}`,
    );
  }
  if (opts.previous) {
    lines.push(
      `PREVIOUS QUERY: ${previousSummary(opts.previous)} → ${JSON.stringify(opts.previous.fetch)}`,
    );
  }
  const containers = opts.containers ?? [];
  if (containers.length > 0) {
    lines.push(
      `DATA CONTAINERS:\n${containers
        .map((c) => `- ${c.containerId} (${c.description}): fieldKeys ${c.fields.map((f) => `${f.fieldKey} "${f.label}"`).join(', ')}`)
        .join('\n')}`,
    );
  }
  lines.push(`USER TURN: ${opts.question}`);
  return lines.join('\n');
}

export type PlanOutcome =
  | { ok: true; plan: PlannedQuery; containerId?: string; ms: number }
  | { ok: false; reason: string; ms: number };

/** `value` with `restore` applied to every string leaf (keys stay). */
function restoreStrings(value: unknown, restore: (s: string) => string): unknown {
  if (typeof value === 'string') return restore(value);
  if (Array.isArray(value)) return value.map((v) => restoreStrings(v, restore));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restoreStrings(v, restore)]));
  }
  return value;
}

/** The planner answer as a validated plan (+ its canvas container). */
export function parsePlan(
  value: Record<string, unknown>,
  opts: { allowedTools: ReadonlySet<string>; question?: string; containers?: readonly PlannerContainer[] },
): { ok: true; plan: PlannedQuery; containerId?: string } | { ok: false; reason: string } {
  const { containerId: rawContainer, tool, input, map, filter, rowKey, itemsPath, ...rest } = value;
  const fetch = {
    tool,
    input,
    map,
    ...(filter !== undefined ? { filter } : {}),
    ...(rowKey !== undefined ? { rowKey } : {}),
    ...(itemsPath !== undefined ? { itemsPath } : {}),
  };
  const validated = validatePlannedQuery({ ...rest, fetch }, opts.allowedTools, {
    ...(opts.question !== undefined ? { question: opts.question } : {}),
  });
  if (!validated.ok) return validated;
  const containers = opts.containers ?? [];
  if (containers.length === 0) return validated;
  const target =
    containers.find((c) => c.containerId === rawContainer) ?? (containers.length === 1 ? containers[0] : undefined);
  if (target === undefined) return { ok: false, reason: 'unknown-container' };
  const mapped = new Set(Object.keys(validated.plan.fetch.map));
  if (!target.fields.every((f) => mapped.has(f.fieldKey))) return { ok: false, reason: 'map-mismatch' };
  return { ...validated, containerId: target.containerId };
}

/** Plan the query for `tool`. Never throws. */
export async function planQuery(opts: {
  llm: FastLlm;
  model: string;
  channel: string;
  question: string;
  tool: FastPathToolSpec;
  allowedTools: ReadonlySet<string>;
  examples?: readonly LearnedPlan[];
  previous?: PreviousQuery;
  containers?: readonly PlannerContainer[];
  privacy?: StoredTextPrivacyRun;
  log: (message: string) => void;
}): Promise<PlanOutcome> {
  const t0 = Date.now();
  const fail = (reason: string): PlanOutcome => ({ ok: false, reason, ms: Date.now() - t0 });
  let content = buildPlannerPrompt(opts);
  if (opts.privacy) {
    const masked = await opts.privacy.mask(content);
    if (!masked.send) {
      opts.log(`[fast-path] planner skipped channel=${opts.channel} (privacy: ${masked.reason})`);
      return fail('privacy-refused');
    }
    content = masked.text;
  }
  let res: Awaited<ReturnType<FastLlm['complete']>>;
  try {
    res = await opts.llm.complete({
      model: opts.model,
      system: PLANNER_SYSTEM,
      messages: [{ role: 'user', content }],
      maxTokens: PLANNER_MAX_TOKENS,
      ...FAST_MODEL_REASONING,
      tools: [plannerTool(opts.tool.name, opts.containers)],
      toolChoice: { name: PLANNER_TOOL },
    });
  } catch (err) {
    opts.log(`[fast-path] planner failed channel=${opts.channel}: ${err instanceof Error ? err.message : String(err)}`);
    return fail('planner-error');
  }
  const answer = forcedToolInput(res, PLANNER_TOOL);
  // real values back into the plan's string leaves, after parsing: a
  // restored value cannot break the structure
  const value = answer && opts.privacy ? restoreStrings(answer.value, (s) => opts.privacy!.restore(s)) : answer?.value;
  const parsed =
    value !== undefined && typeof value === 'object' && value !== null
      ? parsePlan(value as Record<string, unknown>, {
          allowedTools: opts.allowedTools,
          question: opts.question,
          ...(opts.containers ? { containers: opts.containers } : {}),
        })
      : ({ ok: false, reason: 'no-plan' } as const);
  const ms = Date.now() - t0;
  if (!parsed.ok) {
    opts.log(`[fast-path] planner channel=${opts.channel} tool=${opts.tool.name} invalid=${parsed.reason} ms=${ms}`);
    return { ok: false, reason: `planner-invalid:${parsed.reason}`, ms };
  }
  opts.log(
    `[fast-path] planner channel=${opts.channel} tool=${parsed.plan.fetch.tool} ok ms=${ms}` +
      (parsed.plan.summaryDefaulted === true ? ' summary=default' : '') +
      (answer?.via === 'text' ? ' via=text' : ''),
  );
  return {
    ok: true,
    plan: parsed.plan,
    ms,
    ...(parsed.containerId !== undefined ? { containerId: parsed.containerId } : {}),
  };
}
