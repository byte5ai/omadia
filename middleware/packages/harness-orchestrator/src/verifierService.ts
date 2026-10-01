import type {
  ChatAgent,
  ChatStreamEvent,
  ChatTurnInput,
  ChatTurnResult,
  Orchestrator,
  VerifierResultSummary,
} from './orchestrator.js';
import { toSemanticAnswer } from './orchestrator.js';
import { randomUUID } from 'node:crypto';
import type { SemanticAnswer } from '@omadia/channel-sdk';
import type { RunTracePayload } from './runTraceCollector.js';
import type {
  ClaimVerdict,
  VerifierBadge,
  VerifierPipeline,
  VerifierStore,
  VerifierVerdict,
} from '@omadia/verifier';
import {
  buildCorrectionPrompt,
  hasVerificationEvidence,
  isBorderlineVerdict,
} from '@omadia/verifier';
import type { TurnHookRunner } from './turnHooks.js';

/**
 * End-to-end wrapper around the orchestrator that adds answer verification.
 *
 *   user turn → orchestrator.chat → verifier.verify
 *                                   ├─ approved              → return
 *                                   ├─ approved_with_disclaimer → return + disclaimer badge
 *                                   │    (no badge when no claim was confirmed)
 *                                   ├─ skipped / unavailable → return, no badge
 *                                   └─ blocked (enforce only)
 *                                        → inject correction into system hint
 *                                        → orchestrator.chat (retry, max 1x)
 *                                        → verify again
 *                                        → return (badge = corrected when the
 *                                          retry confirmed every claim, partial
 *                                          when only some, failed when still
 *                                          contradicted, no badge when it
 *                                          confirmed nothing)
 *
 * In shadow mode the verifier runs + persists but never blocks / retries.
 * That's how we calibrate the trigger router and extractor in production
 * without risking UX regressions.
 *
 * Errors in the verifier itself never block the user — we always fall back
 * to returning the original orchestrator reply. They surface as
 * `unavailable`, never as `approved`: "the verifier could not check" must
 * not read as "the verifier checked and found nothing wrong".
 */

export interface VerifierServiceOptions {
  orchestrator: Orchestrator;
  pipeline: VerifierPipeline;
  store?: VerifierStore;
  enabled: boolean;
  mode: 'shadow' | 'enforce';
  /** Hard cap on retries after a contradiction. Default 1. */
  maxRetries?: number;
  /**
   * #132 — when the first verdict is borderline (`isBorderlineVerdict`: no
   * contradictions, at least one claim confirmed and one a check could not
   * confirm), draw a second sample from the same orchestrator turn and merge
   * the two verdicts. Default true.
   *
   * Cost note: each enabled re-sample doubles the LLM cost of a turn that
   * already cleared verification with "almost". `maxResamples` caps the
   * blast radius (hard 1 today). Disable for cost-sensitive deployments.
   */
  resampleOnBorderline?: boolean;
  /** Hard cap on borderline re-samples per turn. Default 1. */
  maxResamples?: number;
  log?: (msg: string) => void;
  /** #133 (E6) — when set, a `blocked` verdict fires the `onVerifierBlocked`
   *  turn-hook so the plan-runner can record the rejection on the turn's plan.
   *  Fire-and-forget; never gates the response. */
  turnHookRegistry?: TurnHookRunner;
}

const DEFAULTS = {
  maxRetries: 1,
  resampleOnBorderline: true,
  maxResamples: 1,
};

export class VerifierService implements ChatAgent {
  private readonly orchestrator: Orchestrator;
  private readonly pipeline: VerifierPipeline;
  private readonly store?: VerifierStore;
  private readonly enabled: boolean;
  private readonly mode: 'shadow' | 'enforce';
  private readonly maxRetries: number;
  private readonly resampleOnBorderline: boolean;
  private readonly maxResamples: number;
  private readonly log: (msg: string) => void;
  private readonly turnHookRegistry: TurnHookRunner | undefined;

