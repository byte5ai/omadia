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
  VerifierBadge,
  VerifierPipeline,
  VerifierStore,
  VerifierVerdict,
} from '@omadia/verifier';
import { buildCorrectionPrompt, isBorderlineVerdict } from '@omadia/verifier';

/**
 * End-to-end wrapper around the orchestrator that adds answer verification.
 *
 *   user turn → orchestrator.chat → verifier.verify
 *                                   ├─ approved              → return
 *                                   ├─ approved_with_disclaimer → return + disclaimer badge
 *                                   └─ blocked (enforce only)
 *                                        → inject correction into system hint
 *                                        → orchestrator.chat (retry, max 1x)
 *                                        → verify again
 *                                        → return (badge = corrected | failed)
 *
 * In shadow mode the verifier runs + persists but never blocks / retries.
 * That's how we calibrate the trigger router and extractor in production
 * without risking UX regressions.
 *
 * Errors in the verifier itself never surface to the user — we always fall
 * back to returning the original orchestrator reply. The failure mode the
 * user experiences is "verifier didn't help", not "verifier broke my bot".
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
   * #132 — when the first verdict is borderline (`approved_with_disclaimer`,
   * i.e. no contradictions but at least one unverified claim), draw a
   * second sample from the same orchestrator turn and merge the two
   * verdicts. Default true.
   *
   * Cost note: each enabled re-sample doubles the LLM cost of a turn that
   * already cleared verification with "almost". `maxResamples` caps the
   * blast radius (hard 1 today). Disable for cost-sensitive deployments.
   */
  resampleOnBorderline?: boolean;
  /** Hard cap on borderline re-samples per turn. Default 1. */
  maxResamples?: number;
  log?: (msg: string) => void;
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
      }
    }

    if (doneAnswer === undefined || skipVerification) return;

    const verdict = await this.safeVerify(
      runId,
      input,
      doneAnswer,
      doneRunTrace,
    );
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

    // #132 — borderline gate: when the first verdict is
    // `approved_with_disclaimer` (no contradictions but unverified claims),
    // draw a second sample from the same orchestrator turn. Two independent
    // samples landing on the same disclaimer ⇒ keep. Disagreement ⇒ take
    // the more conservative reading (blocked wins). Bounded at
    // `maxResamples` per turn (default 1) so cost stays predictable.
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

    // Compute the user-facing badge: `corrected` when retry fixed it,
    // `failed` when it did not.
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
      return {
        status: 'approved',
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
  const contradictionCount =
    verdict.status === 'blocked' ? verdict.contradictions.length : 0;
  const unverifiedCount =
    verdict.status === 'approved_with_disclaimer'
      ? verdict.unverified.length
      : verdict.claims.filter((v) => v.status === 'unverified').length;

  return {
    badge: badgeFor(verdict, retryCount),
    status: verdict.status,
    claimCount: verdict.claims.length,
    contradictionCount,
    unverifiedCount,
    retryCount,
    latencyMs: verdict.latencyMs,
    mode,
  };
}

function badgeFor(
  verdict: VerifierVerdict,
  retryCount: number,
): VerifierBadge {
  if (retryCount > 0) {
    // Retry already happened — outcome defines badge.
    return verdict.status === 'blocked' ? 'failed' : 'corrected';
  }
  switch (verdict.status) {
    case 'approved':
      return 'verified';
    case 'approved_with_disclaimer':
      return 'partial';
    case 'blocked':
      return 'failed';
  }
}

function mergeBadges(
  first: VerifierVerdict,
  second: VerifierVerdict,
): VerifierBadge {
  if (first.status === 'blocked' && second.status !== 'blocked') return 'corrected';
  if (first.status === 'blocked' && second.status === 'blocked') return 'failed';
  return badgeFor(second, 1);
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
 * 4. Second sample also borderline (fell back to safeVerify's
 *    `approved` fallback after a pipeline error) → keep first.
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
  // Anything else (approved, approved_with_disclaimer): trust the first
  // sample's disclaimer signal.
  return { verdict: first, takeSecond: false };
}
