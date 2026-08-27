/**
 * `ContextMemoryNamespacer` — the per-context variant of the orchestrator
 * memory bijection. The model still only ever sees `/memories/...`, but the
 * bare root is physically backed by the NARROWEST tier of the turn
 * (`/memories/contexts/<slug>/channel/<key>` or `.../user/<key>`), while two
 * reserved model-facing segments address the wider tiers:
 *
 *   /memories/~team/...  → /memories/contexts/<slug>/team/<teamKey>/...
 *   /memories/~agent/... → /memories/orchestrators/<slug>/...
 *
 * Shared namespaces (`core`, `sessions`, `chat-sessions`, `_*`) pass through
 * untouched, and `list` never emits a physical `contexts/...` path.
 *
 * Pollution guard: every test builds its own `InMemoryMemoryStore` — no
 * module-level fixtures, no store shared between tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryMemoryStore } from '@omadia/memory';

import {
  ContextMemoryNamespacer,
  OrchestratorMemoryNamespacer,
} from '../packages/harness-orchestrator/src/orchestratorMemoryNamespacer.js';

const SLUG = 'public';
const CHANNEL_KEY = 'teams~19-abc-thread-tacv2-a1b2c3d4e5f60718';
const TEAM_KEY = 'teams~team-a-0011223344556677';

const AGENT_ROOT = `/memories/orchestrators/${SLUG}`;
const CHANNEL_ROOT = `/memories/contexts/${SLUG}/channel/${CHANNEL_KEY}`;
const TEAM_ROOT = `/memories/contexts/${SLUG}/team/${TEAM_KEY}`;
const USER_ROOT = `/memories/contexts/${SLUG}/user/teams~aad-1234`;

/** Full context turn: channel tier narrowest, team + agent tiers reachable. */
function channelTurn(): {
  store: InMemoryMemoryStore;
  nsr: ContextMemoryNamespacer;
} {
  const store = new InMemoryMemoryStore();
  const nsr = new ContextMemoryNamespacer(
    { privateRoot: CHANNEL_ROOT, teamRoot: TEAM_ROOT, agentRoot: AGENT_ROOT },
    store,
  );
  return { store, nsr };
}

/** Personal chat: user tier narrowest, no team axis. */
function personalTurn(): {
  store: InMemoryMemoryStore;
  nsr: ContextMemoryNamespacer;
} {
  const store = new InMemoryMemoryStore();
  const nsr = new ContextMemoryNamespacer(
    { privateRoot: USER_ROOT, agentRoot: AGENT_ROOT },
    store,
  );
  return { store, nsr };
}

test('bare /memories writes land in the narrowest (channel) tier', async () => {
  const { store, nsr } = channelTurn();
  await nsr.createFile('/memories/notes.md', 'hi');
  assert.equal(await store.readFile(`${CHANNEL_ROOT}/notes.md`), 'hi');
  // The model still addresses it at the un-namespaced path.
  assert.equal(await nsr.readFile('/memories/notes.md'), 'hi');
  assert.equal(await nsr.fileExists('/memories/notes.md'), true);
});

test('the user tier behaves exactly like the channel tier', async () => {
  const { store, nsr } = personalTurn();
  await nsr.writeFile('/memories/prefs.md', 'dark-mode');
  assert.equal(await store.readFile(`${USER_ROOT}/prefs.md`), 'dark-mode');
  assert.equal(await nsr.readFile('/memories/prefs.md'), 'dark-mode');
});

test('/memories/~team maps to the team tier when a team axis exists', async () => {
  const { store, nsr } = channelTurn();
  await nsr.createFile('/memories/~team/glossary.md', 'team-wide');
  assert.equal(await store.readFile(`${TEAM_ROOT}/glossary.md`), 'team-wide');
  assert.equal(await nsr.readFile('/memories/~team/glossary.md'), 'team-wide');
  // The channel tier is untouched by a `~team` write.
  assert.equal(await store.fileExists(`${CHANNEL_ROOT}/glossary.md`), false);
});

