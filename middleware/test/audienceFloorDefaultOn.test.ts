/**
 * #2048 (spec 2042 G15, §5.4 step 5) — the audience floor is on by default.
 *
 * Pins the issue's two acceptance criteria and the edges default-on creates:
 *
 *  - a fresh configuration enforces the floor without any setting, and an
 *    ordinary person in a 1:1 (web chat) still gets the agent's tools;
 *  - in a group with a member lacking a right, a tool requiring that right is
 *    refused, while the others still run;
 *  - a participant nobody can resolve, or a group without a roster, closes the
 *    room (fail-closed), with a reason that says why;
 *  - headless turns (schedules, Conductor steps) have no audience and are not
 *    bounded by it.
 *
 * The orchestrator, the baseline store and the guard are imported from SOURCE
 * (one AsyncLocalStorage); grant stores come through the package like every
 * other audience test (see `audienceFloorProvider.test.ts` for why).
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  InMemoryGrantStore,
  RoleSourceRegistry,
  floorPermits,
  makePrincipal,
  type AudienceFloor,
  type Principal,
  type ConversationRoster,
} from '@omadia/channel-sdk';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

import { ConfigSchema } from '../src/config.js';
import { guardToolEgress } from '../packages/harness-orchestrator/src/audienceFloorGuard.js';
import {
  audienceRoomFor,
  chatParticipantsFromRoster,
  createAudienceFloorProvider,
} from '../packages/harness-orchestrator/src/audienceFloorProvider.js';
import type { ChatParticipant } from '../packages/harness-orchestrator/src/chatParticipants.js';
import {
  MEMBER_BASELINE_CAPABILITIES,
  MemberBaselineGrantStore,
} from '../packages/harness-orchestrator/src/memberBaselineGrantStore.js';
import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { Orchestrator } from '../packages/harness-orchestrator/src/orchestrator.js';
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import {
  REQUEST,
  drain,
  scriptedModel,
  text,
  toolCalls,
  toolResultContents,
} from './_helpers/replayTurnFixture.js';

const ANNA = makePrincipal('user', 'anna') as Principal;
const BEN = makePrincipal('user', 'ben') as Principal;

function participant(id: string, kind?: 'agent'): ChatParticipant {
  return {
    channelUserId: id,
    aadObjectId: null,
    displayName: id,
    email: null,
    userPrincipalName: null,
    ...(kind ? { kind } : {}),
  };
}

/** A group whose participants resolve 1:1 to `user:<id>`; `ghost` never does. */
function groupFloor(ids: readonly string[], grants: InMemoryGrantStore): () => Promise<AudienceFloor> {
  return createAudienceFloorProvider({
    participants: async () => ids.map((id) => participant(id)),
    resolvePrincipal: async (p) => (p.channelUserId === 'ghost' ? undefined : makePrincipal('user', p.channelUserId)),
    roles: new RoleSourceRegistry(),
    grants: new MemberBaselineGrantStore(grants),
    room: { kind: 'shared' },
  });
}

function guardIn(floor: () => Promise<AudienceFloor>, tool: string): Promise<string | undefined> {
  return turnContext.run({ turnId: 't', turnDate: '2026-11-20', audienceFloor: floor }, () =>
    guardToolEgress(tool),
  );
}

describe('#2048 — a fresh configuration enforces the audience floor', () => {
  it('turns the floor on with the member baseline when nothing is configured', () => {
    const parsed = ConfigSchema.parse({});
    assert.equal(parsed.AUDIENCE_FLOOR_ENABLED, true);
    assert.equal(parsed.AUDIENCE_BASELINE_GRANTS, 'member');
  });

  it('keeps an explicit opt-out and the strict reading available', () => {
    const parsed = ConfigSchema.parse({ AUDIENCE_FLOOR_ENABLED: 'false', AUDIENCE_BASELINE_GRANTS: 'none' });
    assert.equal(parsed.AUDIENCE_FLOOR_ENABLED, false);
    assert.equal(parsed.AUDIENCE_BASELINE_GRANTS, 'none');
  });
});

