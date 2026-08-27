/**
 * W5 — chat-context memory ACL: scope grammar of `ScopedMemoryStore`.
 *
 * Covers the design spec (#870 §3) as implemented by #871:
 *
 *  1. Token matrix for `team:` / `channel:` / `user:` — exact root, child
 *     path, neighbour key, neighbour axis, neighbour agent and the legacy
 *     `/memories/orchestrators/…` tree, each for read and for write.
 *  2. The `ro:` access modifier — reads and filtered lists pass,
 *     write / create / delete / rename raise `MemoryScopeViolation`.
 *  3. Collision-freedom: `/memories/contexts/…` is a top-level segment of its
 *     own, so no legacy `orchestrator:<slug>:*` scope reaches a context tree
 *     and no context scope reaches the agent tree.
 *  4. Compatibility: unknown tokens stay soft-deny + warning, and
 *     `orchestratorMemoryScope` returns byte-identically what it did before.
 *
 * Pollution guard (known full-suite bug): every test builds its own
 * `InMemoryMemoryStore` + `ScopedMemoryStore` through `harness()`. There are
 * no module-level fixtures and no environment mutation.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryMemoryStore } from '@omadia/memory';

import {
  MemoryScopeViolation,
  orchestratorMemoryScope,
  ScopedMemoryStore,
} from '../packages/harness-orchestrator/src/registry/scopedMemoryStore.js';

const AGENT = 'alpha';
const OTHER_AGENT = 'beta';
const KEY = 'teams~ctx-1';
const OTHER_KEY = 'teams~ctx-2';

type ContextAxis = 'team' | 'channel' | 'user';
const AXES: readonly ContextAxis[] = ['team', 'channel', 'user'];

interface Warning {
  readonly msg: string;
  readonly fields?: Record<string, unknown>;
}

interface Harness {
  readonly root: InMemoryMemoryStore;
  readonly scoped: ScopedMemoryStore;
  readonly warnings: Warning[];
}

function harness(scope: readonly string[], agentSlug = AGENT): Harness {
  const root = new InMemoryMemoryStore();
  const warnings: Warning[] = [];
  const scoped = new ScopedMemoryStore({
    agentSlug,
    scope,
    inner: root,
    log: (msg, fields) => warnings.push({ msg, fields }),
  });
  return { root, scoped, warnings };
}

function contextRoot(
  axis: ContextAxis,
  ctxKey = KEY,
  agentSlug = AGENT,
): string {
  return `/memories/contexts/${agentSlug}/${axis}/${ctxKey}`;
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'));
}

/* ------------------------------------------------------------------ *
 * Read / write expectations, expressed against the public MemoryStore
 * surface — `allowedRead` / `allowedWrite` stay private by design.
 * ------------------------------------------------------------------ */

/**
 * `viaList` / `viaRename` are off for patterns whose grant does not extend to
 * the parent directory or to sibling names — an exact-path pattern such as
 * `/memories/exact.md` grants that one path and nothing else.
 */
interface AccessOptions {
  readonly viaList?: boolean;
  readonly viaRename?: boolean;
}

async function assertFileReadable(
  h: Harness,
  path: string,
  opts: AccessOptions = {},
): Promise<void> {
  await h.root.writeFile(path, 'payload');
  assert.equal(await h.scoped.fileExists(path), true, `fileExists ${path}`);
  assert.equal(await h.scoped.readFile(path), 'payload', `readFile ${path}`);
  if (opts.viaList === false) return;
  const entries = await h.scoped.list(parentOf(path));
  assert.ok(
    entries.some((e) => e.virtualPath === path),
    `list should surface ${path}`,
  );
}

async function assertFileNotReadable(h: Harness, path: string): Promise<void> {
  await h.root.writeFile(path, 'payload');
  assert.equal(await h.scoped.fileExists(path), false, `fileExists ${path}`);
  await assert.rejects(
    () => h.scoped.readFile(path),
    MemoryScopeViolation,
    `readFile ${path}`,
  );
  const entries = await h.scoped.list(parentOf(path));
  assert.equal(
    entries.some((e) => e.virtualPath === path),
    false,
    `list must not surface ${path}`,
  );
  // Soft denial never touches the underlying data.
  assert.equal(await h.root.readFile(path), 'payload');
}

