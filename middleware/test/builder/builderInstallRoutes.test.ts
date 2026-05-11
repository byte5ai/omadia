import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { DraftQuota } from '../../src/plugins/builder/draftQuota.js';
import {
  BuildPipelineError,
  type BuildPipeline,
} from '../../src/plugins/builder/buildPipeline.js';
import { CodegenError } from '../../src/plugins/builder/codegen.js';
import type { PackageUploadService } from '../../src/plugins/packageUploadService.js';
import { createBuilderRouter } from '../../src/routes/builder.js';

function withSessionEmail(email: string | null): express.RequestHandler {
  return (req, _res, next) => {
    (req as unknown as { session: { email: string | null } }).session = {
      email,
    };
    next();
  };
}

function makeFakePipeline(opts: {
  store: DraftStore;
  failWith?: 'tsc' | 'timeout';
  failingErrors?: ReadonlyArray<{
    path: string;
    line: number;
    col: number;
    code: string;
    message: string;
  }>;
  codegenIssues?: ReadonlyArray<{
    code:
      | 'spec_validation'
      | 'missing_required_slot'
      | 'missing_marker'
      | 'placeholder_residue';
    detail: string;
  }>;
}): BuildPipeline {
  let buildN = 0;
  const fake = {
    run: async (input: { userEmail: string; draftId: string }) => {
      buildN += 1;
      if (opts.codegenIssues && opts.codegenIssues.length > 0) {
        throw new BuildPipelineError(
          'codegen_failed',
          `BuildPipeline: codegen failed (${String(opts.codegenIssues.length)} issue(s))`,
          new CodegenError(opts.codegenIssues.map((i) => ({ ...i }))),
        );
      }
      const draft = await opts.store.load(input.userEmail, input.draftId);
      if (!draft) {
        throw new BuildPipelineError(
          'draft_not_found',
          `BuildPipeline: draft '${input.draftId}' not found`,
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
            stderrTail: 'error TS2304',
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
          zip: Buffer.from('PK-fake'),
          zipPath: '/tmp/fake.zip',
          durationMs: 1,
        },
      };
    },
  };
  return fake as unknown as BuildPipeline;
}

function makeFakeIngest(opts: {
  failCode?: string;
  failMessage?: string;
  pluginId?: string;
  pluginVersion?: string;
}): PackageUploadService {
  const fake = {
    ingest: async (input: {
      fileBuffer: Buffer;
      originalFilename: string;
      uploadedBy: string;
    }) => {
      if (opts.failCode) {
        return {
          ok: false as const,
          code: opts.failCode,
          message: opts.failMessage ?? 'fake-ingest failure',
        };
      }
      return {
        ok: true as const,
        plugin_id: opts.pluginId ?? 'de.test.installed.agent',
        version: opts.pluginVersion ?? '0.1.0',
        package: {
          id: opts.pluginId ?? 'de.test.installed.agent',
          version: opts.pluginVersion ?? '0.1.0',
          path: '/tmp/packages/x/0.1.0',
          uploaded_at: new Date().toISOString(),
          uploaded_by: input.uploadedBy,
          sha256: 'a'.repeat(64),
          peers_missing: [] as string[],
          zip_bytes: input.fileBuffer.byteLength,
          extracted_bytes: 1024,
          file_count: 5,
        },
      };
    },
  };
  return fake as unknown as PackageUploadService;
}

interface TestApp {
  server: Server;
  baseUrl: string;
  draftStore: DraftStore;
  draftId: string;
  userEmail: string;
  tmpRoot: string;
  setSession: (email: string | null) => void;
  close: () => Promise<void>;
}

