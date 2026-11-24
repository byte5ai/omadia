/**
 * Self-checks of the memory-access world, oracle and seed (step 1). They do
 * not test access control yet; they make sure the later suites stand on solid
 * ground:
 *
 *  - every canary is unique and none is a substring of another, so finding a
 *    canary in a response names exactly one item;
 *  - the oracle answers every viewer × mode × item, with a source, and every
 *    store has both an allowed and a forbidden pair (an oracle that says
 *    \"no\" to everything would make every leak test pass);
 *  - a few verdicts are pinned by hand, so a careless oracle edit shows up;
 *  - seeded into the in-memory backend, every canary reads back from its
 *    store (the positive control: an empty store cannot pass a sweep).
 */
import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';

import { EXPECTED_DIVERGENCES, MODES, PINNED, expected } from './oracle.js';
import { seedInMemory } from './backends.js';
import { readBack, type Seeded } from './seed.js';
import { allViewers, buildWorld, viewerId, type MkItem, type Store, type Viewer } from './world.js';

const world = buildWorld();
const viewers = allViewers();

function viewer(partial: Partial<Viewer>): Viewer {
  return {
    tenant: 'main',
    user: 'alice',
    agent: 'atlas',
    context: 'web',
    shielded: false,
    ...partial,
  };
}

function mk(match: Partial<MkItem>): MkItem {
  const hit = world.byStore['memorable-knowledge'].find((m) =>
    Object.entries(match).every(
      ([k, v]) => JSON.stringify(m[k as keyof MkItem]) === JSON.stringify(v),
    ),
  );
  assert.ok(hit, `no MK matches ${JSON.stringify(match)}`);
  return hit;
}

describe('memory-access world', () => {
  it('every canary is unique and none contains another', () => {
    const canaries = world.items.map((i) => i.canary);
    assert.equal(new Set(canaries).size, canaries.length, 'duplicate canary');
    // Fixed-width number closed by `Z`: a substring hit would need a shared tail.
    for (const c of canaries) assert.match(c, /^CANARY-[A-Z]+-\d{5}Z$/);
  });

  it('covers every store and both tenants', () => {
    const stores: Store[] = [
      'memorable-knowledge',
      'excerpt',
      'turn',
      'entity',
      'plan',
      'scratch',
      'dataset',
      'process',
      'topic',
    ];
    for (const s of stores) {
      const items = world.byStore[s];
      assert.ok(items.length > 0, `store ${s} is empty`);
      assert.deepEqual(
        [...new Set(items.map((i) => i.tenant))].sort(),
        ['main', 'other'],
        `store ${s}`,
      );
    }
  });

  it('viewers: each person only in contexts they belong to', () => {
    assert.ok(!viewers.some((v) => v.context === 'room2' && v.user === 'alice'));
    assert.ok(!viewers.some((v) => v.context === 'dm' && v.user !== 'alice'));
    assert.equal(new Set(viewers.map(viewerId)).size, viewers.length);
  });
});