  constructor(opts: VerifierServiceOptions) {
    this.orchestrator = opts.orchestrator;
    this.pipeline = opts.pipeline;
    if (opts.store) this.store = opts.store;
    this.enabled = opts.enabled;
    this.mode = opts.mode;
    this.maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
    this.resampleOnBorderline =
      opts.resampleOnBorderline ?? DEFAULTS.resampleOnBorderline;
    this.maxResamples = opts.maxResamples ?? DEFAULTS.maxResamples;
    this.log =
      opts.log ??
      ((msg: string): void => {
        console.error(msg);
      });
    this.turnHookRegistry = opts.turnHookRegistry;
  }

  /**
   * #133 (E6) — fire-and-forget signal that this turn's answer was
   * verifier-blocked. Keyed by session scope (the plan-runner looks up the
   * scope's latest plan). Never throws, never blocks the response.
   */
  private fireVerifierBlocked(
    input: ChatTurnInput,
    verdict: VerifierVerdict,
  ): void {
    const reg = this.turnHookRegistry;
    const scope = input.sessionScope;
    if (!reg || !scope) return;
    const contradictions = (verdict as { contradictions?: unknown[] })
      .contradictions;
    const n = Array.isArray(contradictions) ? contradictions.length : 0;
    const reason = `verifier blocked (${String(n)} contradiction${
      n === 1 ? '' : 's'
    })`;
    void reg
      .run(
        'onVerifierBlocked',
        {
          turnId: scope,
          sessionScope: scope,
          ...(input.userId ? { userId: input.userId } : {}),
          // Per-orchestrator isolation: same Agent slug the orchestrator
          // stamps on its hooks, so the plan-runner qualifies the scope
          // identically and finds this Agent's plan.
          agentSlug: this.orchestrator.agentId,
        },
        { blockReason: reason },
      )
      .catch(() => undefined);
  }

  /**
   * Stream wrapper: proxies every event from the underlying orchestrator
   * unchanged, then — after the base `done` event — runs the verifier on
   * the completed answer and emits ONE additional `verifier` event. The
   * client can render a badge or stay silent; the orchestrator's answer
   * stream is not rewritten mid-flight.
   *
   * Note on enforce mode: we intentionally DO NOT retry on the stream
   * path. The user has already seen the tokens as they were generated;
   * replacing the answer after the fact would be a worse UX than a
   * clearly labelled "verifier-widerspruch" badge. Retries remain the
   * non-stream (`/api/chat`) endpoint's territory.
   */
  async *chatStream(input: ChatTurnInput): AsyncGenerator<ChatStreamEvent> {
    if (!this.enabled) {
      yield* this.orchestrator.chatStream(input);
      return;
    }

    const runId = randomUUID();
    let doneAnswer: string | undefined;
    let doneRunTrace: RunTracePayload | undefined;
    let skipVerification = false;

    for await (const event of this.orchestrator.chatStream(input)) {
      yield event;
      if (event.type === 'done') {
        doneAnswer = event.answer;
        doneRunTrace = event.runTrace;
        // The turn ended with a clarification-request card — there are no
        // fact claims to verify. Suppress the verifier pass entirely so the
        // Smart-Card doesn't get adorned with a stray badge.
        if (event.pendingUserChoice) skipVerification = true;
        // #1094 — same reasoning for a degraded turn: its `answer` is the
        // composed turn-incomplete notice (or a server-rendered v4 answer),
        // not model prose, so there is nothing to fact-check. Without this the
        // verifier would stamp a "verified" badge onto a turn that failed.
        if (event.degraded) skipVerification = true;
      }
    }

    if (doneAnswer === undefined || skipVerification) return;

    const verdict = await this.safeVerify(
      runId,
      input,
      doneAnswer,
      doneRunTrace,
    );
    // #133 (E6) — record a verifier block on this turn's plan, same as the
    // non-streaming enforce path. The stream path still does NOT retry (see the
    // method doc — the user already saw the tokens); this only surfaces the
    // rejection on the plan DAG. Shadow mode never blocks, so it never records.
    if (this.mode !== 'shadow' && verdict.status === 'blocked') {
      this.fireVerifierBlocked(input, verdict);
    }
    void this.persist(runId, input, verdict, 0);
    yield {
      type: 'verifier',
      summary: summarise(verdict, 0, this.mode),
    };
  }

