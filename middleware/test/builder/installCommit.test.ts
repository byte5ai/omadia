import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { CodegenError } from '../../src/plugins/builder/codegen.js';
import {
  BuildPipelineError,
  type BuildPipeline,
} from '../../src/plugins/builder/buildPipeline.js';
import type { PackageUploadService } from '../../src/plugins/packageUploadService.js';
import { installDraft } from '../../src/plugins/builder/installCommit.js';

interface FakePipelineHandle {
  pipeline: BuildPipeline;
  buildCalls: () => Array<{ userEmail: string; draftId: string }>;
}

function makeFakePipeline(opts: {
  store: DraftStore;
  /** Force a sandbox build failure (returns BuildResult { ok: false }). */
  failWith?: 'tsc' | 'timeout';
  failingErrors?: ReadonlyArray<{
    path: string;
    line: number;
    col: number;
    code: string;
    message: string;
  }>;
  /** Throw CodegenError-wrapped BuildPipelineError. */
  codegenIssues?: ReadonlyArray<{
    code:
      | 'spec_validation'
      | 'missing_required_slot'
      | 'missing_marker'
      | 'placeholder_residue';
    detail: string;
  }>;
  /** Throw BuildPipelineError('spec_invalid'). */
  specInvalid?: boolean;
  /** Throw BuildPipelineError('draft_not_found'). */
  pipelineDraftMissing?: boolean;
  /** Custom zip buffer to return on success. */
  zipBytes?: Buffer;
}): FakePipelineHandle {
  const calls: Array<{ userEmail: string; draftId: string }> = [];
  let buildN = 0;
  const fake = {
    run: async (input: { userEmail: string; draftId: string }) => {
      calls.push(input);
      buildN += 1;
      if (opts.pipelineDraftMissing) {
        throw new BuildPipelineError(
          'draft_not_found',
          `BuildPipeline: draft '${input.draftId}' not found`,
        );
      }
      if (opts.specInvalid) {
        throw new BuildPipelineError(
          'spec_invalid',
          `BuildPipeline: draft '${input.draftId}' spec failed Zod validation`,
          new Error('zod: missing required field'),
        );
      }
      if (opts.codegenIssues && opts.codegenIssues.length > 0) {
        throw new BuildPipelineError(
          'codegen_failed',
          `BuildPipeline: codegen failed (${String(opts.codegenIssues.length)} issue(s))`,
          new CodegenError(opts.codegenIssues.map((i) => ({ ...i }))),
        );
      }
      const draft = await opts.store.load(input.userEmail, input.draftId);
      if (!draft) {
        throw new Error(
          `fake pipeline: draft not found ${input.userEmail}/${input.draftId}`,
        );
      }
      if (opts.failWith) {
        return {
          buildN,
          draft,
          buildResult: {
            ok: false as const,
            errors: opts.failingErrors ?? [],
            exitCode: 1,
            stdoutTail: '',
            stderrTail: 'tsc error: cannot find name X',
            durationMs: 1,
            reason: opts.failWith,
          },
        };
      }
      return {
        buildN,
        draft,
        buildResult: {
          ok: true as const,
          zip: opts.zipBytes ?? Buffer.from('PK-fake-zip'),
          zipPath: '/tmp/fake.zip',
          durationMs: 1,
        },
      };
    },
  };
  return {
    pipeline: fake as unknown as BuildPipeline,
    buildCalls: () => calls.slice(),
  };
}

interface FakeIngestHandle {
  service: PackageUploadService;
  ingestCalls: () => Array<{
    fileBuffer: Buffer;
    originalFilename: string;
    uploadedBy: string;
  }>;
}

