/**
 * Per-request tool replay ledger: a user request runs each tool call at most
 * once, however often the turn is re-entered.
 *
 * ## The problem
 *
 * In `enforce` mode the answer verifier re-enters a turn: a borderline verdict
 * draws a second sample, a contradiction a correction retry (buffered and,
 * since this ledger, streamed), a contradicting resample both. Every re-entry
 * used to be a complete fresh turn that executed whatever the model called, so
 * a write the first run had already made ran two or three times for one user
 * request. The idempotency store (`toolIdempotency.ts`) does not help here: it
 * needs a caller key the chat path never has, and a re-sampled model rarely
 * repeats a write payload byte for byte.
 *
 * ## What this module provides
 *
 * A {@link ToolReplayLedger} is created per request and travels through
 * `turnContext.toolReplayLedger` to every seam that runs a tool handler
 * (`Orchestrator.dispatchToolDeadlined`, `LocalSubAgent.dispatch`,
 * `ToolDispatchService.invoke`). Each seam asks {@link ToolReplayLedger.decide}
 * before the handler runs and reports what the handler did with
 * {@link ToolReplayLedger.record}.
 *
 *  - **record** (the first run): every call executes; its outcome — the raw
 *    result the turn used, or the exception it threw — is recorded under
 *    (seam, tool name, canonical input). Two identical calls both run and are
 *    both recorded: first-run behaviour does not change.
 *  - **replay** (after {@link ToolReplayLedger.beginReentry}): a recorded call
 *    returns the recorded outcome without running the handler — a thrown
 *    handler replays as the same rejection — through per-key read cursors, so
 *    N identical first-run calls replay N outcomes in order. `beginReentry`
 *    resets every cursor, so a resample followed by a correction retry replays
 *    the first run twice. A call the first run did not make runs only when the
 *    seam knows the tool is read-only; any other miss is refused (the seam
 *    answers with {@link replayMissNotice}) and marks the re-entry abandoned
 *    ({@link ToolReplayLedger.abortedTool}). The orchestrator then throws
 *    {@link ToolReplayAbortError} and the verifier keeps its first answer.
 *
 * Independently of re-entries, a call whose outcome is unknown — its handler
 * threw, or its wrapper returned the withheld exception notice — is never
 * repeated identically within the request unless it is read-only: the repeat
 * is refused (`refuse-repeat`). Every turn carries a ledger for that, also
 * when no verifier is installed; such a turn-local ledger keeps no results.
 *
 * Below the seams, while a request ledger is bound, each seam runs its
 * handler through {@link runHandlerAtMostOnce}: no call beneath it is re-sent
 * by its transport (the MCP client's retry after a transient failure, which
 * cannot tell "never executed" from "executed, reply lost") — a re-send this
 * ledger, which sees one handler call, could not stop.
 *
 * A request ledger also holds the request's record (`requestTurnRecord.ts`):
 * its passes offer their session-log row there, and the verifier writes the
 * row of the pass it delivers. It keeps the first run's attachment ingestion
 * too ({@link ToolReplayLedger.ingestAttachmentsOnce}): a re-entry reuses it
 * instead of importing the request's uploads again. Work that outlives the
 * request — a long-running task's detached runner — runs on a turn-local
 * ledger of its own ({@link runDetachedFromRequestLedger}).
 *
 * ## What it does NOT guarantee
 *
 *  - **One process, one request.** The ledger is an in-memory object that
 *    lives as long as the request. It is never persisted, logged or attached
 *    to a run trace or receipt: it holds RAW handler results from before the
 *    Privacy Shield, and the request's ingested uploads before masking — the
 *    same sensitivity as `captureRawToolResult`. A separate user request — a
 *    new message, a retried HTTP call — runs its tools again; so does another
 *    middleware instance.
 *  - **Exact inputs.** Keys use the stable-JSON fingerprint of the input
 *    (`fingerprintToolInput`): key order does not matter, any other difference
 *    does. A re-entry whose model asks for a slightly different write is
 *    abandoned rather than matched loosely — fuzzy matching would run a
 *    different write.
 *  - **Positive read-only knowledge only.** A seam reports `readOnly` only
 *    for tools it knows to be read-only (the orchestrator's own kernel
 *    reads). The plugin contract has no read-only declaration, and a missing
 *    `writeCapabilities` is not one, so every plugin, MCP, domain and
 *    sub-agent tool counts as a write on a miss.
 *  - **No undo.** The first run's effects stand; the ledger only keeps them
 *    from happening again in the same request.
 */