  /** Drop-in replacement for `orchestrator.chat` with verification. */
  async chat(input: ChatTurnInput): Promise<SemanticAnswer> {
    if (!this.enabled) {
      return this.orchestrator.chat(input);
    }

    const runId = randomUUID();
    // Use `runTurn()` (full internal shape) rather than `chat()` — we need
    // access to `runTrace` for the verifier pipeline's evidence fetcher.
    const firstResult = await this.orchestrator.runTurn(input);
    // Clarification-request turns have no fact claims — skip verification.
    // The Smart-Card UX is the "answer" here; there is nothing to check.
    if (firstResult.pendingUserChoice) {
      return toSemanticAnswer(firstResult);
    }
    const firstVerdict = await this.safeVerify(
      runId,
      input,
      firstResult.answer,
      firstResult.runTrace,
    );

    // Shadow mode: persist + summarise, never retry / block.
    if (this.mode === 'shadow') {
      void this.persist(runId, input, firstVerdict, 0);
      return toSemanticAnswer(
        withVerifier(firstResult, summarise(firstVerdict, 0, this.mode)),
      );
    }

    // #132 — borderline gate: when the first verdict confirmed claims but
    // could not confirm another one it checked (`isBorderlineVerdict`), draw
    // a second sample from the same orchestrator turn. Two independent
    // samples landing on the same disclaimer ⇒ keep. Disagreement ⇒ take
    // the more conservative reading (blocked wins). Bounded at
    // `maxResamples` per turn (default 1) so cost stays predictable.
    // `skipped` / `unavailable`, a disclaimer that confirmed nothing, and one
    // whose doubt is only claims no checker takes must never trigger this
    // paid resample: a second sample cannot add evidence there, and
    // otherwise every small-talk turn would run twice.
    let effectiveResult = firstResult;
    let effectiveVerdict = firstVerdict;
    if (
      this.resampleOnBorderline &&
      this.maxResamples > 0 &&
      isBorderlineVerdict(firstVerdict)
    ) {
      const merged = await this.tryResample(runId, input, firstVerdict);
      if (merged) {
        effectiveResult = merged.result ?? firstResult;
        effectiveVerdict = merged.verdict;
      }
    }

    // Enforce mode: only contradictions trigger a retry. `unverified` flows
    // through with the disclaimer badge — the router already caught enough
    // to make the user aware.
    if (effectiveVerdict.status === 'blocked') {
      this.fireVerifierBlocked(input, effectiveVerdict);
    }
    if (effectiveVerdict.status !== 'blocked' || this.maxRetries <= 0) {
      void this.persist(runId, input, effectiveVerdict, 0);
      return toSemanticAnswer(
        withVerifier(
          effectiveResult,
          summarise(effectiveVerdict, 0, this.mode),
        ),
      );
    }

    const correction = buildCorrectionPrompt(effectiveVerdict);
    if (!correction) {
      // Shouldn't happen for status=blocked, but be defensive.
      void this.persist(runId, input, effectiveVerdict, 0);
      return toSemanticAnswer(
        withVerifier(
          effectiveResult,
          summarise(effectiveVerdict, 0, this.mode),
        ),
      );
    }

    this.log(
      `[verifier/service] retry run=${runId} contradictions=${String(
        effectiveVerdict.contradictions.length,
      )}`,
    );
    const retryInput: ChatTurnInput = {
      ...input,
      extraSystemHint: correction,
    };
    let secondResult: ChatTurnResult;
    try {
      // #579 — a correction retry re-runs an already-screened user turn; mark it
      // so the inbound screening gate does not screen/audit it a second time.
      this.orchestrator.markScreeningReentry(retryInput);
      secondResult = await this.orchestrator.runTurn(retryInput);
    } catch (err) {
      this.log(`[verifier/service] retry FAIL: ${errMsg(err)}`);
      void this.persist(runId, input, effectiveVerdict, 0);
      return toSemanticAnswer(
        withVerifier(
          effectiveResult,
          summarise(effectiveVerdict, 0, this.mode),
        ),
      );
    }

    const secondVerdict = await this.safeVerify(
      runId,
      input,
      secondResult.answer,
      secondResult.runTrace,
    );

    // Merge: persist ONE row with the final retry count; contradictions table
    // reflects whichever verdict actually tripped. We log both for telemetry.
    void this.persist(runId, input, secondVerdict, 1);

    // Compute the user-facing badge: `corrected` when the retry confirmed
    // every claim, `partial` when it confirmed only some, `failed` when it is
    // still contradicted, `unverified` / `unavailable` (no connector badge)
    // when the retry's verification confirmed nothing.
    const badge = mergeBadges(effectiveVerdict, secondVerdict);
    return toSemanticAnswer(
      withVerifier(secondResult, {
        ...summarise(secondVerdict, 1, this.mode),
        badge,
      }),
    );
  }

