/**
 * Member-scoped memory (`members` context memory), end to end.
 *
 * The rule Marcel set: knowledge belongs to the people present when it came
 * up; a chat may use it when everyone present is one of them.
 *
 *   - Marcel, Chris and Christian build knowledge in a group →
 *     Marcel alone with the agent has it.
 *   - Someone new joins the group → while they are present, it stays out.
 *   - Chris and Christian without Marcel → they have it.
 *   - Person-based, not channel-based: Teams group → Marcel's Telegram DM has
 *     it, once his Telegram identity is linked to the same person.
 *   - Agents keep their own knowledge: another agent never has it.
 *   - A group whose member list is not known complete gets none, and what it
 *     says belongs to nobody.
 *
 * Every test runs real orchestrator turns — binder, session logger, graph,
 * recall assembler and graph tool are the production classes, only the model
 * is scripted — and reads what actually reached the model.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

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

const AGENT = 'team-agent';
const OTHER_AGENT = 'other-agent';
/** Only the group says this. */
const SECRET = 'Budget von 4,2 Mio Euro';
const QUESTION = 'Kranich Budget';

const MARCEL = { aad: 'aad-marcel', bf: '29:marcel', name: 'Marcel' };
const CHRIS = { aad: 'aad-chris', bf: '29:chris', name: 'Chris' };
const CHRISTIAN = { aad: 'aad-christian', bf: '29:christian', name: 'Christian' };
const NEWBIE = { aad: 'aad-newbie', bf: '29:newbie', name: 'Neu' };
type Person = typeof MARCEL;

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

function answer(text: string): LlmStreamEvent[] {
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

function kgSearch(): LlmStreamEvent[] {
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
class ScriptedModel {
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

function roster(people: readonly Person[], complete = true): ChatParticipantsProvider {
  const list: ChatParticipant[] = people.map((p) => ({
    channelUserId: p.bf,
    aadObjectId: p.aad,
    displayName: p.name,
    email: null,
    userPrincipalName: null,
  }));
  return Object.assign(async () => Promise.resolve(list), complete ? { completeRoster: true } : {});
}

const teamsGroup = (conversationId: string): TurnOrigin => ({
  channelType: 'teams',
  scope: parseSessionScope(`msteams::${conversationId}`),
  container: { kind: 'team', id: 'team-alpha' },
});
const teamsDm = (person: Person): TurnOrigin => ({
  channelType: 'teams',
  scope: { kind: 'personal', userId: person.aad },
});

interface World {
  readonly graph: InMemoryKnowledgeGraph;
  readonly model: ScriptedModel;
  agent(slug?: string): Orchestrator;
}

function world(): World {
  const graph = new InMemoryKnowledgeGraph();
  const root = new InMemoryMemoryStore();
  const model = new ScriptedModel();
  const agents = new Map<string, Orchestrator>();
  return {
    graph,
    model,
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
async function turn(
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
async function groupLearns(w: World): Promise<void> {
  await turn(w, {
    from: MARCEL,
    origin: teamsGroup('conv-kranich'),
    scope: 'msteams::conv-kranich',
    text: `Projekt Kranich hat ein ${SECRET}.`,
    members: roster([MARCEL, CHRIS, CHRISTIAN]),
    script: [answer('Notiert.')],
  });
}

const sees = (requests: string[]): boolean => requests.some((r) => r.includes(SECRET));

describe('member-scoped memory — whose knowledge reaches which chat', () => {
  it('the group turn is stored with its three owners', async () => {
    const w = world();
    await groupLearns(w);
    const [hit] = await w.graph.searchTurns({ query: QUESTION, limit: 5 });
    assert.ok(hit, 'the group turn was not stored');
    const session = await w.graph.getSession(hit.scope);
    const owners = session?.turns[0]?.turn.props['owners'] as string[] | undefined;
    assert.equal(owners?.length, 3, `owners: ${JSON.stringify(owners)}`);
  });

  it('Marcel alone with the agent has the group knowledge', async () => {
    const w = world();
    await groupLearns(w);
    const requests = await turn(w, {
      from: MARCEL,
      origin: teamsDm(MARCEL),
      scope: 'msteams::dm-marcel',
      text: QUESTION,
      script: [answer('Ja.')],
    });
    assert.ok(sees(requests), 'the group knowledge did not reach Marcel’s direct chat');
  });

  it('a new member in the group: the knowledge stays out while they are present', async () => {
    const w = world();
    await groupLearns(w);
    const requests = await turn(w, {
      from: MARCEL,
      origin: teamsGroup('conv-kranich'),
      scope: 'msteams::conv-kranich',
      text: QUESTION,
      members: roster([MARCEL, CHRIS, CHRISTIAN, NEWBIE]),
      script: [kgSearch(), answer('Dazu habe ich nichts.')],
    });
    assert.ok(!sees(requests), 'the new member’s room received the group knowledge (tail, recall or graph tool)');
  });

  it('Chris and Christian without Marcel have it', async () => {
    const w = world();
    await groupLearns(w);
    const requests = await turn(w, {
      from: CHRIS,
      origin: teamsGroup('conv-chris-christian'),
      scope: 'msteams::conv-chris-christian',
      text: QUESTION,
      members: roster([CHRIS, CHRISTIAN]),
      script: [answer('Ja.')],
    });
    assert.ok(sees(requests), 'Chris and Christian did not get the knowledge they own');
  });

  it('it is person-based: Marcel’s linked Telegram DM has it', async () => {
    const w = world();
    // Marcel's Teams and Telegram identities are known to be the same person
    // (verified email on both) — the cluster merge the identity layer does.
    await w.graph.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: MARCEL.aad,
      aadObjectId: MARCEL.aad,
      email: 'marcel@example.com',
      emailVerified: true,
    });
    await w.graph.resolveOrCreateChannelIdentity({
      channelKind: 'telegram',
      channelUserId: 'telegram:4711',
      email: 'marcel@example.com',
      emailVerified: true,
    });
    await groupLearns(w);
    const requests = await turn(w, {
      from: MARCEL,
      userId: 'telegram:4711',
      origin: { channelType: 'telegram', scope: { kind: 'personal', userId: '4711' } },
      scope: 'telegram::4711',
      text: QUESTION,
      script: [answer('Ja.')],
    });
    assert.ok(sees(requests), 'the Teams group knowledge did not reach the same person on Telegram');
  });

  it('another agent never has it', async () => {
    const w = world();
    await groupLearns(w);
    const requests = await turn(w, {
      from: MARCEL,
      agent: OTHER_AGENT,
      origin: teamsDm(MARCEL),
      scope: 'msteams::dm-marcel-other',
      text: QUESTION,
      script: [kgSearch(), answer('Nein.')],
    });
    assert.ok(!sees(requests), 'another agent received the group knowledge');
  });

  it('a group without a complete member list gets nothing, and owns nothing', async () => {
    const w = world();
    await groupLearns(w);
    const requests = await turn(w, {
      from: MARCEL,
      origin: teamsGroup('conv-kranich'),
      scope: 'msteams::conv-kranich',
      text: QUESTION,
      members: roster([MARCEL, CHRIS, CHRISTIAN], false),
      script: [kgSearch(), answer('Nichts.')],
    });
    assert.ok(!sees(requests), 'an unknown room received member-scoped knowledge');
    // The group's graph scope, as the session logger wrote it (sanitised).
    const [group] = await w.graph.listSessions();
    const session = group ? await w.graph.getSession(group.scope) : null;
    const last = session?.turns.at(-1)?.turn.props['owners'];
    assert.deepEqual(last, [], 'a turn from an unknown room must be owned by nobody');
  });
});
