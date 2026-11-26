/**
 * ADR-0044 — the bounded graph services a plugin resolves through
 * `ctx.services.get`. The canary sweep (`test/memoryAccess`) proves the
 * boundary end to end over the seeded world; this file pins the rules per
 * method on small fakes.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryMemoryStore } from '@omadia/memory';
import { turnContext, type GraphReadScope } from '@omadia/orchestrator';
import {
  GraphServiceRefusedError,
  KgEntityNamespaceError,
  MemoryPathError,
  neighborsOfType,
  type GraphNode,
  type KnowledgeGraph,
  type ProcessMemoryService,
  type ProcessRecord,
} from '@omadia/plugin-api';

import {
  KG_METHOD_ACCESS,
  boundKnowledgeGraph,
  boundMemoryStore,
  boundProcessMemory,
  boundTopicClustering,
} from '../src/platform/boundedGraphServices.js';

const PLUGIN = '@test/plugin';
const ATLAS = 'atlas::';

function inTurn<T>(bound: GraphReadScope | undefined, fn: () => Promise<T>, extra: Record<string, unknown> = {}): Promise<T> {
  return turnContext.run(
    { turnId: 't-1', turnDate: '2026-11-25', agentSlug: 'atlas', graphReadScope: bound ? { value: bound } : {}, ...extra },
    fn,
  );
}

const USER_BOUND: GraphReadScope = { kind: 'user', userId: 'u-a', agentScopePrefix: ATLAS, ownScope: null };
const STRICT_BOUND: GraphReadScope = { kind: 'conversation', scope: `${ATLAS}room` };

function node(id: string, type: string, props: Record<string, unknown> = {}): GraphNode {
  return { id, type, props } as GraphNode;
}

/** A graph whose every method records its call and returns a fixed answer. */
function fakeGraph(): { kg: KnowledgeGraph; calls: string[] } {
  const calls: string[] = [];
  const answers: Record<string, unknown> = {
    searchTurns: [
      { turnId: 't-own', scope: `${ATLAS}room` },
      { turnId: 't-other', scope: 'boreas::room' },
    ],
    findEntities: [node('e-synced', 'OdooEntity'), node('e-captured', 'OdooEntity')],
    getNeighbors: [],
    listPlansForScope: [node('plan-1', 'Plan')],
    ingestEntities: { inserted: 1 },
    ingestFacts: { inserted: 1 },
  };
  const plans: Record<string, GraphNode> = {
    'plan:own': node('plan:own', 'Plan', { scope: 'atlas::web-1' }),
    'plan:other': node('plan:other', 'Plan', { scope: 'atlas::web-2' }),
  };
  const neighbours: Record<string, GraphNode[]> = {
    'e-captured': [node('t-hidden', 'Turn', { scope: 'boreas::room' })],
    'planstep:own-1': [plans['plan:own']!],
    'planstep:other-1': [plans['plan:other']!],
  };
  const kg = new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) {
      if (!(prop in KG_METHOD_ACCESS)) return undefined;
      return async (...args: unknown[]) => {
        calls.push(prop);
        if (prop === 'getNeighbors') return neighbours[String(args[0])] ?? [];
        if (prop === 'getNeighborsOfType') {
          const [ids, type] = args as [string[], string];
          return new Map(ids.map((id) => [id, (neighbours[id] ?? []).filter((n) => n.type === type)]));
        }
        if (prop === 'getSession') return null;
        if (prop === 'getPlan') return plans[String(args[0])] ?? null;
        return answers[prop] ?? null;
      };
    },
    has: (_t, prop) => typeof prop === 'string' && prop in KG_METHOD_ACCESS,
  }) as unknown as KnowledgeGraph;
  return { kg, calls };
}

