import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectGeneratedArtifactTool } from '../../../src/plugins/builder/tools/inspectGeneratedArtifact.js';
import { getBuildStatusTool } from '../../../src/plugins/builder/tools/getBuildStatus.js';
import { runtimeSmokeStatusTool } from '../../../src/plugins/builder/tools/runtimeSmokeStatus.js';
import { _resetCacheForTests } from '../../../src/plugins/builder/boilerplateSource.js';
import { _resetServiceTypeRegistryForTests } from '../../../src/plugins/builder/serviceTypeRegistry.js';
import type { BuildStatusSnapshot } from '../../../src/plugins/builder/buildPipeline.js';
import type { SmokeStatusSnapshot } from '../../../src/plugins/builder/runtimeSmokeOrchestrator.js';
import type { AgentSpecSkeleton } from '../../../src/plugins/builder/types.js';
import {
  createBuilderToolHarness,
  type BuilderToolHarness,
} from '../fixtures/builderToolHarness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, '..', 'fixtures', 'minimal-spec.json');

/** Seed the harness draft with the canonical minimal weather spec + slots so
 *  codegen produces a full file map. */
async function seedGeneratableDraft(harness: BuilderToolHarness): Promise<void> {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<string, unknown>;
  const slots = raw['slots'] as Record<string, string>;
  const { slots: _ignored, ...specInput } = raw;
  void _ignored;
  await harness.draftStore.update(harness.userEmail, harness.draftId, {
    spec: specInput as unknown as AgentSpecSkeleton,
    slots,
  });
}

describe('inspect_generated_artifact (Issue #227)', () => {
  let harness: BuilderToolHarness;

  beforeEach(async () => {
    _resetCacheForTests();
    _resetServiceTypeRegistryForTests();
    harness = await createBuilderToolHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('returns a spec-invalid error on an empty draft skeleton', async () => {
    const result = await inspectGeneratedArtifactTool.run({}, harness.context());
    assert.equal(result.ok, false);
    assert.ok(/spec/i.test(result.error));
  });

  it('renders manifest.yaml by default and lists every generated file', async () => {
    await seedGeneratableDraft(harness);
    const result = await inspectGeneratedArtifactTool.run({}, harness.context());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.file, 'manifest.yaml');
      // The rendered manifest carries the resolved agent id, not a placeholder.
      assert.ok(result.content.includes('de.byte5.agent.weather'));
      assert.ok(!result.content.includes('{{AGENT_ID}}'));
      assert.ok(result.availableFiles.includes('package.json'));
      assert.ok(result.availableFiles.includes('tsconfig.json'));
      assert.equal(result.bytes, Buffer.byteLength(result.content, 'utf-8'));
    }
  });

  it('reads an explicitly requested artefact (package.json)', async () => {
    await seedGeneratableDraft(harness);
    const result = await inspectGeneratedArtifactTool.run(
      { file: 'package.json' },
      harness.context(),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.file, 'package.json');
      const parsed = JSON.parse(result.content) as { name?: string };
      assert.equal(typeof parsed.name, 'string');
    }
  });

  it('errors with an availableFiles hint on an unknown artefact', async () => {
    await seedGeneratableDraft(harness);
    const result = await inspectGeneratedArtifactTool.run(
      { file: 'does-not-exist.yaml' },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.availableFiles && result.availableFiles.length > 0);
      assert.ok(result.availableFiles.includes('manifest.yaml'));
    }
  });
});

describe('get_build_status (Issue #227)', () => {
  let harness: BuilderToolHarness;

  beforeEach(async () => {
    harness = await createBuilderToolHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('reports the surface unavailable when no accessor is wired', async () => {
    const result = await getBuildStatusTool.run({}, harness.context());
    assert.equal(result.ok, false);
  });

  it('returns status "unknown" when the accessor has no snapshot yet', async () => {
    const ctx = { ...harness.context(), lastBuildStatus: () => undefined };
    const result = await getBuildStatusTool.run({}, ctx);
    assert.equal(result.ok, true);
    if (result.ok && 'status' in result) {
      assert.equal(result.status, 'unknown');
    }
  });

  it('passes through a recorded build snapshot', async () => {
    const snap: BuildStatusSnapshot = {
      status: 'failed',
      phase: 'tsc',
      buildN: 7,
      errorCount: 3,
      reason: 'tsc',
      builtAt: '2026-06-05T10:32:00.000Z',
    };
    const ctx = { ...harness.context(), lastBuildStatus: () => snap };
    const result = await getBuildStatusTool.run({}, ctx);
    assert.equal(result.ok, true);
    if (result.ok && 'phase' in result) {
      assert.equal(result.status, 'failed');
      assert.equal(result.phase, 'tsc');
      assert.equal(result.errorCount, 3);
      assert.equal(result.builtAt, '2026-06-05T10:32:00.000Z');
    }
  });
});

describe('runtime_smoke_status (Issue #227)', () => {
  let harness: BuilderToolHarness;

  beforeEach(async () => {
    harness = await createBuilderToolHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('reports the surface unavailable when no accessor is wired', async () => {
    const result = await runtimeSmokeStatusTool.run({}, harness.context());
    assert.equal(result.ok, false);
  });

  it('returns status "unknown" when the accessor has no snapshot yet', async () => {
    const ctx = { ...harness.context(), lastSmokeStatus: () => undefined };
    const result = await runtimeSmokeStatusTool.run({}, ctx);
    assert.equal(result.ok, true);
    if (result.ok && 'status' in result) {
      assert.equal(result.status, 'unknown');
    }
  });

  it('passes through a recorded smoke snapshot', async () => {
    const snap: SmokeStatusSnapshot = {
      phase: 'failed',
      buildN: 4,
      reason: 'activate_failed',
      activateError: 'ctx.memory is required but unavailable',
      smokedAt: '2026-06-05T10:33:00.000Z',
    };
    const ctx = { ...harness.context(), lastSmokeStatus: () => snap };
    const result = await runtimeSmokeStatusTool.run({}, ctx);
    assert.equal(result.ok, true);
    if (result.ok && 'phase' in result) {
      assert.equal(result.phase, 'failed');
      assert.equal(result.reason, 'activate_failed');
      assert.equal(result.activateError, 'ctx.memory is required but unavailable');
      assert.equal(result.smokedAt, '2026-06-05T10:33:00.000Z');
    }
  });
});
