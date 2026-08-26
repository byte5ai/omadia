import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  CONTEXT_MEMORY_CHANNEL_TYPES,
  memoryAxesForOrigin,
  type MemoryAxes,
  type TurnOrigin,
} from '../packages/harness-channel-sdk/src/turnOrigin.js';
import {
  memoryContextKey,
  parseSessionScope,
} from '../packages/harness-channel-sdk/src/scopeId.js';

/**
 * W5 memory-ACL — `memoryAxesForOrigin`, the pure translation from "where did
 * this turn come from" to the scope patterns a turn may reach (design #870 §2
 * table, §3 grammar).
 *
 * The suite is written as that table: one describe per row, plus a fail-closed
 * block for every way an origin can fail to name a context. What is under test
 * is not prettiness of keys but WHICH TIERS a turn reaches — the function is the
 * single place where a turn's audience is decided, so a wrong row here is a
 * cross-team leak that no downstream test would catch.
 *
 * Pollution guard (known full-suite bug): the function is pure and this file
 * holds no module-level fixtures — every case builds its own `TurnOrigin`
 * inline, and no test mutates env or shared state.
 */

/** Recompute a context key through the real derivation — never hand-spelled. */
const channelPattern = (channelType: string, nativeId: string): string =>
  `channel:${memoryContextKey(channelType, nativeId)}:*`;

const teamPattern = (channelType: string, nativeId: string): string =>
  `team:${memoryContextKey(channelType, nativeId)}:*`;

const userPattern = (channelType: string, nativeId: string): string =>
  `user:${memoryContextKey(channelType, nativeId)}:*`;

/** Row 1 of the §2 table — the shape every fail-closed path must return. */
const assertContextFree = (axes: MemoryAxes, because: string): void => {
  assert.equal(axes.isContextFree, true, because);
  assert.deepEqual([...axes.patterns], [], because);
  assert.equal(axes.narrowest, undefined, because);
};

describe('W5 memoryAxesForOrigin — §2 row 2: Teams team channel (container present)', () => {
  it('reaches its own channel tier and its team tier, narrowest first', () => {
    // The literal shapes Teams produces: `teams-<conversationId>` as the session
    // scope, `channelData.team.id` as the container.
    const sessionScope = 'teams-19:abc@thread.tacv2';
    const origin: TurnOrigin = {
      channelType: 'teams',
      scope: parseSessionScope(sessionScope),
      container: { kind: 'team', id: '19:team-a@thread.tacv2' },
      principal: { kind: 'user', userId: 'aad-oid-1' },
    };

    const axes = memoryAxesForOrigin(origin);

    assert.equal(axes.isContextFree, false);
    assert.deepEqual(
      [...axes.patterns],
      [channelPattern('teams', sessionScope), teamPattern('teams', 'team:19:team-a@thread.tacv2')],
    );
    assert.deepEqual(axes.narrowest, {
      axis: 'channel',
      ctxKey: memoryContextKey('teams', sessionScope),
    });
  });

  it('keeps two channels of ONE team apart while both reach the same team tier', () => {
    const container = { kind: 'team', id: '19:team-a@thread.tacv2' } as const;
    const general = memoryAxesForOrigin({
      channelType: 'teams',
      scope: parseSessionScope('teams-19:general@thread.tacv2'),
      container,
    });
    const random = memoryAxesForOrigin({
      channelType: 'teams',
      scope: parseSessionScope('teams-19:random@thread.tacv2'),
      container,
    });

    assert.notEqual(general.patterns[0], random.patterns[0]);
    assert.equal(general.patterns[1], random.patterns[1]);
  });

  it('keeps team A and team B apart — the property the whole design exists for', () => {
    const scope = parseSessionScope('teams-19:shared-name@thread.tacv2');
    const teamA = memoryAxesForOrigin({
      channelType: 'teams',
      scope,
      container: { kind: 'team', id: '19:team-a@thread.tacv2' },
    });
    const teamB = memoryAxesForOrigin({
      channelType: 'teams',
      scope,
      container: { kind: 'team', id: '19:team-b@thread.tacv2' },
    });

    assert.notEqual(teamA.patterns[1], teamB.patterns[1]);
  });

  it('does not let a team container collide with a tenant container of the same id', () => {
    const scope = parseSessionScope('teams-19:c1@thread.tacv2');
    const asTeam = memoryAxesForOrigin({
      channelType: 'teams',
      scope,
      container: { kind: 'team', id: 'acme' },
    });
    const asTenant = memoryAxesForOrigin({
      channelType: 'teams',
      scope,
      container: { kind: 'tenant', id: 'acme' },
    });

    assert.notEqual(asTeam.patterns[1], asTenant.patterns[1]);
  });
});