test('/memories/~agent maps to the agent tier (mapper does not enforce ro)', async () => {
  const { store, nsr } = channelTurn();
  await store.writeFile(`${AGENT_ROOT}/legacy.md`, 'old-knowledge');
  assert.equal(
    await nsr.readFile('/memories/~agent/legacy.md'),
    'old-knowledge',
  );
  assert.equal(await nsr.fileExists('/memories/~agent/legacy.md'), true);
  // Read-only is the ScopedMemoryStore's job — the mapper only rewrites.
  await nsr.writeFile('/memories/~agent/written.md', 'x');
  assert.equal(await store.readFile(`${AGENT_ROOT}/written.md`), 'x');
});

test('a reserved root is addressable bare and round-trips through list', async () => {
  const { nsr } = channelTurn();
  await nsr.createFile('/memories/~team/a.md', '1');
  const paths = (await nsr.list('/memories/~team'))
    .map((e) => e.virtualPath)
    .sort();
  assert.deepEqual(paths, ['/memories/~team', '/memories/~team/a.md']);
});

test('an unbound ~team stays outside every context root (fail-closed)', async () => {
  const { store, nsr } = personalTurn();
  await nsr.writeFile('/memories/~team/leak.md', 'nope');
  // NOT silently redirected into the private tier — it stays at the outer
  // path, where no compiled pattern matches it and the ScopedMemoryStore
  // (layered underneath in production) raises a MemoryScopeViolation.
  assert.equal(await store.readFile('/memories/~team/leak.md'), 'nope');
  assert.equal(await store.fileExists(`${USER_ROOT}/~team/leak.md`), false);
});

test('shared namespaces (core, _rules, chat-sessions) pass through', async () => {
  const { store, nsr } = channelTurn();
  await nsr.writeFile('/memories/core/rules.md', 'shared');
  await nsr.writeFile('/memories/_rules/durable.md', 'rules');
  await nsr.writeFile('/memories/chat-sessions/s1.md', 'transcript');
  // Physically NOT under any context tree.
  assert.equal(await store.readFile('/memories/core/rules.md'), 'shared');
  assert.equal(await store.readFile('/memories/_rules/durable.md'), 'rules');
  assert.equal(
    await store.readFile('/memories/chat-sessions/s1.md'),
    'transcript',
  );
  // …and readable back through the mapper at the same outer path.
  assert.equal(await nsr.readFile('/memories/core/rules.md'), 'shared');
  assert.equal(await nsr.readFile('/memories/_rules/durable.md'), 'rules');
});

test('toInner/toOuter round-trip for every model-facing prefix', async () => {
  const { store, nsr } = channelTurn();
  const outerPaths = [
    '/memories/notes.md',
    '/memories/sub/deep.md',
    '/memories/~team/glossary.md',
    '/memories/~agent/legacy.md',
    '/memories/core/rules.md',
    '/memories/_rules/durable.md',
  ];
  for (const [i, p] of outerPaths.entries()) {
    await nsr.writeFile(p, `v${i}`);
  }
  // Every write reads back at exactly the path it was written to…
  for (const [i, p] of outerPaths.entries()) {
    assert.equal(await nsr.readFile(p), `v${i}`);
  }
  // …and each outer prefix has its own distinct physical home (injective).
  const expected = [
    `${CHANNEL_ROOT}/notes.md`,
    `${CHANNEL_ROOT}/sub/deep.md`,
    `${TEAM_ROOT}/glossary.md`,
    `${AGENT_ROOT}/legacy.md`,
    '/memories/core/rules.md',
    '/memories/_rules/durable.md',
  ];
  assert.deepEqual((await collectFiles(store)).sort(), expected.sort());
});

test('list never emits a physical contexts/... path', async () => {
  const { nsr } = channelTurn();
  await nsr.createFile('/memories/a.md', '1');
  await nsr.createFile('/memories/sub/b.md', '2');
  const paths = (await nsr.list('/memories')).map((e) => e.virtualPath).sort();
  assert.ok(paths.every((p) => p === '/memories' || p.startsWith('/memories/')));
  assert.ok(!paths.some((p) => p.includes('/contexts/')));
  assert.ok(!paths.some((p) => p.includes('/orchestrators/')));
  assert.ok(paths.includes('/memories/a.md'));
  assert.ok(paths.includes('/memories/sub'));
});