function makeFakeIngest(opts: {
  /** Return failure with this code (and optional details). */
  failCode?: string;
  failMessage?: string;
  failDetails?: unknown;
  /** Override the pluginId in the success response. */
  pluginId?: string;
  pluginVersion?: string;
  pluginBytes?: number;
  /** Make ingest throw an unexpected exception. */
  throwError?: Error;
}): FakeIngestHandle {
  const calls: Array<{
    fileBuffer: Buffer;
    originalFilename: string;
    uploadedBy: string;
  }> = [];
  const fake = {
    ingest: async (input: {
      fileBuffer: Buffer;
      originalFilename: string;
      uploadedBy: string;
    }) => {
      calls.push({ ...input });
      if (opts.throwError) throw opts.throwError;
      if (opts.failCode) {
        return {
          ok: false as const,
          code: opts.failCode,
          message: opts.failMessage ?? 'fake-ingest failure',
          ...(opts.failDetails !== undefined ? { details: opts.failDetails } : {}),
        };
      }
      return {
        ok: true as const,
        plugin_id: opts.pluginId ?? 'de.test.installed.agent',
        version: opts.pluginVersion ?? '0.1.0',
        package: {
          id: opts.pluginId ?? 'de.test.installed.agent',
          version: opts.pluginVersion ?? '0.1.0',
          path: '/tmp/packages/de.test.installed.agent/0.1.0',
          uploaded_at: new Date().toISOString(),
          uploaded_by: input.uploadedBy,
          sha256: 'a'.repeat(64),
          peers_missing: [] as string[],
          zip_bytes: opts.pluginBytes ?? input.fileBuffer.byteLength,
          extracted_bytes: 1024,
          file_count: 5,
        },
      };
    },
  };
  return {
    service: fake as unknown as PackageUploadService,
    ingestCalls: () => calls.slice(),
  };
}

interface Harness {
  store: DraftStore;
  draftId: string;
  userEmail: string;
  tmpRoot: string;
  close: () => Promise<void>;
}

