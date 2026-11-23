/**
 * Spec 2042 §5.4 / §6 criteria 4, 13, 16, 38 — the consultation broker.
 *
 * The colleague's "orchestrator" is a scripted `chat()` that does what the
 * real one does under a consultation scope: it reads the scope, reports the
 * labels of what it read into `scope.result`, and answers. The real
 * orchestrator's narrowing is pinned in `consultationEnvelope.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChatTurnInput, SemanticAnswer } from '@omadia/channel-sdk';

import {
  consultationAllowsTool,
  currentConsultation,
  readersOf,
  turnContext,
  unionLabels,
  type ConsultRequest,
  type DiscretionLabel,
  type LabelSet,
  type Readers,
} from '@omadia/orchestrator';
import {
  consultationEnvelope,
  createConsultationBroker,
  type ConsultRegistryEntry,
  type ConsultationBrokerStore,
} from '../../src/consultation/consultationBroker.js';
import type { ConsultationGrant } from '../../src/consultation/consultationStore.js';

const SALES_CHAT = 'teams:19:sales@thread.v2';
const salesReaders = readersOf(['u-sales-1', 'u-sales-2']);
const salesLabel: DiscretionLabel = { kind: 'context', key: SALES_CHAT, readers: salesReaders };
const hrMemory: DiscretionLabel = { kind: 'context', key: 'teams:19:hr@thread.v2', readers: readersOf(['u-hr']) };

interface Seen {
  allowed: string[];
  memoryAccess: string;
  input: ChatTurnInput;
  initialLabels: LabelSet | undefined;
  readers: Readers | undefined;
}

/** A colleague whose run reports `labels` (per attempt) and answers `text`. */
function colleague(opts: {
  id: string;
  slug: string;
  name?: string;
  plugins?: string[];
  archetype?: string;
  labels?: (attempt: number, memoryAccess: string) => DiscretionLabel[];
  answer?: (attempt: number) => string;
  fail?: boolean;
  seen?: Seen[];
  /** Whether B's turn ran with a privacy shield (default true). */
  shielded?: boolean;
}): ConsultRegistryEntry {
  let attempt = 0;
  return {
    agent: {
      id: opts.id,
      slug: opts.slug,
      name: opts.name ?? opts.slug,
      ...(opts.archetype ? { archetype: opts.archetype } : {}),
      identityLanguage: 'en',
    },
    plugins: (opts.plugins ?? []).map((pluginId) => ({ pluginId, enabled: true })),
    built: {
      bundle: {
        agent: {
          async chat(input: ChatTurnInput): Promise<SemanticAnswer> {
            attempt += 1;
            const scope = currentConsultation();
            assert.ok(scope, 'the colleague runs inside a consultation scope');
            opts.seen?.push({
              allowed: [...scope.allowedPluginIds].sort(),
              memoryAccess: scope.memoryAccess,
              input,
              initialLabels: scope.initialLabels,
              readers: scope.readers,
            });
            if (opts.fail) throw new Error('model down');
            scope.result.labels = unionLabels([salesLabel], opts.labels?.(attempt, scope.memoryAccess) ?? []);
            scope.result.wireAnswer = 'masked «PERSON_1» view';
            scope.result.shielded = opts.shielded ?? true;
            return { text: opts.answer?.(attempt) ?? `answer ${String(attempt)}` } as SemanticAnswer;
          },
        },
      },
    },
  };
}

function grant(over: Partial<ConsultationGrant> = {}): ConsultationGrant {
  return {
    fromAgentId: 'a',
    toAgentId: 'b',
    channelScope: null,
    allowedCapabilities: [],
    memoryAccess: 'none',
    disclosure: {},
    maxCallsPerTurn: 2,
    maxCallsPerDay: 50,
    createdBy: 'op',
    createdAt: new Date(),
    updatedBy: null,
    updatedAt: new Date(),
    ...over,
  };
}

