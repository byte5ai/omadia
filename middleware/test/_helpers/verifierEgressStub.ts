/**
 * Stub orchestrator for the verifier wrapper's privacy hand-over tests. It
 * implements `markPrivacyFinalizeHeld` / `takePrivacyEgress` /
 * `isPrivacyGuardActive` with recording continuations, so a test pins the
 * wrapper's side of the contract: which view reaches the pipeline, when
 * `done` is emitted, and how often each turn is finalized.
 */

import { strict as assert } from 'node:assert';

import type {
  ClaimVerdict,
  VerifierInput,
  VerifierPipeline,
  VerifierPrivacy,
  VerifierVerdict,
} from '@omadia/verifier';
import type { PrivacyReceipt } from '@omadia/plugin-api';
import type {
  ChatStreamEvent,
  ChatTurnInput,
  ChatTurnResult,
} from '../../packages/harness-channel-sdk/src/chatAgent.js';
import type { Orchestrator } from '../../packages/harness-orchestrator/src/orchestrator.js';
import type { PrivacyEgressContinuation } from '../../packages/harness-orchestrator/src/privacyEgress.js';

export interface RecordingContinuation extends PrivacyEgressContinuation {
  finalizeCalls: number;
  readonly receipt: PrivacyReceipt;
}

export interface ContinuationOpts {
  readonly wireAnswer?: string | undefined;
  /** The prompt the turn's model received; defaults to the run's input. */
  readonly wireUserMessage?: string;
  readonly maskWouldAlter?: boolean;
  readonly unresolved?: number;
}

function receiptFor(n: number): PrivacyReceipt {
  return {
    datasetsInterned: n,
    fieldsMasked: 0,
    fieldsCleartext: 0,
    verbsExecuted: [],
    pseudonymProjectionUsed: false,
    verifierEgress: { requests: n, maskedSpans: [] },
  };
}

function recordingContinuation(
  n: number,
  opts: ContinuationOpts,
  input: ChatTurnInput,
): RecordingContinuation {
  const receipt = receiptFor(n);
  const view: VerifierPrivacy | undefined =
    opts.wireAnswer === undefined
      ? undefined
      : {
          wireUserMessage: opts.wireUserMessage ?? input.userMessage,
          wireAnswer: opts.wireAnswer,
          admitWireView: async () => undefined,
          projectForWire: async (t) => t,
          restore: async (t) => t,
        };
  const c: RecordingContinuation = {
    receiptId: `turn-${String(n)}`,
    verifierPrivacy: view,
    receipt,
    finalizeCalls: 0,
    maskWouldAlter: async () => opts.maskWouldAlter === true,
    countUnresolvedSurrogates: async () => opts.unresolved ?? 0,
    finalize: async () => {
      c.finalizeCalls += 1;
      return receipt;
    },
  };
  return c;
}

export interface StubState {
  readonly marks: ChatTurnInput[];
  readonly runs: ChatTurnInput[];
  readonly continuations: RecordingContinuation[];
  streamClosed: boolean;
}

