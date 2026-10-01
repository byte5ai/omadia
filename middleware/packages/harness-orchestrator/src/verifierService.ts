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
import type { ChatStreamObserver, SemanticAnswer } from '@omadia/channel-sdk';
import type { RunTracePayload } from './runTraceCollector.js';
import type {
  VerifierPipeline,
  VerifierStore,
  VerifierVerdict,
} from '@omadia/verifier';
import {
  bindVerdictToClaims,
  buildCorrectionPrompt,
  isBorderlineVerdict,
} from '@omadia/verifier';
import type { TurnHookRunner } from './turnHooks.js';
import { fireVerifierBlockedHook } from './verifierBlockedHook.js';
import {
  enforcedVerifiedStream,
  mayVerifyAnswer,
  privacyShieldVerdict,
  releasesWithoutVerification,
  shadowVerifiedStream,
  verdictReleasesAnswer,
  withheldTurnResult,
} from './verifierDelivery.js';
import {
  extractKnowledgeGraphToolsCalled,
  extractPostconditionViolations,
  extractToolsCalled,
} from './verifierTraceEvidence.js';
import {
  mergeBadges,
  mergeBorderlineVerdicts,
  summarise,
  withVerifier,
} from './verifierVerdicts.js';

// Re-exported: tests and callers import these from this module.
export {
  badgeFor,
  mergeBadges,
  mergeBorderlineVerdicts,
} from './verifierVerdicts.js';