import type { AskObserver } from './tools/domainQueryTool.js';
import { fingerprintToolInput, runSendingEachCallOnce } from './toolIdempotency.js';
import { REENTRY_ABANDONED } from './reentryAbandonment.js';
import { RequestReceipts } from './requestReceipts.js';
import { RequestTurnRecord } from './requestTurnRecord.js';
import { turnContext } from './turnContext.js';

export {
  REENTRY_ABANDONED,
  ToolReplayAbortError,
  describeAbandonment,
  replayMissNotice,
} from './reentryAbandonment.js';

/** Where a handler runs: the orchestrator's dispatch, one sub-agent's inner
 *  loop, or the standalone dispatcher (loopback MCP / CLI sub-agents). */
export type ToolReplaySeam = 'orchestrator' | 'dispatch' | `subagent:${string}`;

/**
 * One sub-agent observer event a domain-tool dispatch emitted in the first run.
 * Replayed with the domain tool's result so the re-entry's run trace — and the
 * verifier evidence read from it (inner calls, postconditions) — matches the
 * first run's. Token, phase and usage callbacks are not recorded: they are
 * liveness and cost signals of a model call the replay does not make.
 */
export type ReplayedSubEvent =
  | { readonly type: 'iteration'; readonly iteration: number }
  | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown }
  | {
      readonly type: 'tool_result';
      readonly id: string;
      readonly output: string;
      readonly durationMs: number;
      readonly isError: boolean;
      readonly postcondition?: { readonly issues: readonly string[] };
    };

/** What one handler call of the first run came to. */
export type ToolReplayRecord =
  /** The raw value the turn used (a string, or a sub-agent tool's structured
   *  result), with the sub-agent events its dispatch emitted. */
  | { readonly kind: 'result'; readonly value: unknown; readonly subEvents?: readonly ReplayedSubEvent[] }
  /** The handler threw; a replay rejects with the same value. */
  | { readonly kind: 'rejection'; readonly error: unknown }
  /** Runs again on a re-entry; the calls beneath it replay at their own seam
   *  (a sub-agent whose results only exist in the first run's privacy scope). */
  | { readonly kind: 'rerun' }
  /** Cannot be handed to a re-entry; one that needs it is abandoned. */
  | { readonly kind: 'unreplayable' };

export type ReplayableRecord = Extract<ToolReplayRecord, { kind: 'result' | 'rejection' }>;

export type ToolReplayDecision =
  /** Run the handler. */
  | { readonly action: 'execute' }
  /** Hand back the recorded outcome; the handler does not run. */
  | { readonly action: 'replay'; readonly record: ReplayableRecord }
  /** An identical call ended in an exception earlier in the request. */
  | { readonly action: 'refuse-repeat' }
  /** A re-entry needs a call outside the first run; it is abandoned. */
  | { readonly action: 'refuse-miss' };

export interface ToolReplayDecideOptions {
  /** True only when the seam KNOWS the tool cannot change data. */
  readonly readOnly: boolean;
}

export interface ToolReplayLedgerOptions {
  /** Keep first-run results for replay. False for a turn no re-entry can
   *  follow: only calls with an unknown outcome are tracked. Default true. */
  readonly retainResults?: boolean;
}

/** What a native tool's attachment sink hands the orchestrator (a diagram, a
 *  generated file); structurally `NativeToolAttachment` (`@omadia/plugin-api`). */
export interface ReplayedAttachment {
  readonly kind: string;
  readonly payload: unknown;
}

