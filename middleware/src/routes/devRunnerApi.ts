/**
 * Epic #470 W0 — phone-home router, mounted at `/api/v1/dev-runner` (spec §4).
 *
 * This is the ONLY prefix the runner shim talks to; W2/W3 extend it, never
 * rename it. It is deliberately NOT behind `requireAuth`: the sole
 * authentication is the per-job bearer token (`djr_…`), verified against the
 * stored sha256 hash with a timing-safe compare (`store.verifyRunnerToken`).
 * The runner runs inside the blast chamber over untrusted repo content, so
 * every field is treated as hostile: bodies are size-capped, event types are
 * validated in TypeScript (the DB dropped the CHECK, per 0021), and no error
 * ever echoes the bearer, an upstream body, or a stack trace.
 *
 * Status contract, uniform across routes:
 *   - missing / wrong bearer, or unknown job → 401
 *   - job already terminal                   → 410
 *   - call illegal for the current status    → 409
 *
 * Terminal transitions (POST /result with `failed`/`no_changes`) go through the
 * injected `finalizeDevJob` — the single choke point (spec §4) — never through
 * the store directly. Only `diff_ready` touches the store's `recordResult`,
 * which flips the job to `applying` for the host-side apply step.
 */

import { Router, json as expressJson, text as expressText } from 'express';
import type { NextFunction, Request, Response } from 'express';

import type { FinalizeContext } from '../devplatform/finalizeDevJob.js';
import type { RunnerEventInput } from '../devplatform/devJobStore.js';
import {
  RUNNER_PROTOCOL_VERSION,
  isDevJobEventType,
  isTerminalDevJobStatus,
  type DevJob,
  type DevJobResult,
  type DevJobSpec,
  type DevJobStatus,
  type DevJobUsage,
  type DevRepo,
} from '../devplatform/types.js';

// ---------------------------------------------------------------------------
// Injected seams. Each is the narrow structural slice this router needs, so a
// test injects a plain fake and the index unit wires the real store/finalize.
// ---------------------------------------------------------------------------

/** The `DevJobStore` surface the phone-home routes use. */
export interface DevRunnerJobStore {
  verifyRunnerToken(jobId: string, token: string): Promise<boolean>;
  getJob(jobId: string): Promise<DevJob | null>;
  markRunning(jobId: string): Promise<boolean>;
  /** Liveness without an event. `appendEvents` returns early on an empty batch,
   *  so an agent that thinks without emitting a tool call would otherwise be
   *  reaped by `findStalled` while perfectly healthy. Required, not optional. */
  touchHeartbeat(jobId: string): Promise<boolean>;
  appendEvents(jobId: string, provision: number, events: RunnerEventInput[]): Promise<number>;
  addArtifact(
    jobId: string,
    kind: string,
    content: string,
    meta?: Record<string, unknown>,
  ): Promise<string>;
  recordResult(jobId: string, result: DevJobResult): Promise<void>;
}

/** Repo lookup for spec assembly — clone URL + default branch + test policy. */
export interface DevRunnerRepoLookup {
  getRepo(id: string): Promise<Pick<DevRepo, 'cloneUrl' | 'defaultBranch' | 'runsTests'> | null>;
}

/** Read-only clone-credential source. In W0 this resolves the repo's own stored
 *  device-flow/PAT token (spec §6); W2 swaps it for a scoped App token. */
export interface DevRunnerScmTokens {
  resolve(repoId: string): Promise<string | undefined>;
}

export interface DevRunnerRouterDeps {
  store: DevRunnerJobStore;
  repos: DevRunnerRepoLookup;
  scmTokens: DevRunnerScmTokens;
  /**
   * Bound `finalizeDevJob` — the ONLY terminal-transition path (spec §4). The
   * caller binds the real deps (store, terminate, revokers); the router just
   * calls it for `failed`/`no_changes`. Injected so a test can spy on the choke
   * point.
   */
  finalizeDevJob: (
    jobId: string,
    status: DevJobStatus,
    ctx?: FinalizeContext,
  ) => Promise<DevJob | null>;
  /** `spec.limits.wallClockMs`. Default 30 min. */
  wallClockMs?: number;
  /** Advisory TTL on the returned clone credential (≤15 min). Default 15 min. */
  scmTokenTtlMs?: number;
  /** Hard cap on an uploaded diff, in bytes. Default 5 MiB. */
  maxDiffBytes?: number;
  /** Hard cap on events per `POST /events` batch. Default 1000. */
  maxEventsPerBatch?: number;
  /** `spec.agent.model` — not persisted in W0's schema, injected if configured. */
  agentModel?: string;
  /** `spec.agent.maxTurns`. */
  maxTurns?: number;
  /** Clock injection for `expiresAt` (tests). Default `Date.now`. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Defaults & small helpers.
// ---------------------------------------------------------------------------

const DEFAULT_WALL_CLOCK_MS = 1_800_000; // 30 min
const DEFAULT_SCM_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 min
const DEFAULT_MAX_DIFF_BYTES = 5 * 1024 * 1024; // 5 MiB
const DEFAULT_MAX_EVENTS = 1000;

/** `{ code, message }` — codes prefixed `devplatform.`, never a secret/stack. */
function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ code, message });
}

