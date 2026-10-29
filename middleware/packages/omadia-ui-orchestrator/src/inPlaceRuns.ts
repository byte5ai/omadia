import {
  PRIVACY_REDACT_SERVICE_NAME,
  type PluginContext,
  type PrivacyGuardService,
} from '@omadia/plugin-api';
import { type ChatStreamEvent, type ChatTurnInput, type RevisionId } from '@omadia/channel-sdk';
import {
  fetchRecipeRows,
  openSkeletonPrivacy,
  parseRefreshSource,
  renderSummary,
  type FastPathService,
  type RefreshSource,
} from '@omadia/fast-path';

import { CANVAS_PROTOCOL_VERSION, OPS_CATALOG_VERSION } from './canvasProtocol.js';
import { type CanvasRuntime } from './canvasRuntime.js';
import { mintDataRef } from './dataRef.js';
import { deriveDataRequirements } from './dataRequirements.js';
import { variantLang } from './fastPathRun.js';
import { canvasTables, matchInPlacePlans, planInPlace } from './learnedFastPath.js';
import { publishRowsEvents } from './publishRowsEvents.js';
import { applyVariant, headingContentPath, monthVariantActions, variantActionRef } from './recipeVariant.js';
import {
  buildRowDetailsTree,
  parseRecordId,
  ROW_DETAILS_TOOL,
  rowDetailsAnswer,
  rowDetailsAsk,
  rowDetailsLanguage,
  rowDetailsSource,
} from './rowDetails.js';
import { synthesizeSurfaceEvents } from './surfaceSynthesis.js';
import { validateTree } from './treeValidator.js';
import { actionTargetRow } from './turnTargets.js';

/**
 * LLM-free (or one-fast-call) runs on an EXISTING canvas: a suggested
 * action's recipe variant, "Details anzeigen" row details and the learned
 * in-place re-plan. Each emits nothing on a miss — the caller's next path
 * then runs unchanged.
 */

export type VariantOutcome =
  | { hit: true; events: ChatStreamEvent[]; prose: string; tool: string; rows: number; label: string }
  | { hit: false; reason: string };

/** LLM-free suggested action (recipeVariant.ts): the clicked action's
 *  registered variant, validated against the table's CURRENT recipe, runs
 *  as ONE fetch that REPLACES the table's rows on the client's live tree
 *  (refresh semantics); the variant becomes the table's recipe. Emits
 *  nothing on a miss — the existing action path then runs unchanged. */
export async function runRecipeVariant(
  rt: CanvasRuntime,
  input: ChatTurnInput,
  canvasSessionId: string,
  fp: FastPathService | undefined,
  privacyForced: boolean,
  permitted: ReadonlySet<string>,
): Promise<VariantOutcome> {
  const {
    ctx,
    toolsAccessor,
    variants,
    refreshRecipes,
    derivedVariantsEnabled,
    canvasOutputTools,
    registerVariants,
  } = rt;
  const miss = (reason: string): VariantOutcome => ({ hit: false, reason });
  if (fp === undefined) return miss('disabled');
  if (privacyForced) return miss('privacy-forced');
  const ref = variantActionRef(input);
  if (!ref) return miss('invalid-action');
  const state = input.canvasState;
  if (!state) return miss('no-canvas-state');
  const variant = variants.get(canvasSessionId, ref.containerId, ref.actionId);
  if (!variant) return miss('unknown-variant');
  const base = refreshRecipes.get(canvasSessionId, ref.containerId);
  if (!base) return miss('no-recipe');
  const applied = applyVariant(base, variant);
  if (!applied.ok) return miss(applied.reason);
  const source = applied.source;
  if (!fp.allowedFetchTools().has(source.tool)) return miss('tool-not-allowed');
  if (!permitted.has(source.tool)) return miss('tool-not-permitted');
  const invoke = toolsAccessor?.invoke?.bind(toolsAccessor);
  if (!invoke) return miss('no-invoker');
  const fetched = await fetchRecipeRows(invoke, source, { rejectTruncated: true, timeZone: fp.timeZone });
  if (!fetched.ok) {
    if (fetched.detail !== undefined) {
      ctx.log(`[ui-orchestrator] action-variant ${source.tool} ${fetched.reason}: ${fetched.detail}`);
    }
    return miss(fetched.reason);
  }
  const lang = rowDetailsLanguage(input);
  const events: ChatStreamEvent[] = [];
  let captured = false;
  const jobs = [
    {
      containerId: ref.containerId,
      rows: fetched.rows,
      source,
      actions: derivedVariantsEnabled ? monthVariantActions(source, lang) : [],
    },
  ];
  for await (const ev of synthesizeSurfaceEvents(publishRowsEvents(jobs), {
    canvasSessionId,
    authorizedToolNames: canvasOutputTools,
    protocolVersion: CANVAS_PROTOCOL_VERSION,
    opsCatalogVersion: OPS_CATALOG_VERSION,
    startSurfaceSeq: 0,
    baseRevision: state.basedOnRevision as RevisionId,
    baseTree: state.currentTree,
    dataRequirements: deriveDataRequirements(state.currentTree),
    refreshContainers: new Set([ref.containerId]),
    onPublishedSource: () => {
      captured = true;
      return mintDataRef(canvasSessionId, ref.containerId);
    },
    onPublishedActions: registerVariants(canvasSessionId),
    log: (message) => ctx.log(message),
  })) {
    if (ev.type.startsWith('surface_')) events.push(ev);
  }
  const last = [...events].reverse().find((e) => e.type === 'surface_patch');
  if (last?.type !== 'surface_patch' || !captured) return miss('unpublishable');
  // the heading follows only when the variant names one and the table has one
  const headingPath = variant.heading !== undefined ? headingContentPath(state.currentTree, ref.containerId) : undefined;
  if (variant.heading !== undefined && headingPath !== undefined) {
    const seqs = events.map((e) => ('surfaceSeq' in e && typeof e.surfaceSeq === 'number' ? e.surfaceSeq : -1));
    events.push({
      type: 'surface_patch',
      canvasSessionId,
      surfaceSeq: Math.max(...seqs) + 1,
      basedOnRevision: last.producesRevision,
      producesRevision: String(Number(last.producesRevision) + 1) as RevisionId,
      patches: [{ op: 'replace', path: headingPath, value: variant.heading }],
    });
  }
  // the table now SHOWS the variant: refresh and the next variant build on it
  refreshRecipes.set(canvasSessionId, ref.containerId, source);
  const rows = fetched.rows.length;
  const prose =
    (variant.heading !== undefined ? `${variant.heading}: ` : '') +
    (lang === 'de' ? `${rows} ${rows === 1 ? 'Eintrag' : 'Einträge'}.` : `${rows} ${rows === 1 ? 'row' : 'rows'}.`);
  return { hit: true, events, prose, tool: source.tool, rows, label: variant.heading ?? input.userMessage };
}

