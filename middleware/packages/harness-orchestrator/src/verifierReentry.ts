import type {
  ChatStreamEvent,
  ChatTurnInput,
  ChatTurnResult,
  Orchestrator,
} from './orchestrator.js';
import { ToolReplayAbortError, ToolReplayLedger } from './toolReplayLedger.js';

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
 * with an error the service never forwards. The first run also keeps the
 * request's persistence: a re-entry writes no session-log row, fires no turn
 * hook and leaves its privacy receipt with the ledger, which the service
 * merges into the delivered answer and writes as the request's one row.
 */

type DoneEvent = Extract<ChatStreamEvent, { type: 'done' }>;

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
 * to `runTurn` / `chatStream` unchanged).
 */
export function prepareReentry(
  orchestrator: Orchestrator,
  input: ChatTurnInput,
  ledger: ToolReplayLedger,
): void {
  ledger.beginReentry();
  // A retry's input is the service's own object, dropped with the request;
  // a resample re-binds the request's input, released by the caller.
  orchestrator.bindToolReplayLedger(input, ledger);
  // #579 — the re-entry re-runs an already-screened user turn; the inbound
  // gate does not screen or audit it a second time.
  orchestrator.markScreeningReentry(input);
}

/** The log line for a re-entry that needed a call outside the first run. */
export function reentryAbandonedLine(
  kind: 'resample' | 'retry',
  runId: string,
  toolName: string,
): string {
  return `[verifier/service] ${kind} abandoned run=${runId}: it needed tool "${toolName}", which the first run did not call — the first answer stands`;
}

/** The log line for a re-entry that produced no answer to judge. */
export function reentryFailureLine(
  kind: 'resample' | 'retry',
  runId: string,
  err: unknown,
): string {
  if (err instanceof ToolReplayAbortError) return reentryAbandonedLine(kind, runId, err.toolName);
  return `[verifier/service] ${kind} FAIL: ${err instanceof Error ? err.message : String(err)}`;
}

/** The delivered turn carrying the request's receipt: every pass merged. */
export function asRequestResult(
  result: ChatTurnResult,
  ledger: ToolReplayLedger | undefined,
): ChatTurnResult {
  const receipt = ledger?.receipts.merged();
  return receipt ? { ...result, privacyReceipt: receipt } : result;
}

/**
 * The stream's outgoing `done` as the request: the merged receipt, the key of
 * the request's receipt row and the persisted turn (both from the first run
 * when a re-entry's answer goes out). The row is written first, so the key
 * resolves the moment a consumer sees it.
 */
export async function finishRequestDone(
  done: DoneEvent,
  firstDone: DoneEvent | undefined,
  ledger: ToolReplayLedger,
): Promise<DoneEvent> {
  const receipt = ledger.receipts.merged();
  const receiptId = ledger.receipts.rowId;
  const turnId = done.turnId ?? firstDone?.turnId;
  await ledger.receipts.commit();
  return {
    ...done,
    ...(receipt ? { privacyReceipt: receipt } : {}),
    ...(receiptId !== undefined ? { receiptId } : {}),
    ...(turnId ? { turnId } : {}),
  };
}