  /**
   * #132 — borderline re-sample: re-run the same turn against the
   * orchestrator and merge the two verdicts. Failure to re-run (anything
   * thrown by the orchestrator, or a clarification-card result that has
   * no fact claims) returns `undefined` and the caller keeps `firstVerdict`
   * as the effective verdict — re-sampling is best-effort.
   *
   * Returns `{ verdict, result }` where `result` is the second sample's
   * orchestrator result iff the merge decided to keep it; `undefined`
   * means "keep firstResult". The caller plugs both straight into the
   * existing persist + correction-retry path.
   */
  private async tryResample(
    runId: string,
    input: ChatTurnInput,
    firstVerdict: VerifierVerdict,
  ): Promise<{
    verdict: VerifierVerdict;
    result?: ChatTurnResult;
  } | undefined> {
    this.log(`[verifier/service] borderline resample run=${runId}`);
    let secondResult: ChatTurnResult;
    try {
      // #579 — a borderline resample re-runs the same already-screened user
      // turn; mark it so the inbound gate skips a redundant screen + audit.
      this.orchestrator.markScreeningReentry(input);
      secondResult = await this.orchestrator.runTurn(input);
    } catch (err) {
      this.log(`[verifier/service] resample FAIL: ${errMsg(err)}`);
      return undefined;
    }
    if (secondResult.pendingUserChoice) {
      // Second sample punted to a clarification card — keep the first
      // verdict, the user-facing answer didn't change.
      return undefined;
    }
    const secondVerdict = await this.safeVerify(
      runId,
      input,
      secondResult.answer,
      secondResult.runTrace,
    );
    const merged = mergeBorderlineVerdicts(firstVerdict, secondVerdict);
    this.log(
      `[verifier/service] resample merge run=${runId} first=${firstVerdict.status} second=${secondVerdict.status} → ${merged.verdict.status}${
        merged.takeSecond ? ' (takeSecond)' : ''
      }`,
    );
    return {
      verdict: merged.verdict,
      ...(merged.takeSecond ? { result: secondResult } : {}),
    };
  }

  // ------------------------------------------------------------------

  private async safeVerify(
    runId: string,
    input: ChatTurnInput,
    answer: string,
    runTrace: RunTracePayload | undefined,
  ): Promise<VerifierVerdict> {
    const domainToolsCalled = extractToolsCalled(runTrace);
    const toolPostconditionViolations = extractPostconditionViolations(runTrace);
    const knowledgeGraphToolsCalled = extractKnowledgeGraphToolsCalled(runTrace);
    try {
      return await this.pipeline.verify({
        runId,
        userMessage: input.userMessage,
        answer,
        ...(domainToolsCalled ? { domainToolsCalled } : {}),
        ...(toolPostconditionViolations.length > 0
          ? { toolPostconditionViolations }
          : {}),
        ...(knowledgeGraphToolsCalled !== undefined
          ? { knowledgeGraphToolsCalled }
          : {}),
      });
    } catch (err) {
      this.log(`[verifier/service] pipeline FAIL: ${errMsg(err)}`);
      // Nothing was checked. The reason is a closed code: this verdict is
      // summarised onto the stream, the message stays in the log line above.
      return {
        status: 'unavailable',
        reason: 'pipeline_error',
        claims: [],
        latencyMs: 0,
      };
    }
  }

