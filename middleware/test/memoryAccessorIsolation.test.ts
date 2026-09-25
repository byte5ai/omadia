/**
 * Per-orchestrator plugin-memory isolation (`createMemoryAccessor`).
 *
 * The SAME plugin invoked under two different Agents must write to two
 * disjoint trees (`/memories/orchestrators/<slug>/plugins/<pluginId>/`), so
 * Orchestrator A never sees Orchestrator B's plugin memory — even for a
 * plugin both Agents enable. Legacy `/memories/agents/<pluginId>/` data stays
 * readable for the default Agent only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryMemoryStore } from '@omadia/memory';

import { MemoryPathError } from '@omadia/plugin-api';

import {
  createMemoryAccessor,
  createPluginMemoryToolStore,
} from '../src/platform/memoryAccessor.js';

function freshStore(): InMemoryMemoryStore {
  return new InMemoryMemoryStore();
}

test('same plugin under two Agents writes to disjoint trees', async () => {
  const store = freshStore();
  let slug = 'agent-a';
  const acc = createMemoryAccessor({
    pluginId: 'p',
    store,
    resolveAgentSlug: () => slug,
  });

  await acc.writeFile('notes.md', 'A-secret');
  slug = 'agent-b';
  // Agent B does not see Agent A's note at the same relative path.
  assert.equal(await acc.exists('notes.md'), false);
  await acc.writeFile('notes.md', 'B-secret');

  // Physically disjoint.
  assert.equal(
    await store.readFile('/memories/orchestrators/agent-a/plugins/p/notes.md'),
    'A-secret',
  );
  assert.equal(
    await store.readFile('/memories/orchestrators/agent-b/plugins/p/notes.md'),
    'B-secret',
  );

  // Back to A — still sees only its own.
  slug = 'agent-a';
  assert.equal(await acc.readFile('notes.md'), 'A-secret');
});

test('legacy /memories/agents/<plugin>/ data is read-through for default only', async () => {
  const store = freshStore();
  await store.writeFile('/memories/agents/p/old.md', 'legacy');

  let slug = 'default';
  const acc = createMemoryAccessor({
    pluginId: 'p',
    store,
    resolveAgentSlug: () => slug,
  });
  // Default Agent reads pre-isolation data.
  assert.equal(await acc.exists('old.md'), true);
  assert.equal(await acc.readFile('old.md'), 'legacy');

  // A non-default Agent does NOT get the legacy read-through.
  slug = 'agent-b';
  assert.equal(await acc.exists('old.md'), false);
  await assert.rejects(() => acc.readFile('old.md'));
});

test('outside a turn the accessor falls back to the default Agent tree', async () => {
  const store = freshStore();
  const acc = createMemoryAccessor({
    pluginId: 'p',
    store,
    resolveAgentSlug: () => undefined, // no turn context
  });
  await acc.writeFile('boot.md', 'x');
  assert.equal(
    await store.readFile('/memories/orchestrators/default/plugins/p/boot.md'),
    'x',
  );
});

// ---------------------------------------------------------------------------
// #909 — `createPluginMemoryToolStore`: the `/memories`-rooted view that
// `ctx.tools.invoke('memory', …)` runs the memory tool against. It shares
// `pluginMemoryScope` with `createMemoryAccessor`, so the assertions below
// pin the same physical layout the accessor tests above do.
// ---------------------------------------------------------------------------

const SCOPE_A = '/memories/orchestrators/agent-a/plugins/p';

test('tool store: /memories/* maps into the plugin scope', async () => {
  const store = freshStore();
  const view = createPluginMemoryToolStore({
    pluginId: 'p',
    store,
    resolveAgentSlug: () => 'agent-a',
  });
  await view.createFile('/memories/sub/a.md', 'A');
  assert.equal(await store.readFile(`${SCOPE_A}/sub/a.md`), 'A');
  assert.equal(await view.readFile('/memories/sub/a.md'), 'A');
  assert.equal(await view.readFile('/memories//sub/a.md/'), 'A');
  assert.equal(await store.fileExists('/memories/sub/a.md'), false);
  // The scope root always exists, even before anything was written.
  const empty = createPluginMemoryToolStore({ pluginId: 'q', store });
  assert.equal(await empty.directoryExists('/memories'), true);
  assert.deepEqual(await empty.list('/memories'), []);
});

test('tool store: non-/memories and traversal paths throw MemoryPathError', async () => {
  const store = freshStore();
  await store.createFile('/memories/orchestrators/other/secret.md', 'S');
  const view = createPluginMemoryToolStore({ pluginId: 'p', store });
  for (const bad of [
    '/etc/passwd',
    '/memoriesX/a.md',
    'memories/a.md',
    '/memories/../orchestrators/other/secret.md',
    '/memories/a/../../orchestrators/other/secret.md',
    '/memories/a\u0000.md',
  ]) {
    await assert.rejects(() => view.readFile(bad), MemoryPathError, bad);
    await assert.rejects(() => view.createFile(bad, 'x'), MemoryPathError, bad);
  }
});

test('tool store: list maps entries back to /memories/...', async () => {
  const store = freshStore();
  await store.createFile(`${SCOPE_A}/one.md`, '1');
  await store.createFile(`${SCOPE_A}/dir/two.md`, '22');
  await store.createFile('/memories/orchestrators/agent-a/secret.md', 'S');
  const view = createPluginMemoryToolStore({
    pluginId: 'p',
    store,
    resolveAgentSlug: () => 'agent-a',
  });
  const paths = (await view.list('/memories')).map((e) => e.virtualPath);
  assert.ok(paths.includes('/memories/one.md'));
  assert.ok(paths.includes('/memories/dir'));
  assert.ok(paths.includes('/memories/dir/two.md'));
  assert.ok(paths.every((p) => p === '/memories' || p.startsWith('/memories/')));
  assert.ok(
    paths.every((p) => !p.includes('orchestrators') && !p.includes('secret')),
  );
});

test('tool store: rename stays inside the scope', async () => {
  const store = freshStore();
  const view = createPluginMemoryToolStore({
    pluginId: 'p',
    store,
    resolveAgentSlug: () => 'agent-a',
  });
  await view.createFile('/memories/from.md', 'x');
  await view.rename('/memories/from.md', '/memories/moved/to.md');
  assert.equal(await store.readFile(`${SCOPE_A}/moved/to.md`), 'x');
  assert.equal(await store.fileExists(`${SCOPE_A}/from.md`), false);
  await assert.rejects(
    () => view.rename('/memories/moved/to.md', '/memories/../escaped.md'),
    MemoryPathError,
  );
  await assert.rejects(
    () => view.rename('/memories/moved/to.md', '/tmp/escaped.md'),
    MemoryPathError,
  );
  assert.equal(await store.readFile(`${SCOPE_A}/moved/to.md`), 'x');
});

test('tool store: legacy tree is a read-only fallback for the default Agent', async () => {
  const store = freshStore();
  await store.createFile('/memories/agents/p/old.md', 'legacy');
  let slug: string | undefined;
  const view = createPluginMemoryToolStore({
    pluginId: 'p',
    store,
    resolveAgentSlug: () => slug,
  });
  // Default Agent (no turn) reads through to the legacy tree…
  assert.equal(await view.fileExists('/memories/old.md'), true);
  assert.equal(await view.readFile('/memories/old.md'), 'legacy');
  // (The store's 2-level walk includes the listed directory itself.)
  assert.deepEqual(
    (await view.list('/memories')).map((e) => e.virtualPath),
    ['/memories', '/memories/old.md'],
  );
  // …but writes land in the primary prefix, never in the legacy tree.
  await view.writeFile('/memories/old.md', 'new');
  assert.equal(
    await store.readFile('/memories/orchestrators/default/plugins/p/old.md'),
    'new',
  );
  assert.equal(await store.readFile('/memories/agents/p/old.md'), 'legacy');
  // A non-default Agent gets no fallback at all.
  slug = 'agent-b';
  assert.equal(await view.fileExists('/memories/old.md'), false);
  await assert.rejects(() => view.readFile('/memories/old.md'));
});

test('tool store and ctx.memory resolve the same scope', async () => {
  const store = freshStore();
  let slug = 'agent-a';
  const resolveAgentSlug = (): string => slug;
  const view = createPluginMemoryToolStore({
    pluginId: 'p',
    store,
    resolveAgentSlug,
  });
  const acc = createMemoryAccessor({ pluginId: 'p', store, resolveAgentSlug });
  await view.createFile('/memories/shared.md', 'via-tool');
  assert.equal(await acc.readFile('shared.md'), 'via-tool');
  slug = 'agent-b';
  assert.equal(await acc.exists('shared.md'), false);
  assert.equal(await view.fileExists('/memories/shared.md'), false);
});
