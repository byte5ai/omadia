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
import { buildCorrectionPrompt } from '@omadia/verifier';

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
  log?: (msg: string) => void;
}

const DEFAULTS = {
  maxRetries: 1,
};

export class VerifierService implements ChatAgent {
  private readonly orchestrator: Orchestrator;
  private readonly pipeline: VerifierPipeline;
  private readonly store?: VerifierStore;
  private readonly enabled: boolean;
  private readonly mode: 'shadow' | 'enforce';
  private readonly maxRetries: number;
  private readonly log: (msg: string) => void;

  constructor(opts: VerifierServiceOptions) {
    this.orchestrator = opts.orchestrator;
    this.pipeline = opts.pipeline;
    if (opts.store) this.store = opts.store;
    this.enabled = opts.enabled;
    this.mode = opts.mode;
    this.maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
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

    // Enforce mode: only contradictions trigger a retry. `unverified` flows
    // through with the disclaimer badge — the router already caught enough
    // to make the user aware.
    if (firstVerdict.status !== 'blocked' || this.maxRetries <= 0) {
      void this.persist(runId, input, firstVerdict, 0);
      return toSemanticAnswer(
        withVerifier(firstResult, summarise(firstVerdict, 0, this.mode)),
      );
    }

    const correction = buildCorrectionPrompt(firstVerdict);
    if (!correction) {
      // Shouldn't happen for status=blocked, but be defensive.
      void this.persist(runId, input, firstVerdict, 0);
      return toSemanticAnswer(
        withVerifier(firstResult, summarise(firstVerdict, 0, this.mode)),
      );
    }

    this.log(
      `[verifier/service] retry run=${runId} contradictions=${String(
        firstVerdict.contradictions.length,
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
      void this.persist(runId, input, firstVerdict, 0);
      return toSemanticAnswer(
        withVerifier(firstResult, summarise(firstVerdict, 0, this.mode)),
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
    const badge = mergeBadges(firstVerdict, secondVerdict);
    return toSemanticAnswer(
      withVerifier(secondResult, {
        ...summarise(secondVerdict, 1, this.mode),
        badge,
      }),
    );
  }

  // ------------------------------------------------------------------

  private async safeVerify(
    runId: string,
    input: ChatTurnInput,
    answer: string,
    runTrace: RunTracePayload | undefined,
  ): Promise<VerifierVerdict> {
    const domainToolsCalled = extractToolsCalled(runTrace);
    try {
      return await this.pipeline.verify({
        runId,
        userMessage: input.userMessage,
        answer,
        ...(domainToolsCalled ? { domainToolsCalled } : {}),
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
