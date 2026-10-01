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
import type {
  VerifierPipeline,
  VerifierStore,
  VerifierVerdict,
} from '@omadia/verifier';
import { buildCorrectionPrompt, isBorderlineVerdict } from '@omadia/verifier';
import type { ToolReplayLedger } from './toolReplayLedger.js';
import type { TurnHookRunner } from './turnHooks.js';
import { fireVerifierBlockedHook } from './verifierBlockedHook.js';
import {
  releasesWithoutVerification,
  shadowVerifiedStream,
  verdictReleasesAnswer,
  withheldTurnResult,
} from './verifierDelivery.js';
import { enforcedVerifierStream } from './verifierEnforceStream.js';
import { VerifierJudge } from './verifierJudge.js';
import {
  afterRequestRecord,
  asRequestResult,
  bindRequestLedger,
  FIRST_PASS,
  prepareReentry,
  reentryFailureLine,
  type ReentryPolicy,
} from './verifierReentry.js';
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
 * verdict (`verifierDelivery.ts`). Before it delivers, `enforce` may re-enter
 * the turn: the non-streaming path draws a second sample of a borderline
 * answer, and both paths run one correction retry on a contradiction
 * (`verifierEnforceStream.ts` for the stream):
 *
 *   orchestrator.runTurn → verify → blocked → correction hint in the system
 *   prompt → runTurn (retry, maxRetries) → verify → deliver or withhold
 *
 * A re-entry re-generates the ANSWER; it never re-runs the turn's tools
 * (`verifierReentry.ts`, `toolReplayLedger.ts`). Every call the first run
 * made is replayed from the request's ledger, a call it did not make runs
 * only when it is a kernel read, and a re-entry that needs any other call is
 * abandoned before it runs — the first answer stands (a retry's then keeps
 * its `failed` badge). Canvas turns are not retried on the stream. What the
 * request records — its one session-log row, fact extraction, `onAfterTurn`
 * — is the delivered pass's, written once the service decided
 * (commit-on-delivery, `requestTurnRecord.ts`).
 *
 * A failing verifier surfaces as `unavailable`, never as `approved`: "the
 * verifier could not check" must not read as "the verifier checked and found
 * nothing wrong". The pipeline is injected, so its verdict is held to what
 * its claims show (`bindVerdictToClaims`, `verifierJudge.ts`) before it is
 * retried, resampled, stored or streamed: a status its claims do not back, or
 * a reason outside the closed codes, never reaches `verifier_verdicts` or the
 * stream.
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
   * the two verdicts. Default true; the operator switch is the verifier's
   * `verifier_resample_on_borderline` setup field.
   *
   * Cost note: each enabled re-sample doubles the LLM cost of a turn that
   * already cleared verification with "almost". `maxResamples` caps the
   * blast radius (hard 1 today). Disable for cost-sensitive deployments.
   * The re-sample runs no tool again (see the class comment).
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
  private readonly judge: VerifierJudge;
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
    this.judge = new VerifierJudge({
      pipeline: opts.pipeline,
      ...(opts.store ? { store: opts.store } : {}),
      mode: this.mode,
      log: this.log,
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

  private reentryPolicy(): ReentryPolicy {
    return {
      mode: this.mode,
      maxRetries: this.maxRetries,
      resample: this.resampleOnBorderline && this.maxResamples > 0,
    };
  }

  /**
   * Stream wrapper. `shadow` passes every event through as produced and
   * reports the verdict as one trailing `verifier` event; `enforce` holds
   * every content event until the verdict, releases an answer as the text
   * the verdict is about (never the raw deltas) and replaces one it does not
   * release with the withheld-answer notice (`verifierDelivery.ts`). A
   * contradiction first buys one correction retry over the first run's tool
   * results — never re-running a tool — whose verdict then decides by the
   * same rule; canvas turns are not retried (`verifierEnforceStream.ts`).
   * The route's observer (iteration, token and usage counters — no text) is
   * forwarded in every mode, for the retry too.
   */
  async *chatStream(
    input: ChatTurnInput,
    observer?: ChatStreamObserver,
  ): AsyncGenerator<ChatStreamEvent> {
    if (!this.enabled) {
      yield* this.orchestrator.chatStream(input, observer);
      return;
    }
    const runId = randomUUID();
    if (this.mode === 'shadow') {
      yield* shadowVerifiedStream(this.orchestrator.chatStream(input, observer), async (done) => {
        const verdict = await this.judge.safeVerify(runId, input, done.answer, done.runTrace);
        void this.judge.persist(runId, input, verdict, 0);
        return summarise(verdict, 0, this.mode);
      });
      return;
    }
    yield* enforcedVerifierStream(
      {
        orchestrator: this.orchestrator,
        judge: this.judge,
        policy: this.reentryPolicy(),
        locale: this.locale,
        log: this.log,
        fireVerifierBlocked: (turnInput, verdict) => this.fireVerifierBlocked(turnInput, verdict),
      },
      runId,
      input,
      observer,
    );
  }

  /** Drop-in replacement for `orchestrator.chat` with verification. */
  async chat(input: ChatTurnInput): Promise<SemanticAnswer> {
    if (!this.enabled) {
      return this.orchestrator.chat(input);
    }
    const runId = randomUUID();
    const request = bindRequestLedger(this.orchestrator, input, this.reentryPolicy(), 'chat');
    try {
      return await this.chatVerified(runId, input, request?.ledger);
    } finally {
      // Delivery committed the delivered pass's record already; a request
      // that ended without delivering keeps its first run's record, as
      // before commit-on-delivery. Then the ONE receipt row, every pass's
      // receipt merged in.
      await request?.ledger.turnRecord.commit(FIRST_PASS);
      await request?.ledger.receipts.commit();
      request?.release();
    }
  }

  private async chatVerified(
    runId: string,
    input: ChatTurnInput,
    ledger: ToolReplayLedger | undefined,
  ): Promise<SemanticAnswer> {
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
      return toSemanticAnswer(await asRequestResult(firstResult, FIRST_PASS, ledger));
    }
    const firstVerdict = await this.judge.verdictFor(runId, input, firstResult);

    // Shadow mode: persist + summarise, never retry / block.
    if (this.mode === 'shadow') {
      void this.judge.persist(runId, input, firstVerdict, 0);
      return toSemanticAnswer(
        withVerifier(firstResult, summarise(firstVerdict, 0, this.mode)),
      );
    }

    // #132 — borderline gate: when the first verdict confirmed claims but
    // could not confirm another one it checked (`isBorderlineVerdict`), draw
    // a second sample of the answer over the first run's tool results. Two
    // independent samples landing on the same disclaimer ⇒ keep.
    // Disagreement ⇒ take the more conservative reading (blocked wins).
    // Bounded at `maxResamples` per turn (default 1) so cost stays
    // predictable. `skipped` / `unavailable`, a disclaimer that confirmed
    // nothing, and one whose doubt is only claims no checker takes must never
    // trigger this paid resample: a second sample cannot add evidence there,
    // and otherwise every small-talk turn would run twice.
    // The result the effective verdict is about, and the pass that produced
    // it — the pass whose record the request keeps if it goes out.
    let effective: PassResult = { result: firstResult, pass: FIRST_PASS };
    let effectiveVerdict = firstVerdict;
    if (
      ledger !== undefined &&
      this.resampleOnBorderline &&
      this.maxResamples > 0 &&
      isBorderlineVerdict(firstVerdict)
    ) {
      const merged = await this.tryResample(runId, input, firstVerdict, ledger);
      if (merged) {
        effective = merged.second ?? effective;
        effectiveVerdict = merged.verdict;
      }
    }

    // Enforce mode: only contradictions trigger a retry — a correction hint
    // needs something to correct. Every other verdict is delivered or
    // withheld as it stands (`deliverEnforced`). The block is recorded on
    // the turn's plan once the request's record (its `onAfterTurn`) is in.
    if (effectiveVerdict.status === 'blocked') {
      const blockedVerdict = effectiveVerdict;
      afterRequestRecord(ledger, () => {
        this.fireVerifierBlocked(input, blockedVerdict);
      });
    }
    const deliverWithoutRetry = (): Promise<SemanticAnswer> => {
      void this.judge.persist(runId, input, effectiveVerdict, 0);
      return this.deliverEnforced(
        runId,
        effective,
        effectiveVerdict,
        summarise(effectiveVerdict, 0, this.mode),
        ledger,
      );
    };
    if (effectiveVerdict.status !== 'blocked' || this.maxRetries <= 0 || ledger === undefined) {
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
    let retry: PassResult;
    try {
      const pass = prepareReentry(this.orchestrator, retryInput, ledger);
      retry = { result: await this.orchestrator.runTurn(retryInput), pass };
    } catch (err) {
      this.log(reentryFailureLine('retry', runId, err));
      return deliverWithoutRetry();
    }

    const secondVerdict = await this.judge.verdictFor(runId, input, retry.result);

    // Merge: persist ONE row with the final retry count; contradictions table
    // reflects whichever verdict actually tripped. We log both for telemetry.
    void this.judge.persist(runId, input, secondVerdict, 1);

    // Compute the user-facing badge: `corrected` when the retry confirmed
    // every claim, `partial` when it confirmed only some, `failed` when it is
    // still contradicted, `unverified` / `unavailable` (no connector badge)
    // when the retry's verification confirmed nothing.
    const badge = mergeBadges(effectiveVerdict, secondVerdict);
    return this.deliverEnforced(
      runId,
      retry,
      secondVerdict,
      { ...summarise(secondVerdict, 1, this.mode), badge },
      ledger,
    );
  }

  /**
   * `enforce` delivery on the non-streaming path: the answer with its
   * summary when the verdict releases it, the withheld-answer notice in its
   * place otherwise — the same rule as the stream (`verifierDelivery.ts`).
   * Either is the request's: the record of the pass the verdict is about,
   * committed (commit-on-delivery), and every pass's receipt merged.
   */
  private async deliverEnforced(
    runId: string,
    effective: PassResult,
    verdict: VerifierVerdict,
    summary: VerifierResultSummary,
    ledger: ToolReplayLedger | undefined,
  ): Promise<SemanticAnswer> {
    const delivered = await asRequestResult(effective.result, effective.pass, ledger);
    if (verdictReleasesAnswer(verdict)) {
      return toSemanticAnswer(withVerifier(delivered, summary));
    }
    this.log(`[verifier/service] answer withheld run=${runId} status=${verdict.status}`);
    return toSemanticAnswer(withheldTurnResult(delivered, summary, this.locale));
  }

  /**
   * #132 — borderline re-sample: re-enter the same turn over the first run's
   * tool results and merge the two verdicts. Failure to re-run (anything
   * thrown by the orchestrator — an abandoned re-entry included — or a
   * clarification-card result that has no fact claims) returns `undefined`
   * and the caller keeps `firstVerdict` as the effective verdict —
   * re-sampling is best-effort.
   *
   * Returns `{ verdict, second }` where `second` is the second sample's
   * orchestrator result and pass iff the merge decided to keep it;
   * `undefined` means "keep the first result". The caller plugs both
   * straight into the existing persist + correction-retry path.
   */
  private async tryResample(
    runId: string,
    input: ChatTurnInput,
    firstVerdict: VerifierVerdict,
    ledger: ToolReplayLedger,
  ): Promise<{
    verdict: VerifierVerdict;
    second?: PassResult;
  } | undefined> {
    this.log(`[verifier/service] borderline resample run=${runId}`);
    let second: PassResult;
    try {
      const pass = prepareReentry(this.orchestrator, input, ledger);
      second = { result: await this.orchestrator.runTurn(input), pass };
    } catch (err) {
      this.log(reentryFailureLine('resample', runId, err));
      return undefined;
    }
    if (second.result.pendingUserChoice) {
      // Second sample punted to a clarification card — keep the first
      // verdict, the user-facing answer didn't change.
      return undefined;
    }
    const secondVerdict = await this.judge.verdictFor(runId, input, second.result);
    const merged = mergeBorderlineVerdicts(firstVerdict, secondVerdict);
    this.log(
      `[verifier/service] resample merge run=${runId} first=${firstVerdict.status} second=${secondVerdict.status} → ${merged.verdict.status}${
        merged.takeSecond ? ' (takeSecond)' : ''
      }`,
    );
    return {
      verdict: merged.verdict,
      ...(merged.takeSecond ? { second } : {}),
    };
  }
}

/** A turn result and the pass of the request that produced it. */
interface PassResult {
  readonly result: ChatTurnResult;
  readonly pass: number;
}
