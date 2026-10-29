import {
  type ChatAgent,
  type ChatStreamEvent,
  type ChatTurnInput,
  type RevisionId,
} from '@omadia/channel-sdk';
import {
  CACHE_DOUBT_REASON,
  isCacheDoubt,
  offeredTools,
  openSkeletonPrivacy,
  triageTurn,
  type TriageOutcome,
} from '@omadia/fast-path';

import { CANVAS_PROTOCOL_VERSION, CANVAS_TURN_DIRECTIVE, OPS_CATALOG_VERSION } from './canvasProtocol.js';
import { type CanvasRuntime } from './canvasRuntime.js';
import { tapCanvasSentinels } from './canvasSentinelTap.js';
import { type CanvasTurnBlocks, type CanvasTurnGate } from './canvasTurn.js';
import { CACHE_PEEK_MS, peekCacheHit, planSkeleton } from './cachedSkeleton.js';
import { composeSkeleton, type SkeletonResult } from './composition.js';
import { bindPlanToSkeleton, type PlannedSkeleton } from './fastPathBinding.js';
import { runFastPath, type FastPathOutcome } from './fastPathRun.js';
import { COMPOSER_TOP_K } from './learnedFastPath.js';
import { recordCanvasTurn } from './recordCanvasTurn.js';
import { synthesizeSurfaceEvents } from './surfaceSynthesis.js';
import { resolveTargetRecord, targetRecordBlock } from './turnTargets.js';
import { replaceSkeletonOnWithheld } from './verdictHold.js';

/**
 * The skeleton-first canvas turn (no live tree): router ∥ speculative planner
 * ∥ composer, the skeleton snapshot, the deterministic fast path, and — on a
 * miss — the agent turn with the requirement handoff + surface synthesis.
 */

/** This turn's fast-path inputs and the in-flight triage, started BEFORE the
 *  composer (see {@link startTriage}). */
type TurnTriage = ReturnType<typeof startTriage>;