async function makeHarness(opts: {
  specOverrides?: Record<string, unknown>;
} = {}): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'install-commit-test-'));
  const dbPath = path.join(tmpRoot, 'drafts.db');
  const store = new DraftStore({ dbPath });
  await store.open();
  const userEmail = 'tester@example.com';
  const draft = await store.create(userEmail, 'Install Test');

  // Pre-populate spec with id+version so the orchestrator can derive a
  // sensible zip filename.
  const baseSpec: Record<string, unknown> = {
    id: 'de.test.draft.installcommit',
    version: '0.1.0',
    name: 'Install Test',
    description: 'fixture',
    category: 'analysis',
    template: 'agent-integration',
    ...(opts.specOverrides ?? {}),
  };
  await store.update(userEmail, draft.id, {
    spec: baseSpec as never,
  });

  return {
    store,
    draftId: draft.id,
    userEmail,
    tmpRoot,
    async close() {
      await store.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

describe('installDraft (B.6-1 orchestrator)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('happy path → marks draft installed and returns plugin id+version', async () => {
    const pipeline = makeFakePipeline({ store: h.store });
    const ingest = makeFakeIngest({ pluginId: 'de.test.draft.installcommit', pluginVersion: '0.1.0' });

    const result = await installDraft(
      { userEmail: h.userEmail, draftId: h.draftId },
      {
        draftStore: h.store,
        buildPipeline: pipeline.pipeline,
        packageUploadService: ingest.service,
        log: () => {},
      },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.installedAgentId, 'de.test.draft.installcommit');
    assert.equal(result.version, '0.1.0');
    assert.ok(result.packageBytes > 0);

    // Draft is now status=installed and pinned to the agent id.
    const refreshed = await h.store.load(h.userEmail, h.draftId);
    assert.ok(refreshed);
    assert.equal(refreshed.status, 'installed');
    assert.equal(refreshed.installedAgentId, 'de.test.draft.installcommit');

    // Pipeline + ingest each saw exactly one call.
    assert.equal(pipeline.buildCalls().length, 1);
    const ingestCall = ingest.ingestCalls()[0];
    assert.ok(ingestCall);
    assert.equal(ingestCall.uploadedBy, h.userEmail);
    assert.match(
      ingestCall.originalFilename,
      /^de\.test\.draft\.installcommit-0\.1\.0\.zip$/,
    );
  });

  it('build_failed → returns reason build_failed, draft NOT marked installed', async () => {
    const pipeline = makeFakePipeline({
      store: h.store,
      failWith: 'tsc',
      failingErrors: [
        {
          path: 'plugin.ts',
          line: 12,
          col: 3,
          code: 'TS2304',
          message: "Cannot find name 'fooBar'",
        },
      ],
    });
    const ingest = makeFakeIngest({});

    const result = await installDraft(
      { userEmail: h.userEmail, draftId: h.draftId },
      {
        draftStore: h.store,
        buildPipeline: pipeline.pipeline,
        packageUploadService: ingest.service,
        log: () => {},
      },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'build_failed');
    assert.equal(result.code, 'builder.build_failed.tsc');
    assert.ok(typeof result.message === 'string' && result.message.length > 0);

    // No ingest happened, draft stays in `draft` status.
    assert.equal(ingest.ingestCalls().length, 0);
    const refreshed = await h.store.load(h.userEmail, h.draftId);
    assert.ok(refreshed);
    assert.equal(refreshed.status, 'draft');
    assert.equal(refreshed.installedAgentId, null);
  });

  it('codegen_failed → reason codegen_failed with issues in details', async () => {
    const pipeline = makeFakePipeline({
      store: h.store,
      codegenIssues: [
        { code: 'missing_required_slot', detail: 'slot toolkit-impl is required' },
        { code: 'placeholder_residue', detail: 'unresolved {{INTEGRATION_ID}}' },
      ],
    });
    const ingest = makeFakeIngest({});

    const result = await installDraft(
      { userEmail: h.userEmail, draftId: h.draftId },
      {
        draftStore: h.store,
        buildPipeline: pipeline.pipeline,
        packageUploadService: ingest.service,
        log: () => {},
      },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'codegen_failed');
    assert.equal(result.code, 'builder.codegen_failed');
    const details = result.details as { issues: unknown[] } | undefined;
    assert.ok(details, 'expected details with issues');
    assert.equal(details.issues.length, 2);
    assert.equal(ingest.ingestCalls().length, 0);
  });

  it('spec_invalid → reason spec_invalid with serialized cause', async () => {
    const pipeline = makeFakePipeline({ store: h.store, specInvalid: true });
    const ingest = makeFakeIngest({});
    const result = await installDraft(
      { userEmail: h.userEmail, draftId: h.draftId },
      {
        draftStore: h.store,
        buildPipeline: pipeline.pipeline,
        packageUploadService: ingest.service,
        log: () => {},
      },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'spec_invalid');
    assert.equal(result.code, 'builder.spec_invalid');
    assert.equal(ingest.ingestCalls().length, 0);
  });

  it('draft_not_found from pipeline → reason draft_not_found', async () => {
    const pipeline = makeFakePipeline({
      store: h.store,
      pipelineDraftMissing: true,
    });
    const ingest = makeFakeIngest({});
    const result = await installDraft(
      { userEmail: h.userEmail, draftId: h.draftId },
      {
        draftStore: h.store,
        buildPipeline: pipeline.pipeline,
        packageUploadService: ingest.service,
        log: () => {},
      },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'draft_not_found');
    assert.equal(ingest.ingestCalls().length, 0);
  });

  it('conflict ingest code → reason conflict (id_conflict_builtin)', async () => {
    const pipeline = makeFakePipeline({ store: h.store });
    const ingest = makeFakeIngest({
      failCode: 'package.id_conflict_builtin',
      failMessage:
        'Plugin-ID "de.byte5.integration.odoo" kollidiert mit Built-in.',
    });
    const result = await installDraft(
      { userEmail: h.userEmail, draftId: h.draftId },
      {
        draftStore: h.store,
        buildPipeline: pipeline.pipeline,
        packageUploadService: ingest.service,
        log: () => {},
      },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'conflict');
    assert.equal(result.code, 'package.id_conflict_builtin');

    const refreshed = await h.store.load(h.userEmail, h.draftId);
    assert.ok(refreshed);
    assert.equal(refreshed.status, 'draft');
    assert.equal(refreshed.installedAgentId, null);
  });

  it('conflict ingest code → reason conflict (duplicate_version)', async () => {
    const pipeline = makeFakePipeline({ store: h.store });
    const ingest = makeFakeIngest({
      failCode: 'package.duplicate_version',
      failMessage: 'Version 0.1.0 already uploaded.',
    });
    const result = await installDraft(
      { userEmail: h.userEmail, draftId: h.draftId },
      {
        draftStore: h.store,
        buildPipeline: pipeline.pipeline,
        packageUploadService: ingest.service,
        log: () => {},
      },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'conflict');
    assert.equal(result.code, 'package.duplicate_version');
  });

  it('too_large ingest code → reason too_large', async () => {
    const pipeline = makeFakePipeline({ store: h.store });
    const ingest = makeFakeIngest({
      failCode: 'package.too_large',
      failMessage: 'Upload überschreitet 10MB.',
    });
    const result = await installDraft(
      { userEmail: h.userEmail, draftId: h.draftId },
      {
        draftStore: h.store,
        buildPipeline: pipeline.pipeline,
        packageUploadService: ingest.service,
        log: () => {},
      },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'too_large');
  });

  it('manifest_invalid ingest code → reason manifest_invalid', async () => {
    const pipeline = makeFakePipeline({ store: h.store });
    const ingest = makeFakeIngest({
      failCode: 'package.id_mismatch',
      failMessage: 'package.json.name mismatch',
    });
    const result = await installDraft(
      { userEmail: h.userEmail, draftId: h.draftId },
      {
        draftStore: h.store,
        buildPipeline: pipeline.pipeline,
        packageUploadService: ingest.service,
        log: () => {},
      },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'manifest_invalid');
    assert.equal(result.code, 'package.id_mismatch');
  });

  it('unmapped ingest code → reason ingest_failed', async () => {
    const pipeline = makeFakePipeline({ store: h.store });
    const ingest = makeFakeIngest({
      failCode: 'package.unknown_code',
      failMessage: 'Some new failure mode',
    });
    const result = await installDraft(
      { userEmail: h.userEmail, draftId: h.draftId },
      {
        draftStore: h.store,
        buildPipeline: pipeline.pipeline,
        packageUploadService: ingest.service,
        log: () => {},
      },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'ingest_failed');
    assert.equal(result.code, 'package.unknown_code');
  });

  it('ingest throws unexpectedly → reason ingest_failed with builder.ingest_threw', async () => {
    const pipeline = makeFakePipeline({ store: h.store });
    const ingest = makeFakeIngest({
      throwError: new Error('disk write failed'),
    });
    const result = await installDraft(
      { userEmail: h.userEmail, draftId: h.draftId },
      {
        draftStore: h.store,
        buildPipeline: pipeline.pipeline,
        packageUploadService: ingest.service,
        log: () => {},
      },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'ingest_failed');
    assert.equal(result.code, 'builder.ingest_threw');
    assert.match(result.message, /disk write failed/);
  });

  it('owner-scoped: install for wrong user → fails (draft_not_found via update miss)', async () => {
    // The pipeline fake is owner-aware because it calls store.load(); a
    // foreign user_email returns no draft → BuildPipelineError(draft_not_found).
    const pipeline = makeFakePipeline({
      store: h.store,
      pipelineDraftMissing: true,
    });
    const ingest = makeFakeIngest({});
    const result = await installDraft(
      { userEmail: 'attacker@example.com', draftId: h.draftId },
      {
        draftStore: h.store,
        buildPipeline: pipeline.pipeline,
        packageUploadService: ingest.service,
        log: () => {},
      },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'draft_not_found');
  });
});