  private async persist(
    runId: string,
    input: ChatTurnInput,
    verdict: VerifierVerdict,
    retryCount: number,
  ): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.persist({
        input: {
          runId,
          userMessage: input.userMessage,
          answer: '', // intentionally omitted — no PII beyond what's already
          // captured in session_logger/graph. The store only uses `runId`.
        },
        verdict,
        mode: this.mode,
        retryCount,
      });
    } catch (err) {
      this.log(`[verifier/service] persist FAIL: ${errMsg(err)}`);
    }
  }
}

// --- helpers --------------------------------------------------------------

function withVerifier(
  result: ChatTurnResult,
  verifier: VerifierResultSummary,
): ChatTurnResult {
  return { ...result, verifier };
}

function summarise(
  verdict: VerifierVerdict,
  retryCount: number,
  mode: 'shadow' | 'enforce',
): VerifierResultSummary {
  // Counted over the claim list itself, so `claimCount - contradictionCount
  // - unverifiedCount` is exactly the number of verified claims — the figure
  // the connector and web-chat badge gates check the badge against.
  const count = (pick: (c: ClaimVerdict) => boolean): number =>
    verdict.claims.filter(pick).length;

  return {
    badge: badgeFor(verdict, retryCount),
    status: verdict.status,
    ...(verdict.status === 'skipped' || verdict.status === 'unavailable'
      ? { reason: verdict.reason }
      : {}),
    claimCount: verdict.claims.length,
    contradictionCount: count((c) => c.status === 'contradicted'),
    unverifiedCount: count((c) => c.status === 'unverified'),
    uncheckedCount: count((c) => c.status === 'unverified' && c.cause === 'not_checked'),
    uncoveredCount: count((c) => c.claim.type === 'coverage_gap'),
    retryCount,
    latencyMs: verdict.latencyMs,
    mode,
  };
}

/**
 * Badge for one verdict, bound to evidence (`hasVerificationEvidence`: a
 * check settled at least one claim). Without that the badge is `unavailable`
 * when the verifier could not run or every check that ran failed, and
 * `unverified` otherwise — whatever status the verdict carries. The pipeline
 * is injected, so this reads the claims, not the status. With evidence:
 * `failed` for any contradicted claim, `verified` only when every claim was
 * confirmed, `partial` when some were not. After a retry, `corrected` takes
 * the place of `verified` and needs the same: every claim confirmed. A retry
 * that confirmed only some claims is `partial`, as on a first pass.
 */
export function badgeFor(
  verdict: VerifierVerdict,
  retryCount: number,
): VerifierBadge {
  if (!hasVerificationEvidence(verdict)) {
    return verdict.status === 'unavailable' || everyCheckFailed(verdict)
      ? 'unavailable'
      : 'unverified';
  }
  if (verdict.claims.some((c) => c.status === 'contradicted')) return 'failed';
  const everyClaimConfirmed =
    verdict.status === 'approved' &&
    verdict.claims.every((c) => c.status === 'verified');
  if (!everyClaimConfirmed) return 'partial';
  return retryCount > 0 ? 'corrected' : 'verified';
}

/** True when a check ran on at least one claim and every such check failed.
 *  Claims no check ran on (`not_checked`, including coverage entries) do not
 *  count either way. */
function everyCheckFailed(verdict: VerifierVerdict): boolean {
  const checked = verdict.claims.filter(
    (c) => !(c.status === 'unverified' && c.cause === 'not_checked'),
  );
  return (
    checked.length > 0 &&
    checked.every((c) => c.status === 'unverified' && c.cause === 'check_failed')
  );
}

/**
 * Badge after the correction retry. `corrected` / `failed` describe a retry
 * that followed a blocked first pass, and the retry's own verdict decides:
 * `corrected` needs a second pass that confirmed every claim; one that
 * confirmed only some is `partial`. A retry whose verification was skipped,
 * unavailable or confirmed nothing is never `corrected`.
 */