async function assertFileWritable(
  h: Harness,
  path: string,
  opts: AccessOptions = {},
): Promise<void> {
  await h.scoped.writeFile(path, 'v1');
  assert.equal(await h.root.readFile(path), 'v1', `writeFile ${path}`);
  let last = path;
  if (opts.viaRename !== false) {
    await h.scoped.rename(path, `${path}.bak`);
    assert.equal(await h.root.readFile(`${path}.bak`), 'v1', `rename ${path}`);
    last = `${path}.bak`;
  }
  await h.scoped.delete(last);
  assert.equal(await h.root.fileExists(last), false, `delete ${path}`);
}

async function assertFileNotWritable(h: Harness, path: string): Promise<void> {
  await assert.rejects(
    () => h.scoped.writeFile(path, 'v1'),
    MemoryScopeViolation,
    `writeFile ${path}`,
  );
  await assert.rejects(
    () => h.scoped.createFile(path, 'v1'),
    MemoryScopeViolation,
    `createFile ${path}`,
  );
  await assert.rejects(
    () => h.scoped.delete(path),
    MemoryScopeViolation,
    `delete ${path}`,
  );
  await assert.rejects(
    () => h.scoped.rename(path, `${path}.bak`),
    MemoryScopeViolation,
    `rename ${path}`,
  );
}

async function assertRootAllowed(h: Harness, root: string): Promise<void> {
  await h.root.writeFile(`${root}/seed.md`, 'seed');
  assert.equal(await h.scoped.directoryExists(root), true, `dirExists ${root}`);
  assert.ok((await h.scoped.list(root)).length > 0, `list ${root}`);
  // A subtree delete is a write operation against the exact root path.
  await h.scoped.delete(root);
  assert.equal(await h.root.directoryExists(root), false, `delete ${root}`);
}

async function assertRootDenied(h: Harness, root: string): Promise<void> {
  await h.root.writeFile(`${root}/seed.md`, 'seed');
  assert.equal(await h.scoped.directoryExists(root), false, `dirExists ${root}`);
  assert.deepEqual(await h.scoped.list(root), [], `list ${root}`);
  await assert.rejects(
    () => h.scoped.delete(root),
    MemoryScopeViolation,
    `delete ${root}`,
  );
  assert.equal(await h.root.fileExists(`${root}/seed.md`), true);
}

/* ------------------------------------------------------------------ *
 * 1. Token matrix
 * ------------------------------------------------------------------ */

for (const axis of AXES) {
  const pattern = `${axis}:${KEY}:*`;
  const own = contextRoot(axis);
  const neighbourAxis: ContextAxis = axis === 'team' ? 'channel' : 'team';

  const denied: ReadonlyArray<readonly [string, string]> = [
    ['neighbour key', `${contextRoot(axis, OTHER_KEY)}/notes.md`],
    ['neighbour axis', `${contextRoot(neighbourAxis)}/notes.md`],
    ['neighbour agent', `${contextRoot(axis, KEY, OTHER_AGENT)}/notes.md`],
    ['legacy agent tree', `/memories/orchestrators/${AGENT}/notes.md`],
  ];

  test(`${pattern} — exact root is readable and writable`, async () => {
    await assertRootAllowed(harness([pattern]), own);
  });

  test(`${pattern} — child paths are readable and writable`, async () => {
    for (const child of [`${own}/notes.md`, `${own}/sub/deep/notes.md`]) {
      await assertFileReadable(harness([pattern]), child);
      await assertFileWritable(harness([pattern]), child);
    }
  });

  for (const [label, path] of denied) {
    test(`${pattern} — ${label} is soft-denied for reads`, async () => {
      await assertFileNotReadable(harness([pattern]), path);
    });

    test(`${pattern} — ${label} raises a violation on writes`, async () => {
      await assertFileNotWritable(harness([pattern]), path);
    });
  }

  test(`${pattern} — neighbour roots are denied wholesale`, async () => {
    await assertRootDenied(harness([pattern]), contextRoot(axis, OTHER_KEY));
    await assertRootDenied(harness([pattern]), contextRoot(neighbourAxis));
    await assertRootDenied(
      harness([pattern]),
      contextRoot(axis, KEY, OTHER_AGENT),
    );
  });

  test(`${pattern} — a sibling key sharing a prefix is not matched`, async () => {
    // `teams~ctx-1` must not unlock `teams~ctx-10`: the compiled prefix ends
    // in a path separator.
    const sibling = `${contextRoot(axis, `${KEY}0`)}/notes.md`;
    await assertFileNotReadable(harness([pattern]), sibling);
    await assertFileNotWritable(harness([pattern]), sibling);
  });
}

