import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type {
  ContentPart,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import {
  InMemoryTaskStore,
  LocalSubAgent,
  createDomainTool,
  createLongRunningSubAgentTool,
  longRunningToolNames,
} from '@omadia/orchestrator';

import { registerDbSubAgentTools } from '../../src/agents/subAgentToolHydration.js';

/**
 * W2-2 criterion 4 — the SECOND consumer, proving the seam is genuinely general.
 *
 * This drives a REAL `LocalSubAgent` (the thing `registry/subAgentTools.ts`
 * builds) through the generic seam and asserts the parent turn stops blocking on
 * it. Not a stub of the seam and not a stub of the sub-agent: only the LLM wire
 * is stubbed, exactly as `test/orchestrator/localSubAgent.test.ts` does.
 */

const CAPS = {
  tools: true,
  vision: false,
  streaming: false,
  promptCaching: false,
  forcedToolChoice: false,
  parallelToolCalls: false,
} as const;

function llmResponse(answer: string): LlmResponse {
  const content: ContentPart[] = [{ type: 'text', text: answer }];
  return {
    content,
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'stub-model',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

/**
 * A provider whose single reply is gated on an external latch, so "did the
 * parent turn block?" is decidable rather than a timing guess.
 *
 * `LocalSubAgent.ask` goes through `streamMessageWithObserver`, so the stub must
 * provide `stream` + `classifyError` (mirrors `test/orchestrator/localSubAgent.test.ts`).
 */
function latchedProvider(answer: string): {
  provider: LlmProvider;
  release: () => void;
  calls: () => number;
} {
  let releaseFn: () => void = () => undefined;
  const gate = new Promise<void>((res) => {
    releaseFn = res;
  });
  let calls = 0;
  const provider = {
    id: 'anthropic',
    capabilities: CAPS,
    complete: async (_req: LlmRequest): Promise<LlmResponse> => {
      calls += 1;
      await gate;
      return llmResponse(answer);
    },
    stream: (_req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      calls += 1;
      return {
        async *[Symbol.asyncIterator]() {
          await gate;
          yield { type: 'text_delta', text: answer } as LlmStreamEvent;
          yield { type: 'final', response: llmResponse(answer) } as LlmStreamEvent;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
  return { provider, release: () => releaseFn(), calls: () => calls };
}

function realSubAgent(provider: LlmProvider): LocalSubAgent {
  return new LocalSubAgent({
    name: 'Research',
    provider,
    model: 'stub-model',
    maxTokens: 256,
    maxIterations: 2,
    systemPrompt: 'You are a research sub-agent.',
    tools: [],
  });
}

describe('tasks/createLongRunningSubAgentTool — real LocalSubAgent, deferred', () => {
  it('returns a handle while the sub-agent is still mid-LLM-call', async () => {
    const { provider, release, calls } = latchedProvider('the deferred answer');
    const handle = createLongRunningSubAgentTool({
      baseToolName: 'ask_research',
      displayName: 'Research',
      description: 'Answers research questions.',
      agent: realSubAgent(provider),
      store: new InMemoryTaskStore(),
      onRunnerError: () => undefined,
    });

    const names = longRunningToolNames('ask_research');
    const start = handle.registrations.find((r) => r.name === names.start);
    const status = handle.registrations.find((r) => r.name === names.status);
    assert.ok(start && status);

    // The parent turn's tool dispatch. If the seam awaited the sub-agent's LLM
    // loop, this would hang on the latch — which is the whole regression.
    const startOut = JSON.parse(
      await start.handler({ question: 'what is the state of the art?' }),
    ) as { status: string; taskId: string };
    assert.equal(startOut.status, 'task_started');

    // The sub-agent is genuinely running, and genuinely not finished.
    const mid = JSON.parse(await status.handler({ taskId: startOut.taskId })) as {
      status: string;
      terminal: boolean;
      result?: string;
    };
    assert.equal(mid.status, 'working');
    assert.equal(mid.terminal, false);
    assert.equal(mid.result, undefined, 'no answer yet — this is the deferred shape');

    // Let the sub-agent finish, then collect on a LATER poll (i.e. a later turn).
    release();
    await handle.drainForTest();
    const done = JSON.parse(await status.handler({ taskId: startOut.taskId })) as {
      status: string;
      result: string;
    };
    assert.equal(done.status, 'completed');
    assert.equal(done.result, 'the deferred answer');
    assert.equal(calls(), 1, 'the sub-agent ran exactly once');
  });

  it('reports a sub-agent failure as a terminal task, not a hung handle', async () => {
    const failing = {
      ask: async (): Promise<string> => {
        throw new Error('sub-agent provider 503');
      },
    };
    const handle = createLongRunningSubAgentTool({
      baseToolName: 'ask_flaky',
      displayName: 'Flaky',
      description: 'Flaky.',
      agent: failing,
      store: new InMemoryTaskStore(),
      onRunnerError: () => undefined,
    });
    const names = longRunningToolNames('ask_flaky');
    const start = handle.registrations.find((r) => r.name === names.start);
    const status = handle.registrations.find((r) => r.name === names.status);
    assert.ok(start && status);

    const started = JSON.parse(await start.handler({ question: 'q' })) as { taskId: string };
    await handle.drainForTest();
    const out = JSON.parse(await status.handler({ taskId: started.taskId })) as {
      status: string;
      error: string;
    };
    assert.equal(out.status, 'failed');
    assert.match(out.error, /503/);
  });

  it('refuses an empty question before creating a task', async () => {
    const store = new InMemoryTaskStore();
    const handle = createLongRunningSubAgentTool({
      baseToolName: 'ask_x',
      displayName: 'X',
      description: 'X.',
      agent: { ask: async (): Promise<string> => 'never' },
      store,
    });
    const start = handle.registrations.find((r) => r.name === 'ask_x_start');
    assert.ok(start);
    assert.match(await start.handler({ question: '   ' }), /^Error: /);
    assert.equal(store.size(), 0, 'a refused start must not leave a task row');
  });
});

describe('tasks/boot wiring — registerDbSubAgentTools opt-in', () => {
  const subAgentRow = {
    id: 's1',
    agentId: 'a1',
    name: 'Research',
    slug: 'research',
    status: 'enabled',
    model: null,
    maxTokens: null,
    maxIterations: null,
    skillId: null,
    systemPromptOverride: 'Research things.',
    description: 'Research sub-agent.',
  };

  function makeHost(): { registered: string[]; host: Parameters<typeof registerDbSubAgentTools>[1] } {
    const registered: string[] = [];
    return {
      registered,
      host: {
        orchestrator: {
          hasDomainTool: (n: string) => registered.includes(n),
          registerDomainTool: (t: { name: string }) => registered.push(t.name),
        },
      } as Parameters<typeof registerDbSubAgentTools>[1],
    };
  }

  function makeDeps(
    nativeNames: string[],
    extra: Partial<Parameters<typeof registerDbSubAgentTools>[2]> = {},
  ): Parameters<typeof registerDbSubAgentTools>[2] {
    return {
      client: {} as Parameters<typeof registerDbSubAgentTools>[2]['client'],
      nativeToolRegistry: {
        get: (n: string) => (nativeNames.includes(n) ? {} : undefined),
        register: (n: string) => {
          nativeNames.push(n);
          return () => undefined;
        },
      } as unknown as Parameters<typeof registerDbSubAgentTools>[2]['nativeToolRegistry'],
      mcpManager: {} as Parameters<typeof registerDbSubAgentTools>[2]['mcpManager'],
      mcpServers: [],
      defaultModel: 'stub-model',
      ...extra,
    };
  }

  const slice = {
    subAgents: [subAgentRow],
    toolGrants: [],
    skills: [],
  } as unknown as Parameters<typeof registerDbSubAgentTools>[0];

  it('registers ONLY the blocking tool when nothing is opted in', () => {
    const native: string[] = [];
    const { host, registered } = makeHost();
    registerDbSubAgentTools(slice, host, makeDeps(native));
    assert.deepEqual(registered, ['ask_research']);
    assert.deepEqual(native, [], 'no deferred triple without an allowlist');
  });

  it('adds the deferred triple ALONGSIDE the blocking tool when opted in', () => {
    const native: string[] = [];
    const { host, registered } = makeHost();
    registerDbSubAgentTools(
      slice,
      host,
      makeDeps(native, {
        longRunningSubAgentTools: ['ask_research'],
        taskStore: new InMemoryTaskStore(),
      }),
    );
    // The blocking tool is untouched — a fast sub-agent keeps answering inline.
    assert.deepEqual(registered, ['ask_research']);
    assert.deepEqual(native, [
      'ask_research_start',
      'ask_research_status',
      'ask_research_list',
    ]);
  });

  it('ignores an allowlist entry naming a sub-agent that does not exist', () => {
    const native: string[] = [];
    const { host } = makeHost();
    registerDbSubAgentTools(
      slice,
      host,
      makeDeps(native, {
        longRunningSubAgentTools: ['ask_nonexistent'],
        taskStore: new InMemoryTaskStore(),
      }),
    );
    assert.deepEqual(native, []);
  });

  it('is off when an allowlist is given but no store is', () => {
    const native: string[] = [];
    const { host } = makeHost();
    registerDbSubAgentTools(
      slice,
      host,
      makeDeps(native, { longRunningSubAgentTools: ['ask_research'] }),
    );
    assert.deepEqual(native, [], 'fail closed: no store ⇒ no deferred tools');
  });

  it('does not double-register on a repeated hydrate', () => {
    const native: string[] = [];
    const deps = makeDeps(native, {
      longRunningSubAgentTools: ['ask_research'],
      taskStore: new InMemoryTaskStore(),
    });
    registerDbSubAgentTools(slice, makeHost().host, deps);
    registerDbSubAgentTools(slice, makeHost().host, deps);
    assert.equal(native.length, 3, 'the second hydrate skips existing names');
  });
});

describe('tasks/DomainTool→Askable adaptation', () => {
  it('routes the deferred call through the SAME DomainTool handle', async () => {
    // The adaptation must not bypass the DomainTool: its error wrapping and
    // domain logging are the behaviour the inline path already has, so reusing it
    // is what keeps the deferred and inline routes from drifting apart.
    const asked: string[] = [];
    const domainTool = createDomainTool({
      name: 'ask_probe',
      description: 'Probe.',
      domain: 'subagent.probe',
      agent: {
        ask: async (q: string): Promise<string> => {
          asked.push(q);
          return `answered: ${q}`;
        },
      },
    });

    const handle = createLongRunningSubAgentTool({
      baseToolName: domainTool.name,
      displayName: 'Probe',
      description: domainTool.spec.description,
      agent: { ask: (q, obs) => domainTool.handle({ question: q }, obs) },
      store: new InMemoryTaskStore(),
    });
    const start = handle.registrations.find((r) => r.name === 'ask_probe_start');
    const status = handle.registrations.find((r) => r.name === 'ask_probe_status');
    assert.ok(start && status);

    const started = JSON.parse(await start.handler({ question: 'ping' })) as {
      taskId: string;
    };
    await handle.drainForTest();
    const out = JSON.parse(await status.handler({ taskId: started.taskId })) as {
      result: string;
    };
    assert.deepEqual(asked, ['ping'], 'the wrapped agent saw the question verbatim');
    assert.equal(out.result, 'answered: ping');
  });
});
