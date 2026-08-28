/**
 * #904 — a sub-agent granted the native `memory` tool must write through the
 * SCOPED store, never the undecorated root.
 *
 * The parent orchestrator's `memory` dispatch is scoped twice over: by the
 * build-time `OrchestratorMemoryNamespacer` + `ScopedMemoryStore`
 * (`orchestrator:<slug>:*`, the per-agent boundary that predates this epic) and,
 * when `context_memory` is on, by the turn-bound stack `MemoryBinder.forOrigin`
 * produces. The sub-agent tool path had neither: it resolved `memory` out of the
 * process-wide `NativeToolRegistry`, whose handler is the one the memory PLUGIN
 * registered — bound to the raw root store.
 *
 * Method, taken from `contextMemoryTurnBinding.test.ts` (#903): drive a REAL
 * turn — parent orchestrator delegates to a real `LocalSubAgent`, which calls
 * the granted tool through its own tool loop — and assert the PHYSICAL path the
 * bytes reached at the undecorated root. Every decorator sits above that
 * recorder, so what arrives there is what actually hit storage; an assertion on
 * a decorated store would only re-state the decorator's own arithmetic.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import { InMemoryMemoryStore, MemoryToolHandler } from '@omadia/memory';
import {
  buildSubAgentDomainTools,
  MemoryBinder,
  NativeToolRegistry,
  Orchestrator,
  type ContextMemoryMode,
} from '@omadia/orchestrator';

import type { TurnOrigin } from '../../packages/harness-channel-sdk/src/turnOrigin.js';
import type {
  SkillRow,
  SubAgentRow,
  ToolGrantRow,
} from '../../packages/harness-orchestrator/src/registry/agentGraphStore.js';
import {
  adaptNativeToolForSubAgent,
  turnScopedMemoryResolver,
} from '../../src/agents/subAgentToolHydration.js';

const AGENT_SLUG = 'w5-agent';
const AGENT_ROOT = `/memories/orchestrators/${AGENT_SLUG}`;
const MEMORY_PATH = '/memories/note.md';

/** Same shape `omadia-channel-teams` builds beside its `sessionScope`. */
function teamsOrigin(conversationId = 'c-1', teamId = 't-alpha'): TurnOrigin {
  return {
    channelType: 'teams',
    scope: { kind: 'conversation', channelId: 'msteams', conversationId },
    container: { kind: 'team', id: teamId },
  };
}

// ── scripted provider ───────────────────────────────────────────────────────

const providerCapabilities = {
  tools: true,
  vision: false,
  streaming: true,
  promptCaching: false,
  forcedToolChoice: false,
  parallelToolCalls: false,
} as const;

interface ScriptStep {
  readonly kind: 'tool' | 'text';
  readonly name?: string;
  readonly input?: unknown;
  readonly text?: string;
}

function toolStep(name: string, input: unknown): ScriptStep {
  return { kind: 'tool', name, input };
}

function textStep(text: string): ScriptStep {
  return { kind: 'text', text };
}