export async function* skeletonTurnStream(
  rt: CanvasRuntime,
  input: ChatTurnInput,
  observer: Parameters<ChatAgent['chatStream']>[1],
  base: ChatAgent,
  canvasSessionId: string,
  gate: CanvasTurnGate,
  blocks: CanvasTurnBlocks,
): AsyncGenerator<ChatStreamEvent> {
  const { ctx, llm, model } = rt;
  const { turnStartedAt, privacyGuard, privacyForced, fp } = gate;
  // 1. Skeleton-first — emitted BEFORE the (slow) main turn starts. Never
  //    throws: schema failure → bounded repair retry → deterministic fallback.
  //    An action-only turn (choice pick, button click) has no text — the
  //    structured action then IS the request the skeleton is composed for.
  //    It goes out immediately on every base — also one that holds content
  //    until the verdict (verdictHold.ts says why that is safe).
  //    #1535/#1540 — composed by a model BEFORE the turn has a privacy
  //    handle. With a privacy guard running, the text goes through the
  //    guard's stored-text scope (skeletonPrivacy.ts). With the org policy
  //    on and no guard running, the base turn refuses, so the raw text must
  //    not reach this model either.
  //    Fast path: the ROUTER (@omadia/fast-path router.ts) runs IN PARALLEL
  //    with the composer — both start before either resolves. The composer
  //    is a pure UI composer; a confident deterministic route then gets ONE
  //    planner call against the skeleton's data container. Learned plans:
  //    the top-K active plans most similar to the ask are the router's
  //    intents and the planner's examples (their tools join the whitelist).
  //    Answer-cache hit (resolves in ms): the cached plan knows its table,
  //    so the skeleton is built from it and the composer is not called.
  const turnTriage = startTriage(rt, input, canvasSessionId, base, gate);
  const cachedPlan = await peekCacheHit(turnTriage.triage, turnTriage.cacheVerdict, CACHE_PEEK_MS);
  const skeleton: SkeletonResult = cachedPlan
    ? planSkeleton(cachedPlan, input.userMessage)
    : await composeSkeleton({
        llm,
        model,
        userText: turnTriage.turnText,
        log: (message) => ctx.log(message),
        skipModel: privacyForced,
        ...(privacyGuard !== undefined ? { privacy: openSkeletonPrivacy(privacyGuard) } : {}),
      });
  if (cachedPlan) ctx.log('[composition] skipped — answer-cache hit → plan skeleton');
  let surfaceSeq = 0;
  const initialRevision = '0' as RevisionId;
  const skeletonSnapshot: ChatStreamEvent = {
    type: 'surface_snapshot',
    canvasSessionId,
    surfaceSeq: surfaceSeq++,
    producesRevision: initialRevision,
    tree: skeleton.tree,
    protocolVersion: CANVAS_PROTOCOL_VERSION,
    opsCatalogVersion: OPS_CATALOG_VERSION,
  };
  yield skeletonSnapshot;

  // 2. Deterministic fast path — router said deterministic → the
  //    (speculative) plan is bound to the skeleton's ONE table container,
  //    its columns replacing the composer's → run it here, LLM-free, and
  //    finish the turn. Any miss → the agent path below, exactly as before.
  const fast = await settleFastPath(rt, input, canvasSessionId, gate, turnTriage, skeleton, surfaceSeq);
  if (fast.hit) {
    yield* fast.events;
    const prose = fast.prose;
    yield { type: 'text_delta', text: prose };
    // Recorded like any turn (session log → chat session → graph), so the
    // conversation the next turn continues contains it.
    const turnId = await recordCanvasTurn(ctx, input, prose, fast.toolCalls);
    yield {
      type: 'done',
      answer: prose,
      toolCalls: fast.toolCalls,
      iterations: 0,
      ...(turnId !== undefined ? { turnId } : {}),
    };
    ctx.log(
      `[ui-orchestrator] fast-path hit tool=${fast.tool} rows=${fast.rows} ` +
        `ms=${Date.now() - turnStartedAt}`,
    );
    ctx.log(`[fast-path] hit channel=canvas tool=${fast.tool} rows=${fast.rows} ms=${Date.now() - turnStartedAt}`);
    return;
  }
  ctx.log(`[ui-orchestrator] fast-path miss reason=${fast.reason}`);
  if (fp !== undefined) ctx.log(`[fast-path] miss channel=canvas reason=${fast.reason}`);

  yield* delegateSkeletonTurn(rt, input, observer, base, canvasSessionId, gate, blocks, {
    skeleton,
    surfaceSeq,
    initialRevision,
  });
}

/** Router ∥ speculative planner, started BEFORE the composer: the offered
 *  learned plans, this turn's plannable tools, an action turn's target
 *  record, the triage question and the in-flight triage promise. */