export type RowDetailsOutcome =
  | { hit: true; snapshot: ChatStreamEvent; prose: string; ask: string }
  | { hit: false; reason: string };

/** LLM-free "Details anzeigen" (rowDetails.ts): the target row's table
 *  recipe names tool + model, the row key is the record id — ONE id query,
 *  rendered as a deterministic key/value view. Emits nothing on a miss: the
 *  existing composer/agent path then runs unchanged. No model is called
 *  and no value leaves this function except into the canvas snapshot. */
export async function runRowDetails(
  rt: CanvasRuntime,
  input: ChatTurnInput,
  canvasSessionId: string,
  fp: FastPathService | undefined,
  privacyForced: boolean,
  permitted: ReadonlySet<string>,
): Promise<RowDetailsOutcome> {
  const { ctx, toolsAccessor, refreshRecipes } = rt;
  const miss = (reason: string): RowDetailsOutcome => ({ hit: false, reason });
  if (fp === undefined) return miss('disabled');
  if (privacyForced) return miss('privacy-forced');
  const row = actionTargetRow(input);
  if (!row) return miss('no-target');
  const recipe = refreshRecipes.get(canvasSessionId, row.containerId);
  if (!recipe) return miss('no-recipe');
  if (recipe.tool !== ROW_DETAILS_TOOL) return miss('tool-unsupported');
  if (!fp.allowedFetchTools().has(ROW_DETAILS_TOOL)) return miss('tool-not-allowed');
  if (!permitted.has(ROW_DETAILS_TOOL)) return miss('tool-not-permitted');
  // the row key is a record id only when the table keyed its rows by `id`
  const id = recipe.rowKey === 'id' ? parseRecordId(row.key) : undefined;
  if (id === undefined) return miss('row-key-invalid');
  const source = rowDetailsSource(recipe, id);
  if (!source) return miss('no-recipe');
  const invoke = toolsAccessor?.invoke?.bind(toolsAccessor);
  if (!invoke) return miss('no-invoker');
  const fetched = await fetchRecipeRows(invoke, source, { rejectTruncated: true, timeZone: fp.timeZone });
  if (!fetched.ok) {
    if (fetched.detail !== undefined) {
      ctx.log(`[ui-orchestrator] row-details ${source.tool} ${fetched.reason}: ${fetched.detail}`);
    }
    return miss(fetched.reason === 'truncated' || fetched.reason === 'unmappable' ? fetched.reason : 'invoke-error');
  }
  const record = fetched.records.find((r) => r['id'] === id);
  if (!record) return miss('not-found');
  const model = (source.input as { model: string; fields: string[] }).model;
  const fields = (source.input as { model: string; fields: string[] }).fields;
  const lang = rowDetailsLanguage(input);
  const view = buildRowDetailsTree({ model, record, fields, lang });
  const valid = validateTree(view.tree);
  if (!valid.ok) {
    ctx.log(`[ui-orchestrator] row-details tree invalid: ${valid.errors ?? ''}`);
    return miss('invalid-tree');
  }
  return {
    hit: true,
    snapshot: {
      type: 'surface_snapshot',
      canvasSessionId,
      surfaceSeq: 0,
      producesRevision: '0' as RevisionId,
      tree: view.tree,
      protocolVersion: CANVAS_PROTOCOL_VERSION,
      opsCatalogVersion: OPS_CATALOG_VERSION,
    },
    prose: rowDetailsAnswer(view.title, lang),
    ask: rowDetailsAsk(model, id, lang),
  };
}

