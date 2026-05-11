import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BuildQueue } from '../../src/plugins/builder/buildQueue.js';
import {
  BuildPipeline,
  BuildPipelineError,
} from '../../src/plugins/builder/buildPipeline.js';
import type { BuildResult } from '../../src/plugins/builder/buildSandbox.js';
import { _resetCacheForTests } from '../../src/plugins/builder/boilerplateSource.js';
import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import {
  type AgentSpecSkeleton,
  emptyAgentSpec,
} from '../../src/plugins/builder/types.js';

const FIXTURE_PATH = path.join(
  import.meta.dirname,
  'fixtures',
  'minimal-spec.json',
);

function loadFixtureSpec(): {
  spec: AgentSpecSkeleton;
  slots: Record<string, string>;
} {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as Record<
    string,
    unknown
  >;
  const slots = (raw['slots'] as Record<string, string>) ?? {};
  // BuildPipeline parses spec internally; cast through AgentSpecSkeleton
  // (the DraftStore field type) since the JSON shape matches what Zod
  // accepts.
  return { spec: raw as unknown as AgentSpecSkeleton, slots };
}

function makeBuildSuccess(): BuildResult {
  return {
    ok: true,
    zip: Buffer.from('PK-stub'),
    zipPath: '/tmp/fake.zip',
    durationMs: 5,
  };
}

function makeBuildFailure(): BuildResult {
  return {
    ok: false,
    errors: [
      {
        file: 'plugin.ts',
        line: 1,
        column: 1,
        code: 'TS1234',
        message: 'fake tsc error',
      },
    ],
    exitCode: 1,
    stdoutTail: '',
    stderrTail: 'plugin.ts(1,1): error TS1234: fake tsc error',
    durationMs: 5,
    reason: 'tsc',
  };
}

