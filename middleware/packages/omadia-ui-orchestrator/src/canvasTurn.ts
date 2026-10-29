import {
  PRIVACY_FORCE_GUARDED_ENV_VAR,
  PRIVACY_REDACT_SERVICE_NAME,
  type PluginContext,
  type PrivacyGuardService,
} from '@omadia/plugin-api';
import {
  type ChatAgent,
  type ChatStreamEvent,
  type ChatTurnInput,
  type RevisionId,
} from '@omadia/channel-sdk';
import { type FastPathService } from '@omadia/fast-path';

import { CANVAS_PROTOCOL_VERSION, OPS_CATALOG_VERSION } from './canvasProtocol.js';
import { type CanvasRuntime } from './canvasRuntime.js';
import { tapCanvasSentinels } from './canvasSentinelTap.js';
import { deriveDataRequirements } from './dataRequirements.js';
import { deterministicActionStream } from './deterministicAction.js';
import { runInPlaceLearned, runRecipeVariant, runRowDetails } from './inPlaceRuns.js';
import { recordCanvasTurn } from './recordCanvasTurn.js';
import { variantActionRef } from './recipeVariant.js';
import { isRowDetailsAction, ROW_DETAILS_TOOL } from './rowDetails.js';
import { skeletonTurnStream } from './skeletonTurn.js';
import { synthesizeSurfaceEvents } from './surfaceSynthesis.js';

/**
 * A canvas turn (one that carries `input.canvasSessionId`), in path order:
 * deterministic action → recipe variant → row details → in-place (learned
 * plan, then agent) → skeleton-first (`skeletonTurn.ts`). Each LLM-free path
 * emits nothing on a miss, so the next path starts from a clean slate.
 */

/** The `[canvas-action]` / `[canvas-target]` blocks a turn hands the agent. */
export interface CanvasTurnBlocks {
  actionBlock: string;
  targetBlock: string;
}

/** Per-turn privacy + fast-path gate, resolved once after the deterministic
 *  action check. */
export interface CanvasTurnGate {
  turnStartedAt: number;
  privacyGuard: PrivacyGuardService | undefined;
  privacyForced: boolean;
  /** the canvas fast path — undefined when off, filtered or tool-set-unknown */
  fp: FastPathService | undefined;
  permittedTools: ReadonlySet<string>;
}

function canvasTurnBlocks(input: ChatTurnInput): CanvasTurnBlocks {
  // A structured UI action (choice pick, button click) is the user's ANSWER
  // — handed to the main turn as a [canvas-action] block. Built up-front so
  // both the in-place and skeleton paths below reuse it verbatim.
  const actionBlock = input.action
    ? '\n\n[canvas-action]\n' +
      JSON.stringify(input.action) +
      '\nThis structured UI action is the user’s input for this turn (a ' +
      'choice pick carries the chosen value in payload.value). Act on it ' +
      'directly — do not ask what the user meant.'
    : '';
  // A row-bound text turn (beam, context action) carries the TargetRef of
  // the record it refers to — the agent must act on THAT record, never ask.
  const targetBlock =
    !input.action && input.target !== undefined
      ? '\n\n[canvas-target]\n' +
        JSON.stringify(input.target) +
        '\nThe user’s message refers to EXACTLY this record on the canvas ' +
        '(stable ids: containerId/itemKey/rowKey). Act on it directly — ' +
        'do not ask which record was meant.'
      : '';
  return { actionBlock, targetBlock };
}

/** #1535 — composition models run outside the turn's privacy handle: with
 *  the org policy on and no Privacy Shield running, no raw text may reach
 *  them (skeleton composer, in-place planner) and nothing is learned. */
function openTurnGate(rt: CanvasRuntime, base: ChatAgent): CanvasTurnGate {
  const { ctx, canvasFastPath } = rt;
  const turnStartedAt = Date.now();
  const privacyGuard = (ctx.services as PluginContext['services'] | undefined)?.get<PrivacyGuardService>(
    PRIVACY_REDACT_SERVICE_NAME,
  );
  const privacyForced =
    process.env[PRIVACY_FORCE_GUARDED_ENV_VAR] === 'true' && privacyGuard === undefined;
  // The fast path runs tools on the base agent's behalf, so only tools the
  // agent offers itself (`ChatAgent.offeredToolNames`); an agent that cannot
  // name its tools gets no fast path at all (fail closed).
  const permitted = base.offeredToolNames?.();
  let fp = canvasFastPath();
  if (fp !== undefined && permitted === undefined) {
    ctx.log('[fast-path] miss channel=canvas reason=tool-set-unknown');
    fp = undefined;
  }
  const permittedTools: ReadonlySet<string> = permitted ?? new Set<string>();
  return { turnStartedAt, privacyGuard, privacyForced, fp, permittedTools };
}

