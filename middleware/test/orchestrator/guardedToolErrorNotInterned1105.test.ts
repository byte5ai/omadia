/**
 * Issue #1105 (second defect): a guarded tool that RETURNS a prose error string
 * — the orchestrator's `Error:` tool-error convention — must reach the model AS
 * that error, not be interned by Privacy Shield v4 as a 1-row masked dataset.
 *
 * Interning an error had two consequences the reporter observed:
 *   (a) the model never learned the call failed — it saw a masked digest, not
 *       the error text — and confidently narrated success; and
 *   (b) the interned error became a renderable dataset that a later
 *       `v4_render_answer` materialized as if the error were data (a one-cell
 *       "table" containing the raw `Error:` string).
 *
 * This drives the REAL `Orchestrator` with a real (redacting) privacy handle
 * installed — the exact configuration in which a SUCCESSFUL result IS interned
 * — and asserts a fulfilled `Error:` result arrives at the model verbatim, with
 * no dataset digest wrapped around it. The second case is the control: an
 * ordinary result in the same setup still gets interned.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmResponse } from '@omadia/llm-provider';
import type { PrivacyGuardService } from '@omadia/plugin-api';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';

const ERROR_RESULT =
  'Error: routines are unavailable in this session because the user context did not reach the routines tool.';
const OK_RESULT = '{"status":"ok","rows":[{"a":1}]}';
/** #1097 — the other control-flow carrier: `McpManager.handleFailure` answers
 *  an auth-shaped failure with the app layer's connect prompt (`🔒 …` plus the
 *  `<mcp-auth-required>` machine block the chat UI turns into a Connect card).
 *  It carries no `Error:` prefix, so the original guard missed it. */
const AUTH_PROMPT =
  '🔒 The MCP server "Strava" needs authorization before it can be used. Ask the ' +
  'user to click Connect (this opens the provider\'s login), then retry: ' +
  'https://example.test/oauth/authorize?x=1\n' +
  '<mcp-auth-required serverId="s-1" server="Strava" needsClient="false"></mcp-auth-required>';

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

function recordingProvider(responses: readonly LlmResponse[]): {
  provider: LlmProvider;
  seen: unknown[][];
} {
  const seen: unknown[][] = [];
  let idx = 0;
  const provider = {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
    },
    complete: (request: { messages?: unknown[] }) => {
      seen.push(request.messages ?? []);
      const response = responses[idx];
      idx += 1;
      if (!response) throw new Error('recordingProvider: no scripted response left');
      return Promise.resolve(response);
    },
    stream: () => {
      throw new Error('not used');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return { provider: provider as unknown as LlmProvider, seen };
}

/** A privacy service that WOULD wrap any interned result in a recognizable
 *  digest envelope. If interning ran, the model-visible tool_result carries the
 *  `«dataset:…»` marker instead of the raw string. */
function markingPrivacyService(): PrivacyGuardService {
  return {
    async internToolResultV4(request: { toolName: string; rawResult: string }) {
      return {
        digestText: `«dataset:${request.toolName}» ${request.rawResult}`,
        datasetId: `ds-${request.toolName}`,
      };
    },
    async recordBypassedTool() {},
    async runV4Tool() {
      return { resultText: '' };
    },
    async subAgentResultV4() {
      return { resultText: '' };
    },
    async takeRenderedAnswerV4() {
      return undefined;
    },
    v4ToolSpecs() {
      return [];
    },
    async finalizeTurn() {
      return undefined;
    },
  } as unknown as PrivacyGuardService;
}

function registryWith(name: string, behaviour: () => Promise<string>): NativeToolRegistry {
  const registry = new NativeToolRegistry();
  registry.register(name, {
    handler: behaviour,
    spec: {
      name,
      description: 'test tool',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    } as never,
    domain: 'test.guarded',
  });
  return registry;
}

function toolResultTexts(messages: readonly unknown[][]): string[] {
  const out: string[] = [];
  for (const list of messages) {
    for (const message of list) {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as { type?: string; content?: unknown };
        if (b.type === 'tool_result' && typeof b.content === 'string') out.push(b.content);
      }
    }
  }
  return out;
}

function orchestratorWith(provider: LlmProvider, registry: NativeToolRegistry): Orchestrator {
  return new Orchestrator({
    provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: registry,
    privacyGuard: () => markingPrivacyService(),
  } as ConstructorParameters<typeof Orchestrator>[0]);
}

describe('#1105 — guarded-tool error result is not interned as a dataset', () => {
  it('hands a fulfilled `Error:` result to the model verbatim, not as a digest', async () => {
    const { provider, seen } = recordingProvider([
      toolCallResponse('manage_routine'),
      textResponse('done'),
    ]);
    const orchestrator = orchestratorWith(
      provider,
      registryWith('manage_routine', () => Promise.resolve(ERROR_RESULT)),
    );

    await orchestrator.runTurn({ userMessage: 'Lege eine Routine an.' });

    const results = toolResultTexts(seen);
    assert.equal(results.length, 1, 'exactly one tool_result should have reached the model');
    assert.equal(
      results[0],
      ERROR_RESULT,
      'the model must see the raw error text so it knows the call failed',
    );
    assert.equal(
      results[0]?.includes('«dataset:'),
      false,
      'an error result must NOT be interned as a renderable dataset (that is the #1105 bug)',
    );
  });

  it('#1097 — hands an MCP auth prompt to the model verbatim, block intact', async () => {
    const { provider, seen } = recordingProvider([
      toolCallResponse('mcp__Strava__list_activities'),
      textResponse('bitte verbinden'),
    ]);
    const orchestrator = orchestratorWith(
      provider,
      registryWith('mcp__Strava__list_activities', () => Promise.resolve(AUTH_PROMPT)),
    );

    await orchestrator.runTurn({ userMessage: 'Zeig meine Läufe.' });

    const results = toolResultTexts(seen);
    assert.equal(results.length, 1);
    assert.equal(
      results[0],
      AUTH_PROMPT,
      'the model must see the connect prompt so it can relay it to the user',
    );
    assert.ok(
      results[0]?.includes('<mcp-auth-required'),
      'the machine block the Connect card is parsed from must survive the boundary',
    );
  });

  it('control — an ordinary result in the same setup IS still interned', async () => {
    const { provider, seen } = recordingProvider([
      toolCallResponse('read_rows'),
      textResponse('done'),
    ]);
    const orchestrator = orchestratorWith(
      provider,
      registryWith('read_rows', () => Promise.resolve(OK_RESULT)),
    );

    await orchestrator.runTurn({ userMessage: 'go' });

    const results = toolResultTexts(seen);
    assert.equal(results.length, 1);
    assert.match(
      results[0] ?? '',
      /«dataset:read_rows»/,
      'a non-error result must still be interned — otherwise the test above is vacuous',
    );
  });
});