function fakeStore(state: {
  switches?: Record<string, { consultable: boolean; mayConsult: boolean }>;
  grant?: ConsultationGrant | undefined;
  today?: number;
}) {
  const calls: Array<{ id: string; status?: string; outcome?: string }> = [];
  const store: ConsultationBrokerStore = {
    getSwitches: async (id) => state.switches?.[id] ?? { consultable: true, mayConsult: true },
    getGrant: async () => state.grant,
    startCall: async (c) => {
      if ((state.today ?? 0) >= c.maxCallsPerDay) return false;
      calls.push({ id: c.id });
      return true;
    },
    finishCall: async (id, r) => {
      const call = calls.find((c) => c.id === id);
      if (call) Object.assign(call, { status: r.status, outcome: r.outcome });
    },
    listActivePairs: async () => [{ fromSlug: 'anna', toSlug: 'ben' }],
  };
  return { store, calls };
}

const A = (plugins: string[] = []) => colleague({ id: 'a', slug: 'anna', plugins });

function request(over: Partial<ConsultRequest> = {}): ConsultRequest {
  return {
    fromAgentSlug: 'anna',
    fromTurnId: 'turn-1',
    toAgentSlug: 'ben',
    request: 'What do you think?',
    callsThisTurn: 0,
    sequence: 1,
    origin: { channelType: 'teams', scope: { kind: 'conversation', conversationId: '19:sales@thread.v2' } },
    labels: unionLabels([salesLabel]),
    contextKey: SALES_CHAT,
    readers: salesReaders,
    ...over,
  };
}

/** Run inside a turn that has (or lacks) an active audience floor. */
function inTurn<T>(fn: () => Promise<T>, floor = true): Promise<T> {
  return turnContext.run(
    {
      turnId: 'turn-1',
      turnDate: '2026-11-20',
      ...(floor ? { audienceFloor: async () => ({ capabilities: new Set<string>() }) as never } : {}),
    },
    fn,
  );
}

