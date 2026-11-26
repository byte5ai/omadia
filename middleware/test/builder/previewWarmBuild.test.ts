import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { BuildPipeline, PipelineRunResult } from '../../src/plugins/builder/buildPipeline.js';
import { PreviewCache } from '../../src/plugins/builder/previewCache.js';
import {
  PreviewSetupValueMissingError,
  type PreviewHandle,
} from '../../src/plugins/builder/previewRuntime.js';
import type { PreviewSecretBuffer } from '../../src/plugins/builder/previewSecretBuffer.js';
import {
  isBuildStatusReported,
  warmPreview,
} from '../../src/plugins/builder/previewWarmBuild.js';
import { SpecEventBus, type SpecBusEvent } from '../../src/plugins/builder/specEventBus.js';

/**
 * #1731/#1733/#1807/#1809 — one build-status path for the auto-rebuild
 * scheduler and the preview routes.
 */

const USER = 'op@example.com';
const DRAFT = 'd1';

type RunOutcome = 'ok' | 'tsc';

function makeHarness(opts: {
  outcomes: RunOutcome[];
  activate?: () => Promise<PreviewHandle>;
  newestBuild?: () => number;
}) {
  const bus = new SpecEventBus();
  const events: Array<Extract<SpecBusEvent, { type: 'build_status' }>> = [];
  bus.subscribe(DRAFT, (ev) => {
    if (ev.type === 'build_status') events.push(ev);
  });
  const recorded: Array<{ buildN: number; reason: string }> = [];
  const missing: Array<{ buildN: number; key: string }> = [];
  let buildN = 0;
  const newestBuild = (): number => opts.newestBuild?.() ?? buildN;
  const buildPipeline = {
    run: async (): Promise<PipelineRunResult> => {
      buildN += 1;
      const outcome = opts.outcomes.shift() ?? 'ok';
      const draft = { spec: { setup_fields: [] } } as unknown as PipelineRunResult['draft'];
      if (outcome === 'ok') {
        return {
          draft,
          buildN,
          buildResult: { ok: true, zip: Buffer.from(''), zipPath: '/x.zip', durationMs: 1 },
        };
      }
      return {
        draft,
        buildN,
        buildResult: {
          ok: false,
          reason: 'tsc',
          exitCode: 2,
          stdoutTail: '',
          stderrTail: '',
          durationMs: 1,
          errors: [{ path: 'toolkit.ts', line: 3, col: 7, code: 'TS2322', message: 'nope' }],
        },
      } as unknown as PipelineRunResult;
    },
    recordActivationFailure: (_d: string, n: number, reason: string) => {
      recorded.push({ buildN: n, reason });
    },
    recordMissingSetupValue: (_d: string, n: number, key: string) => {
      missing.push({ buildN: n, key });
    },
    hasNewerBuild: (_d: string, n: number) => newestBuild() > n,
  } as unknown as BuildPipeline;
  const previewCache = new PreviewCache({
    activate:
      opts.activate ??
      (async (a) =>
        ({ draftId: a.draftId, agentId: 'agent', rev: a.rev, close: async () => {} }) as unknown as PreviewHandle),
    logger: () => {},
  });
  const previewSecretBuffer = {
    warm: async () => {},
    get: () => ({}),
  } as unknown as PreviewSecretBuffer;
  const deps = { previewCache, buildPipeline, previewSecretBuffer, bus, log: () => {} };
  return { deps, events, recorded, missing, previewCache };
}

describe('warmPreview', () => {
  it('a tsc failure emits exactly one failed event, with buildN and errors (#1731/#1733)', async () => {
    const h = makeHarness({ outcomes: ['tsc'] });
    const err = await warmPreview(h.deps, { userEmail: USER, draftId: DRAFT }).catch((e: unknown) => e);
    assert.ok(isBuildStatusReported(err));
    const failed = h.events.filter((e) => e.phase === 'failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.buildN, 1);
    assert.equal(failed[0]!.reason, 'tsc');
    assert.equal(failed[0]!.errors?.length, 1);
    assert.ok(!JSON.stringify(h.events).includes(USER), 'no e-mail on the wire');
  });

  it('a cache hit emits no building event (#1807)', async () => {
    const h = makeHarness({ outcomes: ['ok'] });
    await warmPreview(h.deps, { userEmail: USER, draftId: DRAFT });
    assert.deepEqual(h.events.map((e) => e.phase), ['building', 'ok']);
    await warmPreview(h.deps, { userEmail: USER, draftId: DRAFT });
    assert.deepEqual(h.events.map((e) => e.phase), ['building', 'ok']);
  });

  it('a missing test credential at activation is not a failed build (#1809)', async () => {
    const h = makeHarness({
      outcomes: ['ok'],
      activate: async () => {
        throw new PreviewSetupValueMissingError('secret', 'probe_token', 'agent');
      },
    });
    const err = await warmPreview(h.deps, { userEmail: USER, draftId: DRAFT }).catch((e: unknown) => e);
    assert.ok(err instanceof PreviewSetupValueMissingError);
    assert.equal(h.events.filter((e) => e.phase === 'failed').length, 0);
    const last = h.events.at(-1)!;
    assert.equal(last.phase, 'ok');
    assert.equal(last.buildN, 1);
    assert.equal(last.missingSetupKey, 'probe_token');
    assert.equal(h.recorded.length, 0);
    assert.deepEqual(h.missing, [{ buildN: 1, key: 'probe_token' }]);
  });

  it('another activation failure is failed with activate_failed and recorded', async () => {
    const h = makeHarness({
      outcomes: ['ok'],
      activate: async () => {
        throw new Error('boom in activate');
      },
    });
    await warmPreview(h.deps, { userEmail: USER, draftId: DRAFT }).catch(() => {});
    const failed = h.events.filter((e) => e.phase === 'failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.buildN, 1);
    // Stable code on the wire; the message (plugin text, server paths) only
    // in the pipeline record for get_build_status.
    assert.equal(failed[0]!.reason, 'activate_failed:unknown');
    assert.deepEqual(h.recorded.map((r) => r.buildN), [1]);
    assert.match(h.recorded[0]!.reason, /^activate_failed: boom in activate/);
  });

  it('drops the activation result of a build a newer one superseded', async () => {
    const h = makeHarness({
      outcomes: ['ok'],
      newestBuild: () => 2,
      activate: async () => {
        throw new Error('late failure');
      },
    });
    await warmPreview(h.deps, { userEmail: USER, draftId: DRAFT }).catch(() => {});
    assert.equal(h.events.filter((e) => e.phase === 'failed').length, 0);
    assert.equal(h.recorded.length, 0);
  });
});
