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
import { isBorderlineVerdict } from '@omadia/verifier';
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
  EgressLedger,
  StreamPasses,
  carriesUnresolvedPlaceholders,
  privacySafeCorrection,
  type EgressTurn,
  type PrivacyEgressHost,
} from './verifierPrivacyGate.js';
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
 * answer the verifier may not see behind a Privacy Shield, which is never
 * sent to the pipeline (`verifierGate`, `privacyShieldVerdict`). On the
 * stream no content leaves before the verdict (`verifierDelivery.ts`).
 * Before it delivers, `enforce` may re-enter the turn: the non-streaming path
 * draws a second sample of a borderline answer, and both paths run one
 * correction retry on a contradiction (`verifierEnforceStream.ts` for the
 * stream):
 *
 *   orchestrator.runTurn → verify → blocked → correction hint in the system
 *   prompt → runTurn (retry, maxRetries) → verify → deliver or withhold
 *
 * A re-entry re-generates the ANSWER; it never re-runs the turn's tools
 * (`verifierReentry.ts`, `toolReplayLedger.ts`). Every call the first run
 * made is replayed from the request's ledger, a call it did not make runs
 * only when it is a kernel read, and a re-entry that needs any other call is
 * abandoned before it runs — the first answer stands (a retry's then keeps
 * its `failed` badge). The uploads' ingestion is reused the same way. The
 * correction hint names the contradicted claims only — never the evidence
 * the verifier fetched with its own access (`buildCorrectionPrompt`) — and
 * the orchestrator masks it like the user's message; a re-entry whose prompt
 * cannot be masked is abandoned. Canvas turns are not retried on the stream.
 * What the request records — its one session-log row, fact extraction,
 * `onAfterTurn` — is the delivered pass's, written once the service decided
 * (commit-on-delivery, `requestTurnRecord.ts`).
 *
 * Behind a Privacy Shield every pass this wrapper runs — first run,
 * resample, retry — hands its privacy finalisation over
 * (`privacyEgress.ts`, `verifierPrivacyGate.ts`): the verifier's model
 * requests go through that pass's own privacy view, and the pass is
 * finalized only after them, exactly once. A request the verifier may
 * re-enter keeps ONE receipt row, every pass's receipt merged in (verifier
 * requests and tool errors included); the answer carries that merged
 * receipt. The hint is withheld when the turn's masking would still alter it,
 * and a second answer whose restored text still carries placeholders never
 * replaces the first.
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
  /** The orchestrator's privacy hand-over surface (feature-detected). */
  private readonly host: PrivacyEgressHost;
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
    this.host = opts.orchestrator;
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
      host: this.host,
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
   *
   * Behind a Privacy Shield every pass hands its finalisation over, and
   * `done` — which carries the receipt — waits in both modes: the pass's
   * stream is drained first (so its steering / auth cleanup runs), the
   * answer is verified through the pass's privacy view, then the pass is
   * finalized and `done` goes out with the receipt.
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
      yield* this.shadowStream(runId, input, observer);
      return;
    }
    yield* enforcedVerifierStream(
      {
        orchestrator: this.orchestrator,
        egressHost: this.host,
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

  /** `shadow` on the stream: one pass, `done` held only behind a shield. */
  private async *shadowStream(
    runId: string,
    input: ChatTurnInput,
    observer: ChatStreamObserver | undefined,
  ): AsyncGenerator<ChatStreamEvent> {
    const passes = new StreamPasses(this.host, this.log);
    try {
      const egress = passes.open(input);
      yield* shadowVerifiedStream(this.orchestrator.chatStream(input, observer), {
        // The orchestrator handed the continuation over before `done`.
        holdDone: () => egress.take() !== undefined,
        verify: async (done) => {
          const verdict = await this.judge.verdictFor(runId, input, done, egress.take());
          if (verdict === undefined) return undefined;
          void this.judge.persist(runId, input, verdict, 0);
          return summarise(verdict, 0, this.mode);
        },
        finish: (done) => egress.finishDone(done),
      });
    } finally {
      // A client that leaves early, or a throw, must not strand the turn's
      // privacy state until restart.
      await passes.settleAll();
    }
  }

  /** Drop-in replacement for `orchestrator.chat` with verification. */
  async chat(input: ChatTurnInput): Promise<SemanticAnswer> {
    if (!this.enabled) {
      return this.orchestrator.chat(input);
    }
    const runId = randomUUID();
    const request = bindRequestLedger(this.orchestrator, input, this.reentryPolicy(), 'chat');
    // Every pass run below hands its privacy finalisation to this ledger;
    // whatever path returns (or throws), each one is finalized exactly once.
    const egress = new EgressLedger(this.host, this.log);
    try {
      return await this.chatVerified(runId, input, request?.ledger, egress);
    } finally {
      // Every pass finalized — its receipt joins the request's. Delivery
      // committed the delivered pass's record already; a request that ended
      // without delivering keeps its first run's record, as before
      // commit-on-delivery. Then the ONE receipt row, every pass's receipt
      // merged in.
      await egress.settleAll();
      await request?.ledger.turnRecord.commit(FIRST_PASS);
      await request?.ledger.receipts.commit();
      request?.release();
    }
  }

  private async chatVerified(
    runId: string,
    input: ChatTurnInput,
    ledger: ToolReplayLedger | undefined,
    egress: EgressLedger,
  ): Promise<SemanticAnswer> {
    // Use `runTurn()` (full internal shape) rather than `chat()` — we need
    // access to `runTrace` for the verifier pipeline's evidence fetcher.
    const first = await runPass(egress, input, FIRST_PASS, () => this.orchestrator.runTurn(input));
    // Clarification-request turns have no fact claims — skip verification.
    // The Smart-Card UX is the "answer" here; there is nothing to check.
    // `enforce` releases every control-flow result this way, as the stream
    // does (`releasesWithoutVerification`).
    if (
      first.result.pendingUserChoice ||
      (this.mode === 'enforce' && releasesWithoutVerification(first.result))
    ) {
      return toSemanticAnswer(await this.delivered(first, ledger, egress));
    }
    const firstVerdict = await this.judge.verdictFor(runId, input, first.result, first.egress);
    // `shadow` behind a shield without a usable privacy view: not verified at
    // all. (`enforce` gets `privacyShieldVerdict` instead and withholds.)
    if (firstVerdict === undefined) {
      return toSemanticAnswer(await this.delivered(first, ledger, egress));
    }

    // Shadow mode: persist + summarise, never retry / block.
    if (this.mode === 'shadow') {
      void this.judge.persist(runId, input, firstVerdict, 0);
      return toSemanticAnswer(
        withVerifier(
          await this.delivered(first, ledger, egress),
          summarise(firstVerdict, 0, this.mode),
        ),
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
    // The pass the effective verdict is about — the pass whose record the
    // request keeps if it goes out.
    let effective = first;
    let effectiveVerdict = firstVerdict;
    if (
      ledger !== undefined &&
      this.resampleOnBorderline &&
      this.maxResamples > 0 &&
      isBorderlineVerdict(firstVerdict)
    ) {
      const merged = await this.tryResample(runId, input, firstVerdict, ledger, egress);
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
    const deliverWithoutRetry = async (): Promise<SemanticAnswer> => {
      void this.judge.persist(runId, input, effectiveVerdict, 0);
      const shown = await this.shownTurn(runId, first, effective);
      return this.deliverEnforced(
        runId,
        shown,
        effectiveVerdict,
        summarise(effectiveVerdict, 0, this.mode),
        ledger,
        egress,
      );
    };
    if (effectiveVerdict.status !== 'blocked' || this.maxRetries <= 0 || ledger === undefined) {
      return deliverWithoutRetry();
    }

    // The hint names the claims only; behind a shield the retry is withheld
    // when the turn's masking would still alter it.
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
    let retry: PassTurn;
    try {
      const pass = prepareReentry(this.orchestrator, retryInput, ledger);
      retry = await runPass(egress, retryInput, pass, () => this.orchestrator.runTurn(retryInput));
    } catch (err) {
      this.log(reentryFailureLine('retry', runId, err));
      return deliverWithoutRetry();
    }
    // A retry answer whose restored text still carries placeholders the
    // model reworded (so restore could not map them back) would show fake
    // values: it never replaces the earlier answer, and is not judged.
    if (await carriesUnresolvedPlaceholders(retry)) {
      this.log(
        `[verifier/service] retry answer carries unresolved placeholders — keeping the earlier answer run=${runId}`,
      );
      return deliverWithoutRetry();
    }

    const secondVerdict = await this.judge.verdictFor(runId, input, retry.result, retry.egress);
    // `enforce` never gets `undefined` (an unverifiable retry is
    // `privacy_shield`); kept for the type.
    if (secondVerdict === undefined) return deliverWithoutRetry();

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
      egress,
    );
  }

  /**
   * The pass shown while the verdict stays the one `effective` produced. A
   * blocked re-sample replaces the first answer only when it can be shown:
   * one whose restored text still carries a placeholder the model reworded
   * would put a fake value in front of the user, so the first pass is
   * delivered instead — the verdict, and with it the badge, stay the
   * re-sample's. Must run before the passes are finalized.
   */
  private async shownTurn(
    runId: string,
    first: PassTurn,
    effective: PassTurn,
  ): Promise<PassTurn> {
    if (effective === first || !(await carriesUnresolvedPlaceholders(effective))) {
      return effective;
    }
    this.log(
      `[verifier/service] re-sample carries unresolved placeholders — showing the first answer run=${runId}`,
    );
    return first;
  }

  /**
   * The delivered pass as the request's result. Without a request ledger
   * (one pass): that pass finalized, its receipt attached. With one: every
   * pass finalized first — each receipt joins the request's — then the
   * delivered pass's record committed and the merged receipt attached
   * (`asRequestResult`).
   */
  private async delivered(
    turn: PassTurn,
    ledger: ToolReplayLedger | undefined,
    egress: EgressLedger,
  ): Promise<ChatTurnResult> {
    if (ledger === undefined) {
      const receipt = await egress.settle(turn);
      return receipt ? { ...turn.result, privacyReceipt: receipt } : turn.result;
    }
    await egress.settleAll();
    return asRequestResult(turn.result, turn.pass, ledger);
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
    turn: PassTurn,
    verdict: VerifierVerdict,
    summary: VerifierResultSummary,
    ledger: ToolReplayLedger | undefined,
    egress: EgressLedger,
  ): Promise<SemanticAnswer> {
    const delivered = await this.delivered(turn, ledger, egress);
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
   * Returns `{ verdict, second }` where `second` is the second sample's pass
   * iff the merge decided to keep it; `undefined` means "keep the first
   * pass". The caller plugs both straight into the existing persist +
   * correction-retry path.
   */
  private async tryResample(
    runId: string,
    input: ChatTurnInput,
    firstVerdict: VerifierVerdict,
    ledger: ToolReplayLedger,
    egress: EgressLedger,
  ): Promise<{
    verdict: VerifierVerdict;
    second?: PassTurn;
  } | undefined> {
    this.log(`[verifier/service] borderline resample run=${runId}`);
    let second: PassTurn;
    try {
      const pass = prepareReentry(this.orchestrator, input, ledger);
      // The privacy hand-over mark is one-shot, so the egress ledger sets it
      // again for the same input object.
      second = await runPass(egress, input, pass, () => this.orchestrator.runTurn(input));
    } catch (err) {
      this.log(reentryFailureLine('resample', runId, err));
      return undefined;
    }
    if (second.result.pendingUserChoice) {
      // Second sample punted to a clarification card — keep the first
      // verdict, the user-facing answer didn't change.
      return undefined;
    }
    const secondVerdict = await this.judge.verdictFor(runId, input, second.result, second.egress);
    // `enforce` never gets `undefined`; re-sampling is best-effort anyway.
    if (secondVerdict === undefined) return undefined;
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

/** One pass of a request: its turn result, the privacy continuation it
 *  handed over, and which pass it was (`FIRST_PASS`, then 1, 2, …). */
interface PassTurn extends EgressTurn {
  readonly pass: number;
}

/** Runs one pass through the egress ledger (mark held → run → collect). */
async function runPass(
  egress: EgressLedger,
  input: ChatTurnInput,
  pass: number,
  run: () => Promise<ChatTurnResult>,
): Promise<PassTurn> {
  return { ...(await egress.runTurn(input, run)), pass };
}
