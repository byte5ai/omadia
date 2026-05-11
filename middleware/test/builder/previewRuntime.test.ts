import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import {
  PreviewRuntime,
  type PreviewAgentHandle,
  type PreviewPluginContext,
} from '../../src/plugins/builder/previewRuntime.js';
import { PreviewStore } from '../../src/plugins/builder/previewStore.js';

describe('PreviewRuntime', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'preview-runtime-test-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function freshRoot(name: string): string {
    const root = path.join(tmp, name);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    return root;
  }

  /** Test factory — bypasses zip extraction by writing a stub package.json
   *  directly into the preview dir. The activateModule override returns a
   *  pre-fabricated handle. */
  function buildRuntime(opts: {
    previewsRoot: string;
    handle?: PreviewAgentHandle;
    onActivate?: (ctx: PreviewPluginContext) => void;
    activateThrows?: Error;
  }): PreviewRuntime {
    return new PreviewRuntime({
      previewsRoot: opts.previewsRoot,
      logger: () => {},
      extractZip: async (_zipBuf, destDir) => {
        mkdirSync(destDir, { recursive: true });
        writeFileSync(
          path.join(destDir, 'package.json'),
          JSON.stringify({
            name: 'de.byte5.agent.test',
            version: '0.1.0',
            main: 'dist/index.js',
          }),
        );
        // Touch the entry path so default-activate's fs.access wouldn't fail
        // (we override activateModule anyway, so its existence isn't used).
        mkdirSync(path.join(destDir, 'dist'), { recursive: true });
        writeFileSync(path.join(destDir, 'dist', 'index.js'), '// stub\n');
      },
      activateModule: async (_entry, ctx) => {
        if (opts.activateThrows) throw opts.activateThrows;
        opts.onActivate?.(ctx);
        return (
          opts.handle ?? {
            toolkit: { tools: [] },
            close: async () => {},
          }
        );
      },
    });
  }

  beforeEach(() => {});

  describe('activate', () => {
    it('returns a PreviewHandle with toolkit + previewDir', async () => {
      const root = freshRoot('act-1');
      const runtime = buildRuntime({
        previewsRoot: root,
        handle: {
          toolkit: {
            tools: [
              {
                id: 'echo',
                description: 'echo',
                input: z.object({ msg: z.string() }) as z.ZodType<unknown>,
                run: async (raw) => ({ echoed: (raw as { msg: string }).msg }),
              },
            ],
          },
          close: async () => {},
        },
      });

      const handle = await runtime.activate({
        zipBuffer: Buffer.from('PK-stub'),
        draftId: 'd1',
        rev: 1,
        configValues: {},
        secretValues: {},
      });

      assert.equal(handle.draftId, 'd1');
      assert.equal(handle.agentId, 'de.byte5.agent.test');
      assert.equal(handle.rev, 1);
      assert.equal(handle.toolkit.tools.length, 1);
      assert.equal(handle.toolkit.tools[0]?.id, 'echo');
      assert.ok(existsSync(handle.previewDir));
    });

    it('runs a tool through the returned toolkit', async () => {
      const root = freshRoot('act-2');
      const runtime = buildRuntime({
        previewsRoot: root,
        handle: {
          toolkit: {
            tools: [
              {
                id: 'echo',
                description: 'echo',
                input: z.object({ msg: z.string() }) as z.ZodType<unknown>,
                run: async (raw) => ({ echoed: (raw as { msg: string }).msg }),
              },
            ],
          },
          close: async () => {},
        },
      });
      const handle = await runtime.activate({
        zipBuffer: Buffer.alloc(0),
        draftId: 'd1',
        rev: 1,
        configValues: {},
        secretValues: {},
      });
      const out = (await handle.toolkit.tools[0]!.run({ msg: 'hi' })) as {
        echoed: string;
      };
      assert.equal(out.echoed, 'hi');
    });

    it('passes config + secret values through the stub PluginContext', async () => {
      const root = freshRoot('ctx');
      let captured: PreviewPluginContext | undefined;
      const runtime = buildRuntime({
        previewsRoot: root,
        onActivate: (ctx) => {
          captured = ctx;
        },
      });
      await runtime.activate({
        zipBuffer: Buffer.alloc(0),
        draftId: 'd1',
        rev: 1,
        configValues: { base_url: 'https://api.example.com' },
        secretValues: { API_TOKEN: 's3cr3t' },
      });
      assert.ok(captured);
      assert.equal(captured!.agentId, 'de.byte5.agent.test');
      assert.equal(captured!.config.require<string>('base_url'), 'https://api.example.com');
      assert.equal(await captured!.secrets.require('API_TOKEN'), 's3cr3t');
      assert.equal(await captured!.secrets.get('NOT_SET'), undefined);
    });

    it('exposes ctx.routes.register as a no-op stub so admin-UI plugins do not crash on activate', async () => {
      const root = freshRoot('routes-noop');
      let captured: PreviewPluginContext | undefined;
      let activateThrew = false;
      const runtime = buildRuntime({
        previewsRoot: root,
        onActivate: (ctx) => {
          captured = ctx;
          // Mirror what an admin-UI plugin's activate-body does: call
          // ctx.routes.register with a prefix + router-shaped value. In
          // preview this must not throw and must return an unregister fn.
          try {
            const unregister = ctx.routes.register(
              '/api/de.byte5.agent.test/admin',
              { use: () => {} },
            );
            assert.equal(typeof unregister, 'function');
            // The returned unregister must itself be a no-op (no throw).
            unregister();
          } catch {
            activateThrew = true;
          }
        },
      });
      await runtime.activate({
        zipBuffer: Buffer.alloc(0),
        draftId: 'd1',
        rev: 1,
        configValues: {},
        secretValues: {},
      });
      assert.equal(activateThrew, false);
      assert.ok(captured);
      assert.equal(typeof captured!.routes.register, 'function');
    });

    it('exposes ctx.services as a no-op ServicesAccessor stub so external_reads plugins activate to a clean throw, not TypeError', async () => {
      // Theme A regression: previewRuntime previously had no `services`
      // field on its stub context, so codegen-emitted
      // `ctx.services.get<…>('odoo.client')` calls in plugins using
      // spec.external_reads crashed with `Cannot read properties of
      // undefined (reading 'get')`. The stub now mirrors the host
      // ServicesAccessor surface but always returns undefined/false, so
      // the plugin's own null-guard fires the correct error message.
      const root = freshRoot('services-stub');
      let captured: PreviewPluginContext | undefined;
      const runtime = buildRuntime({
        previewsRoot: root,
        onActivate: (ctx) => {
          captured = ctx;
        },
      });
      await runtime.activate({
        zipBuffer: Buffer.alloc(0),
        draftId: 'd1',
        rev: 1,
        configValues: {},
        secretValues: {},
      });
      assert.ok(captured);
      assert.ok(captured!.services, 'ctx.services must be defined');
      assert.equal(captured!.services.get<unknown>('odoo.client'), undefined);
      assert.equal(captured!.services.get<unknown>('any.other'), undefined);
      assert.equal(captured!.services.has('odoo.client'), false);
      const dispose = captured!.services.provide('test.svc', { x: 1 });
      assert.equal(typeof dispose, 'function');
      // Calling the dispose handle is a no-op — must not throw even
      // though no real registration ever happened.
      dispose();
    });

    it('throws when secrets.require is called for a missing key', async () => {
      const root = freshRoot('missing-secret');
      let capturedCtx: PreviewPluginContext | undefined;
      const runtime = buildRuntime({
        previewsRoot: root,
        onActivate: (ctx) => {
          capturedCtx = ctx;
        },
      });
      await runtime.activate({
        zipBuffer: Buffer.alloc(0),
        draftId: 'd1',
        rev: 1,
        configValues: {},
        secretValues: {},
      });
      assert.ok(capturedCtx);
      await assert.rejects(() => capturedCtx!.secrets.require('NOT_SET'));
    });

    it('cleans up the preview directory when activate throws', async () => {
      const root = freshRoot('throw-cleanup');
      const runtime = buildRuntime({
        previewsRoot: root,
        activateThrows: new Error('boom'),
      });
      await assert.rejects(() =>
        runtime.activate({
          zipBuffer: Buffer.alloc(0),
          draftId: 'd1',
          rev: 1,
          configValues: {},
          secretValues: {},
        }),
      );
      // No preview dirs left behind
      const remaining = existsSync(path.join(root, 'd1-1'));
      assert.equal(remaining, false);
    });

    it('handle.close() removes the preview directory', async () => {
      const root = freshRoot('close-cleanup');
      const runtime = buildRuntime({ previewsRoot: root });
      const handle = await runtime.activate({
        zipBuffer: Buffer.alloc(0),
        draftId: 'd1',
        rev: 1,
        configValues: {},
        secretValues: {},
      });
      assert.ok(existsSync(handle.previewDir));
      await handle.close();
      assert.equal(existsSync(handle.previewDir), false);
    });

    it('overwrites a stale preview dir from a previous rev with the same number', async () => {
      const root = freshRoot('stale');
      // Pre-populate a stale dir that should get wiped
      const stalePath = path.join(root, 'd1-1');
      mkdirSync(stalePath, { recursive: true });
      writeFileSync(path.join(stalePath, 'leftover.txt'), 'stale');

      const runtime = buildRuntime({ previewsRoot: root });
      const handle = await runtime.activate({
        zipBuffer: Buffer.alloc(0),
        draftId: 'd1',
        rev: 1,
        configValues: {},
        secretValues: {},
      });
      assert.equal(existsSync(path.join(handle.previewDir, 'leftover.txt')), false);
      assert.ok(existsSync(path.join(handle.previewDir, 'package.json')));
    });
  });

  describe('cleanupOrphans', () => {
    it('removes leftover preview dirs from a previous run', async () => {
      const root = freshRoot('orphans');
      mkdirSync(path.join(root, 'd1-1'), { recursive: true });
      mkdirSync(path.join(root, 'd2-7'), { recursive: true });
      writeFileSync(path.join(root, 'd1-1', 'x.txt'), 'a');
      writeFileSync(path.join(root, 'd2-7', 'y.txt'), 'b');

      const runtime = buildRuntime({ previewsRoot: root });
      const result = await runtime.cleanupOrphans();
      assert.equal(result.removed, 2);
      assert.equal(existsSync(path.join(root, 'd1-1')), false);
      assert.equal(existsSync(path.join(root, 'd2-7')), false);
    });

    it('returns {removed: 0} when the root does not yet exist', async () => {
      const runtime = buildRuntime({
        previewsRoot: path.join(tmp, 'nonexistent-' + String(Date.now())),
      });
      const result = await runtime.cleanupOrphans();
      assert.equal(result.removed, 0);
    });
  });
});

