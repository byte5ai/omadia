import { type ChatStreamEvent, type ChatTurnInput, type RevisionId } from '@omadia/channel-sdk';
import {
  defaultSummary,
  fetchRecipeRows,
  parseRefreshSource,
  renderSummary,
  type RefreshSource,
} from '@omadia/fast-path';

import { CANVAS_PROTOCOL_VERSION, OPS_CATALOG_VERSION } from './canvasProtocol.js';
import { type CanvasRuntime } from './canvasRuntime.js';
import { mintDataRef } from './dataRef.js';
import {
  chartColumns,
  chartTree,
  rootHeading,
  settleLayout,
  type CanvasLayout,
  type ChartKind,
} from './decisionCanvas.js';
import type { DataRequirement } from './composition.js';
import { type PlanColumn, type PlannedSkeleton } from './fastPathBinding.js';
import { publishRowsEvents } from './publishRowsEvents.js';
import { monthVariantActions, type VariantAction } from './recipeVariant.js';
import { synthesizeSurfaceEvents } from './surfaceSynthesis.js';
import { mentionsValue, type TargetRecord } from './turnTargets.js';

export type FastPathOutcome =
  | {
      hit: true;
      events: ChatStreamEvent[];
      /** the rendered summary sentence */
      prose: string;
      tool: string;
      rows: number;
      toolCalls: number;
      /** how the rows went out — set when a layout decision was asked */
      layout?: CanvasLayout;
    }
  | { hit: false; reason: string; failedFetch?: RefreshSource };

type FastPathJob = {
  containerId: string;
  rows: Array<Record<string, unknown>>;
  source: RefreshSource;
  actions: VariantAction[];
  columns?: PlanColumn[];
};

/** The deterministic fast path (see fastPath.ts). Runs only when EVERY
 *  data requirement carries a valid `fetch` for an allow-listed tool; any
 *  miss returns its reason and has emitted NOTHING — the surface events
 *  are buffered until every container is patched, and the recipes commit
 *  only then — so the agent fallback starts from the bare skeleton. The
 *  tool rows never reach a model: they go tool → mapper → canvas patch. */