/** Extract the job bearer token. `Bearer <token>`, case-insensitive; else null. */
function bearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const m = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() || null : null;
}

function deriveCapabilities(
  backend: DevJob['backend'],
  runsTests: boolean,
): DevJobSpec['capabilities'] {
  // The jailed local backend executes neither install nor tests (spec §1/§5).
  if (backend === 'local') return { installDeps: false, runTests: false };
  return { installDeps: true, runTests: runsTests };
}

function sanitizeUsage(raw: unknown): DevJobUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const usage: DevJobUsage = {};
  if (typeof r['tokensIn'] === 'number') usage.tokensIn = r['tokensIn'];
  if (typeof r['tokensOut'] === 'number') usage.tokensOut = r['tokensOut'];
  if (typeof r['costUsd'] === 'number') usage.costUsd = r['costUsd'];
  if (typeof r['estimated'] === 'boolean') usage.estimated = r['estimated'];
  return Object.keys(usage).length > 0 ? usage : undefined;
}

// ---------------------------------------------------------------------------
// Router.
// ---------------------------------------------------------------------------

export function createDevRunnerRouter(deps: DevRunnerRouterDeps): Router {
  const router = Router();
  const {
    store,
    repos,
    scmTokens,
    finalizeDevJob,
    wallClockMs = DEFAULT_WALL_CLOCK_MS,
    scmTokenTtlMs = DEFAULT_SCM_TOKEN_TTL_MS,
    maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
    maxEventsPerBatch = DEFAULT_MAX_EVENTS,
    agentModel,
    maxTurns,
    now = Date.now,
  } = deps;

  // One-shot `scm-token` guard, keyed by `<jobId>#<provision>`. In-memory is the
  // right scope for W0: the clone token is fetched once, early, and a middleware
  // restart drops the runner too, so there is nothing to resume.
  const issuedScmTokens = new Set<string>();

  /** Authenticate, load the job, stash it on `res.locals`. Sends 401 and stops
   *  the chain (does NOT call next) on any failure. Runs BEFORE any body parser
   *  so an unauthenticated request is rejected before its body is read. */
  const authMw = (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      // `req.params[k]` is `string | string[]` under this express typing. A
      // repeated `:id` would arrive as an array; treat anything but a single
      // string as an unauthenticated request rather than coercing it.
      const rawId = req.params['id'];
      const jobId = typeof rawId === 'string' ? rawId : '';
      const token = bearerToken(req);
      if (!token) {
        fail(res, 401, 'devplatform.unauthorized', 'missing or malformed bearer token');
        return;
      }
      const ok = await store.verifyRunnerToken(jobId, token);
      if (!ok) {
        // Unknown job or wrong token — same opaque answer, no oracle.
        fail(res, 401, 'devplatform.unauthorized', 'invalid job token');
        return;
      }
      const job = await store.getJob(jobId);
      if (!job) {
        fail(res, 401, 'devplatform.unauthorized', 'invalid job token');
        return;
      }
      (res.locals as { devJob?: DevJob }).devJob = job;
      next();
    })().catch(next);
  };

  const jobOf = (res: Response): DevJob => (res.locals as { devJob: DevJob }).devJob;

  /** Terminal → 410, wrong-but-live status → 409, else true. */
  function statusGate(res: Response, job: DevJob, allowed: readonly DevJobStatus[]): boolean {
    if (isTerminalDevJobStatus(job.status)) {
      fail(res, 410, 'devplatform.job_terminal', 'job has reached a terminal state');
      return false;
    }
    if (!allowed.includes(job.status)) {
      fail(res, 409, 'devplatform.invalid_state', `call not valid while job is '${job.status}'`);
      return false;
    }
    return true;
  }

  // --- GET /jobs/:id/spec ---------------------------------------------------
  // Returns the DevJobSpec (carries NO credential — regression-tested) and
  // flips provisioning → running. Allowed only in provisioning/running.
  router.get('/jobs/:id/spec', authMw, async (_req, res) => {
    const job = jobOf(res);
    if (!statusGate(res, job, ['provisioning', 'running'])) return;
    if (job.status === 'provisioning') await store.markRunning(job.id);

    const repo = await repos.getRepo(job.repoId);
    if (!repo) {
      fail(res, 500, 'devplatform.repo_unavailable', 'job repository is not available');
      return;
    }

    const spec: DevJobSpec = {
      protocol: RUNNER_PROTOCOL_VERSION,
      jobId: job.id,
      provision: job.provision,
      kind: job.kind,
      brief: job.brief,
      repo: {
        cloneUrl: repo.cloneUrl,
        defaultBranch: repo.defaultBranch,
        baseSha: job.baseSha ?? '',
      },
      branch: job.branch ?? '',
      agent: {
        kind: 'claude-cli',
        ...(agentModel !== undefined ? { model: agentModel } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
      },
      limits: { wallClockMs },
      capabilities: deriveCapabilities(job.backend, repo.runsTests),
    };
    res.json(spec);
  });

  // --- GET /jobs/:id/scm-token ---------------------------------------------
  // Read-only clone credential, one-shot per provision, ≤15 min advisory TTL.
  router.get('/jobs/:id/scm-token', authMw, async (_req, res) => {
    const job = jobOf(res);
    if (!statusGate(res, job, ['provisioning', 'running'])) return;

    const key = `${job.id}#${String(job.provision)}`;
    if (issuedScmTokens.has(key)) {
      fail(res, 409, 'devplatform.scm_token_already_issued', 'clone credential already issued for this provision');
      return;
    }
    const token = await scmTokens.resolve(job.repoId);
    if (!token) {
      // Server-side misconfiguration (no stored repo credential). No secret in
      // the message; the runner cannot proceed and reports failed.
      fail(res, 500, 'devplatform.scm_token_unavailable', 'no clone credential available for this repository');
      return;
    }
    issuedScmTokens.add(key);
    const expiresAt = new Date(now() + scmTokenTtlMs).toISOString();
    res.json({ token, expiresAt });
  });

  // --- POST /jobs/:id/events -----------------------------------------------
  // Idempotent per (job, provision, seq); bumps heartbeat; returns accepted N.
  router.post('/jobs/:id/events', authMw, expressJson({ limit: '4mb' }), async (req, res) => {
    const job = jobOf(res);
    if (!statusGate(res, job, ['provisioning', 'running', 'applying'])) return;

    const body = (req.body ?? {}) as { provision?: unknown; events?: unknown };
    if (!Number.isInteger(body.provision)) {
      fail(res, 400, 'devplatform.invalid_events', 'provision must be an integer');
      return;
    }
    if (!Array.isArray(body.events)) {
      fail(res, 400, 'devplatform.invalid_events', 'events must be an array');
      return;
    }
    if (body.events.length > maxEventsPerBatch) {
      fail(res, 413, 'devplatform.events_batch_too_large', `at most ${String(maxEventsPerBatch)} events per batch`);
      return;
    }
    const events: RunnerEventInput[] = [];
    for (const raw of body.events) {
      const e = (raw ?? {}) as Record<string, unknown>;
      if (!Number.isInteger(e['seq']) || (e['seq'] as number) < 0) {
        fail(res, 400, 'devplatform.invalid_events', 'each event needs a non-negative integer seq');
        return;
      }
      if (!isDevJobEventType(e['type'])) {
        fail(res, 400, 'devplatform.invalid_events', 'each event needs a valid type');
        return;
      }
      events.push({
        seq: e['seq'] as number,
        type: e['type'],
        ts: typeof e['ts'] === 'string' ? e['ts'] : null,
        payload:
          e['payload'] && typeof e['payload'] === 'object'
            ? (e['payload'] as Record<string, unknown>)
            : {},
      });
    }
    const accepted = await store.appendEvents(job.id, body.provision as number, events);
    res.json({ accepted });
  });

  // --- POST /jobs/:id/heartbeat --------------------------------------------
  // The cancel channel. Returns `cancelRequested` so a live runner can stop
  // cooperatively; also bumps liveness on an otherwise idle agent.
  router.post('/jobs/:id/heartbeat', authMw, expressJson({ limit: '16kb' }), async (_req, res) => {
    const job = jobOf(res);
    // W0 has no dedicated cancel flag: a cancel finalizes the job to 'cancelled'
    // (spec §4). Surface that as a cooperative stop rather than a bare 410 —
    // this is the "cancel reaches the runner" path (SPEC DELTA, see report).
    if (job.status === 'cancelled') {
      res.json({ ok: true, cancelRequested: true });
      return;
    }
    if (isTerminalDevJobStatus(job.status)) {
      fail(res, 410, 'devplatform.job_terminal', 'job has reached a terminal state');
      return;
    }
    await store.touchHeartbeat(job.id);
    res.json({ ok: true, cancelRequested: false });
  });

  // --- POST /jobs/:id/diff --------------------------------------------------
  // text/plain unified diff + --numstat, stored as an artifact of kind `diff`.
  router.post(
    '/jobs/:id/diff',
    authMw,
    expressText({ type: () => true, limit: maxDiffBytes }),
    async (req, res) => {
      const job = jobOf(res);
      if (!statusGate(res, job, ['provisioning', 'running'])) return;

      const body = req.body;
      if (typeof body !== 'string' || body.length === 0) {
        fail(res, 400, 'devplatform.empty_diff', 'diff body must be non-empty text/plain');
        return;
      }
      const bytes = Buffer.byteLength(body, 'utf8');
      if (bytes > maxDiffBytes) {
        fail(res, 413, 'devplatform.diff_too_large', 'diff exceeds the size limit');
        return;
      }
      const artifactId = await store.addArtifact(job.id, 'diff', body, {
        bytes,
        provision: job.provision,
      });
      res.json({ artifactId });
    },
  );

  // --- POST /jobs/:id/result ------------------------------------------------
  // diff_ready → `applying` (store). failed/no_changes → terminal via the
  // finalizeDevJob choke point (never the store directly).
  router.post('/jobs/:id/result', authMw, expressJson({ limit: '256kb' }), async (req, res) => {
    const job = jobOf(res);
    if (!statusGate(res, job, ['provisioning', 'running'])) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const outcome = body['outcome'];
    if (outcome !== 'diff_ready' && outcome !== 'no_changes' && outcome !== 'failed') {
      fail(res, 400, 'devplatform.invalid_result', 'outcome must be diff_ready, no_changes, or failed');
      return;
    }

    const result: DevJobResult = { outcome };
    if (typeof body['diffArtifactId'] === 'string') result.diffArtifactId = body['diffArtifactId'];
    if (typeof body['summary'] === 'string') result.summary = body['summary'];
    if (typeof body['error'] === 'string') result.error = body['error'];
    const usage = sanitizeUsage(body['usage']);
    if (usage) result.usage = usage;

    // Persist usage/result payload first (recordResult only flips status for
    // diff_ready → applying; it is a no-op flip for the terminal outcomes).
    await store.recordResult(job.id, result);

    if (outcome === 'diff_ready') {
      res.json({ ok: true });
      return;
    }

    // Terminal outcomes route through the single choke point.
    const status: DevJobStatus = outcome === 'failed' ? 'failed' : 'done';
    await finalizeDevJob(job.id, status, {
      reason: outcome,
      result,
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
    res.json({ ok: true });
  });

  // --- Body-parser / unexpected error boundary -----------------------------
  // Converts express's payload-too-large / parse errors and any thrown handler
  // error into `{ code, message }` — never a stack trace or an upstream body.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const e = (err ?? {}) as { status?: number; statusCode?: number; type?: string };
    const status = e.status ?? e.statusCode ?? 500;
    if (status === 413 || e.type === 'entity.too.large') {
      fail(res, 413, 'devplatform.payload_too_large', 'request body exceeds the limit');
      return;
    }
    if (e.type === 'entity.parse.failed' || status === 400) {
      fail(res, 400, 'devplatform.invalid_body', 'request body could not be parsed');
      return;
    }
    fail(res, 500, 'devplatform.internal', 'internal error');
  });

  return router;
}