describe('ADR-0044 · bounded knowledgeGraph@1', () => {
  it('exposes only the contract methods', () => {
    const extra = { ...fakeGraph().kg, ingestCompanies: async () => undefined };
    const bounded = boundKnowledgeGraph(Object.assign(Object.create(fakeGraph().kg as object), extra), PLUGIN);
    assert.equal((bounded as unknown as Record<string, unknown>)['ingestCompanies'], undefined);
    for (const key of Object.keys(bounded)) assert.ok(key in KG_METHOD_ACCESS, key);
  });

  it('refuses a turn read outside a turn, and in a turn whose boundary is not bound', async () => {
    const { kg, calls } = fakeGraph();
    const bounded = boundKnowledgeGraph(kg, PLUGIN);
    for (const run of [
      () => bounded.searchTurns({ query: 'x' }),
      () => inTurn(undefined, () => bounded.searchTurns({ query: 'x' })),
      () => bounded.getSession('atlas::room'),
      () => bounded.getNeighbors('n'),
      () => bounded.getPlan('plan-1'),
    ]) {
      await assert.rejects(run, (err: unknown) => err instanceof GraphServiceRefusedError && err.reason === 'no-boundary');
    }
    assert.deepEqual(calls, [], 'nothing reached the graph');
  });

  it('refuses the kernel-only methods in and outside a turn', async () => {
    const bounded = boundKnowledgeGraph(fakeGraph().kg, PLUGIN);
    for (const method of ['listSessions', 'listMemorableKnowledgeFor', 'purgeMemorableKnowledge', 'ingestTurn'] as const) {
      const fn = bounded[method] as unknown as (...a: unknown[]) => Promise<unknown>;
      await assert.rejects(() => fn({}), (err: unknown) => err instanceof GraphServiceRefusedError && err.reason === 'kernel-only');
      await inTurn(USER_BOUND, () => assert.rejects(() => fn({}), GraphServiceRefusedError));
    }
  });

  it('holds a turn search to the boundary: this agent only, exact scope', async () => {
    const bounded = boundKnowledgeGraph(fakeGraph().kg, PLUGIN);
    const hits = await inTurn(USER_BOUND, () => bounded.searchTurns({ query: 'x' }));
    assert.deepEqual(hits.map((h) => h.turnId), ['t-own']);
    assert.deepEqual(await inTurn({ kind: 'nothing' }, () => bounded.searchTurns({ query: 'x' })), []);
  });

  it('passes entity writes and, outside a context-bound turn, entity reads', async () => {
    const bounded = boundKnowledgeGraph(fakeGraph().kg, PLUGIN);
    assert.deepEqual(await bounded.ingestEntities([]), { inserted: 1 });
    const outside = await bounded.findEntities({ model: 'res.partner' });
    assert.deepEqual(outside.map((n) => n.id), ['e-synced', 'e-captured']);
    const enforce = await inTurn(USER_BOUND, () => bounded.findEntities({ model: 'res.partner' }));
    assert.equal(enforce.length, 2);
  });

  it('ADR-0167: a plugin declaring entity systems writes entities and facts only there', async () => {
    const { kg, calls } = fakeGraph();
    const bounded = boundKnowledgeGraph(kg, PLUGIN, ['odoo']);
    assert.deepEqual(await bounded.ingestEntities([{ system: 'odoo', model: 'res.partner', id: 1 }]), { inserted: 1 });
    const fact = (ids: string[], factId = 'fact:t:s:p:o') => ({
      factId,
      sourceTurnId: 't',
      subject: 's',
      predicate: 'p',
      object: 'o',
      mentionedEntityIds: ids,
    });
    assert.deepEqual(await bounded.ingestFacts([fact(['odoo:res.partner:1'])]), { inserted: 1 });
    await assert.rejects(
      () => bounded.ingestEntities([{ system: 'confluence', model: 'page', id: 2 }]),
      KgEntityNamespaceError,
    );
    await assert.rejects(
      () => bounded.ingestFacts([fact(['odoo:res.partner:1', 'confluence:page:2'])]),
      KgEntityNamespaceError,
    );
    // A fact id that names an entity node would upsert into that node.
    await assert.rejects(() => bounded.ingestFacts([fact([], 'odoo:res.partner:1')]), KgEntityNamespaceError);
    assert.deepEqual(calls, ['ingestEntities', 'ingestFacts'], 'a refused write never reached the graph');
  });

  it('leaves the batched neighbour read off the bounded object; neighborsOfType falls back', async () => {
    const { kg, calls } = fakeGraph();
    const bounded = boundKnowledgeGraph(kg, PLUGIN);
    assert.equal(bounded.getNeighborsOfType, undefined);
    const map = await inTurn(USER_BOUND, () => neighborsOfType(bounded, ['e-captured'], 'Turn'));
    assert.deepEqual([...map.keys()], ['e-captured']);
    assert.equal(calls.includes('getNeighborsOfType'), false);
    assert.ok(calls.includes('getNeighbors'), 'the bounded per-node read ran');
  });

  it('ADR-0169: a plugin declaring none writes no entity and no fact', async () => {
    const { kg, calls } = fakeGraph();
    const bounded = boundKnowledgeGraph(kg, '@test/undeclared');
    const fact = (ids: string[]) =>
      ({ factId: 'fact:t:s:p:o', sourceTurnId: 't', subject: 's', predicate: 'p', object: 'o', mentionedEntityIds: ids }) as never;
    await assert.rejects(
      () => bounded.ingestEntities([{ system: 'odoo', model: 'res.partner', id: 1 }]),
      KgEntityNamespaceError,
    );
    await assert.rejects(() => bounded.ingestFacts([fact(['odoo:res.partner:1'])]), KgEntityNamespaceError);
    // Not even a fact that mentions no entity.
    await assert.rejects(() => bounded.ingestFacts([fact([])]), /system='fact'/);
    assert.deepEqual(calls, [], 'a refused write never reached the graph');
    // An empty batch writes nothing and still passes through.
    await bounded.ingestEntities([]);
    await bounded.ingestFacts([]);
    assert.deepEqual(calls, ['ingestEntities', 'ingestFacts']);
  });

  it('enforce-strict: an entity another conversation captured stays out; synced master data stays in', async () => {
    const { kg, calls } = fakeGraph();
    const bounded = boundKnowledgeGraph(kg, PLUGIN);
    const hits = await inTurn(STRICT_BOUND, () => bounded.findEntities({ model: 'res.partner' }));
    assert.deepEqual(hits.map((n) => n.id), ['e-synced']);
    // One batched neighbour read for every hit, not one per hit (N+1).
    assert.equal(calls.filter((c) => c === 'getNeighborsOfType').length, 1);
    assert.equal(calls.includes('getNeighbors'), false);
  });

  it('findEntities falls back to getNeighbors per hit for a provider without the batched read', async () => {
    const { kg } = fakeGraph();
    const withoutBatch = new Proxy(kg as object, {
      get: (target, prop) => (prop === 'getNeighborsOfType' ? undefined : Reflect.get(target, prop)),
      has: (target, prop) => prop !== 'getNeighborsOfType' && Reflect.has(target, prop),
    }) as KnowledgeGraph;
    const bounded = boundKnowledgeGraph(withoutBatch, PLUGIN);
    const hits = await inTurn(STRICT_BOUND, () => bounded.findEntities({ model: 'res.partner' }));
    assert.deepEqual(hits.map((n) => n.id), ['e-synced']);
  });

  it('lists the plans of the turn’s own conversation only, and none in a context-bound turn', async () => {
    const bounded = boundKnowledgeGraph(fakeGraph().kg, PLUGIN);
    const own = await inTurn(USER_BOUND, () => bounded.listPlansForScope('atlas::web-1'), { sessionScope: 'web-1' });
    const other = await inTurn(USER_BOUND, () => bounded.listPlansForScope('atlas::web-2'), { sessionScope: 'web-1' });
    const strict = await inTurn(STRICT_BOUND, () => bounded.listPlansForScope('atlas::web-1'), { sessionScope: 'web-1' });
    assert.equal(own.length, 1, JSON.stringify(own));
    assert.deepEqual(other, []);
    assert.deepEqual(strict, []);
  });
});

