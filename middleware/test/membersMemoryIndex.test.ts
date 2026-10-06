/**
 * The owner-set index of `members` notes (W3): keys are canonical, and the
 * index trusts only entries that hash to their own name.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryMemoryStore } from '@omadia/memory';
import { MembersIndex, membersIndexRoot, membersTierKey, MemoryBinder } from '@omadia/orchestrator';
import { parseSessionScope } from '../packages/harness-channel-sdk/src/scopeId.js';

const AGENT = 'agent-x';

describe('members notes — owner-set index', () => {
  it('a key does not depend on order or duplicates', () => {
    assert.equal(membersTierKey(['b', 'a', 'c']), membersTierKey(['c', 'a', 'b', 'a']));
    assert.notEqual(membersTierKey(['a', 'b']), membersTierKey(['a', 'b', 'c']));
  });

  it('covers an audience only with sets that include all of it', async () => {
    const index = new MembersIndex(new InMemoryMemoryStore(), AGENT);
    const trio = await index.register(['m', 'c', 'x']);
    await index.register(['m']);
    const covering = (await index.coveringAudience(['c', 'x'])).map((e) => e.key);
    assert.deepEqual(covering, [trio]);
    assert.deepEqual(await index.coveringAudience(['c', 'newbie']), []);
  });

  it('ignores an index entry whose owners do not hash to its name', async () => {
    const root = new InMemoryMemoryStore();
    const victim = membersTierKey(['m', 'c', 'x']);
    // Someone plants "the trio's tier belongs to the outsider".
    await root.createFile(`${membersIndexRoot(AGENT)}/${victim}.json`, JSON.stringify({ owners: ['outsider'] }));
    const covering = await new MembersIndex(root, AGENT).coveringAudience(['outsider']);
    assert.deepEqual(covering, []);
  });

  it('an unknown room can write nowhere, a known one only to its own tier', async () => {
    const root = new InMemoryMemoryStore();
    const binder = new MemoryBinder({ agentSlug: AGENT, root, mode: 'members' });
    const origin = { channelType: 'teams', scope: parseSessionScope('msteams::conv-1') };

    const unknown = await binder.forAudience(origin, { kind: 'unknown', reason: 'roster-incomplete' });
    assert.deepEqual(unknown.scope, ['ro:core-notes']);
    await assert.rejects(unknown.store.createFile('/memories/x.md', 'x'));

    const known = await binder.forAudience(origin, { kind: 'known', members: ['m', 'c'] });
    const key = membersTierKey(['m', 'c']);
    assert.deepEqual(known.members, { key, shared: [] });
    await known.store.createFile('/memories/x.md', 'x');
    assert.equal(await root.fileExists(`/memories/contexts/${AGENT}/members/${key}/x.md`), true);
    // The index is a sibling of the tiers and outside every grant.
    for (const path of [`/memories/../members-index/${key}.json`, `/memories/contexts/${AGENT}/members-index/${key}.json`]) {
      const readable = await known.store.readFile(path).then(() => true, () => false);
      assert.equal(readable, false, `${path} was readable`);
    }
  });
});
