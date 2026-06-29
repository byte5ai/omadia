/**
 * REGRESSION — `builder.preview_chat_failed: Cannot read properties of
 * undefined (reading 'register')`.
 *
 * Customer hit this in the Agent-Builder preview. The builder agent guessed
 * the crash came from the codegen-emitted `ctx.uiRoutes.register(...)` and the
 * preview harness "not mocking ctx.uiRoutes". That diagnosis was WRONG:
 *
 *   - `ctx.uiRoutes` IS stubbed in preview (always was). Not the culprit.
 *   - The real gap: the boilerplate PluginContext contract
 *     (assets/boilerplate/agent-integration/types.ts) declares `jobs:
 *     JobsAccessor` and `status: StatusAccessor` as NON-optional, the kernel's
 *     createPluginContext provides both, but the preview's createStubContext
 *     omitted BOTH. Any plugin that registers a scheduled job compiled cleanly,
 *     worked after install, and crashed ONLY in preview when activate() ran
 *     `ctx.jobs.register(...)`.
 *
 * Fix: createStubContext now stubs `ctx.jobs` + `ctx.status`, mirroring the
 * kernel wiring (capture + real disposer) WITHOUT firing cron in the ephemeral
 * preview. These tests pin the fixed behaviour and prove a builder-generated
 * agent wires a job + a status report the same way the core does post-install.
 */
import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  PreviewRuntime,
  type PreviewHandle,
  type PreviewPluginContext,
} from '../../src/plugins/builder/previewRuntime.js';

describe('REGRESSION: preview ctx provides jobs/status accessors', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'preview-jobs-reg-'));
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Runtime whose activateModule hands the REAL preview ctx to `onActivate`,
   *  exactly as the kernel hands it to a plugin's activate(). */
  function runtimeWith(
    root: string,
    onActivate: (ctx: PreviewPluginContext) => void | Promise<void>,
  ): PreviewRuntime {
    return new PreviewRuntime({
      previewsRoot: root,
      logger: () => {},
      extractZip: async (_zip, destDir) => {
        mkdirSync(path.join(destDir, 'dist'), { recursive: true });
        writeFileSync(
          path.join(destDir, 'package.json'),
          JSON.stringify({
            name: '@omadia/agent-repro',
            version: '0.1.0',
            main: 'dist/index.js',
          }),
        );
        writeFileSync(path.join(destDir, 'dist', 'index.js'), '// stub\n');
      },
      activateModule: async (_entry, ctx) => {
        await onActivate(ctx);
        return { toolkit: { tools: [] }, close: async () => {} };
      },
    });
  }

  function freshRoot(name: string): string {
    const root = path.join(tmp, name);
    mkdirSync(root, { recursive: true });
    return root;
  }

  function activate(runtime: PreviewRuntime, draftId: string): Promise<PreviewHandle> {
    return runtime.activate({
      zipBuffer: Buffer.from('PK'),
      draftId,
      rev: 1,
      configValues: {},
      secretValues: {},
    });
  }

  it('ctx.uiRoutes is stubbed (control — never was the culprit)', async () => {
    let ok = false;
    const runtime = runtimeWith(freshRoot('ui'), (ctx) => {
      const dispose = ctx.uiRoutes.register({
        routeId: 'dashboard',
        path: '/dashboard',
        title: 'Dashboard',
      });
      dispose();
      ok = true;
    });
    await activate(runtime, 'd-ui');
    assert.equal(ok, true);
  });

  it('ctx.jobs.register no longer throws and the registration is captured', async () => {
    let dispose: (() => void) | undefined;
    const runtime = runtimeWith(freshRoot('jobs'), (ctx) => {
      assert.ok(ctx.jobs, 'ctx.jobs must be present');
      dispose = ctx.jobs.register(
        { name: 'nightly-sync', schedule: { cron: '0 3 * * *' } },
        async () => {},
      );
      assert.equal(typeof dispose, 'function', 'register returns a disposer');
    });

    const handle = await activate(runtime, 'd-jobs');

    assert.equal(handle.jobCaptures.length, 1, 'one job captured');
    assert.equal(handle.jobCaptures[0]?.name, 'nightly-sync');
    assert.deepEqual(handle.jobCaptures[0]?.schedule, { cron: '0 3 * * *' });
    assert.equal(handle.jobCaptures[0]?.disposed, false);

    // Disposer mirrors the kernel contract — flips the capture to disposed.
    dispose?.();
    assert.equal(handle.jobCaptures[0]?.disposed, true);
  });

  it('ctx.status.report/clear no longer throws and reports are captured', async () => {
    const runtime = runtimeWith(freshRoot('status'), (ctx) => {
      assert.ok(ctx.status, 'ctx.status must be present');
      ctx.status.report({ state: 'needs_action', title: 'Connect your account' });
      ctx.status.clear();
    });

    const handle = await activate(runtime, 'd-status');

    assert.equal(handle.statusReports.length, 2);
    assert.deepEqual(handle.statusReports[0], {
      state: 'needs_action',
      title: 'Connect your account',
    });
    // clear() records a synthetic `ok` (kernel treats ok/clear identically).
    assert.deepEqual(handle.statusReports[1], { state: 'ok' });
  });

  it('a builder-generated agent wires a job AND a report like core does', async () => {
    // Simulates the activate-body of a generated plugin that schedules a
    // background sync and reports its connection status — the exact shape the
    // kernel wires post-install, now faithfully captured in preview.
    const runtime = runtimeWith(freshRoot('agent'), (ctx) => {
      ctx.status.report({ state: 'ok', title: 'Connected' });
      ctx.jobs.register(
        { name: 'poll-inbox', schedule: { intervalMs: 300_000 }, overlap: 'skip' },
        async (signal) => {
          // handler body would do the real poll post-install; never fires in preview
          void signal;
        },
      );
    });

    const handle = await activate(runtime, 'd-agent');

    // Job built the way core wires it:
    assert.equal(handle.jobCaptures.length, 1);
    assert.equal(handle.jobCaptures[0]?.name, 'poll-inbox');
    assert.deepEqual(handle.jobCaptures[0]?.schedule, { intervalMs: 300_000 });
    assert.equal(handle.jobCaptures[0]?.spec.overlap, 'skip');
    assert.equal(typeof handle.jobCaptures[0]?.handler, 'function');

    // Report built the way core wires it:
    assert.equal(handle.statusReports.length, 1);
    assert.deepEqual(handle.statusReports[0], { state: 'ok', title: 'Connected' });

    await handle.close();
  });
});