export class ToolReplayLedger {
  readonly #retainResults: boolean;
  #mode: 'record' | 'replay' = 'record';
  /** 0 for the first run, +1 per `beginReentry()`. */
  #pass = 0;
  readonly #entries = new Map<string, ToolReplayRecord[]>();
  readonly #cursors = new Map<string, number>();
  /** Calls whose outcome is unknown, from the first run (kept for the request). */
  readonly #unknown = new Set<string>();
  /** Calls whose outcome is unknown, from the current re-entry only. */
  readonly #reentryUnknown = new Set<string>();
  #abortedTool: string | undefined;
  /** What each native tool's sink attached in the first run, by tool name. */
  readonly #attachments = new Map<string, ReplayedAttachment[]>();
  /** Orchestrator-seam tools the current pass replayed whose attachments it
   *  has not been handed yet, and those it has (once per pass). */
  readonly #replayedTools = new Set<string>();
  readonly #attachmentsHandedOut = new Set<string>();
  /** What the first run's attachment ingestion handed the turn. */
  #ingestion: Promise<unknown> | undefined;
  /** The request's privacy receipts, one per pass (`requestReceipts.ts`). */
  readonly receipts = new RequestReceipts();
  /** The request's recorded turn: the row of the pass the verifier delivers
   *  (`requestTurnRecord.ts`). Used only while {@link defersTurnRecord}. */
  readonly turnRecord = new RequestTurnRecord();

  constructor(options: ToolReplayLedgerOptions = {}) {
    this.#retainResults = options.retainResults ?? true;
  }

  /** `record` for the first run, `replay` from the first re-entry on. */
  get mode(): 'record' | 'replay' {
    return this.#mode;
  }

  /** The pass running now: 0 for the first run, then 1, 2, … per re-entry. */
  get pass(): number {
    return this.#pass;
  }

  /** Whether first-run results are kept (false for a turn-local ledger). */
  get retainsResults(): boolean {
    return this.#retainResults;
  }

  /**
   * True for a request ledger — the one a verifier binds to a request it may
   * re-enter: each pass offers its record to {@link turnRecord} instead of
   * writing it, and the verifier commits the pass it delivers. False for a
   * turn-local ledger, whose turn writes its record itself.
   */
  get defersTurnRecord(): boolean {
    return this.#retainResults;
  }

  /** The tool whose miss abandoned the current re-entry, if one did. */
  get abortedTool(): string | undefined {
    return this.#abortedTool;
  }

  /** Starts a re-entry: replay from the top of the first run. */
  beginReentry(): void {
    this.#mode = 'replay';
    this.#pass += 1;
    this.#cursors.clear();
    this.#reentryUnknown.clear();
    this.#replayedTools.clear();
    this.#attachmentsHandedOut.clear();
    this.#abortedTool = undefined;
  }