describe('ADR-0167 · kernel node namespaces are never an entity system', () => {
  const fact = (factId: unknown, ids: string[] = []) =>
    ({ factId, sourceTurnId: 't', subject: 's', predicate: 'p', object: 'o', mentionedEntityIds: ids }) as never;
  const refused = (err: unknown): boolean => err instanceof KgEntityNamespaceError;

  for (const [label, systems] of [
    ['a declared writer', ['turn', 'session', 'notes']],
    ['an undeclared writer', []],
  ] as const) {
    it(`${label}: turn, session, user, channel and fact namespaces are refused before the graph`, async () => {
      const { kg, calls } = fakeGraph();
      const bounded = boundKnowledgeGraph(kg, '@test/ns', systems);
      for (const system of ['turn', 'session', 'user', 'teams', 'fact', 'mk', 'process', 'turn:atlas:']) {
        await assert.rejects(() => bounded.ingestEntities([{ system, model: 'm', id: 1 }]), refused, system);
      }
      for (const factId of ['odoo:res.partner:1', 'turn:atlas::web-1:2026', undefined, 42]) {
        await assert.rejects(() => bounded.ingestFacts([fact(factId)]), refused, String(factId));
      }
      assert.deepEqual(calls, [], 'nothing reached the graph');
    });
  }

  it('ADR-0169: the Odoo and Confluence syncs write their own master data once declared', async () => {
    const { kg, calls } = fakeGraph();
    const odoo = boundKnowledgeGraph(kg, '@omadia/integration-odoo', ['odoo']);
    const confluence = boundKnowledgeGraph(kg, '@omadia/integration-confluence', ['confluence']);
    await odoo.ingestEntities([{ system: 'odoo', model: 'res.partner', id: 1 }]);
    await confluence.ingestEntities([{ system: 'confluence', model: 'page', id: '123' }]);
    await odoo.ingestFacts([fact('fact:t:s:p:o', ['odoo:res.partner:1'])]);
    await assert.rejects(() => odoo.ingestEntities([{ system: 'confluence', model: 'page', id: '1' }]), refused);
    await assert.rejects(() => confluence.ingestEntities([{ system: 'odoo', model: 'res.partner', id: 1 }]), refused);
    assert.deepEqual(calls, ['ingestEntities', 'ingestEntities', 'ingestFacts']);
  });
});

