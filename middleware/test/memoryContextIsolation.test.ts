/**
 * W5 — chat-context memory ACL: the isolation acceptance test (design #870 §8.4).
 *
 * One `MemoryBinder`, several turn origins. What must hold:
 *
 *  1. Team A ↮ Team B — a note written in team A's channel is invisible in
 *     team B (soft-deny through the model-facing surface) and unreadable at the
 *     store level (hard `MemoryScopeViolation` on an explicit read).
 *  2. The agent tier is READ-ONLY from a context turn: pre-existing notes stay
 *     readable via `/memories/~agent/…`, writing there throws.
 *  3. A context-free turn behaves exactly as today: it reads the agent tier at
 *     the plain `/memories` root and cannot see the context trees through that
 *     surface at all — they exist only physically, in the root store.
 *  4. The same holds channel↔channel (with the team tier shared inside one
 *     team) and user↔user.
 *
 * Every assertion is store-level; nothing here depends on an LLM. Per the
 * design's pollution guard, each test builds its own `InMemoryMemoryStore` and
 * its own binder — there are no module-level fixtures.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryMemoryStore } from '@omadia/memory';

import {
  MemoryBinder,
  type BoundTurnMemory,
} from '../packages/harness-orchestrator/src/memoryBinder.js';
import {
  MemoryScopeViolation,
  ScopedMemoryStore,
} from '../packages/harness-orchestrator/src/registry/scopedMemoryStore.js';
import type { TurnOrigin } from '../packages/harness-orchestrator/src/turnOrigin.js';

const AGENT = 'acme-bot';

function fixture(): { root: InMemoryMemoryStore; binder: MemoryBinder } {
  const root = new InMemoryMemoryStore();
  const binder = new MemoryBinder({ agentSlug: AGENT, root });
  return { root, binder };
}

function teamsChannel(conversationId: string, teamId?: string): TurnOrigin {
  return {
    channelType: 'teams',
    scope: { kind: 'conversation', channelId: 'msteams', conversationId },
    ...(teamId ? { container: { kind: 'team' as const, id: teamId } } : {}),
  };
}

function teamsPersonal(userId: string): TurnOrigin {
  return { channelType: 'teams', scope: { kind: 'personal', userId } };
}

/** The physical root the narrowest tier of a binding writes into. */
function narrowestRoot(bound: BoundTurnMemory): string {
  const narrowest = bound.axes.narrowest;
  assert.ok(narrowest, 'expected a context binding, got the context-free one');
  return `/memories/contexts/${AGENT}/${narrowest.axis}/${narrowest.ctxKey}`;
}

async function createNote(bound: BoundTurnMemory, path: string, body: string): Promise<string> {
  return bound.handler.handle({ command: 'create', path, file_text: body });
}

test('a note written in team A is physically confined to team A\'s channel tier', async () => {
  const { root, binder } = fixture();
  const a = binder.forOrigin(teamsChannel('19:chan-a@thread.tacv2', 'team-a'));

  const reply = await createNote(a, '/memories/secret.md', 'team A only');
  assert.match(reply, /File created at \/memories\/secret\.md\./);

  const physical = `${narrowestRoot(a)}/secret.md`;
  assert.equal(await root.readFile(physical), 'team A only');
  assert.match(physical, new RegExp(`^/memories/contexts/${AGENT}/channel/teams~`));
  // The legacy agent tree is untouched — this is the whole point of the wave.
  assert.equal(await root.fileExists(`/memories/orchestrators/${AGENT}/secret.md`), false);
});

test('team B sees nothing of team A: soft-deny through the tool, hard violation at the store', async () => {
  const { root, binder } = fixture();
  const a = binder.forOrigin(teamsChannel('19:chan-a@thread.tacv2', 'team-a'));
  const b = binder.forOrigin(teamsChannel('19:chan-b@thread.tacv2', 'team-b'));

  await createNote(a, '/memories/secret.md', 'team A only');

  // Soft: through the model-facing surface team B simply has no such file.
  const view = await b.handler.handle({ command: 'view', path: '/memories/secret.md' });
  assert.match(view, /does not exist/);
  assert.equal(await b.store.fileExists('/memories/secret.md'), false);
  // Listing team B's own root shows team B's own notes and nothing else.
  await createNote(b, '/memories/own.md', 'team B only');
  const listing = await b.store.list('/memories');
  assert.deepEqual(
    listing.map((e) => e.virtualPath),
    ['/memories', '/memories/own.md'],
  );

  // Hard: an explicit read of team A's physical path from team B's compiled
  // scope is a scope violation, not an empty result.
  const bScoped = new ScopedMemoryStore({ agentSlug: AGENT, scope: b.scope, inner: root });
  await assert.rejects(
    () => bScoped.readFile(`${narrowestRoot(a)}/secret.md`),
    MemoryScopeViolation,
  );
  await assert.rejects(
    () => bScoped.createFile(`${narrowestRoot(a)}/planted.md`, 'x'),
    MemoryScopeViolation,
  );
});

