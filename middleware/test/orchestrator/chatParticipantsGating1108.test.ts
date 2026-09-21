/**
 * #1108 — `get_chat_participants` is advertised on every channel but only works
 * in Teams. The tool instance is built once and is channel-independent, so
 * gating advertisement on `this.chatParticipantsTool` offered a tool that, on a
 * non-Teams turn, could only return a miss the model never sees (the Privacy
 * Shield interns prose tool results, #1097). The fix gates BOTH the tool list
 * and the system-prompt roster on the per-turn provider
 * (`turnContext.current()?.chatParticipants`), and turns the handler's
 * no-provider miss from an English `Error:` string into a structured German
 * result.
 *
 * These tests pin:
 *   - a turn WITHOUT a roster provider does not advertise the tool (tool list
 *     and system prompt),
 *   - a turn WITH a roster provider advertises it unchanged (Teams behaviour),
 *   - the handler's no-provider branch is a structured non-error result.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import {
  ChatParticipantsTool,
  NativeToolRegistry,
  Orchestrator,
  turnContext,
} from '../../packages/harness-orchestrator/src/index.js';
import type { ChatParticipant } from '../../packages/harness-orchestrator/src/index.js';
import {
  CHAT_PARTICIPANTS_EMPTY_ROSTER_REASON,
  CHAT_PARTICIPANTS_FETCH_FAILED_REASON,
  CHAT_PARTICIPANTS_NO_ROSTER_REASON,
} from '../../packages/harness-orchestrator/src/tools/chatParticipantsTool.js';

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

const finalTextStream: LlmStreamEvent[] = [
  { type: 'text_delta', text: 'done' },
  {
    type: 'final',
    response: {
      content: [{ type: 'text', text: 'done' }],
      finishReason: 'stop',
      providerFinishReason: 'end_turn',
      model: 'test',
      usage: {
        inputTokens: 100,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  },
];

function recordingProvider(seenRequests: LlmRequest[]): LlmProvider {
  return {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (): Promise<LlmResponse> => {
      throw new Error('complete() not scripted');
    },
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      seenRequests.push(req);
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of finalTextStream) yield ev;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

const HUMAN: ChatParticipant = {
  channelUserId: '29:human',
  aadObjectId: 'aad-1',
  displayName: 'Jane Doe',
  email: 'jane@example.com',
  userPrincipalName: 'jane@example.com',
};

/**
 * Runs one turn through an orchestrator that holds a `ChatParticipantsTool`,
 * optionally inside a scope that installs a per-turn roster provider (as the
 * Teams channel does), and returns the request the provider actually saw.
 */
async function runTurn(opts: { withRoster: boolean }): Promise<LlmRequest> {
  const seenRequests: LlmRequest[] = [];
  const orchestrator = new Orchestrator({
    provider: recordingProvider(seenRequests),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    chatParticipantsTool: new ChatParticipantsTool(),
  });

  const drain = async (): Promise<void> => {
    for await (const _ev of orchestrator.chatStream({ userMessage: 'go' })) {
      // drain
    }
  };

  if (opts.withRoster) {
    await turnContext.runWithChatParticipants(async () => [HUMAN], drain);
  } else {
    await drain();
  }

  const request = seenRequests[0];
  assert.ok(request, 'provider received no request');
  return request;
}

const advertisesTool = (request: LlmRequest): boolean =>
  (request.tools ?? []).some((tool) => tool.name === 'get_chat_participants');

describe('#1108 — get_chat_participants is gated on the per-turn roster', () => {
  it('does NOT advertise the tool on a turn without a roster provider', async () => {
    const request = await runTurn({ withRoster: false });
    assert.equal(
      advertisesTool(request),
      false,
      'a non-Teams turn must not offer get_chat_participants',
    );
  });

  it('does NOT describe the tool in the system prompt without a roster', async () => {
    const request = await runTurn({ withRoster: false });
    const system = JSON.stringify(request.system ?? '');
    assert.equal(
      system.includes('get_chat_participants'),
      false,
      'the system-prompt roster must not mention the tool on a channel without a roster',
    );
  });

  it('advertises the tool unchanged on a turn that carries a roster (Teams)', async () => {
    const request = await runTurn({ withRoster: true });
    assert.equal(
      advertisesTool(request),
      true,
      'a Teams turn with a roster provider must still offer get_chat_participants',
    );
  });
});

/**
 * Every "can't produce a roster" branch of the handler must be a structured,
 * German, non-error result — never an `Error:` string the Privacy Shield would
 * intern (#1097) and render to the user as if it were the roster. All branches
 * share the `{ participants: [], reason, note }` shape.
 */
type MissResult = { participants: unknown[]; reason: string; note: string };

const parseMiss = (raw: string): MissResult => {
  assert.equal(
    raw.startsWith('Error:'),
    false,
    'the miss must not be an Error: string the Privacy Shield would mask',
  );
  return JSON.parse(raw) as MissResult;
};

describe('#1108 — the handler never returns an English error string', () => {
  it('no provider wired → structured German no_roster result', async () => {
    // No turnContext scope at all → `turnContext.current()` is undefined, the
    // same shape a non-Teams turn would hit if the tool were ever called.
    const parsed = parseMiss(await new ChatParticipantsTool().handle());
    assert.deepEqual(parsed.participants, []);
    assert.equal(parsed.reason, CHAT_PARTICIPANTS_NO_ROSTER_REASON);
    assert.match(parsed.note, /Teilnehmerliste/);
  });

  it('Telegram admin-only roster present but empty → structured roster_empty result', async () => {
    // Counter-check from the issue: a channel that DOES wire a provider but
    // whose roster resolves empty (admin-only Telegram group) stays a
    // structured non-error, and carries a distinct reason for shape parity.
    const tool = new ChatParticipantsTool();
    const raw = await turnContext.runWithChatParticipants(
      async () => [],
      () => tool.handle(),
    );
    const parsed = parseMiss(raw);
    assert.deepEqual(parsed.participants, []);
    assert.equal(parsed.reason, CHAT_PARTICIPANTS_EMPTY_ROSTER_REASON);
  });

  it('roster fetch throws → structured roster_fetch_failed result, no raw error leaked', async () => {
    const tool = new ChatParticipantsTool();
    const raw = await turnContext.runWithChatParticipants(
      async () => {
        throw new Error('graph store down: secret-host:5432');
      },
      () => tool.handle(),
    );
    const parsed = parseMiss(raw);
    assert.deepEqual(parsed.participants, []);
    assert.equal(parsed.reason, CHAT_PARTICIPANTS_FETCH_FAILED_REASON);
    // The internal error detail must not leak into a channel-visible result.
    assert.equal(raw.includes('secret-host'), false);
  });
});