test('context tokens are bound to the store’s own agent slug', async () => {
  // The very same pattern resolves to a different physical tree per agent —
  // a context key alone can never address another agent's memory.
  const mine = harness([`team:${KEY}:*`], AGENT);
  await assertFileReadable(mine, `${contextRoot('team', KEY, AGENT)}/n.md`);

  const theirs = harness([`team:${KEY}:*`], OTHER_AGENT);
  await assertFileNotReadable(
    theirs,
    `${contextRoot('team', KEY, AGENT)}/n.md`,
  );
  await assertFileReadable(
    harness([`team:${KEY}:*`], OTHER_AGENT),
    `${contextRoot('team', KEY, OTHER_AGENT)}/n.md`,
  );
});

/* ------------------------------------------------------------------ *
 * 2. `ro:` access modifier
 * ------------------------------------------------------------------ */

test('ro: grants reads on the legacy agent tree', async () => {
  const path = `/memories/orchestrators/${AGENT}/notes.md`;
  await assertFileReadable(harness([`ro:orchestrator:${AGENT}:*`]), path);
});

test('ro: refuses every write on the legacy agent tree', async () => {
  const h = harness([`ro:orchestrator:${AGENT}:*`]);
  const path = `/memories/orchestrators/${AGENT}/notes.md`;
  await h.root.writeFile(path, 'existing');
  await assertFileNotWritable(h, path);
  assert.equal(await h.root.readFile(path), 'existing');
});

test('ro: applies to context tokens as well', async () => {
  const path = `${contextRoot('team')}/notes.md`;
  await assertFileReadable(harness([`ro:team:${KEY}:*`]), path);
  const h = harness([`ro:team:${KEY}:*`]);
  await h.root.writeFile(path, 'existing');
  await assertFileNotWritable(h, path);
});

test('ro: still filters list output to the readable subset', async () => {
  const dir = `/memories/orchestrators/${AGENT}`;
  const h = harness([`ro:${dir}`, `ro:${dir}/keep.md`]);
  await h.root.writeFile(`${dir}/keep.md`, 'keep');
  await h.root.writeFile(`${dir}/drop.md`, 'drop');
  const entries = await h.scoped.list(dir);
  assert.deepEqual(
    entries.filter((e) => !e.isDirectory).map((e) => e.virtualPath),
    [`${dir}/keep.md`],
  );
});

test('a read-only tier combines with a writable context tier', async () => {
  const agentPath = `/memories/orchestrators/${AGENT}/legacy.md`;
  const ctxPath = `${contextRoot('channel')}/notes.md`;
  const h = harness([
    'core',
    `ro:orchestrator:${AGENT}:*`,
    `channel:${KEY}:*`,
  ]);
  await h.root.writeFile(agentPath, 'legacy');

  assert.equal(await h.scoped.readFile(agentPath), 'legacy');
  await assert.rejects(
    () => h.scoped.writeFile(agentPath, 'mutated'),
    MemoryScopeViolation,
  );

  await h.scoped.writeFile(ctxPath, 'fresh');
  assert.equal(await h.root.readFile(ctxPath), 'fresh');
});

test('rename across the read-only boundary is refused in both directions', async () => {
  const agentPath = `/memories/orchestrators/${AGENT}/legacy.md`;
  const ctxPath = `${contextRoot('channel')}/promoted.md`;
  const h = harness([`ro:orchestrator:${AGENT}:*`, `channel:${KEY}:*`]);
  await h.root.writeFile(agentPath, 'legacy');
  await h.root.writeFile(ctxPath, 'fresh');

  await assert.rejects(
    () => h.scoped.rename(agentPath, ctxPath.replace('.md', '-2.md')),
    MemoryScopeViolation,
  );
  await assert.rejects(
    () => h.scoped.rename(ctxPath, agentPath.replace('.md', '-2.md')),
    MemoryScopeViolation,
  );
});

