import type { ChatStreamObserver } from '@omadia/channel-sdk';
import type { VerifierBadge, VerifierVerdict } from '@omadia/verifier';
import type { ChatStreamEvent, ChatTurnInput, Orchestrator } from './orchestrator.js';
import type { ToolReplayLedger } from './toolReplayLedger.js';
import {
  enforcedVerifiedStream,
  privacyShieldVerdict,
  verdictNeedsDisclaimer,
  verdictReleasesAnswer,
  type EnforcedRetry,
  type EnforcedVerdict,
} from './verifierDelivery.js';
import type { VerifierJudge } from './verifierJudge.js';
import {
  StreamPasses,
  privacySafeCorrection,
  type PrivacyEgressHost,
  type StreamEgress,
} from './verifierPrivacyGate.js';
import {
  afterRequestRecord,
  bindRequestLedger,
  finishRequestDone,
  FIRST_PASS,
  prepareReentry,
  reentryAbandonedLine,
  type ReentryPolicy,
} from './verifierReentry.js';
import {
  mergeBadges,
  releasedWithDisclaimerLogLine,
  retryLogLine,
  summarise,
  withheldLogLine,
} from './verifierVerdicts.js';

/** What the `enforce` stream needs from `VerifierService`. */
export interface EnforceStreamHost {
  readonly orchestrator: Orchestrator;
  /** The orchestrator's privacy hand-over surface (feature-detected). */
  readonly egressHost: PrivacyEgressHost;
  readonly judge: VerifierJudge;
  readonly policy: ReentryPolicy;
  readonly locale: string | undefined;
  readonly log: (msg: string) => void;
  /** #133 (E6) — record a block on the turn's plan. */
  fireVerifierBlocked(input: ChatTurnInput, verdict: VerifierVerdict): void;
}

/**
 * `VerifierService.chatStream` in `enforce`: the delivery gate of
 * `verifierDelivery.ts`, with one correction retry for a contradiction. The
 * retry re-enters the turn over the first run's tool results — it never runs
 * a tool again (`verifierReentry.ts`) — and is held and judged by the same
 * release rule. Canvas turns are not retried (`bindRequestLedger`). Exactly
 * one verdict row is stored per request: the retry's, or the first one when
 * no retry ran or the retry produced no answer to judge. The request's
 * record (session-log row, `onAfterTurn`) is the delivered turn's: the
 * retry's when its answer goes out or is withheld on its own verdict, the
 * first turn's otherwise.
 *
 * Behind a Privacy Shield each pass hands its privacy finalisation over: its
 * answer is verified through its own view, and every pass is finalized once
 * before the `done` that goes out reads the request's receipt — so the
 * receipt covers every pass and the verifier's requests on each — or, when
 * the client leaves early or the stream throws, in `finally`.
 */
export async function* enforcedVerifierStream(
  host: EnforceStreamHost,
  runId: string,
  input: ChatTurnInput,
  observer: ChatStreamObserver | undefined,
): AsyncGenerator<ChatStreamEvent> {
  const request = bindRequestLedger(host.orchestrator, input, host.policy, 'stream');
  const ledger = request?.ledger;
  const passes = new StreamPasses(host.egressHost, host.log);
  let retryPass = FIRST_PASS;
  try {
    const first = passes.open(input);
    yield* enforcedVerifiedStream(
      host.orchestrator.chatStream(input, observer),
      async (done) => {
        const verdict =
          (await host.judge.verdictFor(runId, input, done, first.take())) ??
          privacyShieldVerdict();
        // #133 (E6) — record the block on this turn's plan, once the
        // request's record (its `onAfterTurn`) is in.
        if (verdict.status === 'blocked') {
          afterRequestRecord(ledger, () => {
            host.fireVerifierBlocked(input, verdict);
          });
        }
        const retry = ledger
          ? await streamRetry(host, runId, input, observer, ledger, verdict, first, passes)
          : undefined;
        if (retry) retryPass = retry.pass;
        return retry
          ? { summary: summarise(verdict, 0, 'enforce'), releases: false, disclaimer: false, retry }
          : deliver(host, runId, input, verdict, 0);
      },
      host.locale,
      async (done, fromRetry) => {
        if (ledger === undefined) return { done: await first.finishDone(done), events: [] };
        // Every pass is finalized first: the request's receipt then holds
        // each pass's, its verifier requests included.
        await passes.settleAll();
        return finishRequestDone(done, fromRetry ? retryPass : FIRST_PASS, ledger);
      },
    );
  } finally {
    // Normally finalized and written before the final `done`. A consumer
    // that stopped reading early still gets every pass finalized, the
    // request's receipt row and — as before commit-on-delivery — the first
    // turn's record.
    await passes.settleAll();
    await ledger?.turnRecord.commit(FIRST_PASS);
    await ledger?.receipts.commit();
    request?.release();
  }
}

