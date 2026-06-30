import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { ConductorAwaitWorker, type ProactiveSenderLike } from '../src/conductor/awaitWorker.js';
import type { ConductorAwaitStore } from '../src/conductor/awaitStore.js';
import type { ConductorChannelBindingStore } from '../src/conductor/channelBindingStore.js';
import type { ConductorRunExecutor } from '../src/conductor/runExecutor.js';

// Conductor US5 reminders — the await worker nudges a waiting holder on their bound channel,
// or flags `unreachable` when no binding resolves. Tick logic exercised with fakes (no DB).

const NOW = () => new Date('2026-06-29T12:00:00.000Z');

function reminderAwait() {
  return {
    id: 'aw1', runId: 'run1', stepId: 'h1', principalKind: 'role', principalRef: 'approvers',
    channelType: 'teams', message: 'approve the release', quorum: 'any', reminderIntervalMs: 3_600_000,
    deadlineAt: null, fallbackTransitionId: null, status: 'waiting', createdAt: new Date(0),
  };
}

function makeWorker(opts: {
  bindings: Record<string, unknown>; // holderId -> conversationRef
  holders: string[];
  reminders?: unknown[];
  responded?: string[]; // responders already recorded (quorum='all' filtering)
  withSender?: boolean;
  claimWins?: boolean;
}) {
  const sent: Array<{ conversationRef: unknown; text: string }> = [];
  const claims: string[] = [];
  const unreachableCalls: Array<{ id: string; unreachable: boolean }> = [];
  const awaitStore = {
    async listDue() { return []; },
    async listRemindersDue() { return opts.reminders ?? [reminderAwait()]; },
    async claimReminderDue(id: string) { claims.push(id); return opts.claimWins ?? true; },
    async setReminderUnreachable(id: string, unreachable: boolean) { unreachableCalls.push({ id, unreachable }); },
    async listResponses() { return (opts.responded ?? []).map((responderId) => ({ responderId, response: { approved: true } })); },
  } as unknown as ConductorAwaitStore;
  const bindingStore = {
    async getMany(userIds: string[]) {
      const m = new Map<string, unknown>();
      for (const u of userIds) if (opts.bindings[u] !== undefined) m.set(u, opts.bindings[u]);
      return m;
    },
  } as unknown as ConductorChannelBindingStore;
  const sender: ProactiveSenderLike = {
    async send({ conversationRef, message }) { sent.push({ conversationRef, text: message.text }); },
  };
  const worker = new ConductorAwaitWorker({
    awaitStore,
    executor: {} as unknown as ConductorRunExecutor,
    bindingStore,
    resolveRoleHolders: async () => opts.holders,
    // Dep is always wired; `withSender:false` models "no sender registered for this channel" (returns undefined).
    getProactiveSender: () => (opts.withSender === false ? undefined : sender),
    now: NOW,
  });
  return { worker, sent, claims, unreachableCalls };
}

describe('ConductorAwaitWorker reminders', () => {
  it('sends a reminder to each holder that has a channel binding', async () => {
    const { worker, sent, unreachableCalls } = makeWorker({
      holders: ['alice', 'bob'],
      bindings: { alice: { conv: 'A' }, bob: { conv: 'B' } },
    });
    await worker.tick();
    assert.equal(sent.length, 2);
    assert.ok(sent[0]!.text.includes('approve the release'));
    assert.deepEqual(unreachableCalls, [{ id: 'aw1', unreachable: false }]);
  });

  it('flags unreachable when no holder has a binding (and still advances the clock)', async () => {
    const { worker, sent, unreachableCalls } = makeWorker({
      holders: ['alice', 'bob'],
      bindings: {}, // nobody bound a channel
    });
    await worker.tick();
    assert.equal(sent.length, 0);
    assert.deepEqual(unreachableCalls, [{ id: 'aw1', unreachable: true }]);
  });

  it('only reminds holders with a binding; partial binding is not unreachable', async () => {
    const { worker, sent, unreachableCalls } = makeWorker({
      holders: ['alice', 'bob'],
      bindings: { bob: { conv: 'B' } }, // only bob bound
    });
    await worker.tick();
    assert.equal(sent.length, 1);
    assert.deepEqual(unreachableCalls, [{ id: 'aw1', unreachable: false }]); // at least one delivered
  });

  it('flags unreachable when no sender is registered for the channel', async () => {
    const { worker, sent, unreachableCalls } = makeWorker({
      holders: ['alice'],
      bindings: { alice: { conv: 'A' } },
      withSender: false,
    });
    await worker.tick();
    assert.equal(sent.length, 0);
    assert.deepEqual(unreachableCalls, [{ id: 'aw1', unreachable: true }]); // no sender → cannot deliver
  });

  it('does not send when the per-interval claim is lost (another replica won)', async () => {
    const { worker, sent, claims, unreachableCalls } = makeWorker({
      holders: ['alice'],
      bindings: { alice: { conv: 'A' } },
      claimWins: false,
    });
    await worker.tick();
    assert.deepEqual(claims, ['aw1']); // claim attempted
    assert.equal(sent.length, 0); // lost → no send
    assert.deepEqual(unreachableCalls, []); // and no bookkeeping (the winner owns it)
  });

  it("quorum='all' does not re-nudge holders who already responded", async () => {
    const allAwait = { ...reminderAwait(), quorum: 'all' };
    const { worker, sent } = makeWorker({
      holders: ['alice', 'bob'],
      responded: ['alice'], // alice already approved
      bindings: { alice: { conv: 'A' }, bob: { conv: 'B' } },
      reminders: [allAwait],
    });
    await worker.tick();
    assert.equal(sent.length, 1); // only bob is nudged
    assert.deepEqual(sent[0]!.conversationRef, { conv: 'B' });
  });
});
