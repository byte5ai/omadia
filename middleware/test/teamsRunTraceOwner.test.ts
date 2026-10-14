/**
 * Every Teams turn lost its run trace in production (v0.170.0, 2026-10-07,
 * `run-ingest-failed`, "User-Cluster user:<aad-id> not found"): the Teams
 * plugin names its sender only through `origin` + `userId` (the AAD object
 * id), so no `channelIdentity` reached the kernel and the raw AAD id went to
 * `ingestRun`, which names no User-Cluster. Transcript and embeddings were
 * written; the Run / ToolCall nodes were not.
 *
 * Pinned against a REAL `Orchestrator` and a real in-memory knowledge graph;
 * only the model is scripted. Imported from SOURCE (one AsyncLocalStorage).
 */

import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

import { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { Orchestrator } from '../packages/harness-orchestrator/src/orchestrator.js';
import {
  originChannelIdentity,
  resolveRunTraceOwner,
} from '../packages/harness-orchestrator/src/resolveTurnOwnerIdentity.js';
import { REQUEST, scriptedModel, text } from './_helpers/replayTurnFixture.js';

function orchestratorOver(graph: InMemoryKnowledgeGraph, responses: Parameters<typeof scriptedModel>[0]) {
  const model = scriptedModel(responses);
  const orchestrator = new Orchestrator({
    provider: model.provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    knowledgeGraph: graph,
  });
  return { orchestrator, model };
}

const GROUP_ORIGIN = {
  channelType: 'teams',
  scope: { kind: 'conversation' as const, conversationId: '19:group@thread.v2' },
};

describe('a Teams turn files its run trace under the sender’s canonical cluster', () => {
  beforeEach(() => {
    mock.method(console, 'warn', () => undefined);
    mock.method(console, 'log', () => undefined);
  });
  afterEach(() => {
    mock.restoreAll();
  });

  it('resolves each group participant to their own cluster, and ingestRun accepts it', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const { orchestrator } = orchestratorOver(graph, [text('Hallo Anna.'), text('Hallo Ben.')]);

    const anna = await orchestrator.runTurn({ ...REQUEST, userId: 'aad-anna', origin: GROUP_ORIGIN });
    const ben = await orchestrator.runTurn({ ...REQUEST, userId: 'aad-ben', origin: GROUP_ORIGIN });

    const resolve = async (aad: string) =>
      (await graph.resolveOrCreateChannelIdentity({ channelKind: 'teams', channelUserId: aad, aadObjectId: aad }))
        .omadiaUserId;
    const annaId = await resolve('aad-anna');
    const benId = await resolve('aad-ben');

    assert.equal(anna.runTrace?.userId, annaId, 'Anna’s trace names her cluster');
    assert.equal(ben.runTrace?.userId, benId, 'Ben’s trace names his cluster');
    assert.notEqual(annaId, benId, 'two people, two clusters');
    assert.notEqual(anna.runTrace?.userId, 'aad-anna', 'never the raw AAD id');

    // The production failure: ingestRun refused the raw AAD id.
    for (const [turn, time] of [[anna, '2026-10-07T11:16:00.000Z'], [ben, '2026-10-07T11:17:00.000Z']] as const) {
      const { turnId } = await graph.ingestTurn({
        scope: REQUEST.sessionScope!,
        time,
        userMessage: REQUEST.userMessage,
        assistantAnswer: turn.answer,
        entityRefs: [],
      });
      await graph.ingestRun({ ...turn.runTrace!, turnId });
    }
  });

  it('control: an HTTP turn (no origin) keeps its canonical userId as before', async () => {
    const graph = new InMemoryKnowledgeGraph();
    const { orchestrator } = orchestratorOver(graph, [text('Hallo.')]);
    const result = await orchestrator.runTurn({ ...REQUEST, userId: 'omadia-user-1' });
    assert.equal(result.runTrace?.userId, 'omadia-user-1');
  });

  it('files the trace without a user link when the identity cannot be resolved', async () => {
    const graph = new InMemoryKnowledgeGraph();
    graph.resolveOrCreateChannelIdentity = () => Promise.reject(new Error('graph down'));
    const { orchestrator } = orchestratorOver(graph, [text('Hallo.')]);
    const result = await orchestrator.runTurn({ ...REQUEST, userId: 'aad-anna', origin: GROUP_ORIGIN });
    assert.equal(result.runTrace?.userId, undefined, 'no id no cluster carries');
  });
});

describe('originChannelIdentity / resolveRunTraceOwner', () => {
  it('derives the identity only for a plugin channel turn without channelIdentity', () => {
    assert.deepEqual(originChannelIdentity({ userId: 'aad-1', origin: GROUP_ORIGIN }), {
      channelKind: 'teams',
      channelUserId: 'aad-1',
      aadObjectId: 'aad-1',
    });
    // A Bot-Framework `29:` id is not an AAD id — no AAD merge on it.
    assert.deepEqual(originChannelIdentity({ userId: '29:bf-1', origin: GROUP_ORIGIN }), {
      channelKind: 'teams',
      channelUserId: '29:bf-1',
    });
    assert.equal(originChannelIdentity({ userId: 'u-1' }), undefined, 'HTTP turn');
    assert.equal(
      originChannelIdentity({ userId: 'u-1', origin: { ...GROUP_ORIGIN, channelType: 'http' } }),
      undefined,
      'a channel type the graph does not model',
    );
    assert.equal(
      originChannelIdentity({
        userId: 'aad-1',
        origin: GROUP_ORIGIN,
        channelIdentity: { channelKind: 'teams', channelUserId: 'aad-1' },
      }),
      undefined,
      'a dispatcher-minted identity is resolved by the turn owner already',
    );
  });

  it('a dispatcher turn keeps the owner the turn already resolved', async () => {
    const owner = await resolveRunTraceOwner(
      undefined,
      { userId: 'aad-1', channelIdentity: { channelKind: 'teams', channelUserId: 'aad-1' } },
      'canonical-1',
    );
    assert.equal(owner, 'canonical-1');
  });

  it('without a knowledge graph a Teams turn files no user link', async () => {
    assert.equal(await resolveRunTraceOwner(undefined, { userId: 'aad-1', origin: GROUP_ORIGIN }, 'aad-1'), undefined);
  });
});
