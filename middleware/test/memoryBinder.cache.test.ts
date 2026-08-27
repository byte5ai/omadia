/**
 * W5 — `MemoryBinder` cache behaviour (design #870 §8.9).
 *
 * The binder builds one memory stack per chat context and caches it, because a
 * stack is pure configuration over the shared root store. Two properties have
 * to hold for that to be safe:
 *
 *  1. The cache is a bounded LRU. A busy Agent serving hundreds of channels
 *     keeps a fixed number of wrappers alive, eviction is least-recently-USED
 *     (not least-recently-added), and evicting a binding never loses data —
 *     it drops a wrapper, not the tree underneath.
 *  2. The key never collides. Different agents, different axes and different
 *     context keys must never share a binding, or the cache would become the
 *     leak the wave exists to close.
 *
 * Pollution guard: every test builds its own store and binder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryMemoryStore } from '@omadia/memory';

import {
  DEFAULT_BINDER_CACHE_CAP,
  MemoryBinder,
  memoryBindingCacheKey,
} from '../packages/harness-orchestrator/src/memoryBinder.js';
import {
  memoryAxesForOrigin,
  type TurnOrigin,
} from '../packages/harness-channel-sdk/src/turnOrigin.js';

const AGENT = 'acme-bot';

/** The separator `memoryBindingCacheKey` joins its parts with (U+001F). */
const SEP = '\u001f';

/** `mode: 'enforce'` — with the shipped `'off'` default every origin would
 *  collapse onto ONE binding and the cache properties would be vacuous. */
function binder(cacheCap?: number): MemoryBinder {
  return new MemoryBinder({
    agentSlug: AGENT,
    root: new InMemoryMemoryStore(),
    mode: 'enforce',
    ...(cacheCap === undefined ? {} : { cacheCap }),
  });
}

function channel(conversationId: string, teamId?: string): TurnOrigin {
  return {
    channelType: 'teams',
    scope: { kind: 'conversation', channelId: 'msteams', conversationId },
    ...(teamId ? { container: { kind: 'team' as const, id: teamId } } : {}),
  };
}

test('the same origin resolves to the same binding instance', () => {
  const b = binder();
  const origin = channel('19:chan-a@thread.tacv2', 'team-a');

  assert.equal(b.forOrigin(origin), b.forOrigin(origin));
  assert.equal(b.cacheSize, 1);
  // A structurally equal but distinct origin object hits the same entry — the
  // key is derived from the scope, not from object identity.
  assert.equal(b.forOrigin(origin), b.forOrigin(channel('19:chan-a@thread.tacv2', 'team-a')));
  assert.equal(b.cacheSize, 1);
});

test('different origins resolve to different bindings', () => {
  const b = binder();
  const a = b.forOrigin(channel('19:chan-a@thread.tacv2', 'team-a'));
  const other = b.forOrigin(channel('19:chan-b@thread.tacv2', 'team-b'));
  const free = b.forOrigin(undefined);

  assert.notEqual(a, other);
  assert.notEqual(a, free);
  assert.equal(b.cacheSize, 3);
});

test('the cache never grows past its cap', () => {
  const b = binder(2);
  b.forOrigin(channel('19:one@thread.tacv2'));
  b.forOrigin(channel('19:two@thread.tacv2'));
  assert.equal(b.cacheSize, 2);

  b.forOrigin(channel('19:three@thread.tacv2'));
  assert.equal(b.cacheSize, 2);

  for (let i = 0; i < 50; i += 1) b.forOrigin(channel(`19:bulk-${i}@thread.tacv2`));
  assert.equal(b.cacheSize, 2);
});

test('eviction is least-recently-used, not least-recently-added', () => {
  const b = binder(2);
  const one = b.forOrigin(channel('19:one@thread.tacv2'));
  b.forOrigin(channel('19:two@thread.tacv2'));

  // Touch `one` so `two` becomes the least recently used entry.
  assert.equal(b.forOrigin(channel('19:one@thread.tacv2')), one);
  b.forOrigin(channel('19:three@thread.tacv2'));

  assert.equal(b.forOrigin(channel('19:one@thread.tacv2')), one, 'one should survive');
  assert.notEqual(
    b.forOrigin(channel('19:two@thread.tacv2')),
    undefined,
    'two is rebuilt after eviction',
  );
});

