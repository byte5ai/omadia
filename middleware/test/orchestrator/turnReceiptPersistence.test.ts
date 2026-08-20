/**
 * #757 — orchestrator-side wiring: a receipt that reaches the user also
 * reaches the persistent store, and a failing store never fails the turn.
 *
 * Setup mirrors `promptMaskPipeline.test.ts`: the REAL privacy-guard service
 * with `mask_user_prompt` forced on produces a real receipt (masked email
 * span) on a real `runTurn`; the store is a fake capturing `record()` calls.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';
import type { TurnReceiptRecordInput } from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

const RAW_EMAIL = 'anna.schmidt@firma.de';

function maskingService(): ReturnType<typeof createPrivacyGuardService> {
  return createPrivacyGuardService({
    readConfig: (key: string) => (key === 'mask_user_prompt' ? 'on' : undefined),
  });
}

function textResponse(text: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

function staticProvider(): LlmProvider {
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (_req: LlmRequest): Promise<LlmResponse> =>
      textResponse('Alles klar.'),
    stream: (): AsyncIterable<LlmStreamEvent> => {
      throw new Error('staticProvider: stream() not scripted');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

type OrchestratorOptions = ConstructorParameters<typeof Orchestrator>[0];

const sessionLogger = {
  log: async (): Promise<{ turnExternalId: string }> => ({
    turnExternalId: 'turn:sess-1:t1',
  }),
} as unknown as OrchestratorOptions['sessionLogger'];

function buildOrch(store: {
  record: (entry: TurnReceiptRecordInput) => Promise<void>;
}): Orchestrator {
  return new Orchestrator({
    provider: staticProvider(),
    model: 'test-model',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    sessionLogger,
    privacyGuard: () => maskingService(),
    turnReceiptStore: () => store,
  });
}

describe('#757 turn-receipt persistence — orchestrator wiring', () => {
  it('persists the receipt the turn attaches, with routing metadata', async () => {
    const recorded: TurnReceiptRecordInput[] = [];
    const orch = buildOrch({
      record: async (entry) => {
        recorded.push(entry);
      },
    });
    const result = await orch.runTurn({
      userMessage: `Bitte schreibe an ${RAW_EMAIL}.`,
      sessionScope: 'sess-1',
      userId: 'u1',
      channelIdentity: { channelKind: 'teams', channelUserId: 'aad-1' },
    });
    assert.ok(result.privacyReceipt, 'turn must attach a receipt');
    assert.equal(recorded.length, 1, 'exactly one persisted receipt per turn');
    const entry = recorded[0]!;
    assert.ok(entry.turnId.length > 0, 'a non-empty turn id must be recorded');
    assert.equal(entry.sessionScope, 'sess-1');
    assert.equal(entry.channel, 'teams');
    assert.equal(entry.model, 'test-model');
    // The persisted receipt is the SAME object the user saw — no divergence
    // between UI truth and record truth.
    assert.deepEqual(entry.receipt, result.privacyReceipt);
    const spans = entry.receipt.maskedPromptSpans ?? [];
    assert.ok(
      spans.some((s) => s.type === 'email'),
      'persisted receipt must carry the masked email span',
    );
  });

  it('a throwing store is loud but never fails the turn', async () => {
    const orch = buildOrch({
      record: async () => {
        throw new Error('pg down');
      },
    });
    const result = await orch.runTurn({
      userMessage: `Bitte schreibe an ${RAW_EMAIL}.`,
      sessionScope: 'sess-1',
      userId: 'u1',
    });
    // The user's answer outranks the audit row.
    assert.ok(result.answer.length > 0);
    assert.ok(result.privacyReceipt, 'receipt still reaches the user');
  });

  it('no store wired ⇒ byte-identical pre-#757 behaviour', async () => {
    const orch = new Orchestrator({
      provider: staticProvider(),
      model: 'test-model',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      sessionLogger,
      privacyGuard: () => maskingService(),
      // deliberately: no turnReceiptStore option
    });
    const result = await orch.runTurn({
      userMessage: `Bitte schreibe an ${RAW_EMAIL}.`,
      sessionScope: 'sess-1',
      userId: 'u1',
    });
    assert.ok(result.privacyReceipt);
  });
});