describe('ADR-0044 · bounded plans: the turn’s own conversation only', () => {
  const own = <T>(fn: () => Promise<T>): Promise<T> => inTurn(STRICT_BOUND, fn, { sessionScope: 'web-1' });

  it('reads and changes the turn’s own plans', async () => {
    const { kg, calls } = fakeGraph();
    const bounded = boundKnowledgeGraph(kg, PLUGIN);
    assert.equal((await own(() => bounded.getPlan('plan:own')))?.id, 'plan:own');
    await own(() => bounded.setPlanStepStatus('planstep:own-1', 'done'));
    await own(() => bounded.ingestPlan({ planId: 'p', scope: 'atlas::web-1' } as never));
    assert.ok(calls.includes('setPlanStepStatus') && calls.includes('ingestPlan'));
  });

  it('another conversation’s plan reads as missing and is never written', async () => {
    const { kg, calls } = fakeGraph();
    const bounded = boundKnowledgeGraph(kg, PLUGIN);
    assert.equal(await own(() => bounded.getPlan('plan:other')), null);
    assert.deepEqual(await own(() => bounded.getPlanSteps('plan:other')), []);
    const outOfScope = (err: unknown): boolean => err instanceof GraphServiceRefusedError && err.reason === 'out-of-scope';
    await assert.rejects(() => own(() => bounded.setPlanStepStatus('planstep:other-1', 'done')), outOfScope);
    await assert.rejects(() => own(() => bounded.deletePlan('plan:other')), outOfScope);
    await assert.rejects(() => own(() => bounded.ingestPlan({ planId: 'p', scope: 'boreas::web-1' } as never)), outOfScope);
    await assert.rejects(
      () => own(() => bounded.upsertPlanStep({ stepId: 's', planId: 'p', scope: 'atlas::web-2' } as never)),
      outOfScope,
    );
    for (const write of ['setPlanStepStatus', 'deletePlan', 'ingestPlan', 'upsertPlanStep', 'getPlanSteps']) {
      assert.ok(!calls.includes(write), write);
    }
  });
});