function startTriage(
  rt: CanvasRuntime,
  input: ChatTurnInput,
  canvasSessionId: string,
  base: ChatAgent,
  gate: CanvasTurnGate,
) {
  const { ctx, llm, model, refreshRecipes } = rt;
  const { privacyGuard, privacyForced, fp, permittedTools } = gate;
  const offered =
    fp !== undefined &&
    !privacyForced &&
    input.action === undefined &&
    input.target === undefined &&
    input.userMessage.trim().length > 0
      ? fp.plans
          .rank(input.userMessage, COMPOSER_TOP_K * 2)
          .map((s) => s.plan)
          .filter((p) => permittedTools.has(p.tool))
          .slice(0, COMPOSER_TOP_K)
      : [];
  // catalog specs + a generic spec for every read tool the base agent
  // offers (its own definitions; @omadia/fast-path genericToolSpecs.ts)
  const turnTools =
    fp !== undefined
      ? offeredTools(
          fp.plannableTools(base.offeredToolDefinitions?.()).filter((t) => permittedTools.has(t.name)),
          offered,
        )
      : [];
  // An action/row-bound turn ("Details" on a row): with the row's record
  // identity known from its table's recipe, the composer may plan ONE
  // deterministic detail query for exactly that record.
  const target =
    fp !== undefined && !privacyForced && (input.action !== undefined || input.target !== undefined)
      ? resolveTargetRecord(refreshRecipes, input, canvasSessionId)
      : undefined;
  const turnText =
    (input.userMessage.trim().length > 0
      ? input.userMessage
      : `UI action: ${JSON.stringify(input.action ?? {})}`) +
    (target !== undefined && turnTools.length > 0 ? targetRecordBlock(target) : '');
  const fastPathKey = `canvas:${canvasSessionId}`;
  const previousQuery = fp?.previousQuery(fastPathKey);
  // router ∥ speculative planner (@omadia/fast-path triageTurn.ts) — started
  // BEFORE the composer, so all three run concurrently. They share ONE
  // privacy run: the user-derived turn message is masked once and the
  // plan restored through it; the composer has its own run.
  const fastPrivacy = privacyGuard !== undefined ? openSkeletonPrivacy(privacyGuard) : undefined;
  // zero-LLM answer cache: only a plain text turn (its question IS the
  // user's text) — never an action/row-bound turn
  const plainTurn = input.action === undefined && input.target === undefined && input.userMessage.trim().length > 0;
  const answerCache = plainTurn ? fp?.answerCache : undefined;
  let tellVerdict: ((hit: boolean) => void) | undefined;
  const cacheVerdict = answerCache
    ? new Promise<boolean>((resolve) => {
        tellVerdict = resolve;
      })
    : undefined;
  const triage: Promise<TriageOutcome> | undefined =
    fp !== undefined && !privacyForced && turnTools.length > 0
      ? triageTurn({
          llm,
          model,
          channel: 'canvas',
          question: turnText,
          tools: turnTools,
          offered,
          allowedTools: fp.allowedFetchTools(),
          ...(previousQuery ? { previous: previousQuery } : {}),
          ...(fastPrivacy ? { privacy: fastPrivacy } : {}),
          ...(answerCache ? { answerCache, onCacheLookup: (hit: boolean) => tellVerdict?.(hit) } : {}),
          log: (m) => ctx.log(m),
        })
      : undefined;
  if (triage === undefined) tellVerdict?.(false); // no triage → no lookup
  return { offered, turnTools, target, turnText, fastPathKey, triage, cacheVerdict };
}

/** Await the triage, bind its plan to the skeleton and run the fast path;
 *  records the fetch outcome (learned-plan bookkeeping) either way. */
async function settleFastPath(
  rt: CanvasRuntime,
  input: ChatTurnInput,
  canvasSessionId: string,
  gate: CanvasTurnGate,
  turnTriage: TurnTriage,
  skeleton: SkeletonResult,
  surfaceSeq: number,
): Promise<FastPathOutcome> {
  const { ctx } = rt;
  const { privacyForced, fp, permittedTools } = gate;
  const { offered, turnTools, target, turnText, fastPathKey, triage } = turnTriage;
  const triaged = triage !== undefined ? await triage : undefined;
  let planned: PlannedSkeleton = skeleton;
  let planMiss: string | undefined;
  if (triaged?.kind === 'agent') {
    planMiss = triaged.reason;
  } else if (triaged?.kind === 'plan') {
    const bound = bindPlanToSkeleton(skeleton, triaged.plan);
    if (bound.ok) planned = bound.skeleton;
    else planMiss = bound.reason;
  }
  let fast: FastPathOutcome =
    planMiss !== undefined
      ? { hit: false, reason: planMiss }
      : await runFastPath(rt, input, canvasSessionId, planned, privacyForced, surfaceSeq, {
          plannable: turnTools.length,
          allowed: fp?.allowedFetchTools() ?? new Set<string>(),
          permitted: permittedTools,
        }, target);
  // answer cache: a slot-filled cached plan with no rows is a doubt (agent
  // path); the plan's execution — not a skeleton binding miss — is booked
  if (triaged?.kind === 'plan' && fast.hit && isCacheDoubt(triaged, fast.rows)) {
    fast = { hit: false, reason: CACHE_DOUBT_REASON };
  }
  if (triaged !== undefined && planMiss === undefined) {
    fp?.settleTriage(triaged, fast.hit ? { ok: true } : { ok: false, reason: fast.reason });
  }
  const fetches = planned.dataRequirements.flatMap((r) => (r.fetch ? [r.fetch] : []));
  if (fast.hit && fetches[0] !== undefined) {
    fp?.rememberQuery(fastPathKey, { question: turnText, fetch: fetches[0] });
  }
  const learnedIds = fast.hit
    ? (fp?.recordFetchOutcome(fetches, true) ?? [])
    : (fp?.recordFetchOutcome(fast.failedFetch ? [fast.failedFetch] : [], false, fast.reason) ?? []);
  if (fast.hit && learnedIds.length > 0) {
    ctx.log(`[ui-orchestrator] learned-plan hit plan=${learnedIds.join(',')} path=new-canvas`);
  } else if (!fast.hit && offered.length > 0) {
    ctx.log(
      `[ui-orchestrator] learned-plan miss reason=${fast.reason} path=new-canvas offered=${offered.length}` +
        (learnedIds.length > 0 ? ` plan=${learnedIds.join(',')}` : ''),
    );
  }
  return fast;
}

