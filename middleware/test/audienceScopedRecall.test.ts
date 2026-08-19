/**
 * #575 — a restricted room narrows its recall instead of losing it.
 *
 * #732 gated recall all-or-nothing on `memory:recall`, and said the missing
 * per-item granularity was a measured limitation. Part of it turned out to be
 * available after all: recall hits carry a `scope`, even though they carry no
 * entitlement labels.
 *
 * So a room can now hold `memory:recall` without
 * `memory:recall:cross_scope` — it recalls its OWN history and drops hits from
 * other conversations. That matters because recall is ACL-gated by the
 * RECALLING user: in a shared room, a hit from that person's other chats lands
 * in the single prompt everyone's answer is derived from.
 *
 * The two halves are tested apart because each fails differently:
 *
 *  - the **guard** decides whether to restrict (and must not restrict when
 *    nobody installed a floor);
 *  - the **retriever** applies it, and has to drop the cross-session legs too —
 *    they bypass the candidate pool entirely, so filtering candidates alone
 *    would look thorough and let plans, processes and curated insights through.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import {
  CROSS_SCOPE_RECALL_CAPABILITY,
  MEMORY_RECALL_CAPABILITY,
  crossScopeRecallRefused,
  guardContextRecall,
} from '../packages/harness-orchestrator/src/audienceFloorGuard.js';
import { turnContext } from '../packages/harness-orchestrator/src/turnContext.js';
import type { AudienceFloor } from '../packages/harness-channel-sdk/src/audienceFloor.js';

const openFloor = (...caps: string[]): AudienceFloor => ({
  outcome: 'open',
  capabilities: new Set(caps),
  denied: new Set<string>(),
});

async function withFloor<T>(
  floor: AudienceFloor | 'none' | 'throws',
  fn: () => Promise<T>,
): Promise<T> {
  const base = { turnId: 't', turnDate: '2026-08-19' };
  if (floor === 'none') return turnContext.run(base, fn);
  return turnContext.run(
    {
      ...base,
      audienceFloor:
        floor === 'throws'
          ? async () => {
              throw new Error('directory down');
            }
          : async () => floor,
    },
    fn,
  );
}

describe('#575 cross-scope recall is a separate capability', () => {
  it('a room with both capabilities recalls freely', async () => {
    const floor = openFloor(MEMORY_RECALL_CAPABILITY, CROSS_SCOPE_RECALL_CAPABILITY);
    assert.equal(await withFloor(floor, guardContextRecall), undefined);
    assert.equal(await withFloor(floor, crossScopeRecallRefused), false);
  });

  it('a room with only memory:recall still recalls — but only its own history', async () => {
    // The point of the split: previously this room got NOTHING, because the
    // single capability answered both questions at once.
    const floor = openFloor(MEMORY_RECALL_CAPABILITY);
    assert.equal(
      await withFloor(floor, guardContextRecall),
      undefined,
      'recall itself must still be permitted',
    );
    assert.equal(await withFloor(floor, crossScopeRecallRefused), true);
  });

  it('a room with neither is refused recall outright', async () => {
    const floor = openFloor();
    assert.notEqual(await withFloor(floor, guardContextRecall), undefined);
  });

  it('no provider installed ⇒ unrestricted', async () => {
    // "Not enforced ≠ closed". Every deployment that has not opted in.
    assert.equal(await withFloor('none', crossScopeRecallRefused), false);
    assert.equal(await withFloor('none', guardContextRecall), undefined);
  });

  it('an unresolvable audience restricts rather than opening', async () => {
    assert.equal(await withFloor('throws', crossScopeRecallRefused), true);
  });

  it('a closed floor is refused by the recall guard, so restriction is moot', async () => {
    const closed: AudienceFloor = { outcome: 'closed', reason: 'audience unknown' };
    assert.notEqual(await withFloor(closed, guardContextRecall), undefined);
    // Still reports "restrict" rather than "free": a closed floor permits
    // nothing, and answering `false` here would read as "cross-scope is fine".
    assert.equal(await withFloor(closed, crossScopeRecallRefused), true);
  });

  it('the two capabilities are distinct tokens', () => {
    assert.notEqual(MEMORY_RECALL_CAPABILITY, CROSS_SCOPE_RECALL_CAPABILITY);
    assert.equal(CROSS_SCOPE_RECALL_CAPABILITY, 'memory:recall:cross_scope');
  });
});

describe('#575 the orchestrator threads the decision into the retriever', () => {
  it('passes restrictToScope to assembleForBudget', async () => {
    // The decision and its application live in different packages, and
    // `restrictToScope` is optional — so dropping the argument compiles, keeps
    // every guard test green, and silently restores cross-session recall for
    // every restricted room. Nothing observable would change until somebody
    // read a prompt.
    //
    // Asserted against the call site because the alternative is standing up a
    // full Orchestrator with a graph, a provider and an LLM — a test that
    // expensive is one that stops being run.
    const source = await readFile(
      new URL('../packages/harness-orchestrator/src/orchestrator.ts', import.meta.url),
      'utf8',
    );
    const call = source.indexOf('assembleForBudget({');
    assert.notEqual(call, -1, 'the retriever call site must still exist');
    const end = source.indexOf('});', call);
    const args = source.slice(call, end);
    assert.ok(args.includes('restrictToScope'), 'the restriction must reach the retriever');
    assert.ok(
      source.includes('crossScopeRecallRefused'),
      'and it must be derived from the floor, not from something else',
    );
  });
});
