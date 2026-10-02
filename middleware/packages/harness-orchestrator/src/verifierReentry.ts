import type {
  ChatStreamEvent,
  ChatTurnInput,
  ChatTurnResult,
  Orchestrator,
} from './orchestrator.js';
import { ToolReplayAbortError, ToolReplayLedger, describeAbandonment } from './toolReplayLedger.js';
import type { FinishedDone } from './verifierDelivery.js';

/**
 * How `VerifierService` re-enters a turn — borderline resample, correction
 * retry, the stream's correction retry — as part of ONE user request.
 *
 * A re-entry re-generates the answer; it never repeats what the first run
 * did. The request gets a `ToolReplayLedger` bound to its input before the
 * first run (`bindRequestLedger`), the first run records every tool outcome
 * into it, and each re-entry replays them (`prepareReentry`): no tool runs
 * twice, a call the first run did not make runs only when it is a kernel
 * read, and a re-entry that needs any other call is abandoned — the
 * orchestrator throws `ToolReplayAbortError` (buffered) or ends the stream
 * with an error the service never forwards.
 *
 * The request has ONE record, and it holds the answer the user got
 * (commit-on-delivery, `requestTurnRecord.ts`): every pass — the first run
 * included — offers its session-log row and its `onAfterTurn` answer to the
 * ledger instead of writing them, and leaves its privacy receipt there. Once
 * the service decided which pass it delivers, it commits that pass's record
 * (for a withheld answer: the pass its final verdict was about) and the
 * request's one receipt row (`asRequestResult`, `finishRequestDone`).
 */

type DoneEvent = Extract<ChatStreamEvent, { type: 'done' }>;

/** The first run of a request; its re-entries are passes 1, 2, … */
export const FIRST_PASS = 0;

/** When a request may be re-entered at all. */
export interface ReentryPolicy {
  readonly mode: 'shadow' | 'enforce';
  readonly maxRetries: number;
  /** The borderline resample is on (`resampleOnBorderline` and a budget). */
  readonly resample: boolean;
}

/** A request's ledger, bound to its input until `release()`. */
export interface RequestLedger {
  readonly ledger: ToolReplayLedger;
  /** Removes the binding; call once the request is over. */
  readonly release: () => void;
}

/**
 * Binds a fresh ledger to the request's input when the request may be
 * re-entered: `enforce` with a resample or a retry allowed (`chat`), or with
 * a retry allowed on a turn that is not a canvas turn (`stream` — the canvas
 * composer pairs surfaces with tool results by tool name, which a retry that
 * reorders calls would confuse). Otherwise no ledger: the turn persists and
 * runs exactly as before.
 */
export function bindRequestLedger(
  orchestrator: Orchestrator,
  input: ChatTurnInput,
  policy: ReentryPolicy,
  path: 'chat' | 'stream',
): RequestLedger | undefined {
  if (policy.mode !== 'enforce') return undefined;
  const reenters =
    path === 'chat'
      ? policy.maxRetries > 0 || policy.resample
      : policy.maxRetries > 0 && input.canvasSessionId === undefined;
  if (!reenters) return undefined;
  const ledger = new ToolReplayLedger();
  return { ledger, release: orchestrator.bindToolReplayLedger(input, ledger) };
}

/**
 * Starts one re-entry of the request with `input` (the same object for a
 * resample, a new one carrying the correction hint for a retry — pass it on
 * to `runTurn` / `chatStream` unchanged). Returns the pass the re-entry runs
 * as: the one to commit when its answer is the one delivered.
 */
export function prepareReentry(
  orchestrator: Orchestrator,
  input: ChatTurnInput,
  ledger: ToolReplayLedger,
): number {
  ledger.beginReentry();
  // A retry's input is the service's own object, dropped with the request;
  // a resample re-binds the request's input, released by the caller.
  orchestrator.bindToolReplayLedger(input, ledger);
  // #579 — the re-entry re-runs an already-screened user turn; the inbound
  // gate does not screen or audit it a second time.
  orchestrator.markScreeningReentry(input);
  return ledger.pass;
}

