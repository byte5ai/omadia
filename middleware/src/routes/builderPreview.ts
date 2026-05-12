import type { Router, Request, Response } from 'express';

import type { BuildPipeline } from '../plugins/builder/buildPipeline.js';
import { BuildPipelineError } from '../plugins/builder/buildPipeline.js';
import { CodegenError } from '../plugins/builder/codegen.js';
import type { BuildResult } from '../plugins/builder/buildSandbox.js';
import type { DraftStore } from '../plugins/builder/draftStore.js';
import type { PreviewCache } from '../plugins/builder/previewCache.js';
import type { RuntimeSmokeOrchestrator } from '../plugins/builder/runtimeSmokeOrchestrator.js';
import type {
  PreviewChatEvent,
  PreviewChatService,
} from '../plugins/builder/previewChatService.js';
import type { PreviewRebuildScheduler } from '../plugins/builder/previewRebuildScheduler.js';
import type { PreviewSecretBuffer } from '../plugins/builder/previewSecretBuffer.js';
import type { SpecEventBus } from '../plugins/builder/specEventBus.js';
import { BuilderModelRegistry } from '../plugins/builder/modelRegistry.js';
import type { BuilderModelId } from '../plugins/builder/types.js';

/**
 * Builder preview-surface routes (Phase B.3-4).
 *
 *   POST   /drafts/:id/preview/chat/turn      → NDJSON stream of PreviewChatEvent
 *   POST   /drafts/:id/preview/tool-call      → JSON { result, isError }
 *   POST   /drafts/:id/preview/refresh        → JSON { ok, build } (manual rebuild)
 *   GET    /drafts/:id/preview/secrets        → JSON { keys: string[] } (no values)
 *   PUT    /drafts/:id/preview/secrets        → 204 (set in-memory secret values)
 *   DELETE /drafts/:id/preview/secrets        → 204 (clear secret buffer for draft)
 *
 * Stream framing follows the kernel's existing convention (`chat.ts`): one
 * JSON object per line on `application/x-ndjson`. Same wire shape SSE would
 * carry, simpler parsing on the client. Each chat-turn stream emits at
 * minimum:
 *
 *   { type: "build_status", phase: "building" }
 *   ... (PreviewChatEvent variants — chat_message, tool_use, tool_result)
 *   { type: "build_status", phase: "ok" | "failed", … }
 *   { type: "turn_done", … }
 *
 * The endpoints assume `requireAuth` is mounted on the parent router.
 */

export interface BuilderPreviewDeps {
  draftStore: DraftStore;
  previewCache: PreviewCache;
  previewChatService: PreviewChatService;
  buildPipeline: BuildPipeline;
  previewSecretBuffer: PreviewSecretBuffer;
  rebuildScheduler: PreviewRebuildScheduler;
  /** SpecEventBus for emitting build_status on the manual-rebuild +
   *  chat-turn paths (B.6-13.3). Without this the Workspace's SSE
   *  consumer never sees tsc errors triggered by REBUILD-button or a
   *  chat-turn-driven rebuild — only auto-rebuilds in index.ts emit. */
  bus: SpecEventBus;
  /** Optional B.9-3 runtime-smoke orchestrator. When provided, fires a
   *  fire-and-forget smoke pass after every fresh ensureWarm activation;
   *  dedup'd per (draftId, rev) so repeated calls on the cached handle
   *  don't re-trigger. Tests omit it (smoke needs the whole preview
   *  toolkit). */
  runtimeSmokeOrchestrator?: RuntimeSmokeOrchestrator;
  /** Override the per-turn maximum NDJSON time-budget (ms). Default 600s. */
  turnTimeoutMs?: number;
}

export type PreviewStreamEvent =
  | PreviewChatEvent
  | {
      type: 'build_status';
      phase: 'building' | 'ok' | 'failed';
      buildN?: number;
      reason?: string;
      /** TSC/sandbox-level errors. Populated when the codegen step
       *  succeeded but the sandbox tsc compile failed. */
      errors?: ReadonlyArray<{
        file: string;
        line: number;
        column: number;
        code: string;
        message: string;
      }>;
      /** Codegen-step issues (spec validation, missing required slot,
       *  missing template marker, placeholder residue). Populated when
       *  the codegen step itself threw a CodegenError. */
      codegenIssues?: ReadonlyArray<{ code: string; detail: string }>;
    }
  | { type: 'error'; code: string; message: string };