export async function* canvasTurnStream(
  rt: CanvasRuntime,
  input: ChatTurnInput,
  observer: Parameters<ChatAgent['chatStream']>[1],
  base: ChatAgent,
  canvasSessionId: string,
): AsyncGenerator<ChatStreamEvent> {
  const { ctx } = rt;
  const blocks = canvasTurnBlocks(input);

  // Deterministic action (LLM-free) — deterministicAction.ts.
  const direct = deterministicActionStream(rt, input, canvasSessionId);
  if (direct !== undefined) {
    yield* direct;
    return;
  }

  const gate = openTurnGate(rt, base);
  const { turnStartedAt, privacyForced, fp, permittedTools } = gate;

  // ── Suggested action as a recipe variant (LLM-free) ────────────────────
  // `action: { type: 'recipe_variant', payload: { actionId, containerId } }`
  // + the live tree: the table's registered variant runs as one fetch that
  // replaces its rows (recipeVariant.ts). Any miss → the paths below.
  if (variantActionRef(input) !== undefined) {
    const v = await runRecipeVariant(rt, input, canvasSessionId, fp, privacyForced, permittedTools);
    if (v.hit) {
      yield* v.events;
      yield { type: 'text_delta', text: v.prose };
      const turnId = await recordCanvasTurn(ctx, input, v.prose, 1, v.label);
      yield {
        type: 'done',
        answer: v.prose,
        toolCalls: 1,
        iterations: 0,
        ...(turnId !== undefined ? { turnId } : {}),
      };
      ctx.log(
        `[fast-path] hit channel=canvas kind=action-variant tool=${v.tool} rows=${v.rows} ms=${Date.now() - turnStartedAt}`,
      );
      return;
    }
    ctx.log(`[fast-path] miss channel=canvas kind=action-variant reason=${v.reason}`);
  }

  // ── Row details (LLM-free) ─────────────────────────────────────────────
  // "Details anzeigen" as a structured action: answered from the row's
  // table recipe alone (rowDetails.ts). Any miss → the paths below.
  if (isRowDetailsAction(input)) {
    const details = await runRowDetails(rt, input, canvasSessionId, fp, privacyForced, permittedTools);
    if (details.hit) {
      yield details.snapshot;
      yield { type: 'text_delta', text: details.prose };
      const turnId = await recordCanvasTurn(ctx, input, details.prose, 1, details.ask);
      yield {
        type: 'done',
        answer: details.prose,
        toolCalls: 1,
        iterations: 0,
        ...(turnId !== undefined ? { turnId } : {}),
      };
      ctx.log(
        `[fast-path] hit channel=canvas kind=row-details tool=${ROW_DETAILS_TOOL} ms=${Date.now() - turnStartedAt}`,
      );
      return;
    }
    ctx.log(`[fast-path] miss channel=canvas kind=row-details reason=${details.reason}`);
  }

  if (fp !== undefined && !privacyForced) {
    await rt.migrateLegacyPlans(fp);
    await fp.plans.load();
  }

  if (input.canvasState) {
    yield* inPlaceTurnStream(rt, input, observer, base, canvasSessionId, input.canvasState, gate, blocks);
    return;
  }

  yield* skeletonTurnStream(rt, input, observer, base, canvasSessionId, gate, blocks);
}

/** ── In-place action (PR-9b-3) ──────────────────────────────────────────
 *  The client handed its CURRENT tree + revision: this action should PATCH
 *  the live canvas, NOT remount a fresh skeleton. Skip skeleton composition
 *  entirely and synthesise on top of `currentTree` — a plugin status-flip
 *  emitting `_pendingSurfacePatch` lands as a `surface_patch` (no remount),
 *  while an action that genuinely recomposes still replaces the tree via a
 *  full snapshot. The data-field contract is derived from the live tree
 *  itself, exactly as `canvas_refresh` does, so a republishing action keeps
 *  its fieldKeys. surfaceSeq restarts at 0 on the client's revision.
 *  A learned in-place plan runs first; on a miss, the agent turn. */
