/**
 * Memory-ACL plan, step 5 — lifecycle invariants that need no database.
 *
 * 1. Visibility never widens without an ACL audit entry. Random sequences of
 *    owner changes, edits and deletes (fast-check) run on the in-memory graph;
 *    after every step, anyone who can now read a memory they could not read
 *    before must be named by an `expand` row of its ACL audit log. A deleted
 *    memory is readable by nobody.
 * 2. Scope keys are injective: two different raw scopes never share a graph
 *    partition under `scopeGraphKey` (`OMADIA_INJECTIVE_SCOPE_KEYS=1`).
 *
 * The Postgres jobs (promotion, scratch reaper, auto-merge, decay, backfill,
 * purge) run in `lifecycleInvariants.pg.test.ts`.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { scopeGraphKey } from '@omadia/channel-sdk';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';

const PEOPLE = ['alice', 'bob', 'carol'] as const;
type Person = (typeof PEOPLE)[number];
const DIM = 8;

type Op =
  | { kind: 'add'; mk: number; actor: Person; target: Person }
  | { kind: 'remove'; mk: number; actor: Person; target: Person }
  | { kind: 'edit'; mk: number; actor: Person }
  | { kind: 'delete'; mk: number; actor: Person };

const person = fc.constantFrom(...PEOPLE);
const opArb = (mks: number): fc.Arbitrary<Op> => {
  const mk = fc.integer({ min: 0, max: mks - 1 });
  return fc.oneof(
    fc.record({ kind: fc.constant('add' as const), mk, actor: person, target: person }),
    fc.record({ kind: fc.constant('remove' as const), mk, actor: person, target: person }),
    fc.record({ kind: fc.constant('edit' as const), mk, actor: person }),
    fc.record({ kind: fc.constant('delete' as const), mk, actor: person }),
  );
};
const ownerSet = fc.subarray([...PEOPLE], { minLength: 1 });

async function world(owners: readonly (readonly Person[])[]) {
  const kg = new InMemoryKnowledgeGraph();
  const ids = {} as Record<Person, string>;
  for (const p of PEOPLE) {
    const res = await kg.resolveOrCreateChannelIdentity({
      channelKind: 'teams',
      channelUserId: `aad-${p}`,
      aadObjectId: `aad-${p}`,
      displayName: p,
    });
    ids[p] = res.omadiaUserId;
  }
  const mks: string[] = [];
  for (const [i, set] of owners.entries()) {
    const res = await kg.createMemorableKnowledge({
      kind: 'insight',
      summary: `memory ${String(i)}`,
      createdBy: `auto:${ids[set[0]!]}`,
      aclOwners: set.map((p) => ids[p]),
      involvedOmadiaUserIds: set.map((p) => ids[p]),
    });
    const v = Array.from({ length: DIM }, () => 0);
    v[i % DIM] = 1;
    await kg.setEmbedding(res.memorableKnowledgeNodeId, v);
    mks.push(res.memorableKnowledgeNodeId);
  }
  return { kg, ids, mks };
}

type World = Awaited<ReturnType<typeof world>>;

/** Who reads each memory, through the by-id read and the recall search. */
async function readers(w: World): Promise<Map<string, Set<Person>>> {
  const out = new Map<string, Set<Person>>();
  for (const id of w.mks) out.set(id, new Set());
  for (const p of PEOPLE) {
    for (const id of w.mks) {
      if (await w.kg.getMemorableKnowledge(id, w.ids[p])) out.get(id)!.add(p);
    }
    const hits = await w.kg.searchMemorableKnowledgeByEmbedding({
      queryEmbedding: Array.from({ length: DIM }, () => 1),
      viewerOmadiaUserId: w.ids[p],
      teamVisibility: true,
      minSimilarity: 0.01,
      limit: 100,
    });
    for (const h of hits) out.get(h.mk.id)?.add(p);
  }
  return out;
}

async function apply(w: World, op: Op): Promise<void> {
  const id = w.mks[op.mk]!;
  const actor = { actorOmadiaUserId: w.ids[op.actor] };
  try {
    if (op.kind === 'add') await w.kg.addOwner(id, w.ids[op.target], actor);
    if (op.kind === 'remove') await w.kg.removeOwner(id, w.ids[op.target], actor);
    if (op.kind === 'edit') await w.kg.updateMemorableKnowledge(id, { summary: 'edited' }, actor);
    if (op.kind === 'delete') await w.kg.deleteMemory(id, actor);
  } catch {
    // Refused (not an owner, last owner, already deleted): no change expected.
  }
}

describe('memory lifecycle invariants (memory-ACL plan step 5)', () => {
  it('visibility never widens without an ACL audit entry, and deleted memory is read by nobody', async () => {
    let widened = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(ownerSet, { minLength: 2, maxLength: 4 }),
        fc.array(opArb(4), { minLength: 1, maxLength: 12 }),
        async (owners, ops) => {
          const w = await world(owners);
          let before = await readers(w);
          for (const op of ops) {
            if (op.mk >= w.mks.length) continue;
            await apply(w, op);
            const after = await readers(w);
            for (const id of w.mks) {
              const gained = [...after.get(id)!].filter((p) => !before.get(id)!.has(p));
              if (gained.length === 0) continue;
              widened++;
              const audit = await w.kg.listMemoryAclAudit(id);
              for (const p of gained) {
                assert.ok(
                  audit.some((a) => a.action === 'expand' && (a.afterOwners ?? []).includes(w.ids[p])),
                  `${p} gained ${id} after ${JSON.stringify(op)} without an expand audit row`,
                );
              }
            }
            for (const id of w.mks) {
              if ((await w.kg.getMemorableKnowledge(id)) !== null) continue;
              assert.equal(after.get(id)!.size, 0, `${id} is deleted but still read by ${[...after.get(id)!].join(', ')}`);
            }
            before = after;
          }
        },
      ),
      { numRuns: 150, seed: 20261126 },
    );
    // Positive control: the sequences did grant access, so the audit check ran.
    assert.ok(widened > 0, 'no operation ever widened access');
  });

  it('scopeGraphKey: different raw scopes never share a graph partition', () => {
    const scope = fc.oneof(
      fc.string({ minLength: 1, maxLength: 90 }),
      fc.stringMatching(/^[a-z]{2,8}[:~@.]{1,2}[0-9a-z:@.-]{1,40}$/),
    );
    fc.assert(
      fc.property(scope, scope, (a, b) => {
        fc.pre(a.trim() !== b.trim());
        assert.notEqual(scopeGraphKey(a), scopeGraphKey(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
      }),
      { numRuns: 2000, seed: 20261126 },
    );
  });

  it(
    'scopeGraphKey: a raw scope spelled like a produced key does not land in that partition',
    () => {
      const raw = 'teams:19:abc@thread';
      const key = scopeGraphKey(raw);
      assert.notEqual(scopeGraphKey(key), key);
    },
  );
});
