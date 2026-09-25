/**
 * #909 — `ctx.tools.invoke('memory', …)` must run inside the CALLER's own
 * memory scope, never against the memory provider's root-bound handler.
 *
 * Production shape reproduced here: the `memory` entry in the
 * `NativeToolRegistry` is a `MemoryToolHandler` bound to the undecorated root
 * `MemoryStore` (see `harness-memory/src/plugin.ts`). Before the fix,
 * `invoke` dispatched straight to it, so any tool-kind plugin — with or
 * without `permissions.memory` — could read and write every Agent's tree.
 */

import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { InMemoryMemoryStore, MemoryToolHandler } from '@omadia/memory';
import { turnContext } from '@omadia/orchestrator';

import type { Plugin } from '../src/api/admin-v1.js';
import type {
  PluginCatalog,
  PluginCatalogEntry,
} from '../src/plugins/manifestLoader.js';
import { ServiceRegistry } from '../src/platform/serviceRegistry.js';
import { createPluginContext } from '../src/platform/pluginContext.js';

type CtxOpts = Parameters<typeof createPluginContext>[0];

const PLUGIN_ID = 'caller';
const SECRET_PATH = '/memories/orchestrators/other-agent/secret.md';
const SECRET = 'TOP-SECRET-OTHER-AGENT';

interface Harness {
  readonly ctx: ReturnType<typeof createPluginContext>;
  readonly rootStore: InMemoryMemoryStore;
  /** Every input the registry's root-bound `memory` handler received. */
  readonly registryMemoryCalls: unknown[];
  /** Every input the registry's `dynamics_fetchxml` handler received. */
  readonly registryOtherCalls: unknown[];
}

function makeCatalog(memoryPermission: boolean): PluginCatalog {
  const plugin = {
    id: PLUGIN_ID,
    kind: 'integration',
    name: PLUGIN_ID,
    version: '0.1.0',
    domain: 'test',
    setup_fields: [],
    permissions_summary: {
      memory_reads: [],
      memory_writes: [],
      graph_reads: [],
      graph_writes: [],
      network_outbound: [],
    },
    depends_on: [],
    provides: [],
    requires: [],
  } as unknown as Plugin;
  const manifest = memoryPermission
    ? {
        permissions: {
          memory: {
            reads: [`agent:${PLUGIN_ID}:*`],
            writes: [`agent:${PLUGIN_ID}:*`],
          },
        },
      }
    : {};
  const entry = {
    plugin,
    manifest,
    source_path: '/abs/caller/manifest.yaml',
    source_kind: 'manifest-v1',
    origin: 'installed',
  } as unknown as PluginCatalogEntry;
  return {
    list: () => [entry],
    get: (id: string) => (id === PLUGIN_ID ? entry : undefined),
  } as unknown as PluginCatalog;
}

async function makeHarness(opts: {
  memoryPermission: boolean;
  publishStore?: boolean;
}): Promise<Harness> {
  const rootStore = new InMemoryMemoryStore();
  await rootStore.createFile(SECRET_PATH, SECRET);

  const registryMemoryCalls: unknown[] = [];
  const registryOtherCalls: unknown[] = [];
  const rootHandler = new MemoryToolHandler(rootStore);
  const entries = new Map<string, { handler: (input: unknown) => Promise<string> }>([
    [
      'memory',
      {
        handler: (input) => {
          registryMemoryCalls.push(input);
          return rootHandler.handle(input);
        },
      },
    ],
    [
      'dynamics_fetchxml',
      {
        handler: async (input) => {
          registryOtherCalls.push(input);
          return 'fetchxml-result';
        },
      },
    ],
  ]);
  const nativeToolRegistry = {
    register: () => () => {},
    registerHandler: () => () => {},
    get: (name: string) => entries.get(name),
  } as unknown as CtxOpts['nativeToolRegistry'];

  const serviceRegistry = new ServiceRegistry();
  if (opts.publishStore !== false) {
    serviceRegistry.provide('memoryStore', rootStore, '@omadia/memory');
  }

  const ctx = createPluginContext({
    agentId: PLUGIN_ID,
    vault: {
      get: async () => undefined,
      listKeys: async () => [],
    } as unknown as CtxOpts['vault'],
    registry: {
      has: () => true,
      list: () => [],
      get: () => ({ config: {} }),
    } as unknown as CtxOpts['registry'],
    catalog: makeCatalog(opts.memoryPermission),
    serviceRegistry,
    nativeToolRegistry,
    routeRegistry: {
      register: () => () => {},
      disposeBySource: () => 0,
    } as unknown as CtxOpts['routeRegistry'],
    jobScheduler: {
      register: () => () => {},
      stopForPlugin: () => {},
    } as unknown as CtxOpts['jobScheduler'],
    // Not exercised by `tools.invoke`; present only to satisfy the options type.
    notificationRouter: {} as unknown as CtxOpts['notificationRouter'],
    uiRouteCatalog: {} as unknown as CtxOpts['uiRouteCatalog'],
    logger: () => {},
  });
  return { ctx, rootStore, registryMemoryCalls, registryOtherCalls };
}

function invoke(h: Harness, name: string, input: unknown): Promise<string> {
  const fn = h.ctx.tools.invoke;
  assert.ok(fn, 'ctx.tools.invoke must be present');
  return fn(name, input);
}

function inTurn<T>(agentSlug: string, fn: () => Promise<T>): Promise<T> {
  return turnContext.run(
    { turnId: 't-909', turnDate: '2026-09-24', agentSlug },
    fn,
  );
}