/**
 * Runs `fn` once the request's record is committed — at once without a
 * ledger, where the turn recorded itself already. For a signal that must
 * follow the request's `onAfterTurn`, as it followed the first run's before
 * commit-on-delivery: `onVerifierBlocked` marks the plan step the turn's
 * `onAfterTurn` finished.
 */
export function afterRequestRecord(ledger: ToolReplayLedger | undefined, fn: () => void): void {
  if (ledger === undefined) {
    fn();
    return;
  }
  void ledger.turnRecord.whenCommitted().then(fn);
}

/** The log line for a re-entry that could not stay inside the first run:
 *  `name` is the tool it needed, or one of `REENTRY_ABANDONED`. */
export function reentryAbandonedLine(
  kind: 'resample' | 'retry',
  runId: string,
  name: string,
): string {
  return `[verifier/service] ${kind} abandoned run=${runId}: ${describeAbandonment(name)} — the first answer stands`;
}

/**
 * The log line for a re-entry that produced no answer to judge. Names the
 * run, the error's class and a closed code — never the error's message,
 * which can quote a tool's or provider's output (the turn's own seams
 * already logged and receipted what failed).
 */
export function reentryFailureLine(
  kind: 'resample' | 'retry',
  runId: string,
  err: unknown,
): string {
  if (err instanceof ToolReplayAbortError) return reentryAbandonedLine(kind, runId, err.toolName);
  return `[verifier/service] ${kind} FAIL run=${runId} class=${errorClass(err)} code=${REENTRY_FAILED}`;
}

/** The closed code of a re-entry that threw for a reason other than leaving
 *  the first run's results (`ToolReplayAbortError`). */
export const REENTRY_FAILED = 'reentry_turn_failed';

/** An error's class name, cut to identifier characters: it comes from code,
 *  not from data, and is safe to log. */
function errorClass(err: unknown): string {
  const name =
    typeof err === 'object' && err !== null ? (err.constructor as { name?: unknown }).name : typeof err;
  const safe = typeof name === 'string' ? name.replace(/[^A-Za-z0-9_$]/g, '').slice(0, 64) : '';
  return safe.length > 0 ? safe : 'unknown';
}

/**
 * The delivered turn as the request's: the record of `pass` — the pass that
 * produced `result` — committed and its Turn id on the result, every pass's
 * receipt merged in. Unchanged without a ledger (the turn recorded itself).
 */
export async function asRequestResult(
  result: ChatTurnResult,
  pass: number,
  ledger: ToolReplayLedger | undefined,
): Promise<ChatTurnResult> {
  if (ledger === undefined) return result;
  const committed = await ledger.turnRecord.commit(pass);
  const receipt = ledger.receipts.merged();
  return {
    ...result,
    ...(committed.turnId !== undefined ? { turnId: committed.turnId } : {}),
    ...(receipt ? { privacyReceipt: receipt } : {}),
  };
}

/**
 * The stream's outgoing `done` as the request: the record of `pass` — the
 * pass `done` came from — committed, with its Turn id and auto-promoted
 * memory on `done` and the events the commit produced (the request's
 * `onAfterTurn` annotations, Knowledge-Graph insert pulses) to go out before
 * it; plus the merged receipt and the key of the request's receipt row. Both
 * rows are written first, so the keys resolve the moment a consumer sees them.
 */
export async function finishRequestDone(
  done: DoneEvent,
  pass: number,
  ledger: ToolReplayLedger,
): Promise<FinishedDone> {
  const committed = await ledger.turnRecord.commit(pass);
  const receipt = ledger.receipts.merged();
  const receiptId = ledger.receipts.rowId;
  await ledger.receipts.commit();
  return {
    done: {
      ...done,
      ...(receipt ? { privacyReceipt: receipt } : {}),
      ...(receiptId !== undefined ? { receiptId } : {}),
      ...(committed.turnId !== undefined ? { turnId: committed.turnId } : {}),
      ...(committed.autoPromotedMkId !== undefined
        ? { autoPromotedMkId: committed.autoPromotedMkId }
        : {}),
    },
    events: committed.events,
  };
}