/** The verdict the stream delivers: stored once, a withheld one logged. */
function deliver(
  host: EnforceStreamHost,
  runId: string,
  input: ChatTurnInput,
  verdict: VerifierVerdict,
  retryCount: number,
  badge?: VerifierBadge,
): EnforcedVerdict {
  void host.judge.persist(runId, input, verdict, retryCount);
  const releases = verdictReleasesAnswer(verdict);
  const disclaimer = releases && verdictNeedsDisclaimer(verdict);
  if (!releases) {
    host.log(withheldLogLine(runId, verdict));
  } else if (disclaimer) {
    host.log(releasedWithDisclaimerLogLine(runId, verdict));
  }
  const summary = summarise(verdict, retryCount, 'enforce');
  return { summary: badge ? { ...summary, badge } : summary, releases, disclaimer };
}

/**
 * The correction retry for a contradiction: the turn re-entered with the
 * correction hint, over the first run's tool results. `undefined` when this
 * verdict buys none. A retry that ends without an ordinary answer, is
 * abandoned, or answers with placeholders the restore could not map back
 * (it would show fake values) leaves the first verdict in place. The hint
 * carries the claims only, and the orchestrator masks it for the wire like
 * the user's message (`wireExtraSystemHint`): a retry whose hint cannot be
 * masked is abandoned; behind a shield one whose hint the first turn's
 * masking would still alter is not sent (`privacySafeCorrection`). The
 * retry's answer is verified through the retry's own privacy view.
 */
async function streamRetry(
  host: EnforceStreamHost,
  runId: string,
  input: ChatTurnInput,
  observer: ChatStreamObserver | undefined,
  ledger: ToolReplayLedger,
  first: VerifierVerdict,
  firstEgress: StreamEgress,
  passes: StreamPasses,
): Promise<(EnforcedRetry & { readonly pass: number }) | undefined> {
  if (first.status !== 'blocked' || host.policy.maxRetries <= 0) return undefined;
  const { correction, withheld } = await privacySafeCorrection(first, firstEgress.take());
  if (withheld) {
    host.log(
      `[verifier/service] retry withheld run=${runId} — the correction would carry masked values (stream)`,
    );
  }
  if (!correction) return undefined;
  host.log(`${retryLogLine(runId, first)} (stream)`);
  const retryInput: ChatTurnInput = { ...input, extraSystemHint: correction };
  const pass = prepareReentry(host.orchestrator, retryInput, ledger);
  const retryEgress = passes.open(retryInput);
  return {
    pass,
    stream: host.orchestrator.chatStream(retryInput, observer),
    judge: async (done) => {
      const abandoned = ledger.abortedTool;
      if (done === undefined || abandoned !== undefined) {
        host.log(
          abandoned !== undefined
            ? reentryAbandonedLine('retry', runId, abandoned)
            : `[verifier/service] retry FAIL run=${runId}: the retry ended without an answer`,
        );
        return { ...deliver(host, runId, input, first, 0), useRetry: false };
      }
      const egress = retryEgress.take();
      if (egress !== undefined && (await egress.countUnresolvedSurrogates(done.answer)) > 0) {
        host.log(
          `[verifier/service] retry answer carries unresolved placeholders — keeping the earlier answer run=${runId}`,
        );
        return { ...deliver(host, runId, input, first, 0), useRetry: false };
      }
      const second =
        (await host.judge.verdictFor(runId, input, done, egress)) ?? privacyShieldVerdict();
      return {
        ...deliver(host, runId, input, second, 1, mergeBadges(first, second)),
        useRetry: true,
      };
    },
  };
}