export type InPlaceOutcome =
  | { hit: true; events: ChatStreamEvent[]; prose: string; plan: string; rows: number }
  | { hit: false; reason: string };

/** Learned fast path for a follow-up in an EXISTING canvas: when an active
 *  plan fits a visible table, ONE fast-model call re-plans that table's
 *  query; the plugin runs it and REPLACES the table's rows. Emits nothing
 *  on a miss — the in-place agent path then runs unchanged. */
export async function runInPlaceLearned(
  rt: CanvasRuntime,
  fp: FastPathService | undefined,
  input: ChatTurnInput,
  canvasSessionId: string,
  state: NonNullable<ChatTurnInput['canvasState']>,
  privacyForced: boolean,
  /** the tools the base agent itself offers — plans outside it never run */
  permitted: ReadonlySet<string>,
): Promise<InPlaceOutcome> {
  const {
    ctx,
    llm,
    model,
    toolsAccessor,
    refreshRecipes,
    derivedVariantsEnabled,
    canvasOutputTools,
    registerVariants,
  } = rt;
  const miss = (reason: string): InPlaceOutcome => ({ hit: false, reason });
  if (fp === undefined) return miss('disabled');
  if (privacyForced) return miss('privacy-forced');
  if (input.action !== undefined || input.target !== undefined) return miss('action-turn');
  const question = input.userMessage.trim();
  if (question.length === 0) return miss('no-question');
  const tables = canvasTables(state.currentTree);
  if (tables.length === 0) return miss('no-table');
  const matched = matchInPlacePlans(fp.plans, question, tables).filter((m) => permitted.has(m.plan.tool));
  if (matched.length === 0) return miss('no-match');
  const invoke = toolsAccessor?.invoke?.bind(toolsAccessor);
  if (!invoke) return miss('no-invoker');
  const currentQueries = new Map<string, RefreshSource>();
  for (const t of tables) {
    const recipe = refreshRecipes.get(canvasSessionId, t.containerId);
    if (recipe) currentQueries.set(t.containerId, recipe);
  }
  const plannerGuard = (ctx.services as PluginContext['services'] | undefined)?.get<PrivacyGuardService>(
    PRIVACY_REDACT_SERVICE_NAME,
  );
  const planned = await planInPlace({
    llm,
    model,
    question,
    tables,
    currentQueries,
    plans: matched,
    allowedTools: new Set([...fp.allowedFetchTools()].filter((t) => permitted.has(t))),
    log: (m) => ctx.log(m),
    ...(plannerGuard !== undefined ? { privacy: openSkeletonPrivacy(plannerGuard) } : {}),
  });
  if (!planned.ok) return miss(planned.reason);
  const fetched = await fetchRecipeRows(invoke, planned.fetch, {
    rejectTruncated: true,
    timeZone: fp.timeZone,
  });
  if (!fetched.ok) {
    fp.recordFetchOutcome([planned.fetch], false, fetched.reason);
    return miss(fetched.reason);
  }
  const rendered = renderSummary(planned.summary, {
    rows: fetched.rows,
    records: fetched.records,
    map: planned.fetch.map,
    ...(planned.locale !== undefined ? { locale: planned.locale } : {}),
  });
  if (!rendered.ok) return miss('summary-unresolvable');
  const recipes: RefreshSource[] = [];
  const events: ChatStreamEvent[] = [];
  const jobs = [
    {
      containerId: planned.containerId,
      rows: fetched.rows,
      source: planned.fetch,
      actions: derivedVariantsEnabled ? monthVariantActions(planned.fetch, variantLang(planned.locale)) : [],
    },
  ];
  for await (const ev of synthesizeSurfaceEvents(publishRowsEvents(jobs), {
    canvasSessionId,
    authorizedToolNames: canvasOutputTools,
    protocolVersion: CANVAS_PROTOCOL_VERSION,
    opsCatalogVersion: OPS_CATALOG_VERSION,
    startSurfaceSeq: 0,
    baseRevision: state.basedOnRevision as RevisionId,
    baseTree: state.currentTree,
    dataRequirements: deriveDataRequirements(state.currentTree),
    // refresh semantics: the first publish REPLACES the stale rows
    refreshContainers: new Set([planned.containerId]),
    onPublishedSource: (containerId, raw) => {
      const source = parseRefreshSource(raw);
      if (!source) return undefined;
      recipes.push(source);
      return mintDataRef(canvasSessionId, containerId);
    },
    onPublishedActions: registerVariants(canvasSessionId),
    log: (message) => ctx.log(message),
  })) {
    if (ev.type.startsWith('surface_')) events.push(ev);
  }
  if (!events.some((e) => e.type === 'surface_patch')) return miss('unpublishable');
  for (const r of recipes) refreshRecipes.set(canvasSessionId, planned.containerId, r);
  const ids = fp.recordFetchOutcome([planned.fetch], true);
  return { hit: true, events, prose: rendered.text, plan: ids[0] ?? 'adapted', rows: fetched.rows.length };
}