export async function runFastPath(
  rt: CanvasRuntime,
  input: ChatTurnInput,
  canvasSessionId: string,
  skeleton: PlannedSkeleton,
  privacyForced: boolean,
  startSurfaceSeq: number,
  /** this turn's plannable tools (built-in + offered learned) and the
   *  fetch whitelist (built-in ∪ active learned) */
  turnTools: { plannable: number; allowed: ReadonlySet<string>; permitted: ReadonlySet<string> },
  /** an action turn's target record — its plan must query exactly it */
  target?: TargetRecord,
  /** the decision model's layout for a plan skeleton (decisionCanvas.ts) —
   *  a chart replaces the table when the rows fit one */
  layout?: Promise<{ layout: CanvasLayout } | undefined>,
): Promise<FastPathOutcome> {
  const {
    ctx,
    toolsAccessor,
    fastPathTimeZone,
    derivedVariantsEnabled,
    canvasOutputTools,
    registerVariants,
    refreshRecipes,
  } = rt;
  const miss = (reason: string): FastPathOutcome => ({ hit: false, reason });
  if (turnTools.plannable === 0) return miss('disabled');
  if (privacyForced) return miss('privacy-forced');
  // a structured action / row-bound turn acts on something: only a target
  // row resolved against its table's recipe can be answered here
  const isActionTurn = input.action !== undefined || input.target !== undefined;
  if (isActionTurn && target === undefined) return miss('action-turn');
  const plans: Array<{ containerId: string; fetch: RefreshSource }> = [];
  for (const req of skeleton.dataRequirements) {
    if (req.fetch === undefined) return miss('no-plan');
    plans.push({ containerId: req.containerId, fetch: req.fetch });
  }
  if (skeleton.source === 'fallback' || plans.length === 0) return miss('no-plan');
  if (plans.some((p) => !turnTools.allowed.has(p.fetch.tool))) return miss('tool-not-allowed');
  // the base agent itself must offer the tool — a fast path never reaches
  // a tool the answering agent does not have
  if (plans.some((p) => !turnTools.permitted.has(p.fetch.tool))) return miss('tool-not-permitted');
  if (target !== undefined && !plans.every((p) => mentionsValue(p.fetch.input, target.id))) {
    return miss('target-not-queried');
  }
  // a valid plan without a usable summary sentence keeps a deterministic
  // count sentence — the rows are the answer, the sentence is decoration
  const summaryTemplate = skeleton.summary ?? defaultSummary(skeleton.locale, input.userMessage);
  if (skeleton.summary === undefined) {
    ctx.log('[ui-orchestrator] fast-path summary missing — default count sentence');
  }
  // ToolsAccessor exposes neither specs nor an availability probe: a tool
  // that is not registered (e.g. odoo_query with generic reads disabled)
  // surfaces as invoke's "unknown or handler-less" → miss tool-unavailable.
  const invoke = toolsAccessor?.invoke?.bind(toolsAccessor);
  if (!invoke) return miss('no-invoker');

  const jobs: FastPathJob[] = [];
  let firstRecords: Array<Record<string, unknown>> = [];
  for (const plan of plans) {
    const fetched = await fetchRecipeRows(invoke, plan.fetch, {
      rejectTruncated: true,
      timeZone: fastPathTimeZone(),
    });
    if (!fetched.ok) {
      if (fetched.detail !== undefined) {
        ctx.log(`[ui-orchestrator] fast-path ${plan.fetch.tool} ${fetched.reason}: ${fetched.detail}`);
      }
      return { hit: false, reason: fetched.reason, failedFetch: plan.fetch };
    }
    if (jobs.length === 0) firstRecords = fetched.records;
    jobs.push({
      containerId: plan.containerId,
      rows: fetched.rows,
      source: plan.fetch,
      // e.g. a birthday-month table offers previous/next month, LLM-free
      actions: derivedVariantsEnabled ? monthVariantActions(plan.fetch, variantLang(skeleton.locale)) : [],
      ...(skeleton.planColumns ? { columns: skeleton.planColumns } : {}),
    });
  }
  // `{count}` / `{sum:…}` = rows of the FIRST requirement (the composer
  // prompt's contract); rendered before anything is emitted, so a sum it
  // cannot state exactly (mixed currencies included) is a clean miss.
  const first = jobs[0];
  const rendered = renderSummary(summaryTemplate, {
    rows: first?.rows ?? [],
    records: firstRecords,
    map: first?.source.map ?? {},
    ...(skeleton.locale !== undefined ? { locale: skeleton.locale } : {}),
  });
  if (!rendered.ok) {
    ctx.log(`[ui-orchestrator] fast-path summary unresolvable: ${rendered.detail}`);
    return miss('summary-unresolvable');
  }

  // the decision model's layout, asked alongside the fetch: a chart view
  // replaces the table (one more snapshot) when the rows fit one
  const chosen = layout !== undefined && jobs.length === 1 ? await settleLayout(layout) : undefined;
  const chart =
    chosen !== undefined && chosen !== 'table' && jobs[0] !== undefined ? chartView(skeleton, jobs[0], chosen) : undefined;
  if (chosen !== undefined && chosen !== 'table' && chart === undefined) {
    ctx.log(`[ui-orchestrator] decision layout ${chosen} not applicable to the rows — table`);
  }
  // what the user sees: the chart, else the table — also when a chart was
  // chosen but the rows do not fit one (the client says why)
  const shownLayout: CanvasLayout | undefined = chart !== undefined ? chosen : chosen !== undefined ? 'table' : undefined;
  const publishJobs = chart !== undefined ? [chart.job] : jobs;
  const events: ChatStreamEvent[] = [];
  let seq = startSurfaceSeq;
  if (chart !== undefined) {
    events.push({
      type: 'surface_snapshot',
      canvasSessionId,
      surfaceSeq: seq++,
      producesRevision: '1' as RevisionId,
      tree: chart.tree,
      protocolVersion: CANVAS_PROTOCOL_VERSION,
      opsCatalogVersion: OPS_CATALOG_VERSION,
    });
  }

  const recipes: Array<{ containerId: string; source: RefreshSource }> = [];
  for await (const ev of synthesizeSurfaceEvents(publishRowsEvents(publishJobs), {
    canvasSessionId,
    authorizedToolNames: canvasOutputTools,
    protocolVersion: CANVAS_PROTOCOL_VERSION,
    opsCatalogVersion: OPS_CATALOG_VERSION,
    startSurfaceSeq: seq,
    baseRevision: (chart !== undefined ? '1' : '0') as RevisionId,
    baseTree: chart?.tree ?? skeleton.tree,
    dataRequirements: chart?.requirements ?? skeleton.dataRequirements,
    onPublishedSource: (containerId, raw) => {
      const source = parseRefreshSource(raw);
      if (!source) return undefined;
      recipes.push({ containerId, source });
      return mintDataRef(canvasSessionId, containerId);
    },
    onPublishedActions: registerVariants(canvasSessionId),
    log: (message) => ctx.log(message),
  })) {
    // only the surface events go out — the synthetic tool events carry rows
    if (ev.type.startsWith('surface_')) events.push(ev);
  }
  if (events.filter((e) => e.type === 'surface_patch').length < publishJobs.length) {
    return miss('unpublishable');
  }
  for (const r of recipes) {
    refreshRecipes.set(canvasSessionId, r.containerId, r.source);
    ctx.log(`[canvas-refresh] recipe captured: ${r.containerId} via ${r.source.tool} (fast path)`);
  }
  return {
    hit: true,
    events,
    prose: rendered.text,
    tool: [...new Set(plans.map((p) => p.fetch.tool))].join(','),
    rows: first?.rows.length ?? 0,
    toolCalls: jobs.length,
    ...(shownLayout !== undefined ? { layout: shownLayout } : {}),
  };
}