test('the agent tier is readable but not writable from a context turn', async () => {
  const { root, binder } = fixture();
  await root.createFile(`/memories/orchestrators/${AGENT}/legacy.md`, 'pre-existing');

  const a = binder.forOrigin(teamsChannel('19:chan-a@thread.tacv2', 'team-a'));

  assert.equal(await a.store.readFile('/memories/~agent/legacy.md'), 'pre-existing');

  await assert.rejects(
    () => a.store.createFile('/memories/~agent/global.md', 'leak'),
    MemoryScopeViolation,
  );
  const reply = await createNote(a, '/memories/~agent/global.md', 'leak');
  assert.match(reply, /is not permitted to write/);
  assert.equal(await root.fileExists(`/memories/orchestrators/${AGENT}/global.md`), false);
});

test('a context-free turn keeps today\'s stack and cannot reach the context trees', async () => {
  const { root, binder } = fixture();
  await root.createFile(`/memories/orchestrators/${AGENT}/legacy.md`, 'pre-existing');

  const a = binder.forOrigin(teamsChannel('19:chan-a@thread.tacv2', 'team-a'));
  await createNote(a, '/memories/secret.md', 'team A only');

  const free = binder.forOrigin(undefined);
  assert.deepEqual(free.scope, ['core', `orchestrator:${AGENT}:*`]);
  assert.equal(free.axes.isContextFree, true);

  // Reads the agent tier at the plain root, exactly as before the wave.
  assert.equal(await free.store.readFile('/memories/legacy.md'), 'pre-existing');
  // Cannot see the context tree through the model-facing surface…
  const physical = `${narrowestRoot(a)}/secret.md`;
  assert.equal(await free.store.fileExists(physical), false);
  assert.equal(await free.store.fileExists('/memories/secret.md'), false);
  // …while it does exist physically in the root store.
  assert.equal(await root.readFile(physical), 'team A only');
});

test('a system scope and an unscoped turn fail closed onto the context-free stack', async () => {
  const { binder } = fixture();

  const system = binder.forOrigin({
    channelType: 'teams',
    scope: { kind: 'system', origin: 'routine', id: 'nightly' },
  });
  const unscoped = binder.forOrigin({
    channelType: 'http',
    scope: { kind: 'unscoped', reason: 'shared', token: 'http-default' },
  });

  for (const bound of [system, unscoped]) {
    assert.equal(bound.axes.isContextFree, true);
    assert.deepEqual(bound.scope, ['core', `orchestrator:${AGENT}:*`]);
  }
});

test('two channels of the same team are isolated but share the team tier', async () => {
  const { root, binder } = fixture();
  const one = binder.forOrigin(teamsChannel('19:chan-one@thread.tacv2', 'team-a'));
  const two = binder.forOrigin(teamsChannel('19:chan-two@thread.tacv2', 'team-a'));

  await createNote(one, '/memories/local.md', 'channel one only');
  assert.equal(await two.store.fileExists('/memories/local.md'), false);
  assert.equal(await one.store.readFile('/memories/local.md'), 'channel one only');

  // The team tier is read-write from a matching team context (coordinator
  // decision 2) and is the same tree for both channels.
  await createNote(one, '/memories/~team/policy.md', 'team-wide');
  assert.equal(await two.store.readFile('/memories/~team/policy.md'), 'team-wide');
  assert.equal(
    await root.readFile(`/memories/contexts/${AGENT}/team/${teamKeyOf(one)}/policy.md`),
    'team-wide',
  );
});

test('a channel without a team container cannot write the team tier', async () => {
  const { binder } = fixture();
  const loose = binder.forOrigin(teamsChannel('19:groupchat@thread.tacv2'));

  assert.deepEqual(loose.axes.patterns.filter((p) => p.startsWith('team:')), []);
  await assert.rejects(
    () => loose.store.createFile('/memories/~team/policy.md', 'nope'),
    MemoryScopeViolation,
  );
});

test('two personal chats are isolated from each other', async () => {
  const { binder } = fixture();
  const alice = binder.forOrigin(teamsPersonal('aad-alice'));
  const bob = binder.forOrigin(teamsPersonal('aad-bob'));

  assert.equal(alice.axes.narrowest?.axis, 'user');
  await createNote(alice, '/memories/preferences.md', 'alice likes tables');

  assert.equal(await bob.store.fileExists('/memories/preferences.md'), false);
  assert.equal(await alice.store.readFile('/memories/preferences.md'), 'alice likes tables');
});

test('a context turn still reaches the shared core namespace', async () => {
  const { root, binder } = fixture();
  await root.createFile('/memories/core/brand.md', 'shared');

  const a = binder.forOrigin(teamsChannel('19:chan-a@thread.tacv2', 'team-a'));
  assert.equal(await a.store.readFile('/memories/core/brand.md'), 'shared');
});

/** The team-tier key granted to a binding, read back off its compiled scope. */
function teamKeyOf(bound: BoundTurnMemory): string {
  for (const p of bound.scope) {
    const m = /^team:([^:]+):\*$/.exec(p);
    if (m) return m[1]!;
  }
  assert.fail(`binding has no team axis: ${bound.scope.join(', ')}`);
}