function toResponse(step: ScriptStep): LlmResponse {
  const usage = {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  if (step.kind === 'tool') {
    return {
      content: [
        { type: 'tool_call', id: 'tu-1', name: step.name, input: step.input },
      ],
      finishReason: 'tool_calls',
      providerFinishReason: 'tool_use',
      model: 'test',
      usage,
    } as unknown as LlmResponse;
  }
  return {
    content: [{ type: 'text', text: step.text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

/**
 * Serves the same script through `complete` and `stream`, so one script drives
 * both the buffered and the streaming entry point. The sub-agent runs its own
 * loop against its own instance — a shared one would couple the two loops' call
 * ordering to an implementation detail of the orchestrator.
 */
function scriptedProvider(steps: readonly ScriptStep[]): LlmProvider {
  let idx = 0;
  const take = (): ScriptStep => {
    if (idx >= steps.length) {
      throw new Error(`no scripted step for provider call ${String(idx + 1)}`);
    }
    const step = steps[idx]!;
    idx += 1;
    return step;
  };
  return {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (): Promise<LlmResponse> => toResponse(take()),
    stream: (): AsyncIterable<LlmStreamEvent> => {
      const step = take();
      return {
        async *[Symbol.asyncIterator]() {
          if (step.kind === 'text') {
            yield { type: 'text_delta', text: step.text } as LlmStreamEvent;
          } else {
            yield { type: 'tool_use_start' } as LlmStreamEvent;
            yield {
              type: 'tool_input_delta',
              text: JSON.stringify(step.input),
            } as LlmStreamEvent;
          }
          yield { type: 'final', response: toResponse(step) } as LlmStreamEvent;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

// ── the undecorated root ────────────────────────────────────────────────────

/** Records the PHYSICAL path of every write that reaches storage. */
class RecordingMemoryStore extends InMemoryMemoryStore {
  readonly writes: string[] = [];

  override async createFile(virtualPath: string, content: string): Promise<void> {
    this.writes.push(virtualPath);
    await super.createFile(virtualPath, content);
  }

  override async writeFile(virtualPath: string, content: string): Promise<void> {
    this.writes.push(virtualPath);
    await super.writeFile(virtualPath, content);
  }
}

// ── the agent graph: one sub-agent, one native `memory` grant ───────────────

const SUB_AGENT_TOOL = 'ask_notetaker';

function subAgentRow(): SubAgentRow {
  return {
    id: 'sub-1',
    parentAgentId: 'agent-1',
    name: 'Notetaker',
    skillId: null,
    model: null,
    maxTokens: null,
    maxIterations: null,
    systemPromptOverride: 'You take notes.',
    status: 'enabled',
    position: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/** The supported operator action this issue is about: grant `memory`. */
function memoryGrant(): ToolGrantRow {
  return {
    id: 'g-1',
    agentId: null,
    subAgentId: 'sub-1',
    toolKind: 'native',
    toolRef: 'memory',
    mcpServerId: null,
    config: {},
    createdAt: new Date(0),
  };
}

const NO_SKILLS: readonly SkillRow[] = [];

type MemoryRegistration = 'handler-only' | 'with-spec';

/**
 * Builds the registry the way a memory provider plugin does.
 *
 * `handler-only` is what `@omadia/memory` / `@omadia/memory-postgres` ship
 * (`ctx.tools.registerHandler('memory', …)`): the kernel emits the
 * `memory_20250818` wire-spec itself, so the entry carries no `spec`.
 * `with-spec` is the registry's other public registration path — same root
 * handler, plus a spec. Both hand out a handler bound to the RAW root store,
 * which is the whole point: whichever one the deployment uses, the sub-agent
 * tool path must not route through it.
 */
function registryWithMemory(
  root: RecordingMemoryStore,
  shape: MemoryRegistration,
): NativeToolRegistry {
  const registry = new NativeToolRegistry();
  const rootHandler = new MemoryToolHandler(root);
  if (shape === 'handler-only') {
    registry.registerHandler('memory', {
      handler: (input: unknown) => rootHandler.handle(input),
    });
  } else {
    registry.register('memory', {
      handler: (input: unknown) => rootHandler.handle(input),
      spec: {
        name: 'memory',
        description: 'Read and write long-term memory.',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' }, path: { type: 'string' } },
          required: ['command'],
        },
      },
    });
  }
  return registry;
}

interface Harness {
  readonly orchestrator: Orchestrator;
  /** The UNDECORATED root store — assertions read physical paths from here. */
  readonly root: RecordingMemoryStore;
}

function harness(
  mode: ContextMemoryMode,
  shape: MemoryRegistration = 'handler-only',
): Harness {
  const root = new RecordingMemoryStore();
  const registry = registryWithMemory(root, shape);
  const subAgentProvider = scriptedProvider([
    toolStep('memory', {
      command: 'create',
      path: MEMORY_PATH,
      file_text: 'the secret',
    }),
    textStep('notiert'),
  ]);
  const domainTools = buildSubAgentDomainTools(
    { subAgents: [subAgentRow()], toolGrants: [memoryGrant()], skills: NO_SKILLS },
    {
      provider: subAgentProvider,
      defaultModel: 'test',
      defaultMaxTokens: 1024,
      defaultMaxIterations: 4,
      // The production resolver, not a test double: the whole claim is that the
      // grant reaches the store the PARENT's dispatch bound for this turn.
      nativeTool: (ref) =>
        adaptNativeToolForSubAgent(registry, ref, turnScopedMemoryResolver),
    },
  );
  assert.equal(domainTools.length, 1, 'expected exactly one sub-agent DomainTool');
  assert.equal(domainTools[0]!.name, SUB_AGENT_TOOL);

  const binder = new MemoryBinder({ agentSlug: AGENT_SLUG, root, mode });
  return {
    root,
    orchestrator: new Orchestrator({
      provider: scriptedProvider([
        toolStep(SUB_AGENT_TOOL, { question: 'merk dir das' }),
        textStep('fertig'),
      ]),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools,
      nativeToolRegistry: registry,
      agentId: AGENT_SLUG,
      // The build-time handler the parent falls back to on an unbound turn.
      // Deliberately bound to the ROOT here: any path that reaches it instead
      // of a scoped tier shows up in the assertions below as a raw-root write.
      memoryToolHandler: new MemoryToolHandler(root),
      memoryBinder: binder,
    }),
  };
}

async function drain(orchestrator: Orchestrator, origin?: TurnOrigin): Promise<void> {
  for await (const _ of orchestrator.chatStream({
    userMessage: 'los',
    sessionScope: 'sess-904',
    ...(origin ? { origin } : {}),
  })) {
    // drain
  }
}

/** The write the sub-agent performed, or a readable failure. */
function soleWrite(root: RecordingMemoryStore): string {
  assert.equal(
    root.writes.length,
    1,
    root.writes.length === 0
      ? 'the sub-agent produced NO write at all — the granted memory tool never reached storage'
      : `expected exactly one write, got ${root.writes.join(', ')}`,
  );
  return root.writes[0]!;
}

// ── 1. per-agent isolation (predates the context ACL) ───────────────────────

describe('#904 sub-agent memory grant — per-agent isolation', () => {
  it('MUTATION CHECK: with context memory OFF the write stays inside the agent tree', async () => {
    // `off` is the shipping default, so this is the boundary the product has
    // promised since long before the W5 epic: whatever an Agent notes lives
    // under `orchestrator:<slug>:*`, never at the raw store root where every
    // other Agent's tree is reachable.
    const h = harness('off');
    await drain(h.orchestrator);
    const written = soleWrite(h.root);
    assert.equal(
      written,
      `${AGENT_ROOT}/note.md`,
      `sub-agent write escaped the agent tree — landed at ${written}`,
    );
  });

  it('MUTATION CHECK: a spec-carrying `memory` registration is not a way around it', async () => {
    // `registerHandler` (no spec) is what the two shipped memory providers use,
    // and `adaptNativeToolForSubAgent`'s spec guard happened to drop the grant
    // on that shape — an accident, not a boundary. The registry's other public
    // registration path carries a spec, and on that shape the sub-agent got the
    // plugin's ROOT handler and wrote straight to `/memories/note.md`.
    const h = harness('off', 'with-spec');
    await drain(h.orchestrator);
    const written = soleWrite(h.root);
    assert.notEqual(
      written,
      MEMORY_PATH,
      'sub-agent wrote to the UNDECORATED root — the scoping wrapper was skipped',
    );
    assert.equal(written, `${AGENT_ROOT}/note.md`);
  });
});

// ── 2. the chat-context ACL (#881) ──────────────────────────────────────────

describe('#904 sub-agent memory grant — chat-context ACL', () => {
  it('MUTATION CHECK: under `enforce` the write lands in the turn CONTEXT tier', async () => {
    const h = harness('enforce');
    await drain(h.orchestrator, teamsOrigin());
    const written = soleWrite(h.root);
    assert.ok(
      !written.startsWith(`${AGENT_ROOT}/`),
      `sub-agent write landed in the agent-global tree (${written}) — the turn binding was lost`,
    );
    assert.ok(
      written.startsWith(`/memories/contexts/${AGENT_SLUG}/`),
      `sub-agent write did not land in a context tier: ${written}`,
    );
  });

  it('two team contexts do not resolve to the same physical path', async () => {
    const alpha = harness('enforce');
    await drain(alpha.orchestrator, teamsOrigin());
    const beta = harness('enforce');
    await drain(beta.orchestrator, teamsOrigin('c-2', 't-beta'));
    assert.notEqual(
      soleWrite(alpha.root),
      soleWrite(beta.root),
      'two distinct team contexts resolved to the SAME physical path',
    );
  });

  it('MUTATION CHECK: buffered runTurn scopes the sub-agent write too', async () => {
    const h = harness('enforce');
    await h.orchestrator.runTurn({
      userMessage: 'los',
      sessionScope: 'sess-904',
      origin: teamsOrigin(),
    });
    const written = soleWrite(h.root);
    assert.ok(
      written.startsWith(`/memories/contexts/${AGENT_SLUG}/`),
      `sub-agent write did not land in a context tier: ${written}`,
    );
  });
});
