import type {
  ChatAgent,
  ChatStreamEvent,
  ChatTurnInput,
  ChatTurnResult,
  Orchestrator,
  VerifierResultSummary,
} from './orchestrator.js';
import { PROMPT_MASK_BLOCKED_ANSWER, toSemanticAnswer } from './orchestrator.js';
import { randomUUID } from 'node:crypto';
import type { ChatStreamObserver, SemanticAnswer } from '@omadia/channel-sdk';
import type { RunTracePayload } from './runTraceCollector.js';
import type {
  VerifierPipeline,
  VerifierStore,
  VerifierVerdict,
} from '@omadia/verifier';
import { bindVerdictToClaims, isBorderlineVerdict } from '@omadia/verifier';
import type { TurnHookRunner } from './turnHooks.js';
import type { PrivacyEgressContinuation } from './privacyEgress.js';
import { fireVerifierBlockedHook } from './verifierBlockedHook.js';
import {
  enforcedVerifiedStream,
  privacyShieldVerdict,
  releasesWithoutVerification,
  shadowVerifiedStream,
  verdictReleasesAnswer,
  withheldTurnResult,
} from './verifierDelivery.js';
import {
  EgressLedger,
  StreamEgress,
  carriesUnresolvedPlaceholders,
  modelFacingUserMessage,
  privacySafeCorrection,
  verifierGate,
  type EgressTurn,
  type PrivacyEgressHost,
  type VerifierGate,
} from './verifierPrivacyGate.js';
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
 * answer the verifier may not see behind a Privacy Shield, which is never
 * sent to the pipeline (`verifierGate`, `privacyShieldVerdict`). On the
 * stream no content leaves before the verdict (`verifierDelivery.ts`); the
 * non-streaming path first runs its correction retry:
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
 *
 * Behind a Privacy Shield every turn this wrapper runs hands its privacy
 * finalisation over (see `privacyEgress.ts` / `verifierPrivacyGate.ts`): the
 * verifier's model requests go through that turn's own privacy view, and the
 * turn's receipt is finalized only after them — exactly once per turn.
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
  /** The orchestrator's privacy hand-over surface (feature-detected). */
  private readonly host: PrivacyEgressHost;
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
    this.host = opts.orchestrator;
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
   * Behind a Privacy Shield the orchestrator hands the turn's finalisation
   * over, and `done` — which carries the receipt — waits in both modes: the
   * inner stream is drained first (so its steering / auth cleanup runs), then
   * the answer is verified through the turn's privacy view, then the turn is
   * finalized and `done` goes out with the receipt.
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
    if (!this.enabled) {
      yield* this.orchestrator.chatStream(input, observer);
      return;
    }
    const runId = randomUUID();
    const egress = new StreamEgress(this.host, input, this.log);
    this.host.markPrivacyFinalizeHeld?.(input);
    try {
      const base = this.orchestrator.chatStream(input, observer);
      if (this.mode === 'shadow') {
        yield* shadowVerifiedStream(base, {
          // The orchestrator handed the continuation over before `done`.
          holdDone: () => egress.take() !== undefined,
          verify: async (done) => {
            const verdict = await this.verdictFor(runId, input, done, egress.take());
            if (verdict === undefined) return undefined;
            void this.persist(runId, input, verdict, 0);
            return summarise(verdict, 0, this.mode);
          },
          finish: (done) => egress.finishDone(done),
        });
        return;
      }
      yield* enforcedVerifiedStream(
        base,
        async (done) => {
          const verdict =
            (await this.verdictFor(runId, input, done, egress.take())) ?? privacyShieldVerdict();
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
        (done) => egress.finishDone(done),
      );
    } finally {
      // A client that leaves early, or a throw, must not strand the turn's
      // privacy state until restart.
      await egress.settleUnfinished();
    }
  }

  /** {@link verifierGate}, logging why a turn is not verified. */
  private gateFor(
    answerSource: ChatTurnResult['answerSource'],
    egress: PrivacyEgressContinuation | undefined,
  ): VerifierGate {
    const gate = verifierGate(answerSource, egress, this.host);
    if (!gate.verify) this.log(`[verifier/service] verification skipped: ${gate.reason}`);
    return gate;
  }

  /** Drop-in replacement for `orchestrator.chat` with verification. */
  async chat(input: ChatTurnInput): Promise<SemanticAnswer> {
    if (!this.enabled) {
      return this.orchestrator.chat(input);
    }
    // Every turn run below hands its privacy finalisation to this ledger;
    // whatever path returns (or throws), each one is finalized exactly once.
    const ledger = new EgressLedger(this.host, this.log);
    try {
      return await this.chatVerified(randomUUID(), input, ledger);
    } finally {
      await ledger.settleAll();
    }
  }

  private async chatVerified(
    runId: string,
    input: ChatTurnInput,
    ledger: EgressLedger,
  ): Promise<SemanticAnswer> {
    // Use `runTurn()` (full internal shape) rather than `chat()` — we need
    // access to `runTrace` for the verifier pipeline's evidence fetcher.
    const first = await ledger.runTurn(input, () => this.orchestrator.runTurn(input));
    // Clarification-request turns have no fact claims — skip verification.
    // The Smart-Card UX is the "answer" here; there is nothing to check.
    // `enforce` releases every control-flow result this way, as the stream
    // does (`releasesWithoutVerification`).
    if (
      first.result.pendingUserChoice ||
      (this.mode === 'enforce' && releasesWithoutVerification(first.result))
    ) {
      return this.deliver(ledger, first);
    }
    const firstVerdict = await this.verdictFor(runId, input, first.result, first.egress);
    // `shadow` behind a shield without a usable privacy view: not verified at
    // all. (`enforce` gets `privacyShieldVerdict` instead and withholds.)
    if (firstVerdict === undefined) return this.deliver(ledger, first);

    // Shadow mode: persist + summarise, never retry / block.
    if (this.mode === 'shadow') {
      void this.persist(runId, input, firstVerdict, 0);
      return this.deliver(ledger, first, summarise(firstVerdict, 0, this.mode));
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
    let effective = first;
    let effectiveVerdict = firstVerdict;
    if (
      this.resampleOnBorderline &&
      this.maxResamples > 0 &&
      isBorderlineVerdict(firstVerdict)
    ) {
      const merged = await this.tryResample(runId, input, firstVerdict, ledger);
      if (merged) {
        effective = merged.turn ?? first;
        effectiveVerdict = merged.verdict;
      }
    }

    // Enforce mode: only contradictions trigger a retry — a correction hint
    // needs something to correct. Every other verdict is delivered or
    // withheld as it stands (`deliverEnforced`).
    if (effectiveVerdict.status === 'blocked') {
      this.fireVerifierBlocked(input, effectiveVerdict);
    }
    const deliverWithoutRetry = async (): Promise<SemanticAnswer> => {
      void this.persist(runId, input, effectiveVerdict, 0);
      const shown = await this.shownTurn(runId, first, effective);
      return this.deliverEnforced(
        runId,
        ledger,
        shown,
        effectiveVerdict,
        summarise(effectiveVerdict, 0, this.mode),
      );
    };
    if (effectiveVerdict.status !== 'blocked' || this.maxRetries <= 0) {
      return deliverWithoutRetry();
    }

    // Behind a shield the hint carries no truth values, and the retry is
    // withheld when the turn's masking would still alter it.
    const { correction, withheld } = await privacySafeCorrection(
      effectiveVerdict,
      effective.egress,
    );
    if (withheld) {
      this.log(
        `[verifier/service] retry withheld run=${runId} — the correction would carry masked values`,
      );
    }
    // No correction: shouldn't happen for status=blocked unless withheld.
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
    let second: EgressTurn;
    try {
      // #579 — a correction retry re-runs an already-screened user turn; mark it
      // so the inbound screening gate does not screen/audit it a second time.
      this.orchestrator.markScreeningReentry(retryInput);
      second = await ledger.runTurn(retryInput, () => this.orchestrator.runTurn(retryInput));
    } catch (err) {
      this.log(`[verifier/service] retry FAIL: ${errMsg(err)}`);
      return deliverWithoutRetry();
    }

    const secondVerdict =
      second.result.answer === PROMPT_MASK_BLOCKED_ANSWER
        ? undefined
        : await this.verdictFor(runId, input, second.result, second.egress);
    // A retry the privacy guard refused is no correction: the first answer's
    // verdict decides.
    if (secondVerdict === undefined) return deliverWithoutRetry();

    // Merge: persist ONE row with the final retry count; contradictions table
    // reflects whichever verdict actually tripped. We log both for telemetry.
    void this.persist(runId, input, secondVerdict, 1);

    // A retry answer whose restored text still carries placeholders the
    // model reworded (so restore could not map them back) would show fake
    // values: it never replaces the earlier answer, whose verdict then
    // decides.
    if (await carriesUnresolvedPlaceholders(second)) {
      this.log(
        `[verifier/service] retry answer carries unresolved placeholders — keeping the earlier answer run=${runId}`,
      );
      const shown = await this.shownTurn(runId, first, effective);
      return this.deliverEnforced(
        runId,
        ledger,
        shown,
        effectiveVerdict,
        summarise(effectiveVerdict, 1, this.mode),
      );
    }

    // Compute the user-facing badge: `corrected` when the retry confirmed
    // every claim, `partial` when it confirmed only some, `failed` when it is
    // still contradicted, `unverified` / `unavailable` (no connector badge)
    // when the retry's verification confirmed nothing.
    const badge = mergeBadges(effectiveVerdict, secondVerdict);
    return this.deliverEnforced(runId, ledger, second, secondVerdict, {
      ...summarise(secondVerdict, 1, this.mode),
      badge,
    });
  }

  /**
   * The turn shown while the verdict stays the one `effective` produced. A
   * blocked re-sample replaces the first answer only when it can be shown:
   * one whose restored text still carries a placeholder the model reworded
   * would put a fake value in front of the user, so the first answer is shown
   * instead — the verdict, and with it the badge, stay the re-sample's.
   */
  private async shownTurn(
    runId: string,
    first: EgressTurn,
    effective: EgressTurn,
  ): Promise<EgressTurn> {
    if (effective === first || !(await carriesUnresolvedPlaceholders(effective))) {
      return effective;
    }
    this.log(
      `[verifier/service] re-sample carries unresolved placeholders — showing the first answer run=${runId}`,
    );
    return first;
  }

  /**
   * Finalize the returned turn's privacy state and attach its receipt (the
   * orchestrator attached none while the finalisation was handed over).
   */
  private async deliver(
    ledger: EgressLedger,
    turn: EgressTurn,
    verifier?: VerifierResultSummary,
  ): Promise<SemanticAnswer> {
    const result = await this.settled(ledger, turn);
    return toSemanticAnswer(verifier ? withVerifier(result, verifier) : result);
  }

  /** The turn result as it is delivered: finalized, its receipt attached. */
  private async settled(ledger: EgressLedger, turn: EgressTurn): Promise<ChatTurnResult> {
    const receipt = await ledger.settle(turn);
    return receipt ? { ...turn.result, privacyReceipt: receipt } : turn.result;
  }

  /**
   * `enforce` delivery on the non-streaming path: the answer with its
   * summary when the verdict releases it, the withheld-answer notice in its
   * place otherwise — the same rule as the stream (`verifierDelivery.ts`).
   * Either way the delivered turn is finalized first, so the notice keeps
   * the turn's receipt.
   */
  private async deliverEnforced(
    runId: string,
    ledger: EgressLedger,
    turn: EgressTurn,
    verdict: VerifierVerdict,
    summary: VerifierResultSummary,
  ): Promise<SemanticAnswer> {
    const result = await this.settled(ledger, turn);
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
   * Returns `{ verdict, turn }` where `turn` is the second sample iff the
   * merge decided to keep it; `undefined` means "keep the first turn". The
   * caller plugs both straight into the existing persist + correction-retry
   * path.
   */
  private async tryResample(
    runId: string,
    input: ChatTurnInput,
    firstVerdict: VerifierVerdict,
    ledger: EgressLedger,
  ): Promise<{
    verdict: VerifierVerdict;
    turn?: EgressTurn;
  } | undefined> {
    this.log(`[verifier/service] borderline resample run=${runId}`);
    let second: EgressTurn;
    try {
      // #579 — a borderline resample re-runs the same already-screened user
      // turn; mark it so the inbound gate skips a redundant screen + audit.
      // The privacy hand-over mark is one-shot, so the ledger sets it again.
      this.orchestrator.markScreeningReentry(input);
      second = await ledger.runTurn(input, () => this.orchestrator.runTurn(input));
    } catch (err) {
      this.log(`[verifier/service] resample FAIL: ${errMsg(err)}`);
      return undefined;
    }
    if (second.result.pendingUserChoice) {
      // Second sample punted to a clarification card — keep the first
      // verdict, the user-facing answer didn't change.
      return undefined;
    }
    const secondVerdict = await this.verdictFor(runId, input, second.result, second.egress);
    // Not verifiable behind the shield: re-sampling is best-effort.
    if (secondVerdict === undefined) return undefined;
    const merged = mergeBorderlineVerdicts(firstVerdict, secondVerdict);
    this.log(
      `[verifier/service] resample merge run=${runId} first=${firstVerdict.status} second=${secondVerdict.status} → ${merged.verdict.status}${
        merged.takeSecond ? ' (takeSecond)' : ''
      }`,
    );
    return {
      verdict: merged.verdict,
      ...(merged.takeSecond ? { turn: second } : {}),
    };
  }

  // ------------------------------------------------------------------

  /**
   * The verdict on one turn's answer (a `done` event or a turn result),
   * through the turn's privacy gate (`verifierGate`). An answer the verifier
   * may not see — one Privacy Shield rendered server-side (real values the
   * turn's model never saw), or, behind a shield, a turn that handed over no
   * view to verify through — never reaches the pipeline: `enforce` cannot
   * confirm it and records `unavailable` / `privacy_shield`, which withholds
   * it; `shadow` reports nothing (`undefined`).
   */
  private async verdictFor(
    runId: string,
    input: ChatTurnInput,
    turn: Pick<ChatTurnResult, 'answer' | 'runTrace' | 'answerSource'>,
    egress: PrivacyEgressContinuation | undefined,
  ): Promise<VerifierVerdict | undefined> {
    const gate = this.gateFor(turn.answerSource, egress);
    if (!gate.verify) {
      return this.mode === 'enforce' ? privacyShieldVerdict() : undefined;
    }
    return this.safeVerify(runId, input, turn.answer, turn.runTrace, gate);
  }

  private async safeVerify(
    runId: string,
    input: ChatTurnInput,
    answer: string,
    runTrace: RunTracePayload | undefined,
    gate: Extract<VerifierGate, { verify: true }>,
  ): Promise<VerifierVerdict> {
    const domainToolsCalled = extractToolsCalled(runTrace);
    const toolPostconditionViolations = extractPostconditionViolations(runTrace);
    const knowledgeGraphToolsCalled = extractKnowledgeGraphToolsCalled(runTrace);
    let returned: unknown;
    try {
      returned = await this.pipeline.verify({
        runId,
        // What the turn's model saw — never an MCP input-card envelope.
        userMessage: modelFacingUserMessage(input.userMessage),
        answer,
        ...(domainToolsCalled ? { domainToolsCalled } : {}),
        ...(toolPostconditionViolations.length > 0
          ? { toolPostconditionViolations }
          : {}),
        ...(knowledgeGraphToolsCalled !== undefined
          ? { knowledgeGraphToolsCalled }
          : {}),
        // The turn's privacy view: every model request of the verifier
        // goes through it (absent only when no shield is installed).
        ...(gate.privacy ? { privacy: gate.privacy } : {}),
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
