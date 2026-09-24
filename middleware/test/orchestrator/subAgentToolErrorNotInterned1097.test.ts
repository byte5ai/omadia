/**
 * Issue #1097 — a guarded tool that returns a prose error string (the
 * `Error:` tool-error convention) must reach the model AS that error, not be
 * interned by Privacy Shield v4 as a 1-row masked dataset.
 *
 * PR #1138 closed the two paths the report reproduced — `Orchestrator.
 * dispatchTool` (web chat) and `ToolDispatchService.afterDispatch` (public
 * API), covered by `guardedToolErrorNotInterned1105.test.ts`. The SUB-AGENT
 * path was left unguarded: `LocalSubAgent.dispatch` interned every non-exempt
 * result, so a tool failing inside a sub-agent handed that sub-agent's own
 * model a `[masked]` digest. The consequences are the ones the issue
 * describes, one level down: the sub-agent cannot read the hint the error
 * carries (`requires scope`, `use search_turns instead`) and so cannot
 * self-correct, and the interned error becomes a renderable dataset.
 *
 * The `is_error` flag on the `tool_result` block is derived from the very same
 * prefix (`localSubAgent.ts`, `output.startsWith('Error:')`), so interning also
 * flipped that flag to false — asserted here, because it is the machine-readable
 * half of the defect.
 *
 * Imported from SOURCE, not from the `@omadia/orchestrator` barrel: the barrel
 * resolves to `dist/`, so a mutation in `src/` would be invisible without a
 * rebuild and this file could report GREEN over stale code.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import type { PrivacyTurnHandle } from '../../packages/harness-orchestrator/src/privacyHandle.js';
import { LocalSubAgent } from '../../packages/harness-orchestrator/src/localSubAgent.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';

const ERROR_RESULT =
  'Error: embeddings not configured — use `search_turns` for keyword-based search instead.';
const OK_RESULT = '{"rows":[{"hit":"Nordwind"}]}';
/** Shape `McpManager.handleFailure` returns for an auth-shaped failure (the
 *  app layer's `onAuthFailure`): a `🔒` prompt plus the machine block the chat
 *  UI parses into a Connect card. Interning it destroyed the card AND left the
 *  sub-agent narrating success over a masked digest. */
const AUTH_PROMPT =
  '🔒 The MCP server "Strava" needs authorization before it can be used. Ask the ' +
  'user to click Connect (this opens the provider\'s login), then retry: ' +
  'https://example.test/oauth/authorize?x=1\n' +
  '<mcp-auth-required serverId="s-1" server="Strava" needsClient="false"></mcp-auth-required>';
const DIGEST_MARKER = '«dataset:';

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

const usage = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
} as const;