function processRecord(id: string, scope: string): ProcessRecord {
  return { id, scope, title: id, steps: ['a'], version: 1, visibility: 'team' } as unknown as ProcessRecord;
}

function fakeProcesses(): { service: ProcessMemoryService; edits: string[] } {
  const records = [processRecord('p-own', `${ATLAS}s`), processRecord('p-other', 'boreas::s')];
  const edits: string[] = [];
  const service: ProcessMemoryService = {
    write: async () => ({ ok: true, id: 'p-new', version: 1 }) as never,
    edit: async (input) => {
      edits.push(input.id);
      return { ok: true, id: input.id, version: 2 } as never;
    },
    query: async () => records.map((record) => ({ record, score: 0.9 })),
    get: async (id) => records.find((r) => r.id === id) ?? null,
    history: async (id) => records.filter((r) => r.id === id),
  };
  return { service, edits };
}

describe('ADR-0044 · bounded processMemory@1', () => {
  it('reads what the process tools read: this agent’s processes, none in a context-bound turn', async () => {
    const { service } = fakeProcesses();
    const bounded = boundProcessMemory(service, PLUGIN);
    const enforce = await inTurn(USER_BOUND, () => bounded.query({ query: 'x', limit: 5 }));
    assert.deepEqual(enforce.map((h) => h.record.id), ['p-own']);
    assert.equal(await inTurn(USER_BOUND, () => bounded.get('p-other')), null);
    assert.deepEqual(await inTurn(USER_BOUND, () => bounded.history('p-other')), []);
    assert.deepEqual(await inTurn(STRICT_BOUND, () => bounded.query({ query: 'x' })), []);
  });

  it('writes only into this agent’s scopes, and only inside a turn', async () => {
    const bounded = boundProcessMemory(fakeProcesses().service, PLUGIN);
    const input = (scope: string) => ({ title: 'X: y', steps: ['a'], scope }) as never;
    await inTurn(USER_BOUND, () => bounded.write(input('atlas::s')));
    await assert.rejects(
      () => inTurn(USER_BOUND, () => bounded.write(input('boreas::s'))),
      (err: unknown) => err instanceof GraphServiceRefusedError && err.reason === 'out-of-scope',
    );
    await assert.rejects(() => bounded.write(input('atlas::s')), GraphServiceRefusedError);
  });

  it('refuses reads outside a turn', async () => {
    const bounded = boundProcessMemory(fakeProcesses().service, PLUGIN);
    await assert.rejects(() => bounded.query({ query: 'x' }), GraphServiceRefusedError);
    await assert.rejects(() => bounded.get('p-own'), GraphServiceRefusedError);
  });

  it('answers an edit of a process the turn may not read like a missing one', async () => {
    const { service, edits } = fakeProcesses();
    const bounded = boundProcessMemory(service, PLUGIN);
    assert.deepEqual(await inTurn(USER_BOUND, () => bounded.edit({ id: 'p-other', title: 'x' })), {
      ok: false,
      reason: 'not-found',
    });
    await inTurn(USER_BOUND, () => bounded.edit({ id: 'p-own', title: 'x' }));
    assert.deepEqual(edits, ['p-own']);
  });
});