test('an evicted binding loses its wrapper, never its data', async () => {
  const b = binder(1);
  const origin = channel('19:one@thread.tacv2');

  const first = b.forOrigin(origin);
  await first.handler.handle({ command: 'create', path: '/memories/n.md', file_text: 'kept' });

  b.forOrigin(channel('19:evictor@thread.tacv2'));
  const second = b.forOrigin(origin);

  assert.notEqual(second, first, 'the wrapper was rebuilt');
  assert.equal(await second.store.readFile('/memories/n.md'), 'kept');
});

test('a non-positive cap falls back to the default rather than disabling the cache', () => {
  assert.equal(DEFAULT_BINDER_CACHE_CAP, 256);
  const b = binder(0);
  const origin = channel('19:one@thread.tacv2');
  assert.equal(b.forOrigin(origin), b.forOrigin(origin));
});

test('the cache key does not collide across agents, axes or context keys', () => {
  const conversation = memoryAxesForOrigin(channel('19:chan-a@thread.tacv2', 'team-a'));
  const otherConversation = memoryAxesForOrigin(channel('19:chan-b@thread.tacv2', 'team-a'));
  const sameConversationOtherTeam = memoryAxesForOrigin(
    channel('19:chan-a@thread.tacv2', 'team-b'),
  );
  const personal = memoryAxesForOrigin({
    channelType: 'teams',
    scope: { kind: 'personal', userId: '19:chan-a@thread.tacv2' },
  });
  const contextFree = memoryAxesForOrigin(undefined);

  const keys = [
    memoryBindingCacheKey(AGENT, conversation, 'enforce'),
    memoryBindingCacheKey(AGENT, otherConversation, 'enforce'),
    memoryBindingCacheKey(AGENT, sameConversationOtherTeam, 'enforce'),
    memoryBindingCacheKey(AGENT, personal, 'enforce'),
    memoryBindingCacheKey(AGENT, contextFree, 'enforce'),
    // Same axes, different agent — the agent slug is part of the key.
    memoryBindingCacheKey('other-bot', conversation, 'enforce'),
    memoryBindingCacheKey('other-bot', contextFree, 'enforce'),
    // Same axes, different MODE. 'enforce' and 'enforce-strict' compile
    // DIFFERENT scopes from one axes object, so sharing a cache entry between
    // them would hand a strict-mode turn a stack that reads the agent tier.
    memoryBindingCacheKey(AGENT, conversation, 'enforce-strict'),
    memoryBindingCacheKey(AGENT, conversation, 'off'),
  ];

  assert.equal(new Set(keys).size, keys.length, `keys collided: ${keys.join('\n')}`);
});

test('the cache key survives a separator-shaped context key', () => {
  // The key is joined with U+001F. `memoryContextKey` emits only
  // `[a-z0-9_~-]`, so the separator cannot occur inside a part — but assert it
  // rather than assume it, because the whole no-collision argument rests on it.
  const axes = memoryAxesForOrigin(channel('19:chan-a@thread.tacv2', 'team-a'));
  const key = memoryBindingCacheKey(AGENT, axes, 'enforce');
  for (const part of [AGENT, axes.narrowest?.ctxKey ?? '', ...axes.patterns]) {
    assert.ok(!part.includes(SEP), `separator leaked into a key part: ${part}`);
  }
  assert.ok(key.includes(SEP));
});

test('two binders for different agents never share a physical tree', async () => {
  const root = new InMemoryMemoryStore();
  const one = new MemoryBinder({ agentSlug: 'agent-one', root, mode: 'enforce' });
  const two = new MemoryBinder({ agentSlug: 'agent-two', root, mode: 'enforce' });
  const origin = channel('19:shared-chan@thread.tacv2', 'team-a');

  await one
    .forOrigin(origin)
    .handler.handle({ command: 'create', path: '/memories/n.md', file_text: 'from one' });

  assert.equal(await two.forOrigin(origin).store.fileExists('/memories/n.md'), false);
  const paths = (await root.list('/memories/contexts')).map((e) => e.virtualPath);
  assert.ok(paths.includes('/memories/contexts/agent-one'), paths.join(', '));
  assert.deepEqual(
    paths.filter((p) => p.includes('agent-two')),
    [],
  );
});
