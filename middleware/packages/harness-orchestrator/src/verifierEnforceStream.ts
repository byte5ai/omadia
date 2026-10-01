import type { ChatStreamObserver } from '@omadia/channel-sdk';
import type { VerifierBadge, VerifierVerdict } from '@omadia/verifier';
import { buildCorrectionPrompt } from '@omadia/verifier';
import type { ChatStreamEvent, ChatTurnInput, Orchestrator } from './orchestrator.js';
import type { ToolReplayLedger } from './toolReplayLedger.js';
import {
  enforcedVerifiedStream,
  verdictReleasesAnswer,
  type EnforcedRetry,
  type EnforcedVerdict,
} from './verifierDelivery.js';
import type { VerifierJudge } from './verifierJudge.js';
import {
  afterRequestRecord,
  bindRequestLedger,
  finishRequestDone,
  FIRST_PASS,
  prepareReentry,
  reentryAbandonedLine,
  type ReentryPolicy,
} from './verifierReentry.js';
import { mergeBadges, summarise } from './verifierVerdicts.js';

/** What the `enforce` stream needs from `VerifierService`. */
export interface EnforceStreamHost {
  readonly orchestrator: Orchestrator;
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
 */
export async function* enforcedVerifierStream(
  host: EnforceStreamHost,
  runId: string,
  input: ChatTurnInput,
  observer: ChatStreamObserver | undefined,
): AsyncGenerator<ChatStreamEvent> {
  const request = bindRequestLedger(host.orchestrator, input, host.policy, 'stream');
  const ledger = request?.ledger;
  let retryPass = FIRST_PASS;
  try {
    yield* enforcedVerifiedStream(
      host.orchestrator.chatStream(input, observer),
      async (done) => {
        const verdict = await host.judge.verdictFor(runId, input, done);
        // #133 (E6) — record the block on this turn's plan, once the
        // request's record (its `onAfterTurn`) is in.
        if (verdict.status === 'blocked') {
          afterRequestRecord(ledger, () => {
            host.fireVerifierBlocked(input, verdict);
          });
        }
        const retry = ledger
          ? streamRetry(host, runId, input, observer, ledger, verdict)
          : undefined;
        if (retry) retryPass = retry.pass;
        return retry
          ? { summary: summarise(verdict, 0, 'enforce'), releases: false, retry }
          : deliver(host, runId, input, verdict, 0);
      },
      host.locale,
      ledger
        ? (done, fromRetry) => finishRequestDone(done, fromRetry ? retryPass : FIRST_PASS, ledger)
        : undefined,
    );
  } finally {
    // Normally written before the final `done`. A consumer that stopped
    // reading early still gets the request's receipt row and — as before
    // commit-on-delivery — the first turn's record.
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
  if (!releases) {
    host.log(`[verifier/service] answer withheld run=${runId} status=${verdict.status}`);
  }
  const summary = summarise(verdict, retryCount, 'enforce');
  return { summary: badge ? { ...summary, badge } : summary, releases };
}

/**
 * The correction retry for a contradiction: the turn re-entered with the
 * correction hint, over the first run's tool results. `undefined` when this
 * verdict buys none. A retry that ends without an ordinary answer, or is
 * abandoned, leaves the first verdict in place.
 */
function streamRetry(
  host: EnforceStreamHost,
  runId: string,
  input: ChatTurnInput,
  observer: ChatStreamObserver | undefined,
  ledger: ToolReplayLedger,
  first: VerifierVerdict,
): (EnforcedRetry & { readonly pass: number }) | undefined {
  if (first.status !== 'blocked' || host.policy.maxRetries <= 0) return undefined;
  const correction = buildCorrectionPrompt(first);
  if (!correction) return undefined;
  host.log(
    `[verifier/service] retry run=${runId} contradictions=${String(first.contradictions.length)} (stream)`,
  );
  const retryInput: ChatTurnInput = { ...input, extraSystemHint: correction };
  const pass = prepareReentry(host.orchestrator, retryInput, ledger);
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
      const second = await host.judge.verdictFor(runId, input, done);
      return {
        ...deliver(host, runId, input, second, 1, mergeBadges(first, second)),
        useRetry: true,
      };
    },
  };
}
