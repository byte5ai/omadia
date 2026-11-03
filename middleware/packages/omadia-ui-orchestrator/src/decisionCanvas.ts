import type { FastPathDecision, FastPathDecisionStep, FastPathDecisionUi } from '@omadia/channel-sdk';
import { chooseDecision, type DecisionTrace, type GateSignal } from '@omadia/fast-path';
import type { DecisionModelService, DecisionOption } from '@omadia/plugin-api';

import type { SkeletonResult } from './composition.js';

/**
 * The canvas on a typed decision model (`decisionModel@1`, e.g. TypeSafe
 * Jev). The decision model is the fast path's gate (@omadia/fast-path
 * decisionRouter.ts); the canvas reuses its verdict for the VIEW, so the
 * skeleton composer, a model call of 2–2.6 s that set the first paint, runs
 * only where a model really has to design the view:
 *
 *   - gate `data`: the query plan knows its table, so the skeleton is built
 *     from the plan (cachedSkeleton.ts `planSkeleton`) with no composer call.
 *     A miss composes afterwards for the agent, whose turn takes far longer.
 *   - gate `model` + `simple` (greeting, confirmation): a plain answer view,
 *     no composer. The agent's short answer fills it (`simpleAnswer.ts`).
 *   - `canvas.layout`: ONE more decision on a plan skeleton, run alongside
 *     the fetch. Table or bar/line/pie chart, chosen on the same masked turn
 *     message the gate saw. A chart is used only when the rows have a label
 *     column and a numeric value column.
 *
 * Everything that ran on the decision model rides to the client on
 * `done.fastPathDecision` (`canvasDecision`).
 */

/** Wait at most this long for the gate before composing as before: a
 *  slow gate never delays the first paint by more than this. */
export const GATE_PEEK_MS = 600;
/** After the fetch, wait at most this long for the layout decision; past
 *  it the rows go out as the table that is already on screen. */
export const LAYOUT_GRACE_MS = 250;
/** The layout decision's bar, as for a direct plan: a wrong chart is worse
 *  than the table. */
export const LAYOUT_MIN_CONFIDENCE = 0.7;
export const LAYOUT_TASK = 'canvas.layout';
/** A chart reads well only within these row counts. */
export const CHART_MIN_ROWS = 2;
export const CHART_MAX_ROWS = 50;
export const PIE_MAX_ROWS = 12;

export type ChartKind = 'bar' | 'line' | 'pie';
export type CanvasLayout = 'table' | ChartKind;

const LAYOUT_INSTRUCTION =
  'How should the rows that answer the USER TURN be shown? A chart ONLY when the turn asks to compare one value ' +
  'across items, to follow a value over time, or for shares of a whole; records, lists, details and lookups are a ' +
  'table.';

export const LAYOUT_OPTIONS: readonly DecisionOption[] = [
  { id: 'table', description: 'table: a list of records, details, a lookup — anything that is not a comparison, trend or share' },
  { id: 'chart_bar', description: 'bar chart: compare one value across items or categories (e.g. revenue per customer)' },
  { id: 'chart_line', description: 'line chart: one value developing over time (per month, week, year)' },
  { id: 'chart_pie', description: 'pie chart: the shares of a whole (distribution, proportion)' },
];

const MAX_TITLE = 80;

