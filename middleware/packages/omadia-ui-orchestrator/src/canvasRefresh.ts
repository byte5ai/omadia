import { type ChatAgent, type ChatStreamEvent, type ChatTurnInput, type RevisionId } from '@omadia/channel-sdk';
import { fetchRecipeRows } from '@omadia/fast-path';

import { CANVAS_PROTOCOL_VERSION, OPS_CATALOG_VERSION } from './canvasProtocol.js';
import { type CanvasRuntime } from './canvasRuntime.js';
import { tapCanvasSentinels } from './canvasSentinelTap.js';
import { deriveDataRequirements } from './dataRequirements.js';
import { publishRowsEvents } from './publishRowsEvents.js';
import { synthesizeSurfaceEvents } from './surfaceSynthesis.js';

/** Deterministic refresh (protocol 1.1 `canvas_refresh`, omadia-ui#5, v1):
 *  NO skeleton composition — the client sent its current tree; the data
 *  requirements are derived from that tree's own containers, the main turn
 *  re-fetches silently, and the first publish per container REPLACES its
 *  rows (the consumed `refreshContainers` set). Patches restart surfaceSeq
 *  at 0 on top of the client's revision — the client accepts a seq-0 patch
 *  run whose basedOnRevision matches. The LLM-free dataRef re-resolution
 *  swaps these internals later without touching the wire contract. */
export async function* canvasRefreshStream(
  rt: CanvasRuntime,
  input: ChatTurnInput,
  observer: Parameters<ChatAgent['chatStream']>[1],
  base: ChatAgent,
  canvasSessionId: string,
  refresh: NonNullable<ChatTurnInput['canvasRefresh']>,
): AsyncGenerator<ChatStreamEvent> {
  const {
    ctx,
    toolsAccessor,
    refreshRecipes,
    fastPathTimeZone,
    canvasOutputTools,
    captureSource,
    deriveSource,
    registerVariants,
  } = rt;
  const requirements = deriveDataRequirements(refresh.currentTree, refresh.scope);
  if (requirements.length === 0) {
    // nothing refreshable in scope — a defined error, not a silent no-op
    yield {
      type: 'surface_error',
      canvasSessionId,
      surfaceSeq: 0,
      revision: refresh.basedOnRevision as RevisionId,
      severity: 'recoverable',
      message: 'refresh_unsupported: no data containers in scope',
    };
    return;
  }
  // LLM-free path (phase 2): when EVERY container in scope has a captured
  // source recipe, re-execute the queries directly and feed the results
  // through the same synthesis pipeline — synthetic publish events, no
  // model anywhere. Any miss/failure → the silent agent turn below.
  const invoke = toolsAccessor?.invoke?.bind(toolsAccessor);
  if (invoke) {
    const jobs: Array<{ containerId: string; rows: Array<Record<string, unknown>> }> = [];
    let deterministic = true;
    for (const req of requirements) {
      const recipe = refreshRecipes.get(canvasSessionId, req.containerId);
      if (!recipe) {
        deterministic = false;
        break;
      }
      const fetched = await fetchRecipeRows(invoke, recipe, { timeZone: fastPathTimeZone() });
      if (!fetched.ok) {
        ctx.log(
          fetched.reason === 'unmappable' || fetched.reason === 'truncated'
            ? `[canvas-refresh] recipe for ${req.containerId} ${fetched.reason} — agent fallback`
            : `[canvas-refresh] recipe ${recipe.tool} failed (${fetched.reason}): ${
                fetched.detail ?? ''
              } — agent fallback`,
        );
        deterministic = false;
        break;
      }
      ctx.log(
        `[canvas-refresh] deterministic: ${req.containerId} via ${recipe.tool} → ` +
          `${fetched.rows.length} rows in ${fetched.ms}ms (no LLM)`,
      );
      jobs.push({ containerId: req.containerId, rows: fetched.rows });
    }
    if (deterministic) {
      yield* synthesizeSurfaceEvents(publishRowsEvents(jobs), {
        canvasSessionId,
        authorizedToolNames: canvasOutputTools,
        protocolVersion: CANVAS_PROTOCOL_VERSION,
        opsCatalogVersion: OPS_CATALOG_VERSION,
        startSurfaceSeq: 0,
        baseRevision: refresh.basedOnRevision as RevisionId,
        baseTree: refresh.currentTree,
        dataRequirements: requirements,
        refreshContainers: new Set(requirements.map((r) => r.containerId)),
        log: (message) => ctx.log(message),
      });
      return;
    }
  }
  const augmented: ChatTurnInput = {
    ...input,
    userMessage:
      '[canvas-refresh]\n' +
      JSON.stringify({ dataRequirements: requirements }) +
      '\nRe-fetch the CURRENT data for the above containers — same query, ' +
      'newer data, nothing else. Work silently: no narration, no memory ' +
      'commentary. Publish via canvas_publish_rows per containerId with ' +
      'rows keyed EXACTLY by the listed fieldKeys (batches of at most 30 ' +
      'rows, one call at a time; for a privacy-shield datasetId pass ' +
      '`datasetId` instead of rows); the canvas REPLACES the stale rows. On ' +
      'the FIRST publish per container pass `source` (exact tool + input + ' +
      'fieldKey→attribute map, relative date operators for relative ' +
      'periods) so the NEXT refresh runs without you. Do NOT compose a ' +
      'new view, do NOT publish to other containers, do NOT call ' +
      'canvas_publish_choice. Reply with one short sentence.',
  };
  yield* synthesizeSurfaceEvents(base.chatStream(augmented, observer), {
    canvasSessionId,
    authorizedToolNames: canvasOutputTools,
    protocolVersion: CANVAS_PROTOCOL_VERSION,
    opsCatalogVersion: OPS_CATALOG_VERSION,
    startSurfaceSeq: 0,
    baseRevision: refresh.basedOnRevision as RevisionId,
    baseTree: refresh.currentTree,
    dataRequirements: requirements,
    takeRawSentinel: tapCanvasSentinels((m) => ctx.log(m)),
    refreshContainers: new Set(requirements.map((r) => r.containerId)),
    // a fallback refresh that publishes WITH a source upgrades the next
    // refresh of this canvas to the deterministic path
    onPublishedSource: captureSource(canvasSessionId),
    deriveSource,
    onPublishedActions: registerVariants(canvasSessionId),
    log: (message) => ctx.log(message),
  });
}
