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
  type PreviewHostServices,
  type PreviewLlmCompleteRequest,
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
    onActivate?: (ctx: PreviewPluginContext) => void | Promise<void>;
    activateThrows?: Error;
    serviceRegistry?: PreviewHostServices;
    /** When set, written as `manifest.yaml` into the extracted package so
     *  `manifestDeclaresMemory` can gate `ctx.memory`. */
    manifestYaml?: string;
  }): PreviewRuntime {
    return new PreviewRuntime({
      previewsRoot: opts.previewsRoot,
      logger: () => {},
      ...(opts.serviceRegistry ? { serviceRegistry: opts.serviceRegistry } : {}),
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
        if (opts.manifestYaml !== undefined) {
          writeFileSync(path.join(destDir, 'manifest.yaml'), opts.manifestYaml);
        }
        // Touch the entry path so default-activate's fs.access wouldn't fail
        // (we override activateModule anyway, so its existence isn't used).
        mkdirSync(path.join(destDir, 'dist'), { recursive: true });
        writeFileSync(path.join(destDir, 'dist', 'index.js'), '// stub\n');
      },
      activateModule: async (_entry, ctx) => {
        if (opts.activateThrows) throw opts.activateThrows;
        await opts.onActivate?.(ctx);
        return (
          opts.handle ?? {
            toolkit: { tools: [] },
            close: async () => {},
          }
        );
      },
    });
  }

  /** Minimal manifest declaring agent-scoped memory permissions, matching the
   *  boilerplate's `permissions.memory` block. */
  const MEMORY_MANIFEST = [
    'schema_version: "1"',
    'identity:',
    '  id: "@omadia/agent-test"',
    'permissions:',
    '  memory:',
    '    reads: ["session:*", "agent:@omadia/agent-test:*"]',
    '    writes: ["agent:@omadia/agent-test:*"]',
    '',
  ].join('\n');

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

    it('falls back to undefined lookups when no host ServiceRegistry is wired (legacy stub behaviour)', async () => {
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

    it('reads through to the host ServiceRegistry so integration-backed agents resolve real services (solution B)', async () => {
      // The blocker: an integration-backed agent does
      // `ctx.services.get('odoo.client')`; with the old stub that always
      // returned undefined, the preview hit the agent's null-guard and could
      // never go green → never installable. Wiring the live registry lets the
      // previewed agent resolve the real service its depends_on integration
      // provides.
      const odooClient = { execute: () => 'ok' };
      const host: PreviewHostServices = {
        get: <T,>(name: string): T | undefined =>
          name === 'odoo.client' ? (odooClient as T) : undefined,
        has: (name: string): boolean => name === 'odoo.client',
      };
      const root = freshRoot('services-readthrough');
      let captured: PreviewPluginContext | undefined;
      const runtime = buildRuntime({
        previewsRoot: root,
        serviceRegistry: host,
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
      // Read-through to the host registry.
      assert.equal(captured!.services.get('odoo.client'), odooClient);
      assert.equal(captured!.services.has('odoo.client'), true);
      assert.equal(captured!.services.get('not.there'), undefined);
      // Agent-provided services stay preview-local and do NOT mutate the host
      // registry; local entries are checked before the host.
      const dispose = captured!.services.provide('local.only', { y: 2 });
      assert.deepEqual(captured!.services.get('local.only'), { y: 2 });
      assert.equal(host.has('local.only'), false);
      dispose();
      assert.equal(captured!.services.get('local.only'), undefined);
    });

    // ── ctx.llm (host-backed, manifest-gated) ─────────────────────────────
    // Regression: previewRuntime built no `llm` accessor, so any agent whose
    // activate-body calls `ctx.llm.complete(...)` hit its own
    // `if (!ctx.llm) throw` guard and failed preview-chat with "ctx.llm
    // unavailable", even though it works post-install. Preview now serves real
    // completions through the wired host 'llm' provider, gated on the same
    // manifest field the kernel checks.
    const LLM_MANIFEST = [
      'schema_version: "1"',
      'identity:',
      '  id: "@omadia/agent-test"',
      'permissions:',
      '  llm:',
      '    models_allowed: ["claude-sonnet-4-6"]',
      '    calls_per_invocation: 1',
      '    max_tokens_per_call: 100',
      '',
    ].join('\n');

    function llmHost(received: PreviewLlmCompleteRequest[]): PreviewHostServices {
      const provider = {
        complete: async (req: PreviewLlmCompleteRequest) => {
          received.push(req);
          return {
            text: 'preview-answer',
            model: req.model,
            inputTokens: 3,
            outputTokens: 5,
            stopReason: 'end_turn' as const,
          };
        },
      };
      return {
        get: <T,>(name: string): T | undefined =>
          name === 'llm' ? (provider as T) : undefined,
        has: (name: string): boolean => name === 'llm',
      };
    }

    it('exposes ctx.llm backed by the host provider when manifest + host are present', async () => {
      const received: PreviewLlmCompleteRequest[] = [];
      let captured: PreviewPluginContext | undefined;
      const runtime = buildRuntime({
        previewsRoot: freshRoot('llm-present'),
        serviceRegistry: llmHost(received),
        manifestYaml: LLM_MANIFEST,
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
      assert.ok(captured?.llm, 'ctx.llm must be present');
      assert.deepEqual(captured!.llm!.modelsAllowed, ['claude-sonnet-4-6']);

      const res = await captured!.llm!.complete({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 5000, // above manifest cap → must clamp
      });
      assert.equal(res.text, 'preview-answer');
      assert.equal(received.length, 1);
      // Delegated to the real host provider, with maxTokens clamped to the cap.
      assert.equal(received[0]!.maxTokens, 100);
    });

    it('ctx.llm enforces the model whitelist and the per-invocation budget', async () => {
      const received: PreviewLlmCompleteRequest[] = [];
      let captured: PreviewPluginContext | undefined;
      const runtime = buildRuntime({
        previewsRoot: freshRoot('llm-guards'),
        serviceRegistry: llmHost(received),
        manifestYaml: LLM_MANIFEST,
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
      const llm = captured!.llm!;
      // Not in models_allowed → rejected before any host call.
      await assert.rejects(
        () => llm.complete({ model: 'gpt-4o', messages: [] }),
        /is not in agent/,
      );
      // First allowed call OK; second exceeds calls_per_invocation: 1.
      await llm.complete({ model: 'claude-sonnet-4-6', messages: [] });
      await assert.rejects(
        () => llm.complete({ model: 'claude-sonnet-4-6', messages: [] }),
        /LLM call budget/,
      );
      assert.equal(received.length, 1, 'only the one allowed call reached host');
    });

    it('ctx.llm is absent when the manifest declares no llm permission', async () => {
      let captured: PreviewPluginContext | undefined;
      const runtime = buildRuntime({
        previewsRoot: freshRoot('llm-no-manifest'),
        serviceRegistry: llmHost([]),
        manifestYaml: MEMORY_MANIFEST, // declares memory, not llm
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
      assert.equal(captured!.llm, undefined);
    });

    it('ctx.llm is absent when no host llm provider is wired (faithful to install)', async () => {
      let captured: PreviewPluginContext | undefined;
      const runtime = buildRuntime({
        previewsRoot: freshRoot('llm-no-host'),
        // no serviceRegistry → host 'llm' not resolvable
        manifestYaml: LLM_MANIFEST,
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
      assert.equal(captured!.llm, undefined);
    });

    it('exposes ctx.memory when the manifest declares memory permissions, backed by an ephemeral store', async () => {
      // Regression: previewRuntime had no `memory` accessor on its stub
      // context, so any agent whose activate-body calls `ctx.memory` (project
      // persistence) hit its own `if (!ctx.memory) throw …` guard and failed
      // preview-chat with `ctx.memory is required but unavailable`, even
      // though its manifest correctly declared permissions.memory. Preview now
      // provides an ephemeral in-memory store gated on the same manifest field
      // the kernel checks post-install.
      const root = freshRoot('memory-present');
      let captured: PreviewPluginContext | undefined;
      const runtime = buildRuntime({
        previewsRoot: root,
        manifestYaml: MEMORY_MANIFEST,
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
      assert.ok(captured!.memory, 'ctx.memory must be present');
      const mem = captured!.memory!;

      // Empty scope: exists/list are well-behaved, not throwing.
      assert.equal(await mem.exists('projects/p1.json'), false);
      assert.deepEqual(await mem.list('.'), []);

      // Write → read round-trip.
      await mem.writeFile('projects/p1.json', '{"name":"alpha"}');
      assert.equal(await mem.readFile('projects/p1.json'), '{"name":"alpha"}');
      assert.equal(await mem.exists('projects/p1.json'), true);
      assert.equal(await mem.exists('projects'), true);

      // createFile is fail-if-exists.
      await assert.rejects(() => mem.createFile('projects/p1.json', 'x'));
      await mem.createFile('projects/p2.json', '{"name":"beta"}');

      // A path that is an implicit directory cannot be written or created as
      // a file — mirrors FilesystemMemoryStore (EISDIR / already-exists), and
      // keeps `list()` from being shadowed by a file/dir key collision.
      await assert.rejects(() => mem.writeFile('projects', 'x'));
      await assert.rejects(() => mem.createFile('projects', 'x'));

      // list returns the dir + its files (relative paths).
      const listed = await mem.list('projects');
      const rels = listed.map((e) => e.relPath).sort();
      assert.deepEqual(rels, ['projects', 'projects/p1.json', 'projects/p2.json']);
      const p1 = listed.find((e) => e.relPath === 'projects/p1.json');
      assert.equal(p1?.isDirectory, false);
      assert.ok((p1?.sizeBytes ?? 0) > 0);

      // delete removes the file.
      await mem.delete('projects/p1.json');
      assert.equal(await mem.exists('projects/p1.json'), false);
      await assert.rejects(() => mem.readFile('projects/p1.json'));

      // Relative-path validation mirrors the real accessor.
      await assert.rejects(() => mem.readFile('/abs/path'));
      await assert.rejects(() => mem.readFile('../escape'));
    });

    it('leaves ctx.memory undefined when the manifest omits memory permissions (mirrors install gate)', async () => {
      const root = freshRoot('memory-absent');
      let captured: PreviewPluginContext | undefined;
      const runtime = buildRuntime({
        previewsRoot: root,
        // Manifest present but with an empty memory block → not declared.
        manifestYaml: [
          'schema_version: "1"',
          'permissions:',
          '  memory:',
          '    reads: []',
          '    writes: []',
          '',
        ].join('\n'),
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
      assert.equal(captured!.memory, undefined);
    });

    it('exposes ctx.http gated on the manifest outbound allow-list, enforcing the host allow-list', async () => {
      // Regression: previewRuntime's stub context never wired `ctx.http`, so
      // ANY agent whose activate-body or tool calls `ctx.http` (a
      // self-contained agent fetching e.g. api.github.com) hit its own
      // `if (!ctx.http) throw 'ctx.http unavailable'` guard and failed preview
      // — even though its manifest correctly declared
      // permissions.network.outbound. Preview now provides the SAME
      // allow-list-enforced accessor the kernel hands out post-install.
      const root = freshRoot('http-present');
      let captured: PreviewPluginContext | undefined;
      const runtime = buildRuntime({
        previewsRoot: root,
        manifestYaml: [
          'schema_version: "1"',
          'permissions:',
          '  network:',
          '    outbound: ["api.github.com"]',
          '',
        ].join('\n'),
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
      assert.ok(captured!.http, 'ctx.http must be present');
      // A host outside the manifest allow-list is rejected before any network
      // I/O — proving the accessor is wired AND gating on the declared hosts.
      await assert.rejects(
        () => captured!.http!.fetch('https://evil.example.com/'),
        /evil\.example\.com|forbidden/i,
      );
      // Non-http(s) schemes are rejected by the same accessor.
      await assert.rejects(() => captured!.http!.fetch('file:///etc/passwd'));
    });

    it('leaves ctx.http undefined when the manifest declares no outbound hosts and is not a web_scanner', async () => {
      const root = freshRoot('http-absent');
      let captured: PreviewPluginContext | undefined;
      const runtime = buildRuntime({
        previewsRoot: root,
        manifestYaml: [
          'schema_version: "1"',
          'permissions:',
          '  network:',
          '    outbound: []',
          '',
        ].join('\n'),
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
      assert.equal(captured!.http, undefined);
    });

    it('memory stores from two separate activations are isolated', async () => {
      const root = freshRoot('memory-isolation');
      const captured: PreviewPluginContext[] = [];
      const runtime = buildRuntime({
        previewsRoot: root,
        manifestYaml: MEMORY_MANIFEST,
        onActivate: (ctx) => {
          captured.push(ctx);
        },
      });
      const h1 = await runtime.activate({
        zipBuffer: Buffer.alloc(0),
        draftId: 'd1',
        rev: 1,
        configValues: {},
        secretValues: {},
      });
      await captured[0]!.memory!.writeFile('notes.md', 'first');
      const h2 = await runtime.activate({
        zipBuffer: Buffer.alloc(0),
        draftId: 'd2',
        rev: 1,
        configValues: {},
        secretValues: {},
      });
      // Second activation's store must not see the first's data.
      assert.equal(await captured[1]!.memory!.exists('notes.md'), false);
      await h1.close();
      await h2.close();
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