async function* inPlaceTurnStream(
  rt: CanvasRuntime,
  input: ChatTurnInput,
  observer: Parameters<ChatAgent['chatStream']>[1],
  base: ChatAgent,
  canvasSessionId: string,
  state: NonNullable<ChatTurnInput['canvasState']>,
  gate: CanvasTurnGate,
  blocks: CanvasTurnBlocks,
): AsyncGenerator<ChatStreamEvent> {
  const { ctx, canvasOutputTools, captureSource, deriveSource, registerVariants, makeLearner } = rt;
  const { turnStartedAt, privacyForced, fp, permittedTools } = gate;
  const { actionBlock, targetBlock } = blocks;
  const learnedHit = await runInPlaceLearned(
    rt,
    fp,
    input,
    canvasSessionId,
    state,
    privacyForced,
    permittedTools,
  );
  if (learnedHit.hit) {
    yield* learnedHit.events;
    yield { type: 'text_delta', text: learnedHit.prose };
    const turnId = await recordCanvasTurn(ctx, input, learnedHit.prose, 1);
    yield {
      type: 'done',
      answer: learnedHit.prose,
      toolCalls: 1,
      iterations: 0,
      ...(turnId !== undefined ? { turnId } : {}),
    };
    ctx.log(
      `[ui-orchestrator] learned-plan hit plan=${learnedHit.plan} path=in-place ` +
        `rows=${learnedHit.rows} ms=${Date.now() - turnStartedAt}`,
    );
    return;
  }
  if (learnedHit.reason !== 'disabled') {
    ctx.log(`[ui-orchestrator] learned-plan miss reason=${learnedHit.reason} path=in-place`);
  }
  const requirements = deriveDataRequirements(state.currentTree);
  const inPlaceLearner = makeLearner(fp, input, requirements, privacyForced);
  const augmentedInPlace: ChatTurnInput = {
    ...input,
    userMessage:
      input.userMessage +
      actionBlock +
      targetBlock +
      '\n\n[canvas-context]\n' +
      JSON.stringify({
        canvasRevision: state.basedOnRevision,
        dataRequirements: requirements,
        instruction:
          'The canvas is ALREADY rendered at the above revision. PERFORM ' +
          'the structured action IN PLACE by INVOKING THE TOOL THAT OWNS ' +
          'IT — for a domain plugin action (e.g. a draft status-update, ' +
          'schedule, or whatever produced this view) call that tool (via ' +
          'its domain query tool if that is how it is reached); the tool ' +
          'emits a precise surface patch that updates only the affected ' +
          'element. Work silently — the canvas is the output channel: do ' +
          'NOT merely describe the change in prose, do NOT ask what the ' +
          'user meant, and do NOT re-run generation. Do NOT recompose the ' +
          'whole view or re-publish unrelated rows unless the action ' +
          'genuinely opens a new view. When you DO publish, key rows ' +
          'EXACTLY by the listed fieldKeys; all published values are ' +
          'PLAIN TEXT, never markdown. After the tool runs, reply with ' +
          'ONE short sentence.',
      }),
  };
  const inPlace = synthesizeSurfaceEvents(base.chatStream(augmentedInPlace, observer), {
    canvasSessionId,
    authorizedToolNames: canvasOutputTools,
    protocolVersion: CANVAS_PROTOCOL_VERSION,
    opsCatalogVersion: OPS_CATALOG_VERSION,
    startSurfaceSeq: 0,
    baseRevision: state.basedOnRevision as RevisionId,
    baseTree: state.currentTree,
    dataRequirements: requirements,
    onPublishedSource: captureSource(canvasSessionId),
    deriveSource,
    onPublishedActions: registerVariants(canvasSessionId),
    ...(inPlaceLearner ? { onPublishedPayload: (d: unknown) => inPlaceLearner.onPublishedPayload(d) } : {}),
    takeRawSentinel: tapCanvasSentinels((m) => ctx.log(m)),
    log: (message) => ctx.log(message),
  });
  yield* inPlaceLearner ? inPlaceLearner.tap(inPlace) : inPlace;
}
