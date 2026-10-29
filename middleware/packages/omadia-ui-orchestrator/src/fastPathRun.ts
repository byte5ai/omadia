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
    }
  | { hit: false; reason: string; failedFetch?: RefreshSource };

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

  const jobs: Array<{
    containerId: string;
    rows: Array<Record<string, unknown>>;
    source: RefreshSource;
    actions: VariantAction[];
    columns?: PlanColumn[];
  }> = [];
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

  const recipes: Array<{ containerId: string; source: RefreshSource }> = [];
  const events: ChatStreamEvent[] = [];
  for await (const ev of synthesizeSurfaceEvents(publishRowsEvents(jobs), {
    canvasSessionId,
    authorizedToolNames: canvasOutputTools,
    protocolVersion: CANVAS_PROTOCOL_VERSION,
    opsCatalogVersion: OPS_CATALOG_VERSION,
    startSurfaceSeq,
    baseRevision: '0' as RevisionId,
    baseTree: skeleton.tree,
    dataRequirements: skeleton.dataRequirements,
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
  if (events.filter((e) => e.type === 'surface_patch').length < jobs.length) {
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
  };
}

/** Label language of deterministic variant actions (fast-path locale). */
export function variantLang(locale: string | undefined): 'de' | 'en' {
  return locale?.toLowerCase().startsWith('en') === true ? 'en' : 'de';
}