describe('#2048 — the member baseline', () => {
  it('gives every resolved person the baseline on top of stored grants, and roles nothing extra', async () => {
    const store = new MemberBaselineGrantStore(new InMemoryGrantStore().grantToPrincipal(ANNA, 'net:*'));
    assert.deepEqual(
      new Set(await store.directGrants(ANNA)),
      new Set(['net:*', ...MEMBER_BASELINE_CAPABILITIES]),
    );
    assert.deepEqual(await store.roleGrants('sales'), []);
  });

  it('passes prohibitions through and does not swallow an unreadable grant table', async () => {
    const inner = new InMemoryGrantStore().denyToPrincipal(BEN, 'tool:send_mail');
    const store = new MemberBaselineGrantStore(inner);
    assert.deepEqual(await store.directDenials(BEN), ['tool:send_mail']);

    const broken = new MemberBaselineGrantStore({
      directGrants: () => Promise.reject(new Error('db down')),
      roleGrants: () => Promise.resolve([]),
    });
    await assert.rejects(() => broken.directGrants(ANNA), /db down/);
  });

  it('`tool:*` permits any tool, and an explicit prohibition still beats it', () => {
    const floor: AudienceFloor = {
      outcome: 'open',
      capabilities: new Set(['tool:*']),
      denied: new Set(['tool:send_mail']),
    };
    assert.equal(floorPermits(floor, 'tool:odoo_read'), true);
    assert.equal(floorPermits(floor, 'tool:send_mail'), false);
    assert.equal(floorPermits(floor, 'memory:recall'), false, 'the wildcard covers tools only');
  });
});

describe('#2048 — acceptance: a member lacking a right withholds that tool from the group', () => {
  it('refuses the prohibited tool for the whole room and lets the others run', async () => {
    const grants = new InMemoryGrantStore().denyToPrincipal(BEN, 'tool:hr_read_record');
    const floor = groupFloor(['anna', 'ben'], grants);

    const refused = await guardIn(floor, 'hr_read_record');
    assert.match(refused ?? '', /refused for this conversation/);
    assert.equal(await guardIn(floor, 'crm_lookup'), undefined, 'a tool nobody forbids still runs');

    const annaAlone = groupFloor(['anna'], grants);
    assert.equal(await guardIn(annaAlone, 'hr_read_record'), undefined, 'without Ben the room may');
  });

  it('closes the room when a participant cannot be resolved (least-privileged audience)', async () => {
    const floor = groupFloor(['anna', 'ghost'], new InMemoryGrantStore());
    assert.match((await guardIn(floor, 'crm_lookup')) ?? '', /could not be resolved/);
  });

  it('names the reason when a channel provides no participant list', async () => {
    const floor = createAudienceFloorProvider({
      participants: undefined,
      resolvePrincipal: async () => ANNA,
      roles: new RoleSourceRegistry(),
      grants: new MemberBaselineGrantStore(),
      room: { kind: 'shared' },
    });
    assert.match(
      (await guardIn(floor, 'crm_lookup')) ?? '',
      /does not tell omadia who is in the conversation/,
    );
  });

  it('does not count other agents in the room as readers', async () => {
    const floor = createAudienceFloorProvider({
      participants: async () => [participant('anna'), participant('bot-mira', 'agent')],
      resolvePrincipal: async (p) =>
        p.channelUserId === 'anna' ? ANNA : undefined,
      roles: new RoleSourceRegistry(),
      grants: new MemberBaselineGrantStore(),
      room: { kind: 'shared' },
    });
    assert.equal(await guardIn(floor, 'crm_lookup'), undefined);
  });
});

describe('#2048 — which room a turn is', () => {
  it('reads web, API and 1:1 channel turns as one-reader rooms of the turn owner', () => {
    assert.deepEqual(audienceRoomFor({}, 'anna'), { kind: 'personal', owner: ANNA });
    assert.deepEqual(
      audienceRoomFor({ origin: { channelType: 'api', scope: { kind: 'conversation', conversationId: 'k' } } }, 'anna'),
      { kind: 'personal', owner: ANNA },
    );
    assert.deepEqual(
      audienceRoomFor({ origin: { channelType: 'teams', scope: { kind: 'personal', userId: 'aad' } } }, 'anna'),
      { kind: 'personal', owner: ANNA },
    );
    assert.deepEqual(
      audienceRoomFor(
        {
          origin: {
            channelType: 'telegram',
            scope: { kind: 'conversation', conversationId: 'c' },
            conversationType: 'direct',
          },
        },
        'anna',
      ),
      { kind: 'personal', owner: ANNA },
    );
  });

  it('reads group channel turns as shared rooms bounded by the roster', () => {
    assert.deepEqual(
      audienceRoomFor({ origin: { channelType: 'teams', scope: { kind: 'conversation', conversationId: '19:x' } } }, 'anna'),
      { kind: 'shared' },
    );
  });

  it('gives a 1:1 without a resolvable owner no audience, and a headless turn no floor', async () => {
    const room = audienceRoomFor({ origin: { channelType: 'teams', scope: { kind: 'personal', userId: 'aad' } } }, undefined);
    assert.deepEqual(room, { kind: 'personal', owner: undefined });
    const floor = createAudienceFloorProvider({
      participants: undefined,
      resolvePrincipal: async () => undefined,
      roles: new RoleSourceRegistry(),
      grants: new MemberBaselineGrantStore(),
      ...(room ? { room } : {}),
    });
    assert.equal((await floor()).outcome, 'closed');
    assert.equal(audienceRoomFor({}, undefined), undefined, 'a schedule or Conductor step has no reader');
  });
});