async function createTestApp(opts: {
  pipeline?: BuildPipeline;
  ingest?: PackageUploadService;
  email?: string | null;
}): Promise<TestApp> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'builder-install-routes-'));
  const dbPath = path.join(tmpRoot, 'drafts.db');
  const draftStore = new DraftStore({ dbPath });
  await draftStore.open();
  const userEmail = 'tester@example.com';
  const draft = await draftStore.create(userEmail, 'Install Route Test');
  await draftStore.update(userEmail, draft.id, {
    spec: {
      id: 'de.test.routes.installcommit',
      version: '0.1.0',
      name: 'Install Route Test',
      description: 'fixture',
      category: 'analysis',
      template: 'agent-integration',
    } as never,
  });
  const draftQuota = new DraftQuota({ store: draftStore, max: 50 });
  let sessionEmail: string | null =
    opts.email === undefined ? userEmail : opts.email;

  const pipeline =
    opts.pipeline ?? makeFakePipeline({ store: draftStore });
  const ingest = opts.ingest ?? makeFakeIngest({});

  const app: Express = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { email: string | null } }).session = {
      email: sessionEmail,
    };
    next();
  });
  app.use(
    '/api/v1/builder',
    createBuilderRouter({
      store: draftStore,
      quota: draftQuota,
      install: {
        draftStore,
        buildPipeline: pipeline,
        packageUploadService: ingest,
        quota: draftQuota,
        log: () => {},
      },
    }),
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    draftStore,
    draftId: draft.id,
    userEmail,
    tmpRoot,
    setSession(email) {
      sessionEmail = email;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await draftStore.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

async function postJson(
  baseUrl: string,
  url: string,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

void withSessionEmail; // silence "unused import" — kept for parallel route tests

describe('POST /api/v1/builder/drafts/:id/install (B.6-1)', () => {
  let app: TestApp;
  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns 200 with plugin_id+version on happy path and marks draft installed', async () => {
    app = await createTestApp({
      ingest: makeFakeIngest({
        pluginId: 'de.test.routes.installcommit',
        pluginVersion: '0.1.0',
      }),
    });
    const { status, json } = await postJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/install`,
    );
    assert.equal(status, 200);
    assert.ok(json);
    assert.equal(json['ok'], true);
    assert.equal(json['installedAgentId'], 'de.test.routes.installcommit');
    assert.equal(json['version'], '0.1.0');

    const refreshed = await app.draftStore.load(app.userEmail, app.draftId);
    assert.ok(refreshed);
    assert.equal(refreshed.status, 'installed');
    assert.equal(refreshed.installedAgentId, 'de.test.routes.installcommit');
  });

  it('returns 401 when session is missing', async () => {
    app = await createTestApp({ email: null });
    const { status, json } = await postJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/install`,
    );
    assert.equal(status, 401);
    assert.ok(json);
    assert.equal(json['code'], 'auth.missing');
  });

  it('returns 404 when the draft does not exist for this user', async () => {
    app = await createTestApp({});
    app.setSession('attacker@example.com');
    const { status, json } = await postJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/install`,
    );
    assert.equal(status, 404);
    assert.ok(json);
    assert.equal(json['ok'], false);
    assert.equal(json['reason'], 'draft_not_found');
  });

  it('returns 409 with reason=conflict on package.id_conflict_builtin', async () => {
    app = await createTestApp({
      ingest: makeFakeIngest({
        failCode: 'package.id_conflict_builtin',
        failMessage:
          'Plugin-ID "de.byte5.integration.odoo" kollidiert mit Built-in.',
      }),
    });
    const { status, json } = await postJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/install`,
    );
    assert.equal(status, 409);
    assert.ok(json);
    assert.equal(json['ok'], false);
    assert.equal(json['reason'], 'conflict');
    assert.equal(json['code'], 'package.id_conflict_builtin');

    const refreshed = await app.draftStore.load(app.userEmail, app.draftId);
    assert.ok(refreshed);
    assert.equal(refreshed.status, 'draft');
    assert.equal(refreshed.installedAgentId, null);
  });

  it('returns 409 with reason=conflict on package.duplicate_version', async () => {
    app = await createTestApp({
      ingest: makeFakeIngest({
        failCode: 'package.duplicate_version',
        failMessage: 'Version 0.1.0 already uploaded.',
      }),
    });
    const { status, json } = await postJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/install`,
    );
    assert.equal(status, 409);
    assert.ok(json);
    assert.equal(json['reason'], 'conflict');
  });

  it('returns 422 with reason=build_failed and surfaces tsc errors in details', async () => {
    app = await createTestApp({
      pipeline: makeFakePipeline({
        store: undefined as unknown as DraftStore,
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
      }),
    });
    // The fake above intentionally has no store; rebuild with the real store
    // wired in.
    await app.close();
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'install-routes-tsc-'));
    const draftStore = new DraftStore({
      dbPath: path.join(tmpRoot, 'drafts.db'),
    });
    await draftStore.open();
    const userEmail = 'tester@example.com';
    const draft = await draftStore.create(userEmail, 'tsc-fail');
    await draftStore.update(userEmail, draft.id, {
      spec: {
        id: 'de.test.tsc.fail',
        version: '0.1.0',
        name: 'tsc-fail',
        description: 'fixture',
        category: 'analysis',
        template: 'agent-integration',
      } as never,
    });
    const draftQuota = new DraftQuota({ store: draftStore, max: 50 });
    const pipeline = makeFakePipeline({
      store: draftStore,
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
    const expressApp: Express = express();
    expressApp.use(express.json());
    expressApp.use(withSessionEmail(userEmail));
    expressApp.use(
      '/api/v1/builder',
      createBuilderRouter({
        store: draftStore,
        quota: draftQuota,
        install: {
          draftStore,
          buildPipeline: pipeline,
          packageUploadService: ingest,
          quota: draftQuota,
          log: () => {},
        },
      }),
    );
    const server: Server = await new Promise((resolve) => {
      const s = expressApp.listen(0, () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${String(port)}`;

    try {
      const { status, json } = await postJson(
        baseUrl,
        `/api/v1/builder/drafts/${draft.id}/install`,
      );
      assert.equal(status, 422);
      assert.ok(json);
      assert.equal(json['reason'], 'build_failed');
      assert.equal(json['code'], 'builder.build_failed.tsc');
      const details = json['details'] as { errors?: unknown[] } | undefined;
      assert.ok(details);
      assert.ok(Array.isArray(details.errors) && details.errors.length === 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await draftStore.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
    // Make sure the outer afterEach close() doesn't double-close.
    app = undefined as unknown as TestApp;
  });

  it('returns 422 with reason=codegen_failed and exposes issues', async () => {
    app = await createTestApp({
      pipeline: makeFakePipeline({
        store: undefined as unknown as DraftStore,
        codegenIssues: [
          { code: 'placeholder_residue', detail: 'unresolved {{X}}' },
        ],
      }),
    });
    const { status, json } = await postJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/install`,
    );
    assert.equal(status, 422);
    assert.ok(json);
    assert.equal(json['reason'], 'codegen_failed');
    assert.equal(json['code'], 'builder.codegen_failed');
    const details = json['details'] as { issues?: unknown[] } | undefined;
    assert.ok(details);
    assert.ok(Array.isArray(details.issues) && details.issues.length === 1);
  });

  it('returns 413 when ingest reports package.too_large', async () => {
    app = await createTestApp({
      ingest: makeFakeIngest({
        failCode: 'package.too_large',
        failMessage: 'Upload überschreitet 10MB.',
      }),
    });
    const { status, json } = await postJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/install`,
    );
    assert.equal(status, 413);
    assert.ok(json);
    assert.equal(json['reason'], 'too_large');
  });

  it('returns 422 when ingest reports a manifest-validation code', async () => {
    app = await createTestApp({
      ingest: makeFakeIngest({
        failCode: 'package.id_mismatch',
        failMessage: 'package.json.name does not match manifest id',
      }),
    });
    const { status, json } = await postJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/install`,
    );
    assert.equal(status, 422);
    assert.ok(json);
    assert.equal(json['reason'], 'manifest_invalid');
    assert.equal(json['code'], 'package.id_mismatch');
  });

  it('returns 500 when ingest fails with an unmapped code', async () => {
    app = await createTestApp({
      ingest: makeFakeIngest({
        failCode: 'package.unknown_failure',
        failMessage: 'something else',
      }),
    });
    const { status, json } = await postJson(
      app.baseUrl,
      `/api/v1/builder/drafts/${app.draftId}/install`,
    );
    assert.equal(status, 500);
    assert.ok(json);
    assert.equal(json['reason'], 'ingest_failed');
  });
});

describe('POST /api/v1/builder/drafts/from-installed/:agentId (B.6-3)', () => {
  let app: TestApp;
  afterEach(async () => {
    if (app) await app.close();
  });

  it('returns 201 with new draftId on happy path; source draft stays installed', async () => {
    app = await createTestApp({});
    // Pretend the seeded draft was installed against agent_id "de.byte5.agent.x"
    await app.draftStore.update(app.userEmail, app.draftId, {
      status: 'installed',
      installedAgentId: 'de.byte5.agent.x',
    });

    const { status, json } = await postJson(
      app.baseUrl,
      `/api/v1/builder/drafts/from-installed/de.byte5.agent.x`,
    );
    assert.equal(status, 201);
    assert.ok(json);
    assert.equal(json['ok'], true);
    assert.equal(json['installedAgentId'], 'de.byte5.agent.x');
    assert.equal(json['sourceDraftId'], app.draftId);
    const newDraftId = json['draftId'];
    assert.equal(typeof newDraftId, 'string');

    // New draft is in `draft` status, no installed_agent_id link.
    const cloned = await app.draftStore.load(
      app.userEmail,
      newDraftId as string,
    );
    assert.ok(cloned);
    assert.equal(cloned.status, 'draft');
    assert.equal(cloned.installedAgentId, null);

    // Source draft still installed + pinned.
    const source = await app.draftStore.load(app.userEmail, app.draftId);
    assert.ok(source);
    assert.equal(source.status, 'installed');
    assert.equal(source.installedAgentId, 'de.byte5.agent.x');
  });

  it('returns 401 when session is missing', async () => {
    app = await createTestApp({ email: null });
    const { status, json } = await postJson(
      app.baseUrl,
      `/api/v1/builder/drafts/from-installed/de.byte5.agent.x`,
    );
    assert.equal(status, 401);
    assert.ok(json);
    assert.equal(json['code'], 'auth.missing');
  });

  it('returns 404 when no source draft pins this agentId for the user', async () => {
    app = await createTestApp({});
    // No draft has installed_agent_id set yet.
    const { status, json } = await postJson(
      app.baseUrl,
      `/api/v1/builder/drafts/from-installed/de.byte5.agent.never-installed`,
    );
    assert.equal(status, 404);
    assert.ok(json);
    assert.equal(json['ok'], false);
    assert.equal(json['reason'], 'source_not_found');
  });

  it('returns 404 when the source draft belongs to another user (owner-scoped)', async () => {
    app = await createTestApp({});
    await app.draftStore.update(app.userEmail, app.draftId, {
      status: 'installed',
      installedAgentId: 'de.byte5.agent.x',
    });
    app.setSession('attacker@example.com');
    const { status, json } = await postJson(
      app.baseUrl,
      `/api/v1/builder/drafts/from-installed/de.byte5.agent.x`,
    );
    assert.equal(status, 404);
    assert.ok(json);
    assert.equal(json['reason'], 'source_not_found');
  });
});
