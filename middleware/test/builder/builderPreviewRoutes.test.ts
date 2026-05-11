import { describe, it, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import type { Server } from 'node:http';

import { DraftStore } from '../../src/plugins/builder/draftStore.js';
import { DraftQuota } from '../../src/plugins/builder/draftQuota.js';
import { PreviewCache } from '../../src/plugins/builder/previewCache.js';
import { PreviewSecretBuffer } from '../../src/plugins/builder/previewSecretBuffer.js';
import { PreviewRebuildScheduler } from '../../src/plugins/builder/previewRebuildScheduler.js';
import { SpecEventBus } from '../../src/plugins/builder/specEventBus.js';
import {
  PreviewChatService,
  type PreviewChatEvent,
} from '../../src/plugins/builder/previewChatService.js';
import type {
  PreviewActivateOptions,
  PreviewHandle,
} from '../../src/plugins/builder/previewRuntime.js';
import { createBuilderRouter } from '../../src/routes/builder.js';
import type { BuildPipeline } from '../../src/plugins/builder/buildPipeline.js';

// Augment express Request with the session shape the production code expects.
declare module 'express-serve-static-core' {
  interface Request {
    session?: { email?: string };
  }
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakeHandle(opts: {
  draftId: string;
  rev: number;
  agentId?: string;
}): PreviewHandle {
  return {
    draftId: opts.draftId,
    agentId: opts.agentId ?? `agent-${opts.draftId}`,
    rev: opts.rev,
    previewDir: `/tmp/preview-${opts.draftId}`,
    toolkit: { tools: [] },
    routeCaptures: [],
    close: async () => {},
  };
}

interface FakePipelineHandle {
  pipeline: BuildPipeline;
  buildCalls: () => Array<{ userEmail: string; draftId: string }>;
}

function makeFakePipeline(opts: {
  store: DraftStore;
  /** Force a build failure (return BuildResult { ok: false }). */
  failWith?: 'tsc' | 'timeout';
  /** Populate the build-failure `errors[]` so the route can surface them. */
  failingErrors?: ReadonlyArray<{
    path: string;
    line: number;
    col: number;
    code: string;
    message: string;
  }>;
  /** Throw CodegenError directly with these issues (mimics the real
   *  BuildPipeline.run codegen-step throw before sandbox runs). */
  codegenIssues?: ReadonlyArray<{ code: string; detail: string }>;
}): FakePipelineHandle {
  const calls: Array<{ userEmail: string; draftId: string }> = [];
  let buildN = 0;
  const fake = {
    run: async (input: { userEmail: string; draftId: string }) => {
      calls.push(input);
      buildN += 1;
      const draft = await opts.store.load(input.userEmail, input.draftId);
      if (!draft) {
        throw new Error(
          `fake pipeline: draft not found ${input.userEmail}/${input.draftId}`,
        );
      }
      if (opts.codegenIssues && opts.codegenIssues.length > 0) {
        const { CodegenError } = await import(
          '../../src/plugins/builder/codegen.js'
        );
        const { BuildPipelineError } = await import(
          '../../src/plugins/builder/buildPipeline.js'
        );
        throw new BuildPipelineError(
          'codegen_failed',
          `BuildPipeline: codegen failed (${String(opts.codegenIssues.length)} issue(s))`,
          new CodegenError(
            opts.codegenIssues.map((i) => ({
              code: i.code as
                | 'spec_validation'
                | 'missing_required_slot'
                | 'missing_marker'
                | 'placeholder_residue',
              detail: i.detail,
            })),
          ),
        );
      }
      if (opts.failWith) {
        return {
          buildN,
          draft,
          buildResult: {
            ok: false,
            errors: opts.failingErrors ?? [],
            exitCode: 1,
            stdoutTail: '',
            stderrTail: '',
            durationMs: 1,
            reason: opts.failWith,
          },
        };
      }
      return {
        buildN,
        draft,
        buildResult: {
          ok: true,
          zip: Buffer.from('PK-fake'),
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

interface RouteHarness {
  baseUrl: string;
  server: Server;
  store: DraftStore;
  buffer: PreviewSecretBuffer;
  cache: PreviewCache;
  chatService: PreviewChatService;
  scheduler: PreviewRebuildScheduler;
  buildCalls: () => Array<{ userEmail: string; draftId: string }>;
  setSession: (email: string | null) => void;
  close: () => Promise<void>;
}

async function startHarness(opts: {
  tmpDir: string;
  scriptedChatEvents?: PreviewChatEvent[];
  pipelineFail?: 'tsc' | 'timeout';
  failingErrors?: ReadonlyArray<{
    path: string;
    line: number;
    col: number;
    code: string;
    message: string;
  }>;
  codegenIssues?: ReadonlyArray<{ code: string; detail: string }>;
}): Promise<RouteHarness> {
  const dbPath = path.join(
    opts.tmpDir,
    `drafts-${String(Date.now())}-${String(Math.random())}.db`,
  );
  const store = new DraftStore({ dbPath });
  await store.open();
  const quota = new DraftQuota({ store });
  const buffer = new PreviewSecretBuffer();

  const fakeActivate = async (
    activateOpts: PreviewActivateOptions,
  ): Promise<PreviewHandle> => {
    return makeFakeHandle({
      draftId: activateOpts.draftId,
      rev: activateOpts.rev,
    });
  };
  const cache = new PreviewCache({
    activate: fakeActivate,
    warmSlots: 3,
    logger: () => {},
  });

  const chatService = new PreviewChatService({
    anthropic: {} as never,
    draftStore: store,
    systemPromptFor: async () => 'sp',
    buildSubAgent: () => ({
      ask: async (
        _q: string,
        observer?: {
          onSubToolUse?: (e: { id: string; name: string; input: unknown }) => void;
          onSubToolResult?: (e: {
            id: string;
            output: string;
            durationMs: number;
            isError: boolean;
          }) => void;
        },
      ) => {
        for (const ev of opts.scriptedChatEvents ?? []) {
          if (ev.type === 'tool_use') {
            observer?.onSubToolUse?.({
              id: ev.useId,
              name: ev.toolId,
              input: ev.input,
            });
          } else if (ev.type === 'tool_result') {
            observer?.onSubToolResult?.({
              id: ev.useId,
              output: ev.output,
              durationMs: ev.durationMs,
              isError: ev.isError,
            });
          }
        }
        const finalMsg = opts.scriptedChatEvents?.find(
          (e) => e.type === 'chat_message' && e.role === 'assistant',
        );
        return finalMsg && finalMsg.type === 'chat_message'
          ? finalMsg.text
          : 'OK';
      },
    }),
    logger: () => {},
  });

  const fakePipeline = makeFakePipeline({
    store,
    ...(opts.pipelineFail ? { failWith: opts.pipelineFail } : {}),
    ...(opts.failingErrors ? { failingErrors: opts.failingErrors } : {}),
    ...(opts.codegenIssues ? { codegenIssues: opts.codegenIssues } : {}),
  });

  const scheduler = new PreviewRebuildScheduler({
    debounceMs: 50,
    invalidate: (u, d) => {
      cache.invalidate(u, d);
    },
    rebuild: async () => {},
    onError: () => {},
  });

  let session: { email?: string } | null = null;
  const setSession = (email: string | null): void => {
    session = email ? { email } : null;
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (session) {
      req.session = session;
    }
    next();
  });
  app.use(
    '/api/v1/builder',
    createBuilderRouter({
      store,
      quota,
      preview: {
        draftStore: store,
        previewCache: cache,
        previewChatService: chatService,
        buildPipeline: fakePipeline.pipeline,
        previewSecretBuffer: buffer,
        rebuildScheduler: scheduler,
        bus: new SpecEventBus(),
        turnTimeoutMs: 30_000,
      },
    }),
  );

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    scheduler.cancelAll();
    await store.close();
  };

  return {
    baseUrl,
    server,
    store,
    buffer,
    cache,
    chatService,
    scheduler,
    buildCalls: fakePipeline.buildCalls,
    setSession,
    close,
  };
}

interface NdjsonChunk {
  type: string;
  [k: string]: unknown;
}

async function readNdjson(res: Response): Promise<NdjsonChunk[]> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as NdjsonChunk);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('builder preview routes', () => {
  let tmp: string;
  let harness: RouteHarness;

  before(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'builder-preview-routes-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (harness) await harness.close();
  });

  describe('POST /preview/chat/turn', () => {
    it('streams build_status, chat_message, tool events, and turn_done as NDJSON', async () => {
      harness = await startHarness({
        tmpDir: tmp,
        scriptedChatEvents: [
          {
            type: 'tool_use',
            useId: 'u1',
            toolId: 'echo',
            input: { q: 'hi' },
          },
          {
            type: 'tool_result',
            useId: 'u1',
            toolId: 'echo',
            output: 'ok',
            isError: false,
            durationMs: 1,
          },
          {
            type: 'chat_message',
            role: 'assistant',
            text: 'final answer',
          },
        ],
      });
      harness.setSession('alice@example.com');
      const draft = await harness.store.create('alice@example.com', 'Echo');

      const res = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/${draft.id}/preview/chat/turn`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hello', model: 'haiku' }),
        },
      );
      assert.equal(res.status, 200);
      const events = await readNdjson(res);
      const types = events.map((e) => e.type);
      assert.equal(types[0], 'build_status', 'first event = build_status');
      assert.ok(
        types.includes('chat_message'),
        'has at least one chat_message',
      );
      assert.ok(types.includes('tool_use'));
      assert.ok(types.includes('tool_result'));
      assert.ok(types.includes('turn_done'));

      // Verify pipeline ran and pushed a build through.
      const calls = harness.buildCalls();
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.userEmail, 'alice@example.com');
      assert.equal(calls[0]?.draftId, draft.id);
    });

    it('rejects unauthenticated requests with 401 JSON', async () => {
      harness = await startHarness({ tmpDir: tmp });
      const res = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/x/preview/chat/turn`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hi' }),
        },
      );
      assert.equal(res.status, 401);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'auth.missing');
    });

    it('returns 400 for empty message', async () => {
      harness = await startHarness({ tmpDir: tmp });
      harness.setSession('a@x');
      const res = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/x/preview/chat/turn`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: '   ' }),
        },
      );
      assert.equal(res.status, 400);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'builder.invalid_message');
    });

    it('returns 400 for unknown model', async () => {
      harness = await startHarness({ tmpDir: tmp });
      harness.setSession('a@x');
      const res = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/x/preview/chat/turn`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hi', model: 'banana' }),
        },
      );
      assert.equal(res.status, 400);
    });

    it('streams build_status.failed with codegenIssues when codegen throws', async () => {
      harness = await startHarness({
        tmpDir: tmp,
        codegenIssues: [
          { code: 'spec_validation', detail: 'depends_on must be an array' },
          { code: 'missing_required_slot', detail: 'slot "skill" missing' },
          { code: 'missing_marker', detail: 'marker {{tools}} not found' },
        ],
      });
      harness.setSession('alice@example.com');
      const draft = await harness.store.create('alice@example.com', 'Bad');
      const res = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/${draft.id}/preview/chat/turn`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hi' }),
        },
      );
      assert.equal(res.status, 200);
      const events = await readNdjson(res);
      const failed = events.find(
        (e) =>
          e.type === 'build_status' &&
          (e as { phase?: string }).phase === 'failed',
      ) as
        | {
            type: 'build_status';
            phase: string;
            reason?: string;
            codegenIssues?: Array<{ code: string; detail: string }>;
          }
        | undefined;
      assert.ok(failed, 'expected a build_status:failed event');
      assert.equal(failed.reason, 'codegen_failed');
      assert.equal(failed.codegenIssues?.length, 3);
      assert.equal(failed.codegenIssues?.[0]?.code, 'spec_validation');
      assert.equal(
        failed.codegenIssues?.[0]?.detail,
        'depends_on must be an array',
      );
    });

    it('streams build_status.failed with errors[] when sandbox tsc fails', async () => {
      harness = await startHarness({
        tmpDir: tmp,
        pipelineFail: 'tsc',
        failingErrors: [
          {
            path: 'src/plugin.ts',
            line: 12,
            col: 4,
            code: 'TS2304',
            message: "Cannot find name 'frobnicate'.",
          },
        ],
      });
      harness.setSession('alice@example.com');
      const draft = await harness.store.create('alice@example.com', 'Bad');
      const res = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/${draft.id}/preview/chat/turn`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hi' }),
        },
      );
      assert.equal(res.status, 200);
      const events = await readNdjson(res);
      const failed = events.find(
        (e) =>
          e.type === 'build_status' &&
          (e as { phase?: string }).phase === 'failed',
      ) as
        | {
            type: 'build_status';
            phase: string;
            errors?: Array<{
              file: string;
              line: number;
              column: number;
              code: string;
              message: string;
            }>;
          }
        | undefined;
      assert.ok(failed, 'expected a build_status:failed event');
      assert.equal(failed.errors?.length, 1);
      assert.equal(failed.errors?.[0]?.file, 'src/plugin.ts');
      assert.equal(failed.errors?.[0]?.line, 12);
      assert.equal(failed.errors?.[0]?.column, 4);
      assert.equal(failed.errors?.[0]?.code, 'TS2304');
    });

    it('falls back to draft.previewModel when no model is supplied', async () => {
      harness = await startHarness({
        tmpDir: tmp,
        scriptedChatEvents: [
          { type: 'chat_message', role: 'assistant', text: 'OK' },
        ],
      });
      harness.setSession('alice@example.com');
      const draft = await harness.store.create('alice@example.com', 'Echo');
      await harness.store.update('alice@example.com', draft.id, {
        previewModel: 'opus',
      });
      const res = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/${draft.id}/preview/chat/turn`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hi' }),
        },
      );
      assert.equal(res.status, 200);
      const events = await readNdjson(res);
      assert.ok(events.length > 0);
    });
  });

  describe('POST /preview/tool-call', () => {
    it('returns 200 + result/isError JSON for a known tool', async () => {
      harness = await startHarness({ tmpDir: tmp });
      harness.setSession('alice@example.com');
      const draft = await harness.store.create('alice@example.com', 'Echo');
      // Pre-warm the cache so we don't go through the pipeline.
      await harness.cache.ensureWarm({
        userEmail: 'alice@example.com',
        draftId: draft.id,
        build: async () => ({
          zipBuffer: Buffer.alloc(0),
          rev: 1,
          configValues: {},
          secretValues: {},
        }),
      });
      // tool-call against an empty toolkit returns isError=true (unknown tool).
      const res = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/${draft.id}/preview/tool-call`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tool_id: 'nope', input: {} }),
        },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as { result: unknown; isError: boolean };
      assert.equal(body.isError, true);
    });

    it('returns 400 when tool_id is missing', async () => {
      harness = await startHarness({ tmpDir: tmp });
      harness.setSession('alice@example.com');
      const res = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/x/preview/tool-call`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: {} }),
        },
      );
      assert.equal(res.status, 400);
    });
  });

  describe('POST /preview/refresh', () => {
    it('invalidates + rebuilds and returns the new buildN', async () => {
      harness = await startHarness({ tmpDir: tmp });
      harness.setSession('alice@example.com');
      const draft = await harness.store.create('alice@example.com', 'Echo');

      const res = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/${draft.id}/preview/refresh`,
        { method: 'POST' },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        ok: boolean;
        buildN: number;
        agentId: string;
      };
      assert.equal(body.ok, true);
      assert.equal(body.buildN, 1);

      const calls = harness.buildCalls();
      assert.equal(calls.length, 1);
    });

    it('returns 500 with builder.codegen_failed when the pipeline fails', async () => {
      harness = await startHarness({ tmpDir: tmp, pipelineFail: 'tsc' });
      harness.setSession('alice@example.com');
      const draft = await harness.store.create('alice@example.com', 'Bad');
      const res = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/${draft.id}/preview/refresh`,
        { method: 'POST' },
      );
      assert.equal(res.status, 500);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'builder.codegen_failed');
    });
  });

  describe('PUT/DELETE /preview/secrets', () => {
    it('stores secrets in the buffer and clears them on DELETE', async () => {
      harness = await startHarness({ tmpDir: tmp });
      harness.setSession('alice@example.com');
      const draftId = 'd-secret';

      const put = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/${draftId}/preview/secrets`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ values: { API_KEY: 'k1' } }),
        },
      );
      assert.equal(put.status, 204);
      assert.deepEqual(harness.buffer.get('alice@example.com', draftId), {
        API_KEY: 'k1',
      });

      const del = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/${draftId}/preview/secrets`,
        { method: 'DELETE' },
      );
      assert.equal(del.status, 204);
      assert.equal(harness.buffer.has('alice@example.com', draftId), false);
    });

    it('rejects non-string secret values with 400', async () => {
      harness = await startHarness({ tmpDir: tmp });
      harness.setSession('alice@example.com');
      const res = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/d/preview/secrets`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ values: { API_KEY: 42 } }),
        },
      );
      assert.equal(res.status, 400);
    });
  });

  describe('GET /preview/secrets', () => {
    it('returns the buffered keys without leaking values', async () => {
      harness = await startHarness({ tmpDir: tmp });
      harness.setSession('alice@example.com');
      const draftId = 'd-status';

      // Seed two secrets
      await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/${draftId}/preview/secrets`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            values: { API_KEY: 'k1', GROUP_SLUG: 'meetup-de' },
          }),
        },
      );

      const res = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/${draftId}/preview/secrets`,
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as { keys?: string[] };
      assert.deepEqual(
        (body.keys ?? []).slice().sort(),
        ['API_KEY', 'GROUP_SLUG'],
      );
      // The bare values must not leak.
      const text = JSON.stringify(body);
      assert.equal(text.includes('k1'), false);
      assert.equal(text.includes('meetup-de'), false);
    });

    it('returns an empty list when nothing is buffered', async () => {
      harness = await startHarness({ tmpDir: tmp });
      harness.setSession('alice@example.com');
      const res = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/empty/preview/secrets`,
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as { keys?: string[] };
      assert.deepEqual(body.keys, []);
    });

    it('rejects with 401 when there is no session', async () => {
      harness = await startHarness({ tmpDir: tmp });
      harness.setSession(null);
      const res = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/d/preview/secrets`,
      );
      assert.equal(res.status, 401);
    });
  });

  describe('GET /drafts/:id/template/slots', () => {
    it('returns the boilerplate template manifest slots for the draft', async () => {
      harness = await startHarness({ tmpDir: tmp });
      harness.setSession('alice@example.com');
      const draft = await harness.store.create('alice@example.com', 'T');
      const res = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/${draft.id}/template/slots`,
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        template: string;
        slots: Array<{
          key: string;
          target_file: string;
          required: boolean;
          description?: string;
        }>;
      };
      assert.equal(typeof body.template, 'string');
      assert.ok(Array.isArray(body.slots));
      // The bundled `agent-integration` template declares the
      // client-impl / toolkit-impl / skill-prompt slots that the
      // workspace review surfaced.
      const required = body.slots.filter((s) => s.required).map((s) => s.key);
      assert.ok(required.length >= 1, 'at least one required slot exists');
    });

    it('returns 404 when the draft does not belong to the caller', async () => {
      harness = await startHarness({ tmpDir: tmp });
      harness.setSession('alice@example.com');
      const res = await fetch(
        `${harness.baseUrl}/api/v1/builder/drafts/no-such-draft/template/slots`,
      );
      assert.equal(res.status, 404);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, 'builder.draft_not_found');
    });
  });

  describe('non-preview B.0 routes still work without preview deps', () => {
    it('mounts builder router without preview and serves /models', async () => {
      const dbPath = path.join(tmp, `drafts-no-preview-${String(Math.random())}.db`);
      const store = new DraftStore({ dbPath });
      await store.open();
      const quota = new DraftQuota({ store });

      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.session = { email: 'a@x' };
        next();
      });
      app.use('/api/v1/builder', createBuilderRouter({ store, quota }));
      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const port = (server.address() as AddressInfo).port;

      const res = await fetch(`http://127.0.0.1:${String(port)}/api/v1/builder/models`);
      assert.equal(res.status, 200);

      // Preview routes must NOT be mounted in this configuration.
      const turn = await fetch(
        `http://127.0.0.1:${String(port)}/api/v1/builder/drafts/x/preview/chat/turn`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hi' }),
        },
      );
      // Express returns 404 for unmounted routes.
      assert.equal(turn.status, 404);

      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    });
  });
});