describe('BuildPipeline', () => {
  let tmp: string;
  let store: DraftStore;
  let dbPath: string;
  let templateRoot: string;
  let stagingBaseDir: string;

  before(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'build-pipeline-test-'));
    _resetCacheForTests();
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (store) await store.close();
    dbPath = path.join(
      tmp,
      `drafts-${String(Date.now())}-${String(Math.random())}.db`,
    );
    store = new DraftStore({ dbPath });
    await store.open();
    templateRoot = path.join(tmp, `tmpl-${String(Date.now())}`);
    stagingBaseDir = path.join(tmp, `staging-${String(Date.now())}`);
  });

  it('runs codegen + staging + sandbox build and returns the BuildResult', async () => {
    const { spec, slots } = loadFixtureSpec();
    const draft = await store.create('alice@example.com', 'Weather');
    await store.update('alice@example.com', draft.id, { spec, slots });

    const queue = new BuildQueue({ concurrency: 1 });
    let sandboxCalls = 0;
    let observedStaging = '';
    const pipeline = new BuildPipeline({
      draftStore: store,
      buildQueue: queue,
      templateRoot,
      stagingBaseDir,
      buildSandbox: async (opts) => {
        sandboxCalls += 1;
        observedStaging = opts.stagingDir;
        return makeBuildSuccess();
      },
      logger: () => {},
    });

    const result = await pipeline.run({
      userEmail: 'alice@example.com',
      draftId: draft.id,
    });

    assert.equal(sandboxCalls, 1);
    assert.equal(result.buildResult.ok, true);
    assert.equal(result.buildN, 1);
    assert.match(observedStaging, /staging-/);
    // Cleanup must have happened — staging dir gone after run().
    assert.equal(existsSync(observedStaging), false, 'staging dir cleaned');
  });

  it('writes AGENT.md (with persona/quality frontmatter) into the staging dir (Phase 3 / OB-67)', async () => {
    const { spec, slots } = loadFixtureSpec();
    const draft = await store.create('alice@example.com', 'Weather');
    await store.update('alice@example.com', draft.id, {
      spec: {
        ...spec,
        persona: {
          axes: { sarcasm: 90, directness: 80 },
          custom_notes: 'Antworte auf Deutsch.',
        },
        quality: { sycophancy: 'high' },
      },
      slots,
    });

    const queue = new BuildQueue({ concurrency: 1 });
    let agentMdContent = '';
    const pipeline = new BuildPipeline({
      draftStore: store,
      buildQueue: queue,
      templateRoot,
      stagingBaseDir,
      buildSandbox: async (opts) => {
        const agentMdPath = path.join(opts.stagingDir, 'AGENT.md');
        agentMdContent = readFileSync(agentMdPath, 'utf-8');
        return makeBuildSuccess();
      },
      logger: () => {},
    });

    await pipeline.run({
      userEmail: 'alice@example.com',
      draftId: draft.id,
    });

    assert.match(
      agentMdContent,
      /^---\n/,
      'AGENT.md must lead with frontmatter',
    );
    assert.match(
      agentMdContent,
      /persona:[\s\S]*sarcasm:\s*90/,
      'persona.axes.sarcasm=90 must land in frontmatter',
    );
    assert.match(
      agentMdContent,
      /quality:[\s\S]*sycophancy:\s*high/,
      'quality.sycophancy=high must land in frontmatter',
    );
    assert.match(
      agentMdContent,
      /Antworte auf Deutsch/,
      'custom_notes must be preserved verbatim',
    );
  });

  it('cleans up the staging dir even when the sandbox returns a failure', async () => {
    const { spec, slots } = loadFixtureSpec();
    const draft = await store.create('alice@example.com', 'Weather');
    await store.update('alice@example.com', draft.id, { spec, slots });

    const queue = new BuildQueue({ concurrency: 1 });
    let observedStaging = '';
    const pipeline = new BuildPipeline({
      draftStore: store,
      buildQueue: queue,
      templateRoot,
      stagingBaseDir,
      buildSandbox: async (opts) => {
        observedStaging = opts.stagingDir;
        return makeBuildFailure();
      },
      logger: () => {},
    });

    const result = await pipeline.run({
      userEmail: 'alice@example.com',
      draftId: draft.id,
    });

    assert.equal(result.buildResult.ok, false);
    if (result.buildResult.ok) throw new Error('expected failure');
    assert.equal(result.buildResult.reason, 'tsc');
    assert.equal(existsSync(observedStaging), false, 'staging cleaned on fail');
  });

  it('throws BuildPipelineError(draft_not_found) for missing or cross-user draft', async () => {
    const { spec, slots } = loadFixtureSpec();
    const draft = await store.create('alice@example.com', 'Weather');
    await store.update('alice@example.com', draft.id, { spec, slots });

    const queue = new BuildQueue({ concurrency: 1 });
    const pipeline = new BuildPipeline({
      draftStore: store,
      buildQueue: queue,
      templateRoot,
      stagingBaseDir,
      buildSandbox: async () => makeBuildSuccess(),
      logger: () => {},
    });

    await assert.rejects(
      async () =>
        pipeline.run({
          userEmail: 'mallory@example.com',
          draftId: draft.id,
        }),
      (err: unknown) =>
        err instanceof BuildPipelineError && err.code === 'draft_not_found',
    );
  });

  it('throws BuildPipelineError(spec_invalid) when the draft spec fails Zod parse', async () => {
    const draft = await store.create('alice@example.com', 'Empty');
    // emptyAgentSpec() has empty `id`/`name`/etc. — Zod will reject
    // (id regex requires at least one char, name min(1)).
    await store.update('alice@example.com', draft.id, {
      spec: emptyAgentSpec(),
    });

    const queue = new BuildQueue({ concurrency: 1 });
    const pipeline = new BuildPipeline({
      draftStore: store,
      buildQueue: queue,
      templateRoot,
      stagingBaseDir,
      buildSandbox: async () => makeBuildSuccess(),
      logger: () => {},
    });

    await assert.rejects(
      async () =>
        pipeline.run({
          userEmail: 'alice@example.com',
          draftId: draft.id,
        }),
      (err: unknown) =>
        err instanceof BuildPipelineError && err.code === 'spec_invalid',
    );
  });

  it('increments buildN per pipeline-instance across multiple runs', async () => {
    const { spec, slots } = loadFixtureSpec();
    const draft = await store.create('alice@example.com', 'Weather');
    await store.update('alice@example.com', draft.id, { spec, slots });

    const queue = new BuildQueue({ concurrency: 1 });
    const pipeline = new BuildPipeline({
      draftStore: store,
      buildQueue: queue,
      templateRoot,
      stagingBaseDir,
      buildSandbox: async () => makeBuildSuccess(),
      logger: () => {},
    });

    const a = await pipeline.run({
      userEmail: 'alice@example.com',
      draftId: draft.id,
    });
    const b = await pipeline.run({
      userEmail: 'alice@example.com',
      draftId: draft.id,
    });

    assert.equal(a.buildN, 1);
    assert.equal(b.buildN, 2);
  });

  it('passes the AbortSignal from the queue into buildSandbox', async () => {
    const { spec, slots } = loadFixtureSpec();
    const draft = await store.create('alice@example.com', 'Weather');
    await store.update('alice@example.com', draft.id, { spec, slots });

    const queue = new BuildQueue({ concurrency: 1 });
    let observedSignal: AbortSignal | undefined;
    const pipeline = new BuildPipeline({
      draftStore: store,
      buildQueue: queue,
      templateRoot,
      stagingBaseDir,
      buildSandbox: async (opts) => {
        observedSignal = opts.signal;
        return makeBuildSuccess();
      },
      logger: () => {},
    });

    await pipeline.run({
      userEmail: 'alice@example.com',
      draftId: draft.id,
    });
    assert.ok(observedSignal, 'sandbox got an AbortSignal');
    assert.equal(observedSignal?.aborted, false);
  });

  it('does not leak staging dirs when many runs happen in parallel', async () => {
    const { spec, slots } = loadFixtureSpec();
    const draft = await store.create('alice@example.com', 'Weather');
    await store.update('alice@example.com', draft.id, { spec, slots });

    const queue = new BuildQueue({ concurrency: 3 });
    const pipeline = new BuildPipeline({
      draftStore: store,
      buildQueue: queue,
      templateRoot,
      stagingBaseDir,
      buildSandbox: async () => makeBuildSuccess(),
      logger: () => {},
    });

    // Three separate drafts so the queue doesn't coalesce them.
    const drafts = await Promise.all([
      store.create('alice@example.com', 'A'),
      store.create('alice@example.com', 'B'),
      store.create('alice@example.com', 'C'),
    ]);
    for (const d of drafts) {
      await store.update('alice@example.com', d.id, { spec, slots });
    }
    await Promise.all(
      drafts.map((d) =>
        pipeline.run({
          userEmail: 'alice@example.com',
          draftId: d.id,
        }),
      ),
    );

    if (existsSync(stagingBaseDir)) {
      const remaining = readdirSync(stagingBaseDir);
      assert.deepEqual(remaining, [], 'no staging dirs left over');
    }
  });
});
