/**
 * #2290 / ADR-0261 — what migration 0120 changes for one agent used by two
 * web accounts and two API keys. On `members` each account and each key gets
 * its own tier: a note one of them saves is not readable by the others. On
 * `off` (now only for explicitly shared agents) all four share one tree.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryMemoryStore } from '@omadia/memory';
import { MemoryBinder, webAccountOrigin } from '@omadia/orchestrator';
import type { ContextMemoryMode } from '@omadia/orchestrator';
import { apiKeyOrigin } from '../packages/harness-channel-api/src/channelKey.js';

const AGENT = 'shared-desk';
const NOTE = '/memories/pref.md';

/** Each caller with the one-person audience its turns resolve to (ADR-0182). */
const CALLERS = [
  { name: 'account A', origin: webAccountOrigin('acct-a'), member: 'acct-a' },
  { name: 'account B', origin: webAccountOrigin('acct-b'), member: 'acct-b' },
  { name: 'key 1', origin: apiKeyOrigin('k1'), member: 'key-owner-k1' },
  { name: 'key 2', origin: apiKeyOrigin('k2'), member: 'key-owner-k2' },
] as const;

async function storeFor(binder: MemoryBinder, mode: ContextMemoryMode, i: number) {
  const caller = CALLERS[i];
  assert.ok(caller);
  const bound =
    mode === 'members'
      ? await binder.forAudience(caller.origin, { kind: 'known', members: [caller.member] })
      : binder.forOrigin(caller.origin);
  return bound.store;
}

async function canRead(binder: MemoryBinder, mode: ContextMemoryMode, i: number): Promise<boolean> {
  const store = await storeFor(binder, mode, i);
  return store.readFile(NOTE).then(
    (text) => text.includes('only for'),
    () => false,
  );
}

describe('#2290 — one agent, two accounts and two API keys', () => {
  for (let writer = 0; writer < CALLERS.length; writer += 1) {
    it(`members: a note ${CALLERS[writer]?.name ?? ''} saves stays with them`, async () => {
      const binder = new MemoryBinder({ agentSlug: AGENT, root: new InMemoryMemoryStore(), mode: 'members' });
      await (await storeFor(binder, 'members', writer)).createFile(NOTE, `only for ${String(writer)}`);
      for (let reader = 0; reader < CALLERS.length; reader += 1) {
        assert.equal(
          await canRead(binder, 'members', reader),
          reader === writer,
          `${CALLERS[reader]?.name ?? ''} reading ${CALLERS[writer]?.name ?? ''}'s note`,
        );
      }
    });
  }

  it('off: every account and key reads the same note (shared agent)', async () => {
    const binder = new MemoryBinder({ agentSlug: AGENT, root: new InMemoryMemoryStore(), mode: 'off' });
    await (await storeFor(binder, 'off', 0)).createFile(NOTE, 'only for 0');
    for (let reader = 0; reader < CALLERS.length; reader += 1) {
      assert.equal(await canRead(binder, 'off', reader), true);
    }
  });
});
