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

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
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

  it('#1097 — a data result carrying the auth block in one cell IS still interned', async () => {
    // The predicate is prefix-anchored: content that merely CONTAINS a
    // control-flow marker (a planted note, a quoted prompt) must not switch
    // the shield off for the whole multi-row result.
    const planted = JSON.stringify({
      rows: [
        { name: 'Erika Mustermann', note: AUTH_PROMPT },
        { name: 'Max Mustermann', note: 'ok' },
      ],
    });
    const { provider, seen } = recordingProvider([
      toolCallResponse('read_rows'),
      textResponse('done'),
    ]);
    const orchestrator = orchestratorWith(
      provider,
      registryWith('read_rows', () => Promise.resolve(planted)),
    );

    await orchestrator.runTurn({ userMessage: 'go' });

    const results = toolResultTexts(seen);
    assert.equal(results.length, 1);
    assert.match(
      results[0] ?? '',
      /«dataset:read_rows»/,
      'a rows payload with the auth block in a cell is data and must be interned',
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

/**
 * #1097 triage AC4 — self-correction is reachable again on the chat path.
 *
 * The issue's most deterministic reproduction: `search_turns_semantic` without
 * an embedding client answers with an `Error:` whose text names the fallback
 * (`use search_turns …`). Interned, the model saw `[masked]`, never retried and
 * rendered the error as "ein Treffer gefunden". This drives the REAL
 * `query_knowledge_graph` tool (in-memory graph, no `embeddingClient`) through
 * the real `Orchestrator` with a scripted model that follows the hint, and
 * pins the wiring the retry depends on: the error reaches the model verbatim
 * with `is_error` set BEFORE its next call, and the fallback call is dispatched
 * and its data result interned as usual.
 */
describe('#1097 — search_turns_semantic without embeddings falls back to search_turns', () => {
  const SEMANTIC_ERROR =
    'Error: embeddings not configured — use `search_turns` for keyword-based search instead.';

  function kgCall(id: string, query: string): LlmResponse {
    return {
      content: [
        {
          type: 'tool_call',
          id,
          name: 'query_knowledge_graph',
          input: { query, text: 'Nordwind' },
        },
      ],
      finishReason: 'tool_calls',
      providerFinishReason: 'tool_use',
      model: 'test',
      usage,
    } as unknown as LlmResponse;
  }

  interface ResultBlock {
    readonly content: string;
    readonly isError: boolean;
  }

  /** The `tool_result` blocks of ONE request, `is_error` read in either
   *  spelling so the test pins the flag, not the layer that normalized it. */
  function resultBlocks(messages: readonly unknown[]): ResultBlock[] {
    const out: ResultBlock[] = [];
    for (const message of messages) {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Array<{
        type?: string;
        content?: unknown;
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
    return out;
  }

  it('hands the error to the model flagged, then dispatches and interns the fallback', async () => {
    const graph = new InMemoryKnowledgeGraph();
    await graph.ingestTurn({
      scope: 'chat-earlier',
      time: '2026-09-01T10:00:00.000Z',
      userMessage: 'Wie steht es um Projekt Nordwind?',
      assistantAnswer: 'Nordwind liegt im Plan.',
      entityRefs: [],
    });
    const { provider, seen } = recordingProvider([
      kgCall('use-semantic', 'search_turns_semantic'),
      kgCall('use-fts', 'search_turns'),
      textResponse('Ein früherer Chat erwähnt Nordwind.'),
    ]);
    const orchestrator = new Orchestrator({
      provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      knowledgeGraph: graph,
      privacyGuard: () => markingPrivacyService(),
    } as ConstructorParameters<typeof Orchestrator>[0]);

    await orchestrator.runTurn({
      userMessage: 'Suche im Knowledge Graph semantisch nach "Nordwind".',
    });

    assert.equal(seen.length, 3, 'the model was asked three times: call, fallback, answer');
    const beforeFallback = resultBlocks(seen[1] ?? []);
    assert.equal(beforeFallback.length, 1);
    assert.equal(
      beforeFallback[0]?.content,
      SEMANTIC_ERROR,
      'the model must read the hint verbatim before it decides on the fallback',
    );
    assert.equal(beforeFallback[0]?.isError, true, 'the error must carry is_error');

    const final = resultBlocks(seen[2] ?? []);
    assert.equal(final.length, 2, 'both tool calls produced a tool_result');
    const fallback = final[1]?.content ?? '';
    assert.match(
      fallback,
      /«dataset:query_knowledge_graph»/,
      'the fallback is data and must still be interned (control)',
    );
    assert.ok(fallback.includes('"mode":"fts"'), 'search_turns (FTS) actually ran');
    assert.ok(fallback.includes('Nordwind'), 'the fallback found the earlier turn');
    assert.equal(final[1]?.isError, false, 'the fallback result is not an error');
  });
});