export function stubOrchestrator(opts: {
  readonly results?: readonly ChatTurnResult[];
  readonly stream?: readonly ChatStreamEvent[];
  /** Hand the finalisation over when marked (a privacy provider is wired). */
  readonly handOver?: boolean;
  readonly privacyActive?: boolean;
  /** Per-turn continuation options, by run index; default: a view whose
   *  wire answer is the run's own answer. */
  readonly continuation?: (index: number, result: ChatTurnResult) => ContinuationOpts;
  readonly throwOnRun?: number;
}): { orchestrator: Orchestrator; state: StubState } {
  const held = new WeakSet<object>();
  const stashed = new WeakMap<object, RecordingContinuation>();
  const state: StubState = { marks: [], runs: [], continuations: [], streamClosed: false };
  const handOver = (input: ChatTurnInput, result: ChatTurnResult): void => {
    if (!held.delete(input) || opts.handOver !== true) return;
    const index = state.continuations.length;
    const c = recordingContinuation(
      index + 1,
      opts.continuation?.(index, result) ?? { wireAnswer: result.answer },
      input,
    );
    state.continuations.push(c);
    stashed.set(input, c);
  };
  const orchestrator = {
    agentId: 'default',
    markScreeningReentry(): void {},
    markPrivacyFinalizeHeld(input: ChatTurnInput): void {
      state.marks.push(input);
      held.add(input);
    },
    takePrivacyEgress(input: ChatTurnInput): PrivacyEgressContinuation | undefined {
      const c = stashed.get(input);
      stashed.delete(input);
      return c;
    },
    isPrivacyGuardActive: (): boolean => opts.privacyActive === true,
    async runTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
      const index = state.runs.length;
      state.runs.push(input);
      if (opts.throwOnRun === index) throw new Error('turn failed');
      const result = opts.results?.[index] ?? opts.results?.[opts.results.length - 1];
      assert.ok(result, 'stub has no scripted result');
      handOver(input, result);
      return result;
    },
    async *chatStream(input: ChatTurnInput): AsyncGenerator<ChatStreamEvent> {
      state.runs.push(input);
      try {
        for (const event of opts.stream ?? []) {
          if (event.type === 'done') {
            handOver(input, { answer: event.answer, toolCalls: 0, iterations: 0 });
          }
          await Promise.resolve();
          yield event;
        }
      } finally {
        state.streamClosed = true;
      }
    },
  };
  return { orchestrator: orchestrator as unknown as Orchestrator, state };
}

/** A pipeline that returns `sequence` in order and records its inputs. */
export function verdicts(sequence: readonly VerifierVerdict[]): {
  pipeline: VerifierPipeline;
  inputs: VerifierInput[];
  onVerify: { hook?: () => void };
} {
  const inputs: VerifierInput[] = [];
  const onVerify: { hook?: () => void } = {};
  let i = 0;
  const pipeline = {
    verify: async (input: VerifierInput): Promise<VerifierVerdict> => {
      inputs.push(input);
      onVerify.hook?.();
      const v = sequence[i] ?? sequence[sequence.length - 1]!;
      i += 1;
      return v;
    },
  } as unknown as VerifierPipeline;
  return { pipeline, inputs, onVerify };
}

/** A pipeline whose every verification throws. */
export function failingPipeline(): VerifierPipeline {
  return {
    verify: async (): Promise<VerifierVerdict> => {
      throw new Error('verifier provider down');
    },
  } as unknown as VerifierPipeline;
}

const CLAIM = {
  id: 'c_001',
  text: 'Die Rechnung ist offen',
  type: 'qualitative' as const,
  expectedSource: 'odoo' as const,
  relatedEntities: [],
};
// The channel badge only shows when at least one claim was checked.
export const APPROVED: VerifierVerdict = {
  status: 'approved',
  claims: [{ status: 'verified', claim: CLAIM, source: 'odoo' }],
  latencyMs: 0,
};
export const BORDERLINE: VerifierVerdict = {
  status: 'approved_with_disclaimer',
  claims: [{ status: 'unverified', claim: CLAIM, reason: 'no evidence' }],
  unverified: [{ status: 'unverified', claim: CLAIM, reason: 'no evidence' }],
  latencyMs: 0,
};
export const TRUTH = 'Tatsaechlich-Wert-4711';
const CONTRADICTION: ClaimVerdict = {
  status: 'contradicted',
  claim: CLAIM,
  truth: TRUTH,
  source: 'odoo',
  detail: `Δ=${TRUTH}`,
};
export const BLOCKED: VerifierVerdict = {
  status: 'blocked',
  claims: [CONTRADICTION],
  contradictions: [CONTRADICTION],
  latencyMs: 0,
};

export function turn(answer: string, extra: Partial<ChatTurnResult> = {}): ChatTurnResult {
  return { answer, toolCalls: 0, iterations: 1, ...extra };
}

export const SILENT = (): void => undefined;
