/**
 * Shared world for the member-scoped memory tests: real orchestrator turns
 * (binder, session logger, graph, recall, graph tool, memory tool) with only
 * the model scripted. See `memberScopedMemory.test.ts` for the rule.
 */
import type { LlmProvider, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { InMemoryMemoryStore, MemoryToolHandler } from '@omadia/memory';
import {
  MemoryBinder,
  NativeToolRegistry,
  Orchestrator,
  SessionLogger,
  turnContext,
  type ChatParticipant,
  type ChatParticipantsProvider,
} from '@omadia/orchestrator';
import { ContextRetriever } from '@omadia/orchestrator-extras';
import type { TurnOrigin } from '../../packages/harness-channel-sdk/src/turnOrigin.js';
import { parseSessionScope } from '../../packages/harness-channel-sdk/src/scopeId.js';

export const AGENT = 'team-agent';
export const OTHER_AGENT = 'other-agent';
/** Only the group says this. */
export const SECRET = 'Budget von 4,2 Mio Euro';
export const QUESTION = 'Kranich Budget';

export const MARCEL = { aad: 'aad-marcel', bf: '29:marcel', name: 'Marcel' };
export const CHRIS = { aad: 'aad-chris', bf: '29:chris', name: 'Chris' };
export const CHRISTIAN = { aad: 'aad-christian', bf: '29:christian', name: 'Christian' };
export const NEWBIE = { aad: 'aad-newbie', bf: '29:newbie', name: 'Neu' };
export type Person = typeof MARCEL;

export const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function answer(text: string): LlmStreamEvent[] {
  return [
    { type: 'text_delta', text },
    {
      type: 'final',
      response: {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        providerFinishReason: 'end_turn',
        model: 'test',
        usage,
      },
    } as LlmStreamEvent,
  ];
}

/** One scripted `memory` tool call (`create`, `view`, …). */
export function memoryCall(input: Record<string, unknown>): LlmStreamEvent[] {
  return [
    {
      type: 'final',
      response: {
        content: [{ type: 'tool_call', id: `tu-mem-${String(input['command'])}`, name: 'memory', input }],
        finishReason: 'tool_calls',
        providerFinishReason: 'tool_use',
        model: 'test',
        usage,
      },
    } as LlmStreamEvent,
  ];
}

export function kgSearch(): LlmStreamEvent[] {
  return [
    {
      type: 'final',
      response: {
        content: [
          { type: 'tool_call', id: 'tu-kg', name: 'query_knowledge_graph', input: { query: 'search_turns', text: QUESTION } },
        ],
        finishReason: 'tool_calls',
        providerFinishReason: 'tool_use',
        model: 'test',
        usage,
      },
    } as LlmStreamEvent,
  ];
}

/** Hands out scripted streams on demand and records every request. */
export class ScriptedModel {
  readonly requests: string[] = [];
  private readonly queue: LlmStreamEvent[][] = [];
  push(...streams: LlmStreamEvent[][]): void {
    this.queue.push(...streams);
  }
  provider(): LlmProvider {
    const take = (req: unknown): LlmStreamEvent[] => {
      this.requests.push(JSON.stringify(req));
      const next = this.queue.shift();
      if (!next) throw new Error('no scripted stream left');
      return next;
    };
    return {
      id: 'anthropic',
      capabilities: {
        tools: true,
        vision: false,
        streaming: true,
        promptCaching: false,
        forcedToolChoice: false,
        parallelToolCalls: false,
      },
      complete: async (req: unknown): Promise<LlmResponse> =>
        Promise.resolve((take(req).at(-1) as { response: LlmResponse }).response),
      stream: (req: unknown): AsyncIterable<LlmStreamEvent> => {
        const events = take(req);
        return {
          async *[Symbol.asyncIterator]() {
            for (const ev of events) yield ev;
          },
        };
      },
      classifyError: () => ({ retryable: false, kind: 'other' as const }),
    } as unknown as LlmProvider;
  }
}

export function roster(people: readonly Person[], complete = true): ChatParticipantsProvider {
  const list: ChatParticipant[] = people.map((p) => ({
    channelUserId: p.bf,
    aadObjectId: p.aad,
    displayName: p.name,
    email: null,
    userPrincipalName: null,
  }));
  return Object.assign(async () => Promise.resolve(list), complete ? { completeRoster: true } : {});
}

export const teamsGroup = (conversationId: string): TurnOrigin => ({
  channelType: 'teams',
  scope: parseSessionScope(`msteams::${conversationId}`),
  container: { kind: 'team', id: 'team-alpha' },
});
export const teamsDm = (person: Person): TurnOrigin => ({
  channelType: 'teams',
  scope: { kind: 'personal', userId: person.aad },
});

export interface World {
  readonly graph: InMemoryKnowledgeGraph;
  readonly model: ScriptedModel;
  /** The undecorated memory store every agent's binder sits on. */
  readonly root: InMemoryMemoryStore;
  agent(slug?: string): Orchestrator;
}

export function world(): World {
  const graph = new InMemoryKnowledgeGraph();
  const root = new InMemoryMemoryStore();
  const model = new ScriptedModel();
  const agents = new Map<string, Orchestrator>();
  return {
    graph,
    model,
    root,
    agent(slug = AGENT) {
      const existing = agents.get(slug);
      if (existing) return existing;
      const created = new Orchestrator({
        provider: model.provider(),
        model: 'test',
        maxTokens: 1024,
        maxToolIterations: 4,
        domainTools: [],
        nativeToolRegistry: new NativeToolRegistry(),
        agentId: slug,
        knowledgeGraph: graph,
        contextRetriever: new ContextRetriever(graph),
        sessionLogger: new SessionLogger(root, graph, undefined, slug),
        memoryToolHandler: new MemoryToolHandler(root),
        memoryBinder: new MemoryBinder({ agentSlug: slug, root, mode: 'members' }),
      } as unknown as ConstructorParameters<typeof Orchestrator>[0]);
      agents.set(slug, created);
      return created;
    },
  };
}

/** One turn; returns the serialised model requests it produced. */
export async function turn(
  w: World,
  opts: {
    readonly from: Person;
    readonly origin: TurnOrigin;
    readonly scope: string;
    readonly text: string;
    readonly members?: ChatParticipantsProvider;
    readonly agent?: string;
    readonly script: LlmStreamEvent[][];
    readonly userId?: string;
  },
): Promise<string[]> {
  w.model.push(...opts.script);
  const before = w.model.requests.length;
  const run = async (): Promise<void> => {
    for await (const _ of w.agent(opts.agent).chatStream({
      userMessage: opts.text,
      sessionScope: opts.scope,
      userId: opts.userId ?? opts.from.aad,
      origin: opts.origin,
    })) {
      // drain
    }
  };
  await (opts.members ? turnContext.runWithChatParticipants(opts.members, run) : run());
  return w.model.requests.slice(before);
}

/** Marcel, Chris and Christian talk in the group; the group learns the secret. */
export async function groupLearns(w: World): Promise<void> {
  await turn(w, {
    from: MARCEL,
    origin: teamsGroup('conv-kranich'),
    scope: 'msteams::conv-kranich',
    text: `Projekt Kranich hat ein ${SECRET}.`,
    members: roster([MARCEL, CHRIS, CHRISTIAN]),
    script: [answer('Notiert.')],
  });
}