describe('consultation broker', () => {
  it('criterion 4: no grant, revoked grant, no audience floor and exhausted budgets are refused', async () => {
    const state: { grant: ConsultationGrant | undefined; today?: number } = { grant: undefined };
    const { store } = fakeStore(state);
    const registry = new Map([
      ['anna', A()],
      ['ben', colleague({ id: 'b', slug: 'ben' })],
    ]);
    const broker = createConsultationBroker({ store, getRegistry: () => registry });

    const noGrant = await inTurn(() => broker.consult(request()));
    assert.equal(noGrant.kind === 'refused' && noGrant.reason, 'no_grant');

    state.grant = grant();
    const ok = await inTurn(() => broker.consult(request()));
    assert.equal(ok.kind, 'answered');

    // Revoked → refused on the very next call (fresh read, no cache).
    state.grant = undefined;
    const revoked = await inTurn(() => broker.consult(request()));
    assert.equal(revoked.kind === 'refused' && revoked.reason, 'no_grant');

    state.grant = grant();
    const noFloor = await inTurn(() => broker.consult(request()), false);
    assert.equal(noFloor.kind === 'refused' && noFloor.reason, 'no_audience_floor');

    const turnBudget = await inTurn(() => broker.consult(request({ callsThisTurn: 2 })));
    assert.equal(turnBudget.kind === 'refused' && turnBudget.reason, 'turn_budget');

    state.today = 50;
    const dayBudget = await inTurn(() => broker.consult(request()));
    assert.equal(dayBudget.kind === 'refused' && dayBudget.reason, 'day_budget');
  });

  it('criterion 13: switches off are refused, facilitators are out, channel scope holds', async () => {
    const switches = {
      a: { consultable: false, mayConsult: false },
      b: { consultable: true, mayConsult: false },
    };
    const { store } = fakeStore({ switches, grant: grant() });
    const registry = new Map([
      ['anna', A()],
      ['ben', colleague({ id: 'b', slug: 'ben' })],
      ['fac', colleague({ id: 'f', slug: 'fac', archetype: 'facilitator' })],
    ]);
    const broker = createConsultationBroker({ store, getRegistry: () => registry });
    const r1 = await inTurn(() => broker.consult(request()));
    assert.equal(r1.kind === 'refused' && r1.reason, 'may_not_consult');
    switches.a.mayConsult = true;
    switches.b.consultable = false;
    const r2 = await inTurn(() => broker.consult(request()));
    assert.equal(r2.kind === 'refused' && r2.reason, 'not_consultable');
    switches.b.consultable = true;
    const r3 = await inTurn(() => broker.consult(request({ toAgentSlug: 'fac' })));
    assert.equal(r3.kind === 'refused' && r3.reason, 'archetype');

    const scoped = createConsultationBroker({
      store: fakeStore({ grant: grant({ channelScope: ['slack'] }) }).store,
      getRegistry: () => registry,
    });
    const r4 = await inTurn(() => scoped.consult(request()));
    assert.equal(r4.kind === 'refused' && r4.reason, 'channel_not_granted');
  });

  it('criterion 13: the colleague runs with grant ∩ its grants ∩ the asker\'s grants, no session, no memory', async () => {
    const seen: Seen[] = [];
    const registry = new Map([
      ['anna', A(['@omadia/crm', '@omadia/web-search'])],
      ['ben', colleague({ id: 'b', slug: 'ben', plugins: ['@omadia/crm', '@omadia/odoo-hr', '@omadia/web-search'], seen })],
    ]);
    const g = grant({ allowedCapabilities: ['@omadia/odoo-hr', '@omadia/crm'] });
    assert.deepEqual([...consultationEnvelope(g, registry.get('anna')!, registry.get('ben')!)], ['@omadia/crm']);
    const broker = createConsultationBroker({ store: fakeStore({ grant: g }).store, getRegistry: () => registry });
    const out = await inTurn(() => broker.consult(request({ userId: 'u-sales-1' })));
    assert.equal(out.kind, 'answered');
    assert.deepEqual(seen[0]!.allowed, ['@omadia/crm']);
    assert.equal(seen[0]!.memoryAccess, 'none');
    // No session scope: nothing of B's run is logged, ingested or promoted;
    // no user id without `discreet` memory (recall needs it).
    assert.equal(seen[0]!.input.sessionScope, undefined);
    assert.equal(seen[0]!.input.userId, undefined);
    assert.equal(seen[0]!.input.origin?.channelType, 'teams');
  });

  it('criterion 13: inside the run the HR system and memory are refused to the colleague', async () => {
    const { runAsConsultation } = await import('@omadia/orchestrator');
    const scope = {
      agentSlug: 'ben',
      fromAgentSlug: 'anna',
      fromTurnId: 't',
      callId: 'c',
      allowedPluginIds: new Set(['@omadia/crm']),
      memoryAccess: 'none' as const,
      readers: salesReaders,
      result: {},
    };
    runAsConsultation(scope, () => {
      assert.equal(consultationAllowsTool('ben', 'odoo_hr_read', '@omadia/odoo-hr'), false);
      assert.equal(consultationAllowsTool('ben', 'crm_search', '@omadia/crm'), true);
      assert.equal(consultationAllowsTool('ben', 'memory', undefined), false);
      assert.equal(consultationAllowsTool('ben', 'query_knowledge_graph', undefined), false);
      assert.equal(consultationAllowsTool('ben', 'consult', undefined), false);
      assert.equal(consultationAllowsTool('ben', 'book_meeting', undefined), false);
      assert.equal(consultationAllowsTool('ben', 'v4_filter', undefined), true);
      // Another agent's tools (A's own loop) are not narrowed by B's scope.
      assert.equal(consultationAllowsTool('anna', 'odoo_hr_read', '@omadia/odoo-hr'), true);
    });
    runAsConsultation({ ...scope, memoryAccess: 'discreet' }, () => {
      assert.equal(consultationAllowsTool('ben', 'query_knowledge_graph', undefined), true);
      assert.equal(consultationAllowsTool('ben', 'memory', undefined), false);
    });
  });

  it('criterion 4: two consultations get distinct ids; a failed run is shown as failed', async () => {
    const { store, calls } = fakeStore({ grant: grant() });
    const registry = new Map([
      ['anna', A()],
      ['ben', colleague({ id: 'b', slug: 'ben', name: 'Ben' })],
      ['bad', colleague({ id: 'x', slug: 'bad', name: 'Bad', fail: true })],
    ]);
    const broker = createConsultationBroker({ store, getRegistry: () => registry });
    const first = await inTurn(() => broker.consult(request()));
    const second = await inTurn(() => broker.consult(request({ callsThisTurn: 1, sequence: 2 })));
    assert.ok(first.kind === 'answered' && second.kind === 'answered');
    assert.notEqual(first.contribution.id, second.contribution.id);
    assert.equal(first.contribution.speaker.slug, 'ben');
    assert.equal(first.contribution.speaker.displayName, 'Ben');

    const failed = await inTurn(() => broker.consult(request({ toAgentSlug: 'bad' })));
    assert.ok(failed.kind === 'answered');
    assert.equal(failed.contribution.status, 'failed');
    assert.equal(failed.contribution.text, 'Bad could not answer right now.');
    assert.equal(calls.at(-1)?.status, 'failed');
  });

  it('criterion 4: a colleague that does not answer in time is shown as failed', async () => {
    const slow: ConsultRegistryEntry = {
      ...colleague({ id: 'b', slug: 'ben', name: 'Ben' }),
      built: { bundle: { agent: { chat: () => new Promise<SemanticAnswer>(() => undefined) } } },
    };
    const broker = createConsultationBroker({
      store: fakeStore({ grant: grant() }).store,
      getRegistry: () => new Map([['anna', A()], ['ben', slow]]),
      timeoutMs: 20,
    });
    // The broker's timer is unref'd (it must not keep a process alive) and the
    // colleague's promise never settles, so nothing else holds the event loop
    // open until the timeout fires: hold it here.
    const keepAlive = setInterval(() => undefined, 1_000);
    try {
      const out = await inTurn(() => broker.consult(request()));
      assert.ok(out.kind === 'answered');
      assert.equal(out.contribution.status, 'failed');
    } finally {
      clearInterval(keepAlive);
    }
  });

  it('criterion 16: HR knowledge never reaches the sales chat; with `existence` only that Ben can help', async () => {
    // B (discreet memory) recalled an entry owned by HR only.
    const hrRecall = (_attempt: number, memoryAccess: string) => (memoryAccess === 'discreet' ? [hrMemory] : []);
    const leak = 'P is leaving the company';
    const answer = (attempt: number) => (attempt === 1 ? leak : 'I have nothing on that.');
    const registry = () =>
      new Map([
        ['anna', A()],
        ['ben', colleague({ id: 'b', slug: 'ben', name: 'Ben', labels: hrRecall, answer })],
      ]);
    // Default disclosure: `none` → regenerated without memory; nothing of it.
    const none = createConsultationBroker({
      store: fakeStore({ grant: grant({ memoryAccess: 'discreet' }) }).store,
      getRegistry: registry,
    });
    const quiet = await inTurn(() => none.consult(request()));
    assert.ok(quiet.kind === 'answered');
    assert.equal(quiet.contribution.status, 'delivered');
    assert.equal(quiet.contribution.text, 'I have nothing on that.');
    assert.ok(!quiet.contribution.text.includes('leaving'));
    // Nothing of the HR context joins A's turn.
    assert.ok(!quiet.labels.labels.some((l) => l.kind === 'context' && l.key === hrMemory.key));

    const existence = createConsultationBroker({
      store: fakeStore({ grant: grant({ memoryAccess: 'discreet', disclosure: { context: 'existence' } }) }).store,
      getRegistry: registry,
    });
    const hint = await inTurn(() => existence.consult(request()));
    assert.ok(hint.kind === 'answered');
    assert.equal(hint.contribution.text, 'Ben can help with this, but not here. Best ask Ben directly.');
    assert.ok(!hint.labels.labels.some((l) => l.kind === 'context' && l.key === hrMemory.key));
  });

  it('criterion 38: withheld at `none` and non-existent look the same', async () => {
    const neutral = 'I have nothing on that.';
    const withheld = createConsultationBroker({
      store: fakeStore({ grant: grant({ memoryAccess: 'discreet' }) }).store,
      getRegistry: () =>
        new Map([
          ['anna', A()],
          [
            'ben',
            colleague({
              id: 'b',
              slug: 'ben',
              labels: (_a, m) => (m === 'discreet' ? [hrMemory] : []),
              answer: (a) => (a === 1 ? 'secret' : neutral),
            }),
          ],
        ]),
    });
    const absent = createConsultationBroker({
      store: fakeStore({ grant: grant({ memoryAccess: 'discreet' }) }).store,
      getRegistry: () =>
        new Map([
          ['anna', A()],
          ['ben', colleague({ id: 'b', slug: 'ben', answer: () => neutral })],
        ]),
    });
    const a = await inTurn(() => withheld.consult(request()));
    const b = await inTurn(() => absent.consult(request()));
    assert.ok(a.kind === 'answered' && b.kind === 'answered');
    assert.deepEqual(
      { text: a.contribution.text, status: a.contribution.status },
      { text: b.contribution.text, status: b.contribution.status },
    );
  });

  it('a contribution A could read itself is delivered in full, the `redacted` level delivers the masked view', async () => {
    const crm: DiscretionLabel = { kind: 'source', system: '@omadia/crm', restricted: false };
    const registry = new Map([
      ['anna', A(['@omadia/crm'])],
      ['ben', colleague({ id: 'b', slug: 'ben', plugins: ['@omadia/crm'], labels: () => [crm], answer: () => 'Real Name' })],
    ]);
    const full = createConsultationBroker({
      store: fakeStore({ grant: grant({ allowedCapabilities: ['@omadia/crm'] }) }).store,
      getRegistry: () => registry,
    });
    const out = await inTurn(() => full.consult(request()));
    assert.ok(out.kind === 'answered');
    assert.equal(out.contribution.text, 'Real Name');
    const labels: LabelSet = out.labels;
    assert.ok(labels.labels.some((l) => l.kind === 'source' && l.system === '@omadia/crm'));

    const memoryKnowledge: DiscretionLabel = { kind: 'context', key: 'members:abc', readers: salesReaders };
    const redacted = createConsultationBroker({
      store: fakeStore({ grant: grant({ memoryAccess: 'discreet', disclosure: { context: 'redacted' } }) }).store,
      getRegistry: () =>
        new Map([
          ['anna', A()],
          ['ben', colleague({ id: 'b', slug: 'ben', labels: () => [memoryKnowledge], answer: () => 'Real Name' })],
        ]),
    });
    const masked = await inTurn(() => redacted.consult(request()));
    assert.ok(masked.kind === 'answered');
    assert.equal(masked.contribution.text, 'masked «PERSON_1» view');
  });

  it('criterion 17: A\'s labels go with the request; B may receive them only when its grants cover them', async () => {
    const hrSource: DiscretionLabel = { kind: 'source', system: '@omadia/odoo-hr', restricted: true };
    const askerLabels = unionLabels([salesLabel, hrSource]);
    const seen: Seen[] = [];
    const audits: string[][] = [];
    const without = createConsultationBroker({
      store: fakeStore({ grant: grant() }).store,
      getRegistry: () =>
        new Map([
          ['anna', A(['@omadia/odoo-hr'])],
          ['ben', colleague({ id: 'b', slug: 'ben', plugins: ['@omadia/crm'], seen })],
        ]),
      audit: (e) => audits.push([...e.violations]),
    });
    const refused = await inTurn(() => without.consult(request({ labels: askerLabels })));
    assert.equal(refused.kind === 'refused' && refused.reason, 'discretion');
    assert.equal(seen.length, 0, 'B never ran');
    assert.deepEqual(audits[0], ['source:@omadia/odoo-hr:agent_lacks_grant']);

    const withGrant = createConsultationBroker({
      store: fakeStore({ grant: grant() }).store,
      getRegistry: () =>
        new Map([
          ['anna', A(['@omadia/odoo-hr'])],
          ['ben', colleague({ id: 'b', slug: 'ben', plugins: ['@omadia/odoo-hr'], seen })],
        ]),
    });
    const out = await inTurn(() => withGrant.consult(request({ labels: askerLabels })));
    assert.equal(out.kind, 'answered');
    // B's turn starts with what A had read: its own egress checks see it.
    assert.ok(seen[0]!.initialLabels?.labels.some((l) => l.kind === 'source' && l.system === '@omadia/odoo-hr'));
    // B answers into A's room: its conversation label carries A's readers,
    // never an `unknown` of its own that would stick to A's conversation.
    assert.deepEqual(seen[0]!.readers, salesReaders);
  });

  it('depth 1: no consultation starts inside a consultation run', async () => {
    const { runAsConsultation } = await import('@omadia/orchestrator');
    const broker = createConsultationBroker({
      store: fakeStore({ grant: grant() }).store,
      getRegistry: () => new Map([['anna', A()], ['ben', colleague({ id: 'b', slug: 'ben' })]]),
    });
    const scope = {
      agentSlug: 'carl',
      fromAgentSlug: 'dora',
      fromTurnId: 't',
      callId: 'c',
      allowedPluginIds: new Set<string>(),
      memoryAccess: 'none' as const,
      readers: salesReaders,
      result: {},
    };
    const out = await inTurn(() => runAsConsultation(scope, () => broker.consult(request())));
    assert.equal(out.kind === 'refused' && out.reason, 'depth');
  });

  it('a colleague past its deadline gets no tool any more', async () => {
    let captured: ReturnType<typeof currentConsultation>;
    const slow: ConsultRegistryEntry = {
      ...colleague({ id: 'b', slug: 'ben' }),
      built: {
        bundle: {
          agent: {
            chat: () => {
              captured = currentConsultation();
              return new Promise<SemanticAnswer>(() => undefined);
            },
          },
        },
      },
    };
    const broker = createConsultationBroker({
      store: fakeStore({ grant: grant({ allowedCapabilities: ['@omadia/crm'] }) }).store,
      getRegistry: () => new Map([['anna', A(['@omadia/crm'])], ['ben', { ...slow, plugins: [{ pluginId: '@omadia/crm', enabled: true }] }]]),
      timeoutMs: 20,
    });
    const keepAlive = setInterval(() => undefined, 1_000);
    try {
      await inTurn(() => broker.consult(request()));
    } finally {
      clearInterval(keepAlive);
    }
    const { runAsConsultation } = await import('@omadia/orchestrator');
    assert.ok(captured);
    assert.equal(captured.result.expired, true);
    runAsConsultation(captured, () => {
      assert.equal(consultationAllowsTool('ben', 'crm_search', '@omadia/crm'), false);
    });
  });

  it('`none` regenerates without memory and without tools, so no write runs twice', async () => {
    const seen: Seen[] = [];
    const broker = createConsultationBroker({
      store: fakeStore({ grant: grant({ memoryAccess: 'discreet', allowedCapabilities: ['@omadia/crm'] }) }).store,
      getRegistry: () =>
        new Map([
          ['anna', A(['@omadia/crm'])],
          [
            'ben',
            colleague({
              id: 'b',
              slug: 'ben',
              plugins: ['@omadia/crm'],
              labels: (_a, m) => (m === 'discreet' ? [hrMemory] : []),
              seen,
            }),
          ],
        ]),
    });
    await inTurn(() => broker.consult(request()));
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0]!.allowed, ['@omadia/crm']);
    assert.deepEqual(seen[1]!.allowed, []);
    assert.equal(seen[1]!.memoryAccess, 'none');
  });

  it('`redacted` without a shielded run is only existence, never the full text', async () => {
    const memoryKnowledge: DiscretionLabel = { kind: 'context', key: 'members:abc', readers: salesReaders };
    const broker = createConsultationBroker({
      store: fakeStore({ grant: grant({ memoryAccess: 'discreet', disclosure: { context: 'redacted' } }) }).store,
      getRegistry: () =>
        new Map([
          ['anna', A()],
          [
            'ben',
            colleague({
              id: 'b',
              slug: 'ben',
              name: 'Ben',
              labels: () => [memoryKnowledge],
              answer: () => 'Real Name',
              shielded: false,
            }),
          ],
        ]),
    });
    const out = await inTurn(() => broker.consult(request()));
    assert.ok(out.kind === 'answered');
    assert.equal(out.contribution.text, 'Ben can help with this, but not here. Best ask Ben directly.');
  });

  it('criterion 4: the day budget is taken atomically with the ledger entry', async () => {
    const broker = createConsultationBroker({
      store: fakeStore({ grant: grant({ maxCallsPerDay: 3 }), today: 3 }).store,
      getRegistry: () => new Map([['anna', A()], ['ben', colleague({ id: 'b', slug: 'ben' })]]),
    });
    const out = await inTurn(() => broker.consult(request()));
    assert.equal(out.kind === 'refused' && out.reason, 'day_budget');
  });

  it('offers only colleagues of active pairs, from a background-refreshed snapshot', async () => {
    const registry = new Map([
      ['anna', A()],
      ['ben', colleague({ id: 'b', slug: 'ben', name: 'Ben' })],
    ]);
    const broker = createConsultationBroker({ store: fakeStore({ grant: grant() }).store, getRegistry: () => registry });
    assert.deepEqual(broker.targetsFor('anna'), []);
    await broker.refresh();
    assert.deepEqual(broker.targetsFor('anna'), [{ slug: 'ben', displayName: 'Ben' }]);
    assert.deepEqual(broker.targetsFor('ben'), []);
  });
});