describe('#2048 — a facilitator turn reads its conversation roster', () => {
  const roster = (over: Partial<ConversationRoster>): ConversationRoster => ({
    conversationType: 'group',
    participants: [
      { userRef: { kind: 'teams-aad', id: '29:anna', displayName: 'Anna' }, externalId: 'aad-anna' },
      { userRef: { kind: 'teams-aad', id: '28:mira' }, isBot: true },
    ],
    partial: false,
    ...over,
  });

  it('maps people and marks bots as agents', async () => {
    const list = await chatParticipantsFromRoster(async () => roster({}))();
    assert.deepEqual(
      list.map((p) => [p.channelUserId, p.aadObjectId, p.kind]),
      [
        ['29:anna', 'aad-anna', undefined],
        ['28:mira', null, 'agent'],
      ],
    );
  });

  it('yields no participants for an unreadable roster, which closes the floor', async () => {
    assert.deepEqual(await chatParticipantsFromRoster(async () => undefined)(), []);
    assert.deepEqual(
      await chatParticipantsFromRoster(async () => roster({ status: 'unknown', participants: [] }))(),
      [],
    );
  });
});

describe('#2048 — the orchestrator installs the floor on both turn paths', () => {
  beforeEach(() => {
    mock.method(console, 'warn', () => undefined);
    mock.method(console, 'log', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  function setup(
    grants: InMemoryGrantStore,
    graphs: { knowledgeGraph?: InMemoryKnowledgeGraph; identityGraph?: InMemoryKnowledgeGraph } = {
      knowledgeGraph: new InMemoryKnowledgeGraph(),
    },
  ) {
    const registry = new NativeToolRegistry();
    let runs = 0;
    registry.register('hr_read_record', {
      handler: async () => {
        runs += 1;
        return 'record';
      },
      spec: {
        name: 'hr_read_record',
        description: 'reads an HR record',
        input_schema: { type: 'object' as const, properties: {}, required: [] },
      } as never,
    });
    const model = scriptedModel([toolCalls(['hr_read_record', {}]), text('done')]);
    const orchestrator = new Orchestrator({
      provider: model.provider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: registry,
      ...(graphs.knowledgeGraph ? { knowledgeGraph: graphs.knowledgeGraph } : {}),
      ...(graphs.identityGraph ? { identityGraph: graphs.identityGraph } : {}),
      audienceGrants: new MemberBaselineGrantStore(grants),
    });
    return { orchestrator, model, runs: () => runs };
  }

  it('lets an ordinary web-chat user use the tool (buffered path)', async () => {
    const { orchestrator, runs } = setup(new InMemoryGrantStore());
    await orchestrator.runTurn({ ...REQUEST, userId: 'anna' });
    assert.equal(runs(), 1);
  });

  it('refuses the tool to a web-chat user it is forbidden to (streaming path)', async () => {
    const { orchestrator, model, runs } = setup(new InMemoryGrantStore().denyToPrincipal(ANNA, 'tool:hr_read_record'));
    await drain(orchestrator.chatStream({ ...REQUEST, userId: 'anna' }));
    assert.equal(runs(), 0, 'the handler never ran');
    assert.ok(
      toolResultContents(model.requests[1]).some((c) => c.includes('refused for this conversation')),
      'the model was told why',
    );
  });

  // Live 2026-11-20: a facilitator is built without memory, so it had no
  // knowledge graph, so nobody in its group resolved, and the floor refused
  // every tool of a running facilitation.
  const groupTurn = {
    ...REQUEST,
    origin: { channelType: 'teams', scope: { kind: 'conversation' as const, conversationId: '19:x' } },
  };
  const roomOf = (ids: readonly string[]) => async () =>
    ids.map((id) => ({ ...participant(`29:${id}`), aadObjectId: `aad-${id}` }));

  it('resolves the group of an orchestrator built without memory through its identity graph', async () => {
    const { orchestrator, runs } = setup(new InMemoryGrantStore(), {
      identityGraph: new InMemoryKnowledgeGraph(),
    });
    await turnContext.runWithChatParticipants(roomOf(['anna', 'ben', 'carl']), () =>
      orchestrator.runTurn(groupTurn),
    );
    assert.equal(runs(), 1, 'the tool ran for a room of resolvable people');
  });

  it('closes that group when no graph can say who its members are', async () => {
    const { orchestrator, model, runs } = setup(new InMemoryGrantStore(), {});
    await turnContext.runWithChatParticipants(roomOf(['anna', 'ben', 'carl']), () =>
      orchestrator.runTurn(groupTurn),
    );
    assert.equal(runs(), 0);
    assert.ok(
      toolResultContents(model.requests[1]).some((c) => c.includes('3 participant(s) could not be resolved')),
      'the refusal names the unresolved members',
    );
  });
});