test('list of the agent tier round-trips through the ~agent prefix', async () => {
  const { store, nsr } = channelTurn();
  await store.writeFile(`${AGENT_ROOT}/legacy.md`, 'old');
  const paths = (await nsr.list('/memories/~agent'))
    .map((e) => e.virtualPath)
    .sort();
  assert.deepEqual(paths, ['/memories/~agent', '/memories/~agent/legacy.md']);
});

test('two contexts of one agent do not collide at the same model path', async () => {
  const store = new InMemoryMemoryStore();
  const teamA = new ContextMemoryNamespacer(
    { privateRoot: `/memories/contexts/${SLUG}/team/teams~a` },
    store,
  );
  const teamB = new ContextMemoryNamespacer(
    { privateRoot: `/memories/contexts/${SLUG}/team/teams~b` },
    store,
  );
  await teamA.createFile('/memories/secret.md', 'from-a');
  await teamB.createFile('/memories/secret.md', 'from-b');
  assert.equal(await teamA.readFile('/memories/secret.md'), 'from-a');
  assert.equal(await teamB.readFile('/memories/secret.md'), 'from-b');
});

test('context-free construction reproduces the legacy namespacer exactly', async () => {
  const legacyStore = new InMemoryMemoryStore();
  const legacy = new OrchestratorMemoryNamespacer(SLUG, legacyStore);
  const ctxStore = new InMemoryMemoryStore();
  // No team/agent root → no reserved segment is bound, so every path behaves
  // like today: privatized into the Agent tree, shared segments pass through.
  const ctx = new ContextMemoryNamespacer({ privateRoot: AGENT_ROOT }, ctxStore);

  for (const p of ['/memories/notes.md', '/memories/core/rules.md']) {
    await legacy.writeFile(p, 'v');
    await ctx.writeFile(p, 'v');
  }
  assert.deepEqual(
    (await collectFiles(ctxStore)).sort(),
    (await collectFiles(legacyStore)).sort(),
  );
  assert.deepEqual(
    (await ctx.list('/memories')).map((e) => e.virtualPath).sort(),
    (await legacy.list('/memories')).map((e) => e.virtualPath).sort(),
  );
});

test('rename maps both sides and can move across tiers', async () => {
  const { store, nsr } = channelTurn();
  await nsr.createFile('/memories/draft.md', 'body');
  await nsr.rename('/memories/draft.md', '/memories/~team/final.md');
  assert.equal(await store.readFile(`${TEAM_ROOT}/final.md`), 'body');
  assert.equal(await store.fileExists(`${CHANNEL_ROOT}/draft.md`), false);
});

test('delete and directoryExists go through the same mapping', async () => {
  const { store, nsr } = channelTurn();
  await nsr.createFile('/memories/~team/dir/x.md', '1');
  assert.equal(await nsr.directoryExists('/memories/~team/dir'), true);
  assert.equal(await nsr.directoryExists('/memories/dir'), false);
  await nsr.delete('/memories/~team/dir/x.md');
  assert.equal(await store.fileExists(`${TEAM_ROOT}/dir/x.md`), false);
});

/**
 * Enumerates every physical file path held by an in-memory store. `list`
 * walks two levels per call, so the overlapping walks are de-duplicated.
 */
async function collectFiles(store: InMemoryMemoryStore): Promise<string[]> {
  const files = new Set<string>();
  const visited = new Set<string>();
  const stack = ['/memories'];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined || visited.has(dir)) continue;
    visited.add(dir);
    for (const entry of await store.list(dir)) {
      if (entry.virtualPath === dir) continue;
      if (entry.isDirectory) stack.push(entry.virtualPath);
      else files.add(entry.virtualPath);
    }
  }
  return [...files];
}