/** The chart view of a planned table: the skeleton's heading over a chart
 *  in the table's place, and the job publishing `label` / `value` points.
 *  The recipe's map gains `label` / `value`, so a refresh replays the same
 *  points. undefined when the rows cannot be that chart. */
function chartView(
  skeleton: PlannedSkeleton,
  job: FastPathJob,
  kind: ChartKind,
): { tree: unknown; requirements: DataRequirement[]; job: FastPathJob } | undefined {
  const cols = chartColumns(job.rows, Object.keys(job.source.map), kind);
  if (cols === undefined) return undefined;
  const labelAttr = job.source.map[cols.labelKey];
  const valueAttr = job.source.map[cols.valueKey];
  if (labelAttr === undefined || valueAttr === undefined) return undefined;
  const labelOf = (key: string): string => job.columns?.find((c) => c.fieldKey === key)?.label ?? key;
  const description = skeleton.dataRequirements[0]?.description ?? '';
  return {
    tree: chartTree(rootHeading(skeleton.tree), job.containerId, kind),
    requirements: [
      {
        containerId: job.containerId,
        description,
        fields: [
          { fieldKey: 'label', label: labelOf(cols.labelKey) },
          { fieldKey: 'value', label: labelOf(cols.valueKey) },
        ],
      },
    ],
    job: {
      containerId: job.containerId,
      rows: job.rows.map((r) => ({
        ...(r['rowKey'] !== undefined ? { rowKey: r['rowKey'] } : {}),
        label: r[cols.labelKey],
        value: r[cols.valueKey],
      })),
      source: { ...job.source, map: { label: labelAttr, value: valueAttr } },
      actions: [],
    },
  };
}

/** Label language of deterministic variant actions (fast-path locale). */
export function variantLang(locale: string | undefined): 'de' | 'en' {
  return locale?.toLowerCase().startsWith('en') === true ? 'en' : 'de';
}