/**
 * End-to-end wrapper around the orchestrator that adds answer verification.
 *
 * `shadow` observes: the verifier runs and persists, the answer goes out
 * unchanged with the verdict as a badge. That is how the trigger router and
 * extractor are calibrated in production without touching delivery.
 *
 * `enforce` is a delivery gate. An answer is delivered only when its verdict
 * releases it — `approved`, or `skipped` because it holds nothing to check
 * (`verdictReleasesAnswer`); otherwise the user gets a localized notice that
 * the answer was withheld (`answerSource: 'verifier-blocked'`). It fails
 * closed: a verifier that could not run (`unavailable`) or claims it could
 * not confirm withhold the answer just like a contradiction, and so does an
 * answer Privacy Shield rendered server-side, which is never sent to the
 * pipeline (`mayVerifyAnswer`). On the stream no content leaves before the
 * verdict (`verifierDelivery.ts`); the non-streaming path first runs its
 * correction retry:
 *
 *   orchestrator.runTurn → verify → blocked → correction hint in the system
 *   prompt → runTurn (retry, maxRetries) → verify → deliver or withhold
 *
 * The stream path never retries — a retry re-runs the turn's tools.
 *
 * A failing verifier surfaces as `unavailable`, never as `approved`: "the
 * verifier could not check" must not read as "the verifier checked and found
 * nothing wrong". The pipeline is injected, so its verdict is held to what
 * its claims show (`bindVerdictToClaims`) before it is retried, resampled,
 * stored or streamed: a status its claims do not back, or a reason outside
 * the closed codes, never reaches `verifier_verdicts` or the stream.
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
  /**
   * Operator locale (the AI-disclosure setup's `locale`) for the notice that
   * replaces a withheld answer in `enforce` mode. A turn's own
   * `aiDisclosure.locale` wins; this covers turns without one (disclosure
   * set to `off`). Neither → German, like the turn-incomplete notice.
   */
  locale?: string;
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
  private readonly locale: string | undefined;

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
    this.locale = opts.locale;
  }

  /** `ChatAgent.holdsContentUntilVerdict`: true in `enforce`, so a wrapper
   *  holds content of its own (a canvas skeleton) until the verdict too. */
  get holdsContentUntilVerdict(): boolean {
    return this.enabled && this.mode === 'enforce';
  }

  /** #133 (E6) — record a verifier block on this turn's plan (`verifierBlockedHook.ts`). */
  private fireVerifierBlocked(input: ChatTurnInput, verdict: VerifierVerdict): void {
    fireVerifierBlockedHook(this.turnHookRegistry, this.orchestrator.agentId, input, verdict);
  }

  /**
   * Stream wrapper. `shadow` passes every event through as produced and
   * reports the verdict as one trailing `verifier` event; `enforce` holds
   * every content event until the verdict, releases an answer as the text
   * the verdict is about (never the raw deltas) and replaces one it does not
   * release with the withheld-answer notice (`verifierDelivery.ts`). The
   * route's observer (iteration, token and usage counters — no text) is
   * forwarded in every mode.
   *
   * The stream path never runs a correction retry, in either mode: a retry
   * re-runs the whole turn including its tool calls, and the stream has no
   * safeguard against repeating a tool call that already wrote something.
   * In `enforce` a blocked answer is withheld instead.
   */
  async *chatStream(
    input: ChatTurnInput,
    observer?: ChatStreamObserver,
  ): AsyncGenerator<ChatStreamEvent> {
    const base = this.orchestrator.chatStream(input, observer);
    if (!this.enabled) {
      yield* base;
      return;
    }
    const runId = randomUUID();
    if (this.mode === 'shadow') {
      yield* shadowVerifiedStream(base, async (done) => {
        const verdict = await this.safeVerify(runId, input, done.answer, done.runTrace);
        void this.persist(runId, input, verdict, 0);
        return summarise(verdict, 0, this.mode);
      });
      return;
    }
    yield* enforcedVerifiedStream(
      base,
      async (done) => {
        const verdict = await this.verdictFor(runId, input, done);
        // #133 (E6) — record the block on this turn's plan.
        if (verdict.status === 'blocked') this.fireVerifierBlocked(input, verdict);
        void this.persist(runId, input, verdict, 0);
        const releases = verdictReleasesAnswer(verdict);
        if (!releases) {
          this.log(`[verifier/service] answer withheld run=${runId} status=${verdict.status}`);
        }
        return { summary: summarise(verdict, 0, this.mode), releases };
      },
      this.locale,
    );
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
    // `enforce` releases every control-flow result this way, as the stream
    // does (`releasesWithoutVerification`).
    if (
      firstResult.pendingUserChoice ||
      (this.mode === 'enforce' && releasesWithoutVerification(firstResult))
    ) {
      return toSemanticAnswer(firstResult);
    }
    const firstVerdict = await this.verdictFor(runId, input, firstResult);

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

    // Enforce mode: only contradictions trigger a retry — a correction hint
    // needs something to correct. Every other verdict is delivered or
    // withheld as it stands (`deliverEnforced`).
    if (effectiveVerdict.status === 'blocked') {
      this.fireVerifierBlocked(input, effectiveVerdict);
    }
    const deliverWithoutRetry = (): SemanticAnswer => {
      void this.persist(runId, input, effectiveVerdict, 0);
      return this.deliverEnforced(
        runId,
        effectiveResult,
        effectiveVerdict,
        summarise(effectiveVerdict, 0, this.mode),
      );
    };
    if (effectiveVerdict.status !== 'blocked' || this.maxRetries <= 0) {
      return deliverWithoutRetry();
    }

    const correction = buildCorrectionPrompt(effectiveVerdict);
    // Shouldn't happen for status=blocked, but be defensive.
    if (!correction) return deliverWithoutRetry();

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
      return deliverWithoutRetry();
    }

    const secondVerdict = await this.verdictFor(runId, input, secondResult);

    // Merge: persist ONE row with the final retry count; contradictions table
    // reflects whichever verdict actually tripped. We log both for telemetry.
    void this.persist(runId, input, secondVerdict, 1);

    // Compute the user-facing badge: `corrected` when the retry confirmed
    // every claim, `partial` when it confirmed only some, `failed` when it is
    // still contradicted, `unverified` / `unavailable` (no connector badge)
    // when the retry's verification confirmed nothing.
    const badge = mergeBadges(effectiveVerdict, secondVerdict);
    return this.deliverEnforced(runId, secondResult, secondVerdict, {
      ...summarise(secondVerdict, 1, this.mode),
      badge,
    });
  }

  /**
   * `enforce` delivery on the non-streaming path: the answer with its
   * summary when the verdict releases it, the withheld-answer notice in its
   * place otherwise — the same rule as the stream (`verifierDelivery.ts`).
   */
  private deliverEnforced(
    runId: string,
    result: ChatTurnResult,
    verdict: VerifierVerdict,
    summary: VerifierResultSummary,
  ): SemanticAnswer {
    if (verdictReleasesAnswer(verdict)) {
      return toSemanticAnswer(withVerifier(result, summary));
    }
    this.log(`[verifier/service] answer withheld run=${runId} status=${verdict.status}`);
    return toSemanticAnswer(withheldTurnResult(result, summary, this.locale));
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
    const secondVerdict = await this.verdictFor(runId, input, secondResult);
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

  /**
   * The verdict on one turn's answer (a `done` event or a turn result).
   * `enforce` never hands the pipeline an answer Privacy Shield rendered
   * server-side (`mayVerifyAnswer`): its claim extractor would send the real
   * values the shield kept from the turn's model to the verifier's provider.
   * That answer gets `unavailable` / `privacy_shield`, which withholds it.
   * `shadow` verifies as before.
   */
  private async verdictFor(
    runId: string,
    input: ChatTurnInput,
    turn: Pick<ChatTurnResult, 'answer' | 'runTrace' | 'answerSource'>,
  ): Promise<VerifierVerdict> {
    if (this.mode === 'enforce' && !mayVerifyAnswer(turn)) {
      this.log(`[verifier/service] not verified run=${runId}: answer rendered by the privacy shield`);
      return privacyShieldVerdict();
    }
    return this.safeVerify(runId, input, turn.answer, turn.runTrace);
  }

  private async safeVerify(
    runId: string,
    input: ChatTurnInput,
    answer: string,
    runTrace: RunTracePayload | undefined,
  ): Promise<VerifierVerdict> {
    const domainToolsCalled = extractToolsCalled(runTrace);
    const toolPostconditionViolations = extractPostconditionViolations(runTrace);
    const knowledgeGraphToolsCalled = extractKnowledgeGraphToolsCalled(runTrace);
    let returned: unknown;
    try {
      returned = await this.pipeline.verify({
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
    // Everything below acts on this verdict, so it is bound once, here: the
    // status its claims back, a closed reason. What did not hold is logged
    // with the raw value; the stream only ever sees the bound verdict.
    const bound = bindVerdictToClaims(returned);
    if (bound.problem !== undefined) {
      this.log(`[verifier/service] pipeline verdict not taken as returned: ${bound.problem}`);
    }
    return bound.verdict;
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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