describe('memory-access oracle', () => {
  it('answers every viewer × mode × item, and every store discriminates', () => {
    const seen = new Map<Store, { allowed: number; denied: number }>();
    for (const item of world.items) {
      const counts = seen.get(item.store) ?? { allowed: 0, denied: 0 };
      for (const mode of MODES) {
        for (const v of viewers) {
          const verdict = expected(v, mode, item);
          assert.ok(verdict.source.length > 0, `no source for ${item.canary}`);
          if (verdict.basis === 'pinned') assert.ok(verdict.source.startsWith(PINNED));
          if (verdict.allowed) counts.allowed++;
          else counts.denied++;
        }
      }
      seen.set(item.store, counts);
    }
    for (const [store, c] of seen) {
      assert.ok(
        c.allowed > 0 && c.denied > 0,
        `store ${store} is all ${c.allowed > 0 ? 'allowed' : 'denied'}`,
      );
    }
  });

  it('another tenant never sees anything', () => {
    const other = viewer({ tenant: 'other' });
    for (const item of world.items.filter((i) => i.tenant === 'main')) {
      for (const mode of MODES)
        assert.equal(expected(other, mode, item).allowed, false, item.canary);
    }
  });

  it('hand-pinned verdicts', () => {
    const alice = viewer({});
    const bob = viewer({ user: 'bob' });
    const privAlice = mk({
      owners: ['alice'],
      visibility: 'private',
      originAgent: 'none',
      authorship: 'conversation',
      provenance: 'protected',
    });
    assert.equal(expected(alice, 'off', privAlice).allowed, true, 'owner sees own private MK');
    assert.equal(
      expected(bob, 'off', privAlice).allowed,
      false,
      'non-owner never sees a private MK',
    );

    const otherAgent = mk({
      owners: ['alice'],
      visibility: 'private',
      originAgent: 'boreas',
      authorship: 'conversation',
      provenance: 'protected',
    });
    assert.equal(
      expected(alice, 'off', otherAgent).allowed,
      false,
      'viewerAgentSlug constrains the owner branch',
    );

    const team = mk({
      owners: ['bob', 'carol'],
      visibility: 'team',
      originAgent: 'boreas',
      authorship: 'conversation',
      provenance: 'protected',
    });
    assert.equal(
      expected(alice, 'enforce', team).allowed,
      true,
      'team MK crosses users and agents (pinned)',
    );
    assert.equal(expected(alice, 'enforce', team).basis, 'pinned');

    // members, room1 (alice + bob): needs both as owners.
    const room1Alice = viewer({ context: 'room1' });
    const both = mk({
      owners: ['alice', 'bob'],
      visibility: 'private',
      originAgent: 'atlas',
      authorship: 'conversation',
      provenance: 'protected',
    });
    assert.equal(expected(room1Alice, 'members', both).allowed, true);
    assert.equal(
      expected(room1Alice, 'members', privAlice).allowed,
      false,
      'bob is present and no owner',
    );
    assert.equal(
      expected(room1Alice, 'members', team).allowed,
      false,
      'visibility does not widen members',
    );
    const operator = mk({
      owners: [],
      visibility: 'private',
      originAgent: 'none',
      authorship: 'operator',
      provenance: 'protected',
    });
    const autoDurable = mk({
      owners: [],
      visibility: 'private',
      originAgent: 'none',
      authorship: 'auto-durable',
      provenance: 'protected',
    });
    assert.equal(
      expected(room1Alice, 'members', operator).allowed,
      true,
      'operator-authored passes',
    );
    assert.equal(
      expected(room1Alice, 'members', autoDurable).allowed,
      false,
      'auto: durable does not',
    );

    const stamped = mk({
      owners: ['alice'],
      visibility: 'private',
      originAgent: 'none',
      authorship: 'conversation',
      provenance: 'stamped-unprotected',
    });
    assert.equal(expected(alice, 'off', stamped).allowed, true);
    assert.equal(
      expected(viewer({ shielded: true }), 'off', stamped).allowed,
      false,
      'shield drops unprotected MK',
    );

    const coreFile = world.byStore.scratch.find((s) => s.tenant === 'main' && s.tier === 'core')!;
    for (const mode of MODES)
      assert.equal(
        expected(room1Alice, mode, coreFile).allowed,
        true,
        'core readable in every mode',
      );
    const room2Tier = world.byStore.scratch.find(
      (s) =>
        s.tenant === 'main' &&
        s.tier === 'context-channel' &&
        s.agent === 'atlas' &&
        s.context === 'room2',
    )!;
    assert.equal(expected(room1Alice, 'enforce', room2Tier).allowed, false, 'Kanal ↮ Kanal');
  });

  it('lists the divergences the contract suite must confirm or clear', () => {
    assert.ok(EXPECTED_DIVERGENCES.length > 0);
    assert.equal(new Set(EXPECTED_DIVERGENCES.map((d) => d.id)).size, EXPECTED_DIVERGENCES.length);
  });
});

describe('memory-access seed · InMemoryKnowledgeGraph', () => {
  let seeded: Seeded;

  before(async () => {
    seeded = await seedInMemory(world);
  });

  it('every canary reads back from its store (positive control)', async () => {
    const missing: string[] = [];
    for (const item of world.items) {
      if (seeded.skipped.includes(item)) continue;
      const text = await readBack(seeded, item);
      if (!text?.includes(item.canary)) missing.push(`${item.store} ${item.canary}`);
    }
    assert.deepEqual(missing, []);
  });

  it('only process memory is skipped (the in-memory graph has none)', () => {
    assert.deepEqual([...new Set(seeded.skipped.map((i) => i.store))], ['process']);
  });
});