function toolCallResponse(name: string): LlmResponse {
  return {
    content: [{ type: 'tool_call', id: 'use-1', name, input: {} }],
    finishReason: 'tool_calls',
    providerFinishReason: 'tool_use',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

function textResponse(text: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

/** Records every request the sub-agent's model saw, so the `tool_result` the
 *  sub-agent itself was handed can be read back off the wire. */
function recordingProvider(responses: readonly LlmResponse[]): {
  provider: LlmProvider;
  seen: LlmRequest[];
} {
  const seen: LlmRequest[] = [];
  let idx = 0;
  const next = (): LlmResponse => {
    const response = responses[idx];
    idx += 1;
    if (!response) throw new Error('recordingProvider: no scripted response left');
    return response;
  };
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (req: LlmRequest): Promise<LlmResponse> => {
      seen.push(req);
      return next();
    },
    stream: (req: LlmRequest) => {
      seen.push(req);
      const response = next();
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'final', response };
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return { provider: provider as unknown as LlmProvider, seen };
}

/** A handle that WOULD wrap any interned result in a recognizable envelope —
 *  if interning ran, the sub-agent's `tool_result` carries the marker instead
 *  of the raw string. Nothing here is a no-op stub: the control test below
 *  proves the marker really does appear when interning is correct. */
function markingPrivacyHandle(): PrivacyTurnHandle {
  return {
    async internToolResultV4({ toolName, rawResult }: { toolName: string; rawResult: string }) {
      return {
        digestText: `${DIGEST_MARKER}${toolName}» ${rawResult}`,
        datasetId: `ds-${toolName}`,
      };
    },
    async recordBypassedTool() {},
    checkBypass() {
      return undefined;
    },
    async runV4Tool() {
      throw new Error('not used on this path');
    },
    async subAgentResultV4() {
      throw new Error('not used on this path');
    },
    async takeRenderedAnswerV4() {
      return undefined;
    },
    v4ToolSpecs() {
      return [];
    },
    async maskPrompt(text: string) {
      return { text } as never;
    },
    async finalizeTurn() {
      return undefined;
    },
  } as unknown as PrivacyTurnHandle;
}

function subAgentWith(provider: LlmProvider, toolName: string, result: string): LocalSubAgent {
  return new LocalSubAgent({
    name: 'test',
    provider,
    model: 'claude-haiku',
    maxTokens: 1024,
    maxIterations: 5,
    systemPrompt: 'you are a test',
    tools: [
      {
        spec: {
          name: toolName,
          description: 'test tool',
          input_schema: { type: 'object' as const, properties: {}, required: [] },
        },
        handle: async () => result,
      },
    ],
  } as ConstructorParameters<typeof LocalSubAgent>[0]);
}

interface ToolResultBlock {
  readonly content: string;
  readonly isError: boolean;
}

/** The `tool_result` blocks the sub-agent put back on its own model's wire. */
function toolResults(requests: readonly LlmRequest[]): ToolResultBlock[] {
  const out: ToolResultBlock[] = [];
  for (const req of requests) {
    for (const message of (req.messages ?? []) as unknown as Array<{ content?: unknown }>) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Array<{
        type?: string;
        content?: unknown;
        // The provider-neutral message shape uses `isError`; the raw
        // Anthropic block spelling is `is_error`. Read both so this test
        // pins the FLAG, not the spelling of whichever layer normalized it.
        isError?: boolean;
        is_error?: boolean;
      }>) {
        if (block.type !== 'tool_result' || typeof block.content !== 'string') continue;
        out.push({
          content: block.content,
          isError: block.isError === true || block.is_error === true,
        });
      }
    }
  }
  return out;
}

async function askGuarded(agent: LocalSubAgent, question: string): Promise<void> {
  await turnContext.run(
    {
      turnId: 'turn-1097',
      turnDate: '2026-09-22',
      privacyHandle: markingPrivacyHandle(),
    },
    async () => {
      await agent.ask(question);
    },
  );
}

describe('#1097 — sub-agent tool error result is not interned as a dataset', () => {
  it('hands an `Error:` result to the sub-agent model verbatim, flagged as an error', async () => {
    const { provider, seen } = recordingProvider([
      toolCallResponse('search_turns_semantic'),
      textResponse('semantische Suche ist nicht verfügbar'),
    ]);
    const agent = subAgentWith(provider, 'search_turns_semantic', ERROR_RESULT);

    await askGuarded(agent, 'Suche semantisch nach "Nordwind".');

    const results = toolResults(seen);
    assert.equal(results.length, 1, 'exactly one tool_result should have reached the model');
    assert.equal(
      results[0]?.content,
      ERROR_RESULT,
      'the sub-agent must see the raw error text so it can correct its call',
    );
    assert.equal(
      results[0]?.content.includes(DIGEST_MARKER),
      false,
      'an error result must NOT be interned as a renderable dataset (that is the #1097 bug)',
    );
    assert.equal(
      results[0]?.isError,
      true,
      'the `Error:` prefix must still drive is_error — interning silently cleared it',
    );
  });

  it('hands an MCP auth prompt through verbatim so the Connect card survives', async () => {
    const { provider, seen } = recordingProvider([
      toolCallResponse('mcp__Strava__list_activities'),
      textResponse('bitte verbinden'),
    ]);
    const agent = subAgentWith(provider, 'mcp__Strava__list_activities', AUTH_PROMPT);

    await askGuarded(agent, 'Zeig meine Läufe.');

    const results = toolResults(seen);
    assert.equal(results.length, 1);
    assert.equal(
      results[0]?.content,
      AUTH_PROMPT,
      'the sub-agent must see the connect prompt so it can relay it',
    );
    assert.ok(
      results[0]?.content.includes('<mcp-auth-required'),
      'the machine block the Connect card is parsed from must survive the boundary',
    );
    assert.equal(results[0]?.content.includes(DIGEST_MARKER), false);
  });

  it('control — an ordinary sub-agent result in the same setup IS still interned', async () => {
    const { provider, seen } = recordingProvider([
      toolCallResponse('search_turns'),
      textResponse('ein Treffer'),
    ]);
    const agent = subAgentWith(provider, 'search_turns', OK_RESULT);

    await askGuarded(agent, 'Suche nach "Nordwind".');

    const results = toolResults(seen);
    assert.equal(results.length, 1);
    assert.match(
      results[0]?.content ?? '',
      /«dataset:search_turns»/,
      'a non-error result must still be interned — otherwise the test above is vacuous',
    );
    assert.equal(results[0]?.isError, false, 'a successful result is not an error');
  });
});