test('nested ro: is not a pattern — soft-deny plus warning', async () => {
  const h = harness([`ro:ro:orchestrator:${AGENT}:*`]);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0]!.msg, /unknown scope pattern/);
  await assertFileNotReadable(h, `/memories/orchestrators/${AGENT}/notes.md`);
});

/* ------------------------------------------------------------------ *
 * 3. Collision-freedom between the two trees
 * ------------------------------------------------------------------ */

test('a legacy agent scope reaches no context tree', async () => {
  for (const axis of AXES) {
    const h = harness(orchestratorMemoryScope(AGENT));
    await assertFileNotReadable(h, `${contextRoot(axis)}/notes.md`);
    await assertFileNotWritable(h, `${contextRoot(axis)}/notes.md`);
  }
  const h = harness(orchestratorMemoryScope(AGENT));
  await assertRootDenied(h, `/memories/contexts/${AGENT}`);
});

test('a context scope reaches neither the agent tree nor foreign contexts', async () => {
  const h = harness([
    `team:${KEY}:*`,
    `channel:${KEY}:*`,
    `user:${KEY}:*`,
  ]);
  await assertFileNotReadable(h, `/memories/orchestrators/${AGENT}/notes.md`);
  await assertFileNotWritable(h, `/memories/orchestrators/${AGENT}/notes.md`);
  await assertRootDenied(
    harness([`team:${KEY}:*`]),
    `/memories/orchestrators/${AGENT}`,
  );
});

test('the contexts root itself is never granted by a tier token', async () => {
  const h = harness([`team:${KEY}:*`]);
  await assertRootDenied(h, `/memories/contexts/${AGENT}/team`);
});

/* ------------------------------------------------------------------ *
 * 4. Compatibility of the pre-existing grammar
 * ------------------------------------------------------------------ */

test('orchestratorMemoryScope is byte-identical to the legacy contract', () => {
  assert.deepEqual(orchestratorMemoryScope(AGENT), [
    'core',
    `orchestrator:${AGENT}:*`,
  ]);
  assert.deepEqual(orchestratorMemoryScope('svc-1'), [
    'core',
    'orchestrator:svc-1:*',
  ]);
});

test('legacy tokens keep their exact meaning', async () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['core', '/memories/core/brand.md'],
    ['core', '/memories/sessions/s1/turn.md'],
    ['core', '/memories/chat-sessions/c1/turn.md'],
    ['core', '/memories/_rules/hr.md'],
    ['agent:hr:*', '/memories/agents/hr/notes.md'],
    [`orchestrator:${AGENT}:*`, `/memories/orchestrators/${AGENT}/notes.md`],
    ['session:*', '/memories/sessions/s1/turn.md'],
    ['/memories/prefixed/*', '/memories/prefixed/deep/notes.md'],
  ];
  for (const [pattern, path] of cases) {
    await assertFileReadable(harness([pattern]), path);
    await assertFileWritable(harness([pattern]), path);
  }
});

test('an exact-path token grants that path and nothing around it', async () => {
  const exact = '/memories/exact.md';
  const opts = { viaList: false, viaRename: false };
  await assertFileReadable(harness([exact]), exact, opts);
  await assertFileWritable(harness([exact]), exact, opts);

  const h = harness([exact]);
  await assertFileNotReadable(h, '/memories/exact.md.bak');
  await assertFileNotWritable(h, '/memories/exact.md.bak');
});

test('an unknown token stays soft-deny and is warned about', async () => {
  const h = harness(['team:has:colons:*', 'nonsense']);
  assert.equal(h.warnings.length, 2);
  for (const w of h.warnings) {
    assert.match(w.msg, /unknown scope pattern/);
    assert.equal(w.fields?.agentSlug, AGENT);
  }
  assert.deepEqual(
    h.warnings.map((w) => w.fields?.pattern),
    ['team:has:colons:*', 'nonsense'],
  );
  // A context key carrying a `:` cannot be spelled — so it can never widen
  // the grammar by accident.
  await assertFileNotReadable(
    h,
    `/memories/contexts/${AGENT}/team/has:colons/notes.md`,
  );
  await assertRootDenied(h, `/memories/contexts/${AGENT}`);
});

test('an empty scope denies everything', async () => {
  const h = harness([]);
  assert.equal(h.warnings.length, 0);
  await assertFileNotReadable(h, `${contextRoot('team')}/notes.md`);
  await assertFileNotWritable(h, `/memories/core/brand.md`);
});