describe('W5 memoryAxesForOrigin — §2 row 3: group chat without a container', () => {
  it('gives a Telegram group its channel tier and no team tier', () => {
    const scope = parseSessionScope('telegram::-1001234567890');
    const axes = memoryAxesForOrigin({ channelType: 'telegram', scope });

    assert.equal(axes.isContextFree, false);
    assert.deepEqual([...axes.patterns], [channelPattern('telegram', 'telegram::-1001234567890')]);
    assert.deepEqual(axes.narrowest, {
      axis: 'channel',
      ctxKey: memoryContextKey('telegram', 'telegram::-1001234567890'),
    });
  });

  it('treats an explicit `group:` scope as a channel tier too', () => {
    const axes = memoryAxesForOrigin({
      channelType: 'teams',
      scope: parseSessionScope('group:19:groupchat@thread.v2'),
    });

    assert.deepEqual([...axes.patterns], [channelPattern('teams', 'group:19:groupchat@thread.v2')]);
    assert.equal(axes.narrowest?.axis, 'channel');
  });

  it('keeps a channel-qualified conversation apart from the bare conversation id', () => {
    // `formatSessionScope` keeps the channelId, so `a::c1` and `c1` are two
    // partitions — collapsing them would merge two platforms' conversations.
    const qualified = memoryAxesForOrigin({
      channelType: 'telegram',
      scope: parseSessionScope('a::c1'),
    });
    const bare = memoryAxesForOrigin({
      channelType: 'telegram',
      scope: parseSessionScope('c1'),
    });

    assert.notEqual(qualified.patterns[0], bare.patterns[0]);
  });
});

describe('W5 memoryAxesForOrigin — §2 row 4: personal chat', () => {
  it('gives a Teams 1:1 turn only its user tier', () => {
    const axes = memoryAxesForOrigin({
      channelType: 'teams',
      scope: parseSessionScope('personal:aad-oid-1'),
      principal: { kind: 'user', userId: 'aad-oid-1' },
    });

    assert.equal(axes.isContextFree, false);
    assert.deepEqual([...axes.patterns], [userPattern('teams', 'aad-oid-1')]);
    assert.deepEqual(axes.narrowest, {
      axis: 'user',
      ctxKey: memoryContextKey('teams', 'aad-oid-1'),
    });
  });

  it('keys the user tier on the scope, not on the principal', () => {
    // A principal that disagrees with the scope must not move the tier: the
    // scope is what the platform authenticated the turn into.
    const axes = memoryAxesForOrigin({
      channelType: 'telegram',
      scope: parseSessionScope('personal:12345'),
      principal: { kind: 'user', userId: 'someone-else' },
    });

    assert.deepEqual([...axes.patterns], [userPattern('telegram', '12345')]);
  });

  it('separates two people in private chats on the same channel', () => {
    const alice = memoryAxesForOrigin({
      channelType: 'telegram',
      scope: parseSessionScope('personal:111'),
    });
    const bob = memoryAxesForOrigin({
      channelType: 'telegram',
      scope: parseSessionScope('personal:222'),
    });

    assert.notEqual(alice.patterns[0], bob.patterns[0]);
  });

  it('still adds a team tier when a personal turn carries a container', () => {
    const axes = memoryAxesForOrigin({
      channelType: 'teams',
      scope: parseSessionScope('personal:aad-oid-1'),
      container: { kind: 'tenant', id: 'acme' },
    });

    assert.deepEqual(
      [...axes.patterns],
      [userPattern('teams', 'aad-oid-1'), teamPattern('teams', 'tenant:acme')],
    );
    assert.equal(axes.narrowest?.axis, 'user');
  });
});

describe('W5 memoryAxesForOrigin — §2 row 5: API turn with a tenant', () => {
  it('reaches the tenant team tier and its own conversation tier', () => {
    const axes = memoryAxesForOrigin({
      channelType: 'api',
      scope: parseSessionScope('api::conv-7'),
      container: { kind: 'tenant', id: 'acme' },
    });

    assert.deepEqual(
      [...axes.patterns],
      [channelPattern('api', 'api::conv-7'), teamPattern('api', 'tenant:acme')],
    );
    assert.equal(axes.narrowest?.axis, 'channel');
  });

  it('maps an org scope with no container onto the team tier alone', () => {
    // An org scope names a tenant-wide audience, not a conversation. Landing it
    // on the team tier is strictly NARROWER than the context-free row it would
    // otherwise take, so this is the safe direction.
    const axes = memoryAxesForOrigin({
      channelType: 'api',
      scope: parseSessionScope('org:acme'),
    });

    assert.equal(axes.isContextFree, false);
    assert.deepEqual([...axes.patterns], [teamPattern('api', 'org:acme')]);
    assert.deepEqual(axes.narrowest, {
      axis: 'team',
      ctxKey: memoryContextKey('api', 'org:acme'),
    });
  });

  it('lets an explicit container win over the org scope', () => {
    const axes = memoryAxesForOrigin({
      channelType: 'api',
      scope: parseSessionScope('org:acme'),
      container: { kind: 'tenant', id: 'globex' },
    });

    assert.deepEqual([...axes.patterns], [teamPattern('api', 'tenant:globex')]);
  });
});