const DEFAULT_TURN_TIMEOUT_MS = 600_000;

/**
 * Mounts the preview routes onto an existing router. Idempotent against
 * the same router instance — caller must guarantee a single registration.
 */
export function registerBuilderPreviewRoutes(
  router: Router,
  deps: BuilderPreviewDeps,
): void {
  // ── POST /drafts/:id/preview/chat/turn ────────────────────────────────────
  router.post(
    '/drafts/:id/preview/chat/turn',
    async (req: Request, res: Response) => {
      const email = readEmail(req);
      if (!email) {
        sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
        return;
      }
      const draftId = readId(req);
      if (!draftId) {
        sendJson(res, 400, {
          code: 'builder.invalid_id',
          message: 'missing :id',
        });
        return;
      }

      const body = (req.body ?? {}) as {
        message?: unknown;
        model?: unknown;
      };
      if (typeof body.message !== 'string' || body.message.trim().length === 0) {
        sendJson(res, 400, {
          code: 'builder.invalid_message',
          message: 'message must be a non-empty string',
        });
        return;
      }
      const message = body.message;

      let modelId: BuilderModelId;
      if (body.model === undefined) {
        const draft = await deps.draftStore.load(email, draftId);
        if (!draft) {
          sendJson(res, 404, {
            code: 'builder.draft_not_found',
            message: `kein Draft mit id '${draftId}'`,
          });
          return;
        }
        modelId = draft.previewModel;
      } else if (
        typeof body.model === 'string' &&
        BuilderModelRegistry.has(body.model)
      ) {
        modelId = body.model;
      } else {
        sendJson(res, 400, {
          code: 'builder.invalid_model',
          message: `model muss einer von haiku|sonnet|opus sein`,
        });
        return;
      }

      const anthropicModelId =
        BuilderModelRegistry.get(modelId).anthropicModelId;

      // Open the NDJSON stream.
      res.status(200);
      res.setHeader(
        'Content-Type',
        'application/x-ndjson; charset=utf-8',
      );
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      let clientGone = false;
      res.on('close', () => {
        if (!res.writableEnded) clientGone = true;
      });

      const write = (ev: PreviewStreamEvent): void => {
        if (clientGone) return;
        res.write(`${JSON.stringify(ev)}\n`);
      };

      const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
      const turnDeadline = Date.now() + turnTimeoutMs;

      try {
        write({ type: 'build_status', phase: 'building' });
        const handle = await ensureWarmHandle({
          deps,
          email,
          draftId,
        });
        write({
          type: 'build_status',
          phase: 'ok',
          buildN: handle.rev,
        });

        const iterator = deps.previewChatService.runTurn({
          handle,
          userEmail: email,
          userMessage: message,
          modelChoice: anthropicModelId,
        });

        for await (const ev of iterator) {
          if (clientGone) break;
          if (Date.now() > turnDeadline) {
            write({
              type: 'error',
              code: 'builder.turn_timeout',
              message: `preview turn exceeded ${String(turnTimeoutMs)}ms`,
            });
            break;
          }
          write(ev);
        }
      } catch (err) {
        if (err instanceof BuildPipelineError) {
          const detail = extractBuildFailureDetail(err.cause);
          write({
            type: 'build_status',
            phase: 'failed',
            reason: err.code,
            ...(detail.errors ? { errors: detail.errors } : {}),
            ...(detail.codegenIssues
              ? { codegenIssues: detail.codegenIssues }
              : {}),
          });
          write({
            type: 'error',
            code: `builder.${err.code}`,
            message: err.message,
          });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `[builder/preview/chat] turn failed for ${email}/${draftId}:`,
            err,
          );
          write({
            type: 'error',
            code: 'builder.preview_chat_failed',
            message,
          });
        }
      } finally {
        if (!res.writableEnded) res.end();
      }
    },
  );

  // ── POST /drafts/:id/preview/tool-call ────────────────────────────────────
  router.post(
    '/drafts/:id/preview/tool-call',
    async (req: Request, res: Response) => {
      const email = readEmail(req);
      if (!email) {
        sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
        return;
      }
      const draftId = readId(req);
      if (!draftId) {
        sendJson(res, 400, {
          code: 'builder.invalid_id',
          message: 'missing :id',
        });
        return;
      }
      const body = (req.body ?? {}) as {
        tool_id?: unknown;
        input?: unknown;
      };
      if (typeof body.tool_id !== 'string' || body.tool_id.length === 0) {
        sendJson(res, 400, {
          code: 'builder.invalid_tool_id',
          message: 'tool_id must be a non-empty string',
        });
        return;
      }
      const toolId = body.tool_id;

      try {
        const handle = await ensureWarmHandle({
          deps,
          email,
          draftId,
        });
        const result = await deps.previewChatService.runDirectTool({
          handle,
          toolId,
          input: body.input,
        });
        sendJson(res, 200, {
          result: result.result,
          isError: result.isError,
        });
      } catch (err) {
        sendError(res, err, 'builder.preview_tool_failed');
      }
    },
  );

  // ── POST /drafts/:id/preview/refresh ──────────────────────────────────────
  // Manual rebuild trigger. Synchronously rebuilds + activates the preview
  // and returns the new buildN (or the failure reason). Useful for a
  // "Rebuild" button in the UI.
  router.post(
    '/drafts/:id/preview/refresh',
    async (req: Request, res: Response) => {
      const email = readEmail(req);
      if (!email) {
        sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
        return;
      }
      const draftId = readId(req);
      if (!draftId) {
        sendJson(res, 400, {
          code: 'builder.invalid_id',
          message: 'missing :id',
        });
        return;
      }
      try {
        deps.previewCache.invalidate(email, draftId);
        const handle = await ensureWarmHandle({ deps, email, draftId });
        sendJson(res, 200, {
          ok: true,
          buildN: handle.rev,
          agentId: handle.agentId,
        });
      } catch (err) {
        sendError(res, err, 'builder.preview_refresh_failed');
      }
    },
  );

  // ── GET /drafts/:id/preview/status ────────────────────────────────────────
  // Lightweight read-only probe: returns the current preview-cache state
  // without triggering a build. Used by the Workspace on mount to
  // re-hydrate its `buildStatus` after a page reload — without this the
  // install button stays disabled with the "last build must succeed"
  // message even if the cache is warm from earlier work.
  router.get(
    '/drafts/:id/preview/status',
    (req: Request, res: Response) => {
      const email = readEmail(req);
      if (!email) {
        sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
        return;
      }
      const draftId = readId(req);
      if (!draftId) {
        sendJson(res, 400, { code: 'builder.invalid_id', message: 'missing :id' });
        return;
      }
      const handle = deps.previewCache.get(email, draftId);
      if (handle) {
        sendJson(res, 200, {
          phase: 'ok',
          buildN: handle.rev,
          agentId: handle.agentId,
        });
      } else {
        sendJson(res, 200, { phase: 'idle' });
      }
    },
  );

  // ── GET /drafts/:id/preview/secrets ───────────────────────────────────────
  // Returns ONLY the buffered keys, never the values. The Workspace uses
  // this to show "which setup_fields already have a test credential set"
  // without ever rendering a secret on the client.
  router.get(
    '/drafts/:id/preview/secrets',
    async (req: Request, res: Response) => {
      const email = readEmail(req);
      if (!email) {
        sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
        return;
      }
      const draftId = readId(req);
      if (!draftId) {
        sendJson(res, 400, {
          code: 'builder.invalid_id',
          message: 'missing :id',
        });
        return;
      }
      await deps.previewSecretBuffer.warm(email, draftId);
      const keys = deps.previewSecretBuffer.keys(email, draftId);
      res.json({ keys, persistent: deps.previewSecretBuffer.persistent });
    },
  );

  // ── PUT /drafts/:id/preview/secrets ───────────────────────────────────────
  router.put(
    '/drafts/:id/preview/secrets',
    async (req: Request, res: Response) => {
      const email = readEmail(req);
      if (!email) {
        sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
        return;
      }
      const draftId = readId(req);
      if (!draftId) {
        sendJson(res, 400, {
          code: 'builder.invalid_id',
          message: 'missing :id',
        });
        return;
      }
      const body = (req.body ?? {}) as { values?: unknown };
      const values = body.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        sendJson(res, 400, {
          code: 'builder.invalid_secrets',
          message: 'values must be an object of string→string',
        });
        return;
      }
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
        if (typeof v !== 'string') {
          sendJson(res, 400, {
            code: 'builder.invalid_secrets',
            message: `value for '${k}' must be a string`,
          });
          return;
        }
        cleaned[k] = v;
      }
      await deps.previewSecretBuffer.set(email, draftId, cleaned);
      // Setting secrets invalidates a warm cache so the next turn picks
      // them up from the build closure.
      deps.previewCache.invalidate(email, draftId);
      res.status(204).end();
    },
  );

  // ── DELETE /drafts/:id/preview/secrets ───────────────────────────────────
  router.delete(
    '/drafts/:id/preview/secrets',
    async (req: Request, res: Response) => {
      const email = readEmail(req);
      if (!email) {
        sendJson(res, 401, { code: 'auth.missing', message: 'no session' });
        return;
      }
      const draftId = readId(req);
      if (!draftId) {
        sendJson(res, 400, {
          code: 'builder.invalid_id',
          message: 'missing :id',
        });
        return;
      }
      await deps.previewSecretBuffer.drop(email, draftId);
      deps.previewCache.invalidate(email, draftId);
      res.status(204).end();
    },
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureWarmHandle(opts: {
  deps: BuilderPreviewDeps;
  email: string;
  draftId: string;
}): ReturnType<PreviewCache['ensureWarm']> {
  const { deps, email, draftId } = opts;
  const handle = await ensureWarmHandleInner(opts);
  // B.9-3: kick off runtime-smoke after every fresh build. Dedup'd per
  // (draftId, rev) inside the orchestrator — cached-handle returns no-op.
  deps.runtimeSmokeOrchestrator?.attemptSmoke({ handle, userEmail: email, draftId });
  return handle;
}

async function ensureWarmHandleInner(opts: {
  deps: BuilderPreviewDeps;
  email: string;
  draftId: string;
}): ReturnType<PreviewCache['ensureWarm']> {
  const { deps, email, draftId } = opts;
  // B.6-13.3 — emit `building` so the workspace UI can flip its build
  // indicator immediately on the manual REBUILD path. The auto-rebuild
  // path in index.ts emits the same event around its own callback; the
  // SSE consumer treats the latest event as authoritative.
  deps.bus.emit(draftId, { type: 'build_status', phase: 'building' });
  return deps.previewCache.ensureWarm({
    userEmail: email,
    draftId,
    build: async () => {
      const result = await deps.buildPipeline.run({
        userEmail: email,
        draftId,
      });
      if (!result.buildResult.ok) {
        deps.bus.emit(draftId, {
          type: 'build_status',
          phase: 'failed',
          reason: result.buildResult.reason,
          errorCount: result.buildResult.errors.length,
          errors: result.buildResult.errors.slice(0, 50).map((e) => ({
            file: e.path,
            line: e.line,
            column: e.col,
            code: e.code,
            message: e.message,
          })),
        });
        // Log stdout/stderr tails so we can diagnose `reason=unknown`
        // failures from middleware.log instead of having to surface them
        // through the SSE wire (B.6-12.1 diag).
        console.log(
          `[builder] preview build failed reason=${result.buildResult.reason} ` +
            `exit=${String(result.buildResult.exitCode)} ` +
            `errors=${String(result.buildResult.errors.length)} ` +
            `draft=${draftId}`,
        );
        if (result.buildResult.stdoutTail) {
          console.log(
            `[builder] preview stdout-tail draft=${draftId}:\n${result.buildResult.stdoutTail}`,
          );
        }
        if (result.buildResult.stderrTail) {
          console.log(
            `[builder] preview stderr-tail draft=${draftId}:\n${result.buildResult.stderrTail}`,
          );
        }
        throw new BuildPipelineError(
          'codegen_failed',
          `preview build failed: ${result.buildResult.reason}`,
          result.buildResult,
        );
      }
      // Lazy-load any secrets persisted in a previous run when the
      // buffer is vault-backed. No-op for heap-only buffers (tests).
      await deps.previewSecretBuffer.warm(email, draftId);
      // Build success → emit `ok` with the buildN so the workspace
      // header transitions out of `building` even when the rebuild was
      // triggered manually (REBUILD button) or by a chat-turn rather
      // than by the auto-rebuild scheduler.
      deps.bus.emit(draftId, {
        type: 'build_status',
        phase: 'ok',
        buildN: result.buildN,
      });
      // Split buffer values by setup_field type. The PreviewSecretBuffer
      // holds ALL setup-field values (string + secret + oauth + …) under
      // a single namespace, but the runtime distinguishes:
      //   ctx.secrets.get(key) → looks in secretValues
      //   ctx.config.get(key)  → looks in configValues
      // Pre-fix this used draft.slots as configValues (entirely wrong —
      // slots are code chunks). Now we route by field.type:
      const allBufferValues = deps.previewSecretBuffer.get(email, draftId);
      const { configValues, secretValues } = splitBufferByFieldType(
        allBufferValues,
        result.draft.spec.setup_fields ?? [],
      );
      return {
        zipBuffer: result.buildResult.zip,
        rev: result.buildN,
        configValues,
        secretValues,
      };
    },
  });
}

/**
 * Pick out the actionable details from a BuildPipelineError's `cause` so
 * the UI can show *why* a build failed:
 *   - cause is a CodegenError → return its `issues[]` as codegenIssues
 *   - cause is a BuildResult with ok=false → map its `errors[]`
 *     (path/line/col/code/message) onto the wire shape (file/line/column/
 *     code/message)
 *   - anything else → empty (UI falls back to the bare reason string)
 */
function extractBuildFailureDetail(cause: unknown): {
  errors?: ReadonlyArray<{
    file: string;
    line: number;
    column: number;
    code: string;
    message: string;
  }>;
  codegenIssues?: ReadonlyArray<{ code: string; detail: string }>;
} {
  if (cause instanceof CodegenError) {
    return {
      codegenIssues: cause.issues.map((i) => ({
        code: i.code,
        detail: i.detail,
      })),
    };
  }
  if (
    cause !== null &&
    typeof cause === 'object' &&
    'ok' in cause &&
    (cause as { ok: unknown }).ok === false &&
    'errors' in cause &&
    Array.isArray((cause as { errors: unknown }).errors)
  ) {
    const br = cause as BuildResult;
    if (br.ok === false) {
      return {
        errors: br.errors.map((e) => ({
          file: e.path,
          line: e.line,
          column: e.col,
          code: e.code,
          message: e.message,
        })),
      };
    }
  }
  return {};
}

/**
 * Splits the PreviewSecretBuffer's flat key→value map into the two
 * runtime channels (configValues / secretValues) based on each
 * setup_field's declared type. Fields not in the spec are dropped
 * — they shouldn't be in the buffer in the first place, but if a
 * stale entry survives a spec change the runtime safely ignores it.
 */
function splitBufferByFieldType(
  bufferValues: Readonly<Record<string, string>>,
  setupFields: ReadonlyArray<unknown>,
): {
  configValues: Readonly<Record<string, unknown>>;
  secretValues: Readonly<Record<string, string>>;
} {
  const configValues: Record<string, unknown> = {};
  const secretValues: Record<string, string> = {};
  const fieldByKey = new Map<string, string>();
  for (const raw of setupFields) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as { key?: unknown; type?: unknown };
    if (typeof f.key !== 'string') continue;
    fieldByKey.set(f.key, typeof f.type === 'string' ? f.type : 'string');
  }
  for (const [key, value] of Object.entries(bufferValues)) {
    const declaredType = fieldByKey.get(key);
    if (declaredType === undefined) continue;
    if (declaredType === 'secret' || declaredType === 'oauth') {
      secretValues[key] = value;
    } else {
      configValues[key] = value;
    }
  }
  return { configValues, secretValues };
}

function readEmail(req: Request): string | null {
  const email = req.session?.email;
  return typeof email === 'string' && email.length > 0 ? email : null;
}

function readId(req: Request): string | null {
  const raw = req.params['id'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function sendJson(
  res: Response,
  status: number,
  body: Record<string, unknown>,
): void {
  res.status(status).json(body);
}

function sendError(res: Response, err: unknown, fallbackCode: string): void {
  if (err instanceof BuildPipelineError) {
    sendJson(res, err.code === 'draft_not_found' ? 404 : 500, {
      code: `builder.${err.code}`,
      message: err.message,
    });
    return;
  }
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status: number }).status) || 500
      : 500;
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, status, {
    code: status === 401 ? 'auth.missing' : fallbackCode,
    message,
  });
}