/** Steps 3+4 — the agent turn behind the already-visible skeleton. */
function delegateSkeletonTurn(
  rt: CanvasRuntime,
  input: ChatTurnInput,
  observer: Parameters<ChatAgent['chatStream']>[1],
  base: ChatAgent,
  canvasSessionId: string,
  gate: CanvasTurnGate,
  blocks: CanvasTurnBlocks,
  /** the skeleton already on screen and the seq/revision it went out at */
  shown: { skeleton: SkeletonResult; surfaceSeq: number; initialRevision: RevisionId },
): AsyncGenerator<ChatStreamEvent> {
  const { ctx, canvasOutputTools, captureSource, deriveSource, registerVariants, makeLearner } = rt;
  const { privacyForced, fp } = gate;
  const { actionBlock, targetBlock } = blocks;
  const { skeleton, surfaceSeq, initialRevision } = shown;
  // 3. Requirement handoff — the main turn carries what the skeleton
  //    promised, so Tier 3 returns payloads matching those exact fields.
  //    Only the request-derived part rides in the (masked) user message;
  //    the fixed protocol directive goes to the system prompt. The
  //    composer's `fetch` plans are internal and stay out.
  const augmented: ChatTurnInput = {
    ...input,
    userMessage:
      input.userMessage +
      actionBlock +
      targetBlock +
      '\n\n[canvas-context]\n' +
      JSON.stringify({
        canvasSkeleton: { revision: initialRevision, source: skeleton.source },
        dataRequirements: skeleton.dataRequirements.map(({ fetch: _fetch, ...req }) => req),
      }),
    fixedSystemHint: CANVAS_TURN_DIRECTIVE,
  };

  // 4. Delegate + canvas-aware synthesis continuing seq/revision after the
  //    skeleton. The learner watches the turn and, on a clean `done`,
  //    records the ONE read query behind the published rows as a candidate.
  const learner = makeLearner(fp, input, skeleton.dataRequirements, privacyForced);
  const synthesized = synthesizeSurfaceEvents(base.chatStream(augmented, observer), {
    canvasSessionId,
    authorizedToolNames: canvasOutputTools,
    protocolVersion: CANVAS_PROTOCOL_VERSION,
    opsCatalogVersion: OPS_CATALOG_VERSION,
    startSurfaceSeq: surfaceSeq,
    baseRevision: initialRevision,
    baseTree: skeleton.tree,
    dataRequirements: skeleton.dataRequirements,
    onPublishedSource: captureSource(canvasSessionId),
    deriveSource,
    onPublishedActions: registerVariants(canvasSessionId),
    ...(learner ? { onPublishedPayload: (d: unknown) => learner.onPublishedPayload(d) } : {}),
    takeRawSentinel: tapCanvasSentinels((m) => ctx.log(m)),
    log: (message) => ctx.log(message),
  });
  const turn = learner ? learner.tap(synthesized) : synthesized;
  // A held (verifier-enforce) turn that ends withheld or failed replaces
  // the already-visible skeleton, so no loading placeholder is orphaned.
  return base.holdsContentUntilVerdict === true
    ? replaceSkeletonOnWithheld(turn, {
        canvasSessionId,
        protocolVersion: CANVAS_PROTOCOL_VERSION,
        opsCatalogVersion: OPS_CATALOG_VERSION,
        lastSurfaceSeq: surfaceSeq - 1,
        lastRevision: initialRevision,
      })
    : turn;
}