describe('#909 — plugin WITHOUT permissions.memory', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness({ memoryPermission: false });
  });

  it('cannot read another agent\'s subtree through invoke', async () => {
    await assert.rejects(
      () => invoke(h, 'memory', { command: 'view', path: SECRET_PATH }),
      (err: Error) => {
        assert.equal(err.name, 'ToolInvokePermissionError');
        assert.match(err.message, /plugin 'caller'/);
        assert.match(err.message, /permissions\.memory/);
        assert.doesNotMatch(err.message, new RegExp(SECRET));
        return true;
      },
    );
    assert.equal(h.registryMemoryCalls.length, 0);
  });

  it('cannot create files through invoke', async () => {
    await assert.rejects(
      () =>
        invoke(h, 'memory', {
          command: 'create',
          path: '/memories/x.md',
          file_text: 'planted',
        }),
      /permissions\.memory/,
    );
    assert.equal(h.registryMemoryCalls.length, 0);
    assert.equal(await h.rootStore.fileExists('/memories/x.md'), false);
    const all = await h.rootStore.list('/memories');
    assert.ok(
      all.every((e) => !e.virtualPath.endsWith('/x.md')),
      'no new file may appear anywhere in the root store',
    );
  });
});

describe('#909 — plugin WITH permissions.memory', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness({ memoryPermission: true });
  });

  it('never sees another agent\'s file — the path is resolved in its own scope', async () => {
    const out = await invoke(h, 'memory', { command: 'view', path: SECRET_PATH });
    assert.doesNotMatch(out, new RegExp(SECRET));
    assert.match(out, /does not exist/);
    assert.equal(h.registryMemoryCalls.length, 0);
  });

  it('viewing /memories lists only its own subtree', async () => {
    await invoke(h, 'memory', {
      command: 'create',
      path: '/memories/mine.md',
      file_text: 'own',
    });
    const out = await invoke(h, 'memory', { command: 'view', path: '/memories' });
    assert.match(out, /\/memories\/mine\.md/);
    assert.doesNotMatch(out, /other-agent/);
    assert.doesNotMatch(out, /orchestrators/);
    assert.equal(h.registryMemoryCalls.length, 0);
  });

  it('writes land in the per-agent plugin subtree, in parity with ctx.memory', async () => {
    const out = await inTurn('agent-a', () =>
      invoke(h, 'memory', {
        command: 'create',
        path: '/memories/notes.md',
        file_text: 'from-invoke',
      }),
    );
    assert.match(out, /File created at \/memories\/notes\.md/);
    assert.equal(
      await h.rootStore.readFile(
        `/memories/orchestrators/agent-a/plugins/${PLUGIN_ID}/notes.md`,
      ),
      'from-invoke',
    );
    assert.equal(await h.rootStore.fileExists('/memories/notes.md'), false);
    assert.ok(h.ctx.memory, 'ctx.memory must be present with the permission');
    const viaAccessor = await inTurn('agent-a', () =>
      h.ctx.memory!.readFile('notes.md'),
    );
    assert.equal(viaAccessor, 'from-invoke');
  });

  it('outside a turn, writes land under the default agent', async () => {
    await invoke(h, 'memory', {
      command: 'create',
      path: '/memories/outside.md',
      file_text: 'x',
    });
    assert.equal(
      await h.rootStore.fileExists(
        `/memories/orchestrators/default/plugins/${PLUGIN_ID}/outside.md`,
      ),
      true,
    );
  });

  it('a traversal path yields an error string and leaks nothing', async () => {
    const out = await invoke(h, 'memory', {
      command: 'view',
      path: '/memories/../orchestrators/other-agent/secret.md',
    });
    assert.match(out, /^Error:/);
    assert.doesNotMatch(out, new RegExp(SECRET));
  });

  it('legacy /memories/agents/<id>/ is readable under the default agent only', async () => {
    await h.rootStore.createFile(`/memories/agents/${PLUGIN_ID}/old.md`, 'legacy');
    const asDefault = await invoke(h, 'memory', {
      command: 'view',
      path: '/memories/old.md',
    });
    assert.match(asDefault, /legacy/);
    const asB = await inTurn('agent-b', () =>
      invoke(h, 'memory', { command: 'view', path: '/memories/old.md' }),
    );
    assert.doesNotMatch(asB, /legacy/);
    assert.match(asB, /does not exist/);
  });
});

describe('#909 — declared but no memory store published', () => {
  it('rejects as unavailable and never reaches the registry handler', async () => {
    const h = await makeHarness({ memoryPermission: true, publishStore: false });
    await assert.rejects(
      () => invoke(h, 'memory', { command: 'view', path: '/memories' }),
      /'memory' is unavailable/,
    );
    assert.equal(h.registryMemoryCalls.length, 0);
  });
});

describe('#909 — other tools keep the registry dispatch', () => {
  it('a non-memory tool still reaches its registry handler (canvas refresh)', async () => {
    const h = await makeHarness({ memoryPermission: false });
    const out = await invoke(h, 'dynamics_fetchxml', { fetchxml: '<fetch/>' });
    assert.equal(out, 'fetchxml-result');
    assert.deepEqual(h.registryOtherCalls, [{ fetchxml: '<fetch/>' }]);
  });

  it('an unknown tool keeps the exact error message', async () => {
    const h = await makeHarness({ memoryPermission: false });
    await assert.rejects(() => invoke(h, 'nope', {}), {
      message: "tools.invoke: 'nope' is unknown or handler-less",
    });
  });
});