describe('W5 memoryAxesForOrigin — §2 row 1: fail-closed', () => {
  it('returns the context-free axes when no origin was supplied at all', () => {
    // The no-flag-day case: a channel plugin that predates `origin`.
    assertContextFree(memoryAxesForOrigin(undefined), 'missing origin');
  });

  it('refuses an absent scope', () => {
    assertContextFree(
      memoryAxesForOrigin({ channelType: 'teams', scope: parseSessionScope(undefined) }),
      'unscoped: absent',
    );
  });

  it('refuses every shared bucket token', () => {
    // These are the measured multi-caller buckets from #575. A context tree keyed
    // on one of them would be shared by unrelated callers — the exact hole.
    for (const token of ['http-default', 'teams-unknown', 'unknown']) {
      assertContextFree(
        memoryAxesForOrigin({ channelType: 'http', scope: parseSessionScope(token) }),
        `unscoped: shared token ${token}`,
      );
    }
  });

  it('refuses machine scopes — they have no audience by construction', () => {
    for (const raw of [
      'routine:nightly',
      'schedule:cron-1',
      'conductor:run-1',
      'conductor-builder:draft-1',
    ]) {
      assertContextFree(
        memoryAxesForOrigin({ channelType: 'api', scope: parseSessionScope(raw) }),
        `system scope ${raw}`,
      );
    }
  });

  it('refuses a channel type nobody has written a §2 row for', () => {
    for (const channelType of ['discord', 'canvas', 'cli', '', '   ']) {
      assertContextFree(
        memoryAxesForOrigin({
          channelType,
          scope: parseSessionScope('c1'),
          container: { kind: 'team', id: 'team-a' },
        }),
        `unknown channelType ${JSON.stringify(channelType)}`,
      );
    }
  });

  it('accepts a known channel type regardless of case or padding', () => {
    for (const channelType of ['Teams', ' teams ', 'TEAMS']) {
      const axes = memoryAxesForOrigin({ channelType, scope: parseSessionScope('c1') });
      assert.equal(axes.isContextFree, false, channelType);
      assert.deepEqual([...axes.patterns], [channelPattern('teams', 'c1')], channelType);
    }
  });

  it('refuses a personal scope whose user id is blank', () => {
    // `parseSessionScope('personal:')` yields an EMPTY userId — a bucket every
    // such turn would share.
    assertContextFree(
      memoryAxesForOrigin({ channelType: 'teams', scope: parseSessionScope('personal:') }),
      'blank personal userId',
    );
  });

  it('drops a blank container instead of keying a shared team tier on it', () => {
    const axes = memoryAxesForOrigin({
      channelType: 'teams',
      scope: parseSessionScope('teams-19:c1@thread.tacv2'),
      container: { kind: 'team', id: '  ' },
    });

    assert.deepEqual([...axes.patterns], [channelPattern('teams', 'teams-19:c1@thread.tacv2')]);
    assert.equal(axes.narrowest?.axis, 'channel');
  });

  it('refuses an org scope with a blank org id', () => {
    assertContextFree(
      memoryAxesForOrigin({ channelType: 'api', scope: parseSessionScope('org:') }),
      'blank orgId',
    );
  });

  it('refuses a container kind outside the contract', () => {
    // Crosses a plugin boundary from an independently versioned package, so the
    // type alone is not the guarantee.
    const axes = memoryAxesForOrigin({
      channelType: 'teams',
      scope: parseSessionScope('personal:u1'),
      container: { kind: 'workspace', id: 'w1' } as unknown as TurnOrigin['container'],
    });

    assert.deepEqual([...axes.patterns], [userPattern('teams', 'u1')]);
  });
});

describe('W5 memoryAxesForOrigin — grammar and purity', () => {
  it('emits only patterns the §3 grammar can compile', () => {
    const axes = memoryAxesForOrigin({
      channelType: 'teams',
      scope: parseSessionScope('teams-19:abc@thread.tacv2'),
      container: { kind: 'team', id: '19:team-a@thread.tacv2' },
    });

    // `<ctxKey>` must never contain a `:` — the store matches `/^team:([^:]+):\*$/`.
    for (const pattern of axes.patterns) {
      assert.match(pattern, /^(team|channel|user):[a-z0-9_~-]+:\*$/, pattern);
    }
  });

  it('is pure — the same origin yields an equal result and no shared mutable state', () => {
    const build = (): TurnOrigin => ({
      channelType: 'teams',
      scope: parseSessionScope('teams-19:abc@thread.tacv2'),
      container: { kind: 'team', id: '19:team-a@thread.tacv2' },
    });

    assert.deepEqual(memoryAxesForOrigin(build()), memoryAxesForOrigin(build()));
  });

  it('hands out a frozen context-free value that a caller cannot widen', () => {
    const axes = memoryAxesForOrigin(undefined);
    assert.throws(() => {
      (axes.patterns as string[]).push('team:evil:*');
    });
    assertContextFree(memoryAxesForOrigin(undefined), 'still context-free after a push attempt');
  });

  it('documents its allowlist as data the §4 recipes can be checked against', () => {
    assert.deepEqual([...CONTEXT_MEMORY_CHANNEL_TYPES].sort(), [
      'api',
      'http',
      'teams',
      'telegram',
    ]);
  });
});