describe('ADR-0044 · bounded memoryStore@1', () => {
  async function seededStore(): Promise<InMemoryMemoryStore> {
    const store = new InMemoryMemoryStore();
    for (const [path, content] of [
      ['/memories/_brand/logo.md', 'logo'],
      ['/memories/_rules/r.md', 'rule'],
      ['/memories/core/notes.md', 'core'],
      ['/memories/orchestrators/atlas/secret-alice.md', 'private'],
      ['/memories/sessions/atlas/2026-11-25.md', 'transcript'],
      ['/memories/chat-sessions/chat-1.json', 'chat'],
      ['/memories/contexts/atlas/user/u-a/n.md', 'context'],
      ['/memories/loose-alice.md', 'legacy note'],
      ['/memories/pairings/dm/u-a.json', '{}'],
      ['/memories/agents/@omadia/channel-teams/refs-alice.json', 'plugin-wide'],
      ['/memories/ui-prefs/default/u-a/operator.json', 'prefs'],
    ] as const) {
      await store.createFile(path, content);
    }
    return store;
  }

  it('reads the shared trees and changes a declared top-level tree', async () => {
    const bounded = boundMemoryStore(await seededStore(), PLUGIN, ['notes']);
    assert.equal(await bounded.readFile('/memories/_brand/logo.md'), 'logo');
    assert.equal(await bounded.readFile('/memories/core/notes.md'), 'core');
    await bounded.writeFile('/memories/notes/a.md', 'a');
    assert.equal(await bounded.readFile('/memories/notes/a.md'), 'a');
  });

  it('ADR-0256: an undeclared tree is neither read nor changed', async () => {
    const bounded = boundMemoryStore(await seededStore(), PLUGIN);
    await assert.rejects(() => bounded.readFile('/memories/pairings/dm/u-a.json'), MemoryPathError);
    await assert.rejects(() => bounded.writeFile('/memories/pairings/dm/u-a.json', '{}'), MemoryPathError);
    await assert.rejects(() => bounded.writeFile('/memories/notes/a.md', 'a'), MemoryPathError);
    await assert.rejects(() => bounded.list('/memories/pairings'), MemoryPathError);
  });

  it('ADR-0256: channel-telegram keeps pairings without declaring it, and nobody else can claim it', async () => {
    const store = await seededStore();
    const telegram = boundMemoryStore(store, '@omadia/channel-telegram');
    await telegram.writeFile('/memories/pairings/dm/u-a.json', '{"a":1}');
    assert.equal(await telegram.readFile('/memories/pairings/dm/u-a.json'), '{"a":1}');
    const rival = boundMemoryStore(store, '@test/rival', ['pairings']);
    await assert.rejects(() => rival.writeFile('/memories/pairings/x', 'hijack'), MemoryPathError);
    await assert.rejects(() => rival.readFile('/memories/pairings/dm/u-a.json'), MemoryPathError);
  });

  it('ADR-0256: the first plugin to use a declared tree owns it; the record is kernel-private', async () => {
    const store = await seededStore();
    const first = boundMemoryStore(store, '@test/first', ['notes']);
    const second = boundMemoryStore(store, '@test/second', ['notes']);
    // Both race for the unclaimed tree: exactly one wins.
    const results = await Promise.allSettled([
      first.writeFile('/memories/notes/a.md', 'first'),
      second.writeFile('/memories/notes/b.md', 'second'),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const record = JSON.parse(await store.readFile('/memories/_plugin-trees/notes.json')) as { pluginId: string };
    const [winner, loser] = record.pluginId === '@test/first' ? [first, second] : [second, first];
    await winner.writeFile('/memories/notes/c.md', 'again');
    await assert.rejects(() => loser.readFile('/memories/notes/c.md'), MemoryPathError);
    // A fresh wrapper of the winner (a restart) still owns it.
    await boundMemoryStore(store, record.pluginId, ['notes']).readFile('/memories/notes/c.md');
    for (const bounded of [first, second]) {
      await assert.rejects(() => bounded.readFile('/memories/_plugin-trees/notes.json'), MemoryPathError);
      await assert.rejects(() => bounded.writeFile('/memories/_plugin-trees/notes.json', '{}'), MemoryPathError);
      await assert.rejects(() => bounded.list('/memories/_plugin-trees'), MemoryPathError);
    }
  });

  it('ADR-0256: core is read-only for plugins', async () => {
    const bounded = boundMemoryStore(await seededStore(), PLUGIN, ['core']);
    await assert.rejects(() => bounded.writeFile('/memories/core/notes.md', 'x'), MemoryPathError);
    await assert.rejects(() => bounded.createFile('/memories/core/new.md', 'x'), MemoryPathError);
    await assert.rejects(() => bounded.delete('/memories/core/notes.md'), MemoryPathError);
  });

  it('never reaches a private tree or a loose root file, and names no path in the refusal', async () => {
    const bounded = boundMemoryStore(await seededStore(), PLUGIN);
    for (const path of [
      '/memories/orchestrators/atlas/secret-alice.md',
      '/memories/sessions/atlas/2026-11-25.md',
      '/memories/chat-sessions/chat-1.json',
      '/memories/contexts/atlas/user/u-a/n.md',
      '/memories/agents/@omadia/channel-teams/refs-alice.json',
      '/memories/Agents/@omadia/channel-teams/refs-alice.json',
      '/memories/ui-prefs/default/u-a/operator.json',
      '/memories/loose-alice.md',
      '/memories/core/../orchestrators/atlas/secret-alice.md',
      '/memories//sessions/atlas/2026-11-25.md',
      '/memories/Orchestrators/atlas/secret-alice.md',
      '/etc/passwd',
    ]) {
      await assert.rejects(
        () => bounded.readFile(path),
        (err: unknown) => err instanceof MemoryPathError && !err.message.includes('alice') && !err.message.includes('2026'),
        path,
      );
    }
  });

  it('lists the root without private trees, other plugins’ trees or loose files', async () => {
    const bounded = boundMemoryStore(await seededStore(), PLUGIN);
    const listed = (await bounded.list('/memories')).map((e) => e.virtualPath);
    assert.ok(listed.some((p) => p.startsWith('/memories/core')), listed.join(','));
    for (const p of listed) {
      assert.doesNotMatch(p, /orchestrators|agents|ui-prefs|sessions|contexts|loose-alice|pairings|_plugin-trees/, p);
    }
  });

  it('keeps the _* trees and core/audit read-only and refuses changes to the root or core as a whole', async () => {
    const bounded = boundMemoryStore(await seededStore(), PLUGIN);
    for (const change of [
      () => bounded.writeFile('/memories/_rules/r.md', 'x'),
      () => bounded.writeFile('/memories/_brand/logo.md', 'x'),
      () => bounded.createFile('/memories/core/Audit/x.md', 'x'),
      () => bounded.createFile('/memories/core/audit/x.md', 'x'),
      () => bounded.delete('/memories/core'),
      () => bounded.delete('/memories'),
      () => bounded.rename('/memories/pairings', '/memories/orchestrators/atlas/p'),
      () => bounded.writeFile('/memories/core/notes.md', 'x'),
    ]) {
      await assert.rejects(change, MemoryPathError);
    }
  });
});

describe('bounded topicClustering@1: kernel-only', () => {
  it('refuses list, getWithMembers and recluster, in and outside a turn', async () => {
    const topics = boundTopicClustering(PLUGIN);
    const kernelOnly = (err: unknown): boolean => err instanceof GraphServiceRefusedError && err.reason === 'kernel-only';
    for (const run of [
      () => topics.list('any-user'),
      () => topics.getWithMembers('topic:1', 'any-user'),
      () => topics.recluster(),
    ]) {
      await assert.rejects(run, kernelOnly);
      await inTurn(USER_BOUND, () => assert.rejects(run, kernelOnly));
    }
  });
});
