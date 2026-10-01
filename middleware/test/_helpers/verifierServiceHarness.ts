/**
 * Drives a REAL `VerifierService` over a scripted orchestrator and a stubbed
 * verifier pipeline, and records what the service hands each collaborator.
 *
 * For the stream path it also records which events the consumer had already
 * received at the moment the pipeline was asked for a verdict. The service is
 * an async generator the consumer pulls from, so that snapshot is exact: an
 * event the consumer holds when `verify` runs was delivered before the
 * verdict existed.
 */

import type {
  VerifierInput,
  VerifierPipeline,
  VerifierStore,
  VerifierVerdict,
} from '@omadia/verifier';

import type {
  ChatStreamEvent,
  ChatStreamObserver,
  ChatTurnInput,
  ChatTurnResult,
} from '../../packages/harness-channel-sdk/src/chatAgent.js';
import type { Orchestrator } from '../../packages/harness-orchestrator/src/orchestrator.js';
import type { TurnHookRunner } from '../../packages/harness-orchestrator/src/turnHooks.js';
import { VerifierService } from '../../packages/harness-orchestrator/src/verifierService.js';

/** A verdict the stub pipeline returns, or an error it rejects with. */
export type ScriptedVerdict = VerifierVerdict | Error;

export interface VerifierHarnessOptions {
  mode: 'shadow' | 'enforce';
  enabled?: boolean;
  /** One event script per `orchestrator.chatStream` call; the last repeats. */
  streams?: readonly (readonly ChatStreamEvent[])[];
  /** One result per `orchestrator.runTurn` call; the last repeats. */
  results?: readonly ChatTurnResult[];
  /** One verdict per `pipeline.verify` call; the last repeats. */
  verdicts: readonly ScriptedVerdict[];
  maxRetries?: number;
  /** Operator locale for the withheld-answer notice. */
  locale?: string;
  /** Called when the pipeline is asked for a verdict, before it answers — for
   *  a consumer outside the harness (a wrapping agent) to snapshot what it
   *  holds at that moment. */
  onVerify?: () => void;
}

export interface PersistedRow {
  status: VerifierVerdict['status'];
  retryCount: number;
  mode: 'shadow' | 'enforce';
}

export interface VerifierHarness {
  readonly service: VerifierService;
  /** The input of each `pipeline.verify` call. */
  readonly verifyInputs: VerifierInput[];
  /** Event types the stream consumer held when each `verify` call ran. */
  readonly receivedAtVerify: string[][];
  readonly streamCalls: { input: ChatTurnInput; observer: ChatStreamObserver | undefined }[];
  readonly runTurnInputs: ChatTurnInput[];
  /** Inputs passed to `markScreeningReentry`, by identity. */
  readonly reentries: ChatTurnInput[];
  readonly persisted: PersistedRow[];
  /** Turn-hook points the service fired. */
  readonly hookPoints: string[];
  /** Drains `service.chatStream` and returns every event it yielded. */
  stream(input?: ChatTurnInput, observer?: ChatStreamObserver): Promise<ChatStreamEvent[]>;
}

export const USER_INPUT: ChatTurnInput = {
  userMessage: 'Wie hoch war der Umsatz im dritten Quartal?',
  sessionScope: 'scope-1',
};

function pick<T>(list: readonly T[], index: number, what: string): T {
  const value = list[Math.min(index, list.length - 1)];
  if (value === undefined) throw new Error(`harness: no ${what} scripted`);
  return value;
}

export function createVerifierHarness(opts: VerifierHarnessOptions): VerifierHarness {
  const received: ChatStreamEvent[] = [];
  const verifyInputs: VerifierInput[] = [];
  const receivedAtVerify: string[][] = [];
  const streamCalls: VerifierHarness['streamCalls'] = [];
  const runTurnInputs: ChatTurnInput[] = [];
  const reentries: ChatTurnInput[] = [];
  const persisted: PersistedRow[] = [];
  const hookPoints: string[] = [];
  const streams = opts.streams ?? [];
  const results = opts.results ?? [];

  const orchestrator = {
    agentId: 'default',
    markScreeningReentry(input: ChatTurnInput): void {
      reentries.push(input);
    },
    async *chatStream(
      input: ChatTurnInput,
      observer?: ChatStreamObserver,
    ): AsyncGenerator<ChatStreamEvent> {
      const script = pick(streams, streamCalls.length, 'stream');
      streamCalls.push({ input, observer });
      for (const event of script) {
        await Promise.resolve();
        yield event;
      }
    },
    runTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
      const result = pick(results, runTurnInputs.length, 'runTurn result');
      runTurnInputs.push(input);
      return Promise.resolve(result);
    },
  } as unknown as Orchestrator;

  const pipeline = {
    verify(input: VerifierInput): Promise<VerifierVerdict> {
      const next = pick(opts.verdicts, verifyInputs.length, 'verdict');
      verifyInputs.push(input);
      receivedAtVerify.push(received.map((e) => e.type));
      opts.onVerify?.();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  } as unknown as VerifierPipeline;

  const store = {
    persist(row: { verdict: VerifierVerdict; retryCount: number; mode: 'shadow' | 'enforce' }) {
      persisted.push({ status: row.verdict.status, retryCount: row.retryCount, mode: row.mode });
      return Promise.resolve();
    },
  } as unknown as VerifierStore;

  const turnHookRegistry: TurnHookRunner = {
    run(point) {
      hookPoints.push(point);
      return Promise.resolve([]);
    },
  };

  const service = new VerifierService({
    orchestrator,
    pipeline,
    store,
    enabled: opts.enabled ?? true,
    mode: opts.mode,
    maxRetries: opts.maxRetries ?? 1,
    log: () => undefined,
    turnHookRegistry,
    ...(opts.locale !== undefined ? { locale: opts.locale } : {}),
  });

  return {
    service,
    verifyInputs,
    receivedAtVerify,
    streamCalls,
    runTurnInputs,
    reentries,
    persisted,
    hookPoints,
    async stream(input = USER_INPUT, observer) {
      received.length = 0;
      for await (const event of service.chatStream(input, observer)) received.push(event);
      return [...received];
    },
  };
}