export function mergeBadges(
  first: VerifierVerdict,
  second: VerifierVerdict,
): VerifierBadge {
  return badgeFor(second, first.status === 'blocked' ? 1 : 0);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Flatten a RunTrace into the list of tool / sub-agent names invoked in
 * this turn. Used by the pipeline's trace-cross-check rule to spot
 * accounting/HR numeric claims that arrived WITHOUT a fresh fach-agent
 * call — i.e. the orchestrator replayed numbers from the context block.
 *
 * Returns `undefined` when no trace is available — the pipeline then
 * skips the check rather than treating "no evidence" as "no tool call".
 */
function extractToolsCalled(
  trace: RunTracePayload | undefined,
): string[] | undefined {
  if (!trace) return undefined;
  const names = new Set<string>();
  for (const invocation of trace.agentInvocations) {
    names.add(invocation.agentName);
    for (const call of invocation.toolCalls) {
      names.add(call.toolName);
    }
  }
  for (const call of trace.orchestratorToolCalls) {
    names.add(call.toolName);
  }
  return [...names];
}

/**
 * #131 — true when this turn invoked the knowledge-graph (or any of the
 * KG-backed sub-agent / orchestrator tools the verifier counts as
 * "fetched evidence"). The pipeline uses this as the gate for the
 * citation-missing check: no KG call ⇒ citations are irrelevant.
 */
function extractKnowledgeGraphToolsCalled(
  trace: RunTracePayload | undefined,
): boolean | undefined {
  if (!trace) return undefined;
  const KG_NAMES: ReadonlySet<string> = new Set(['query_knowledge_graph']);
  for (const call of trace.orchestratorToolCalls) {
    if (KG_NAMES.has(call.toolName)) return true;
  }
  for (const inv of trace.agentInvocations) {
    for (const call of inv.toolCalls) {
      if (KG_NAMES.has(call.toolName)) return true;
    }
  }
  return false;
}

/**
 * #130 — collect every postcondition violation the bridgeTool stamped onto
 * the runTrace. The verifier turns each entry into a synthetic
 * `tool_postcondition` ClaimVerdict (status='contradicted'), which flips the
 * verdict to `blocked` and drives the existing correctionPrompt retry loop.
 */
function extractPostconditionViolations(
  trace: RunTracePayload | undefined,
): {
  toolName: string;
  callId: string;
  agentContext: string;
  issues: readonly string[];
}[] {
  if (!trace) return [];
  const out: {
    toolName: string;
    callId: string;
    agentContext: string;
    issues: readonly string[];
  }[] = [];
  for (const invocation of trace.agentInvocations) {
    for (const call of invocation.toolCalls) {
      if (call.postcondition) {
        out.push({
          toolName: call.toolName,
          callId: call.callId,
          agentContext: call.agentContext,
          issues: call.postcondition.issues,
        });
      }
    }
  }
  for (const call of trace.orchestratorToolCalls) {
    if (call.postcondition) {
      out.push({
        toolName: call.toolName,
        callId: call.callId,
        agentContext: call.agentContext,
        issues: call.postcondition.issues,
      });
    }
  }
  return out;
}

/**
 * #132 — merge two verdicts when the first was borderline
 * (`approved_with_disclaimer`) and the second one was drawn from a re-run
 * of the same turn. Strategy:
 *
 * 1. Both agree on borderline → keep first (the two independent samples
 *    confirmed the same level of uncertainty; treat the disclaimer as
 *    earned signal, not noise).
 * 2. Second sample escalated to `blocked` → flip to second so the
 *    correctionPrompt retry can run on the contradictions the second
 *    sample exposed. Conservative bias.
 * 3. Second sample relaxed to `approved` → keep first. Two contradictory
 *    samples + one finding stuff we didn't is exactly the noise signal
 *    that the disclaimer exists to communicate; don't upgrade.
 * 4. Second sample checked nothing — `skipped`, or `unavailable` (safeVerify's
 *    result after a pipeline error) → keep first; it adds no signal.
 *
 * `takeSecond` is true only when we propagate the second sample's
 * orchestrator result onward (its answer string is what the LLM
 * generated for that verdict).
 */
export function mergeBorderlineVerdicts(
  first: VerifierVerdict,
  second: VerifierVerdict,
): { verdict: VerifierVerdict; takeSecond: boolean } {
  if (second.status === 'blocked') {
    return { verdict: second, takeSecond: true };
  }
  // Anything else (approved, approved_with_disclaimer, skipped,
  // unavailable): trust the first sample's disclaimer signal.
  return { verdict: first, takeSecond: false };
}