  /** What a seam does with one call, decided before its handler runs. */
  decide(
    seam: ToolReplaySeam,
    toolName: string,
    input: unknown,
    options: ToolReplayDecideOptions,
  ): ToolReplayDecision {
    const fingerprint = fingerprintToolInput(input);
    const unknownKey = callKey(toolName, fingerprint);
    if (this.#mode === 'record') {
      return !options.readOnly && this.#unknown.has(unknownKey)
        ? { action: 'refuse-repeat' }
        : { action: 'execute' };
    }
    const key = entryKey(seam, toolName, fingerprint);
    const recorded = this.#entries.get(key) ?? [];
    const cursor = this.#cursors.get(key) ?? 0;
    const record = recorded[cursor];
    if (record !== undefined) {
      this.#cursors.set(key, cursor + 1);
      switch (record.kind) {
        case 'result':
          if (seam === 'orchestrator') this.#replayedTools.add(toolName);
          return { action: 'replay', record };
        case 'rejection':
          return { action: 'replay', record };
        case 'rerun':
          return { action: 'execute' };
        case 'unreplayable':
          this.abort(toolName);
          return { action: 'refuse-miss' };
      }
    }
    if (!options.readOnly && (this.#unknown.has(unknownKey) || this.#reentryUnknown.has(unknownKey))) {
      return { action: 'refuse-repeat' };
    }
    if (options.readOnly) return { action: 'execute' };
    this.abort(toolName);
    return { action: 'refuse-miss' };
  }

  /**
   * Reports what one executed call came to. Recorded in the first run only —
   * a re-entry runs over the first run's results and adds none. A rejection
   * also marks the call's outcome unknown, on a re-entry too.
   */
  record(seam: ToolReplaySeam, toolName: string, input: unknown, record: ToolReplayRecord): void {
    const fingerprint = fingerprintToolInput(input);
    if (record.kind === 'rejection') this.#markUnknown(callKey(toolName, fingerprint));
    if (this.#mode !== 'record' || !this.#retainResults) return;
    const key = entryKey(seam, toolName, fingerprint);
    const list = this.#entries.get(key);
    if (list) list.push(record);
    else this.#entries.set(key, [record]);
  }

  /** Marks a call whose outcome is unknown although its handler returned
   *  (a wrapper caught the exception and returned the withheld notice). */
  noteUnknownOutcome(toolName: string, input: unknown): void {
    this.#markUnknown(callKey(toolName, fingerprintToolInput(input)));
  }

  /** Marks the current re-entry abandoned; the first miss names it. */
  abort(toolName: string): void {
    if (this.#mode === 'replay' && this.#abortedTool === undefined) this.#abortedTool = toolName;
  }

  /**
   * Keeps what one native tool's attachment sink handed over in the first
   * run (a diagram, a generated file). A replayed call fills no sink, so a
   * re-entry gets these back through {@link takeReplayedAttachments}.
   */
  recordAttachments(toolName: string, attachments: readonly ReplayedAttachment[]): void {
    if (this.#mode !== 'record' || !this.#retainResults || attachments.length === 0) return;
    const list = this.#attachments.get(toolName);
    if (list) list.push(...attachments);
    else this.#attachments.set(toolName, [...attachments]);
  }

  /**
   * The first run's attachments of every tool the current pass replayed —
   * each tool's once per pass, like a sink that clears on read. Per tool, not
   * per call: a pass that replays one of two calls gets both calls' files.
   */
  takeReplayedAttachments(): ReplayedAttachment[] {
    const out: ReplayedAttachment[] = [];
    for (const tool of this.#replayedTools) {
      if (this.#attachmentsHandedOut.has(tool)) continue;
      this.#attachmentsHandedOut.add(tool);
      out.push(...(this.#attachments.get(tool) ?? []));
    }
    this.#replayedTools.clear();
    return out;
  }

  /**
   * The request's attachment ingestion (`Orchestrator.ingestAttachments`),
   * once per request. The first run ingests and keeps what it got — the
   * extracted text and `[dataset-imported]` blocks before masking, the image
   * blocks — and every re-entry gets exactly that back: an upload is fetched
   * and imported as a dataset once, and a re-entry's model is told the same
   * dataset ids the replayed first-run results refer to. A re-entry with no
   * first-run ingestion to reuse is abandoned and gets `abandoned`: ingesting
   * there would import outside the first run. A turn-local ledger keeps
   * nothing and ingests every time. `ingest` must not throw.
   *
   * Single-flight: the first run's ingestion is kept as a promise from the
   * moment it starts, so a second caller that arrives while it is still
   * running — in the first run or in a re-entry — awaits the same import
   * instead of starting another one.
   */
  async ingestAttachmentsOnce<T>(ingest: () => Promise<T>, abandoned: T): Promise<T> {
    if (!this.#retainResults) return ingest();
    if (this.#ingestion !== undefined) return (await this.#ingestion) as T;
    if (this.#mode === 'record') {
      const pending = ingest();
      this.#ingestion = pending;
      return pending;
    }
    this.abort(REENTRY_ABANDONED.attachmentsNotRecorded);
    return abandoned;
  }

  #markUnknown(key: string): void {
    if (this.#mode === 'record') this.#unknown.add(key);
    else this.#reentryUnknown.add(key);
  }
}

/**
 * Runs one seam's tool handler (`Orchestrator.dispatchToolDeadlined`,
 * `LocalSubAgent.dispatch`, `ToolDispatchService.invoke`, the MCP input-card
 * replay). Inside a request a verifier bound a ledger to (`retainsResults`),
 * every call beneath the handler is sent at most once
 * (`runSendingEachCallOnce`, `toolIdempotency.ts`): the MCP client does not
 * re-send a call after a transient transport failure, which cannot tell
 * "never executed" from "executed, reply lost" — a retry would run a write a
 * second time below this ledger, which sees one handler call. Any other turn
 * runs the handler as it is.
 */
export function runHandlerAtMostOnce<T>(
  ledger: ToolReplayLedger | undefined,
  handler: () => Promise<T>,
): Promise<T> {
  return ledger?.retainsResults === true ? runSendingEachCallOnce(handler) : handler();
}

/**
 * Runs `fn` — work started inside a turn that outlives it, like a
 * long-running task's detached runner — on a turn-local ledger of its own
 * instead of the ledger of the request that started it.
 *
 * Everything else of the turn context carries over unchanged. Only the ledger
 * must not: the runner keeps working after the request's first run, also
 * while the verifier re-enters the request, and a request ledger in replay
 * mode would refuse the runner's calls as misses outside the first run (and
 * abandon the re-entry running at that moment) or hand them first-run
 * results. The runner would also keep the request's raw results alive for as
 * long as it runs. Its own ledger still refuses an identical repeat of a call
 * whose outcome is unknown, within the task.
 */
export function runDetachedFromRequestLedger<T>(fn: () => Promise<T>): Promise<T> {
  const ctx = turnContext.current();
  if (ctx?.toolReplayLedger === undefined) return fn();
  return turnContext.run(
    { ...ctx, toolReplayLedger: new ToolReplayLedger({ retainResults: false }) },
    fn,
  );
}

function callKey(toolName: string, fingerprint: string): string {
  return `${toolName}\u0000${fingerprint}`;
}

function entryKey(seam: ToolReplaySeam, toolName: string, fingerprint: string): string {
  return `${seam}\u0000${toolName}\u0000${fingerprint}`;
}

/**
 * Wraps a dispatch's observer so the sub-agent events it emits are recorded
 * for replay; every event still reaches the wrapped observer.
 */
export class SubEventRecorder {
  readonly events: ReplayedSubEvent[] = [];
  readonly observer: AskObserver;

  constructor(inner: AskObserver | undefined) {
    const events = this.events;
    // Every callback delegates explicitly (no spread), so an observer whose
    // methods live on a prototype loses none of them.
    this.observer = {
      onIteration(ev) {
        events.push({ type: 'iteration', iteration: ev.iteration });
        inner?.onIteration?.(ev);
      },
      onSubToolUse(ev) {
        events.push({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
        inner?.onSubToolUse?.(ev);
      },
      onSubToolResult(ev) {
        events.push({
          type: 'tool_result',
          id: ev.id,
          output: ev.output,
          durationMs: ev.durationMs,
          isError: ev.isError,
          ...(ev.postcondition ? { postcondition: ev.postcondition } : {}),
        });
        inner?.onSubToolResult?.(ev);
      },
      onIterationPhase(ev) {
        inner?.onIterationPhase?.(ev);
      },
      onTokenChunk(ev) {
        inner?.onTokenChunk?.(ev);
      },
      onIterationUsage(ev) {
        inner?.onIterationUsage?.(ev);
      },
      onIterationEnd(ev) {
        inner?.onIterationEnd?.(ev);
      },
    };
  }
}

/** Re-emits recorded sub-agent events to a re-entry's observer, inner tool
 *  results flagged `replayed`. A throwing observer is logged and skipped. */
export function replaySubEvents(
  observer: AskObserver | undefined,
  events: readonly ReplayedSubEvent[] | undefined,
): void {
  if (!observer || !events) return;
  for (const ev of events) {
    try {
      if (ev.type === 'iteration') {
        observer.onIteration?.({ iteration: ev.iteration });
      } else if (ev.type === 'tool_use') {
        observer.onSubToolUse?.({ id: ev.id, name: ev.name, input: ev.input });
      } else {
        observer.onSubToolResult?.({
          id: ev.id,
          output: ev.output,
          durationMs: ev.durationMs,
          isError: ev.isError,
          ...(ev.postcondition ? { postcondition: ev.postcondition } : {}),
          replayed: true,
        });
      }
    } catch (err) {
      console.warn('[tool-replay] observer threw on a replayed sub-agent event:', err);
    }
  }
}