/** The gate verdict, or undefined when it does not come within `ms`. */
export async function peekGate(gate: Promise<GateSignal> | undefined, ms = GATE_PEEK_MS): Promise<GateSignal | undefined> {
  if (gate === undefined) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([gate, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The question as a heading: one line, no trailing question mark, capped. */
export function questionTitle(question: string): string {
  const line = question.replace(/\s+/g, ' ').trim().replace(/[?？]+$/, '');
  const capped = line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

export const SIMPLE_ANSWER_ID = 'answer';

/** The view of a simple model turn: the question and a text node the
 *  agent's answer fills. No data requirement, so no publish is expected. */
export function simpleSkeleton(question: string): SkeletonResult {
  return {
    tree: simpleTree(question, { loading: true }),
    dataRequirements: [],
    source: 'simple',
  };
}

/** The simple view, loading or with the answer. */
export function simpleTree(question: string, body: { loading: true } | { text: string }): unknown {
  const heading = questionTitle(question);
  return {
    type: 'container',
    id: 'root',
    layout: 'stack',
    children: [
      ...(heading.length > 0 ? [{ type: 'heading', content: heading, level: 2 }] : []),
      'text' in body
        ? { type: 'text', id: SIMPLE_ANSWER_ID, content: body.text }
        : { type: 'text', id: SIMPLE_ANSWER_ID, content: '', loading: 'skeleton' },
    ],
  };
}

/** Ask the decision model how to show the rows. undefined → the table. */
export async function decideLayout(opts: {
  decide: DecisionModelService;
  /** the masked turn message the gate saw (`TriageOutcome.decisionInput`) */
  input: string;
  log: (message: string) => void;
  onStep?: (step: FastPathDecisionStep) => void;
}): Promise<{ layout: CanvasLayout; confidence: number } | undefined> {
  const result = await chooseDecision(
    opts.decide,
    { task: LAYOUT_TASK, instruction: LAYOUT_INSTRUCTION, input: opts.input, options: LAYOUT_OPTIONS },
    opts.log,
    opts.onStep,
  );
  if (!result) return undefined;
  opts.log(`[ui-orchestrator] decision layout choice=${result.choice} conf=${result.confidence.toFixed(2)}`);
  if (result.confidence < LAYOUT_MIN_CONFIDENCE) return undefined;
  const layout: CanvasLayout = result.choice === 'table' ? 'table' : (result.choice.replace('chart_', '') as ChartKind);
  return { layout, confidence: result.confidence };
}

/** The layout decision, or undefined when it is not there within `ms`. */
export async function settleLayout(
  layout: Promise<{ layout: CanvasLayout } | undefined>,
  ms = LAYOUT_GRACE_MS,
): Promise<CanvasLayout | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return (await Promise.race([layout.catch(() => undefined), timeout]))?.layout;
  } finally {
    clearTimeout(timer);
  }
}

const ID_KEY = /^(id|row_?key|.*_id)$/i;
/** value columns by preference: money first, then counts/quantities */
const VALUE_HINTS = [
  /amount|total|sum|betrag|umsatz|revenue|residual|balance|saldo|price|preis|value|wert/i,
  /count|anzahl|qty|quantity|menge|hours|stunden/i,
];

/** The label and value columns a chart of `rows` would use, or undefined
 *  when the rows cannot be a chart of `kind` (too few/many rows, no text
 *  label, no numeric value). */
export function chartColumns(
  rows: ReadonlyArray<Record<string, unknown>>,
  fieldKeys: readonly string[],
  kind: ChartKind,
): { labelKey: string; valueKey: string } | undefined {
  const max = kind === 'pie' ? PIE_MAX_ROWS : CHART_MAX_ROWS;
  if (rows.length < CHART_MIN_ROWS || rows.length > max) return undefined;
  const keys = fieldKeys.filter((k) => !ID_KEY.test(k));
  const numeric = keys.filter((k) => rows.every((r) => typeof r[k] === 'number' && Number.isFinite(r[k])));
  const valueKey = VALUE_HINTS.map((hint) => numeric.find((k) => hint.test(k))).find((k) => k !== undefined) ?? numeric[0];
  const labelKey = keys.find(
    (k) => k !== valueKey && rows.every((r) => typeof r[k] === 'string' && (r[k] as string).trim().length > 0),
  );
  if (valueKey === undefined || labelKey === undefined) return undefined;
  if (kind === 'pie' && rows.some((r) => (r[valueKey] as number) < 0)) return undefined;
  return { labelKey, valueKey };
}

/** The view of a chart answer: the heading of the plan skeleton and a
 *  chart that the rows fill as `label` / `value` points. */
export function chartTree(heading: unknown, containerId: string, kind: ChartKind): unknown {
  return {
    type: 'container',
    id: 'root',
    layout: 'stack',
    children: [
      ...(heading !== undefined ? [heading] : []),
      { type: 'chart', id: containerId, loading: 'skeleton', chartType: kind, points: [] },
    ],
  };
}

/** The first heading node of a tree's root, if any. */
export function rootHeading(tree: unknown): unknown {
  const children = (tree as { children?: unknown } | null)?.children;
  return Array.isArray(children)
    ? children.find((c) => (c as { type?: unknown } | null)?.type === 'heading')
    : undefined;
}

/**
 * What ran on the decision model for this canvas turn, as `done.fastPathDecision`
 * (undefined when nothing did). The triage's trace when its gate decided,
 * otherwise a fallback entry from the steps alone (the gate was unsure and a
 * language model routed).
 */
export function canvasDecision(opts: {
  provider: string | undefined;
  trace: DecisionTrace | undefined;
  steps: readonly FastPathDecisionStep[];
  ui: FastPathDecisionUi;
  answered: boolean;
}): FastPathDecision | undefined {
  const { trace, steps, ui } = opts;
  if (steps.length === 0 || opts.provider === undefined) return undefined;
  const gate = steps.find((s) => s.task === 'fast-path.gate');
  const base: FastPathDecision = trace
    ? {
        provider: trace.provider,
        ...(trace.model !== undefined ? { model: trace.model } : {}),
        verdict: trace.verdict,
        ...(trace.route !== undefined ? { route: trace.route } : {}),
        ...(trace.tool !== undefined ? { tool: trace.tool } : {}),
        confidence: trace.confidence,
        ms: trace.ms,
        ...(trace.direct === true ? { direct: true as const } : {}),
      }
    : {
        provider: opts.provider,
        verdict: gate?.choice === 'data' ? 'data' : 'model',
        confidence: gate?.confidence ?? 0,
        ms: steps.reduce((sum, s) => sum + s.ms, 0),
        fallback: true as const,
      };
  return {
    ...base,
    ...(opts.answered ? { answered: true as const } : {}),
    steps: steps.map((s) => ({ ...s })),
    ui,
  };
}