describe('PreviewStore', () => {
  it('stores and retrieves handles by draftId', () => {
    const store = new PreviewStore();
    const handle = {
      draftId: 'd1',
      agentId: 'a',
      rev: 1,
      toolkit: { tools: [] },
      previewDir: '/x',
      routeCaptures: [],
      close: async () => {},
    };
    store.set('d1', handle);
    assert.equal(store.get('d1'), handle);
    assert.equal(store.has('d1'), true);
    assert.equal(store.size, 1);
  });

  it('delete removes without closing', () => {
    const store = new PreviewStore();
    let closed = false;
    store.set('d1', {
      draftId: 'd1',
      agentId: 'a',
      rev: 1,
      toolkit: { tools: [] },
      previewDir: '/x',
      routeCaptures: [],
      close: async () => {
        closed = true;
      },
    });
    assert.equal(store.delete('d1'), true);
    assert.equal(store.has('d1'), false);
    assert.equal(closed, false);
  });

  it('closeAll closes every handle and clears the store', async () => {
    const store = new PreviewStore();
    let closeCount = 0;
    for (let i = 0; i < 3; i++) {
      store.set(`d${i}`, {
        draftId: `d${i}`,
        agentId: 'a',
        rev: 1,
        toolkit: { tools: [] },
        previewDir: '/x',
        routeCaptures: [],
        close: async () => {
          closeCount += 1;
        },
      });
    }
    await store.closeAll();
    assert.equal(store.size, 0);
    assert.equal(closeCount, 3);
  });

  it('draftIds returns all keys', () => {
    const store = new PreviewStore();
    const handle = {
      draftId: '',
      agentId: 'a',
      rev: 1,
      toolkit: { tools: [] },
      previewDir: '/x',
      routeCaptures: [],
      close: async () => {},
    };
    store.set('a', { ...handle, draftId: 'a' });
    store.set('b', { ...handle, draftId: 'b' });
    const ids = store.draftIds().sort();
    assert.deepEqual(ids, ['a', 'b']);
  });
});
