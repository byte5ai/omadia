/**
 * Epic #470 W0 — admin REST + SSE router, mounted by the index unit as
 * `app.use('/api/v1/admin/dev-platform', requireAuth, createDevPlatformRouter(...))`
 * (spec §9). This is the ONLY admin prefix and `GET /jobs/:id/events` is the
 * ONLY job-event SSE route in the whole epic — W3's chat card consumes THIS
 * route rather than standing up a second one.
 *
 * The router is defence-in-depth about the session: it is mounted behind
 * `requireAuth`, yet every handler re-reads `req.session` and answers 401 when
 * it is absent, so a wiring mistake fails closed and the routes are testable
 * without the auth middleware (mirrors `builderEvents.ts`).
 *
 * This file owns the factory, the job routes, the SSE tail and the artifact
 * routes. The shared seams / view mappers / admission guards live in
 * `devPlatformShared.ts`; the repo-onboarding, device-flow and issues routes
 * live in `devPlatformRepos.ts` (both file-size splits, all under `src/routes/`).
 */

import { Router, json as expressJson } from 'express';
import type { NextFunction, Request, Response } from 'express';

import { composeBrief } from '../devplatform/briefComposer.js';
import { mintRunnerToken } from '../devplatform/jobToken.js';
import type { ListJobsFilter } from '../devplatform/devJobStore.js';
import {
  isDevJobAuthMode,
  isDevJobKind,
  isDevJobStatus,
  isRunnerBackendKind,
  isTerminalDevJobStatus,
  type DevJob,
  type DevJobAuthMode,
  type DevJobEvent,
  type DevJobKind,
  type DevJobSource,
  type RunnerBackendKind,
} from '../devplatform/types.js';
import { registerDevPlatformRepoRoutes } from './devPlatformRepos.js';
import {
  DevPlatformError,
  assertAuthModeAdmissible,
  assertLocalBackendAdmissible,
  deriveCapabilities,
  handler,
  isPermittedLauncher,
  isTerminalStatusEvent,
  readParam,
  requireCaller,
  sendError,
  toJobView,
  type DevPlatformCaller,
  type DevPlatformRouterDeps,
} from './devPlatformShared.js';

export type {
  DevPlatformRouterDeps,
  DevPlatformRepoStore,
  DevPlatformJobStore,
  DevPlatformCredentialStore,
  DevPlatformDeviceFlow,
  DevPlatformTracker,
  RepoAccessResult,
  DevRepoView,
  DevJobView,
} from './devPlatformShared.js';
export {
  DevPlatformError,
  assertAuthModeAdmissible,
  assertLocalBackendAdmissible,
  isPermittedLauncher,
  toRepoView,
  toJobView,
} from './devPlatformShared.js';

const DEFAULT_HEARTBEAT_MS = 25_000;
const SSE_REPLAY_PAGE = 500;

export function createDevPlatformRouter(deps: DevPlatformRouterDeps): Router {
  const router = Router();
  router.use(expressJson({ limit: '256kb' }));

  // Repo onboarding / device-flow / issues / check routes (file-size split).
  registerDevPlatformRepoRoutes(router, deps);

  const log = deps.log ?? (() => {});

  // --- POST /jobs -----------------------------------------------------------
  router.post(
    '/jobs',
    handler(async (req, res) => {
      const caller = requireCaller(req);
      const body = (req.body ?? {}) as Record<string, unknown>;

      const repoId = asString(body['repoId']);
      if (!repoId) throw new DevPlatformError(400, 'devplatform.invalid_job', 'repoId is required');
      const kind = body['kind'];
      if (!isDevJobKind(kind)) throw new DevPlatformError(400, 'devplatform.invalid_job', 'kind is invalid');
      const backend = body['backend'];
      if (!isRunnerBackendKind(backend)) {
        throw new DevPlatformError(400, 'devplatform.invalid_job', 'backend is invalid');
      }
      const authMode: DevJobAuthMode = isDevJobAuthMode(body['authMode']) ? body['authMode'] : 'api_key';

      const repo = await deps.repoStore.getRepo(repoId);
      if (!repo) throw new DevPlatformError(404, 'devplatform.repo_not_found', 'no such repository');

      // Launch authorization — the enterprise-critical gate (spec §6).
      if (!isPermittedLauncher(repo, caller)) {
        throw new DevPlatformError(403, 'devplatform.not_launcher', 'not a permitted launcher for this repository');
      }

      const source: DevJobSource = 'admin';
      const jobShape = { backend, source, authMode };
      assertLocalBackendAdmissible(jobShape, repo);
      assertAuthModeAdmissible(jobShape, repo, { subscriptionModeEnabled: deps.subscriptionModeEnabled });

      // Compose the brief: from a tracker ticket, or from the operator's text.
      const capabilities = deriveCapabilities(backend, repo.runsTests);
      const provisionalBranch = provisionalBranchName(kind, body);
      let brief: string;
      let sourceRef: string | null = null;
      const issueNumber = asIntOrNull(body['issueNumber']);
      if (issueNumber !== null) {
        const token = await deps.credentials.resolve(repo.id);
        if (!token) {
          throw new DevPlatformError(409, 'devplatform.repo_not_connected', 'repository has no stored credential');
        }
        const tracker = deps.makeIssuesTracker({ owner: repo.owner, name: repo.name, token });
        const ticket = await tracker.getTicket(issueNumber);
        brief = composeBrief(
          {
            kind,
            repo: { owner: repo.owner, name: repo.name },
            branch: provisionalBranch,
            defaultBranch: repo.defaultBranch,
            capabilities,
          },
          ticket,
        );
        sourceRef = `gh-issue:${String(issueNumber)}`;
      } else {
        const text = asString(body['brief']);
        if (!text) {
          throw new DevPlatformError(400, 'devplatform.invalid_job', 'either issueNumber or brief is required');
        }
        brief = text;
      }

      // Mint the one-time runner token; only its hash is persisted. The plaintext
      // is intentionally discarded — the worker unit mints the token it hands to
      // the backend (see the delivery report's boundary note).
      const minted = mintRunnerToken();
      const job = await deps.jobStore.createJob({
        repoId: repo.id,
        kind,
        brief,
        source,
        sourceRef,
        backend,
        authMode,
        createdBy: caller.sub,
        runnerTokenHash: minted.hash,
      });
      log(`[dev-platform] job ${job.id} created for ${repo.owner}/${repo.name} by ${caller.sub}`);
      res.status(201).json(toJobView(job));
    }),
  );

  // --- GET /jobs ------------------------------------------------------------
  router.get(
    '/jobs',
    handler(async (req, res) => {
      requireCaller(req);
      const filter: ListJobsFilter = {};
      const repoId = asString(req.query['repoId']);
      if (repoId) filter.repoId = repoId;
      const status = req.query['status'];
      if (typeof status === 'string' && isDevJobStatus(status)) filter.status = status;
      const limit = asIntOrNull(req.query['limit']);
      if (limit !== null) filter.limit = limit;
      const jobs = await deps.jobStore.listJobs(filter);
      res.json({ jobs: jobs.map(toJobView) });
    }),
  );

  // --- GET /jobs/:id --------------------------------------------------------
  router.get(
    '/jobs/:id',
    handler(async (req, res) => {
      requireCaller(req);
      const job = await loadJob(deps, req);
      res.json(toJobView(job));
    }),
  );

  // --- POST /jobs/:id/cancel ------------------------------------------------
  router.post(
    '/jobs/:id/cancel',
    handler(async (req, res) => {
      requireCaller(req);
      const job = await loadJob(deps, req);
      // Both a queued and a live job route through the single choke point.
      await deps.finalizeDevJob(job.id, 'cancelled', { reason: 'cancelled by operator' });
      res.status(202).json({ ok: true, status: 'cancelled' });
    }),
  );

  // --- POST /jobs/:id/apply -------------------------------------------------
  // Retry of the host-side apply. 409 unless `applying` or failed-after-diff.
  router.post(
    '/jobs/:id/apply',
    handler(async (req, res) => {
      requireCaller(req);
      const job = await loadJob(deps, req);
      const failedAfterDiff = job.status === 'failed' && Boolean(job.result?.diffArtifactId);
      if (job.status !== 'applying' && !failedAfterDiff) {
        throw new DevPlatformError(409, 'devplatform.apply_not_allowed', `cannot apply while job is '${job.status}'`);
      }
      const { prUrl } = await deps.applyJob(job.id);
      res.json({ prUrl });
    }),
  );

  // --- POST /jobs/:id/retry -------------------------------------------------
  // W0: re-queue by cloning the job into a fresh queued row (a new runner token;
  // the row's one-time-token invariant forbids reusing the old one). Allowed
  // only once the source job has finished.
  router.post(
    '/jobs/:id/retry',
    handler(async (req, res) => {
      const caller = requireCaller(req);
      const job = await loadJob(deps, req);
      if (!isTerminalDevJobStatus(job.status)) {
        throw new DevPlatformError(409, 'devplatform.retry_not_allowed', `cannot retry while job is '${job.status}'`);
      }
      const repo = await deps.repoStore.getRepo(job.repoId);
      if (!repo) throw new DevPlatformError(404, 'devplatform.repo_not_found', 'no such repository');
      if (!isPermittedLauncher(repo, caller)) {
        throw new DevPlatformError(403, 'devplatform.not_launcher', 'not a permitted launcher for this repository');
      }
      const minted = mintRunnerToken();
      const next = await deps.jobStore.createJob({
        repoId: job.repoId,
        kind: job.kind,
        brief: job.brief,
        source: 'admin',
        sourceRef: job.sourceRef,
        backend: job.backend,
        authMode: job.authMode,
        createdBy: caller.sub,
        runnerTokenHash: minted.hash,
      });
      res.status(202).json({ ok: true, jobId: next.id });
    }),
  );

  // --- GET /jobs/:id/events (SSE) -------------------------------------------
  registerJobEventsRoute(router, deps);

  // --- GET /jobs/:id/artifacts ----------------------------------------------
  router.get(
    '/jobs/:id/artifacts',
    handler(async (req, res) => {
      requireCaller(req);
      const job = await loadJob(deps, req);
      const artifacts = await deps.jobStore.listArtifacts(job.id);
      res.json({
        artifacts: artifacts.map((a) => ({
          id: a.id,
          jobId: a.jobId,
          kind: a.kind,
          meta: a.meta,
          bytes: Buffer.byteLength(a.content, 'utf8'),
          createdAt: a.createdAt,
        })),
      });
    }),
  );

  // --- GET /artifacts/:id ---------------------------------------------------
  router.get(
    '/artifacts/:id',
    handler(async (req, res) => {
      requireCaller(req);
      const id = readParam(req, 'id');
      if (!id) throw new DevPlatformError(400, 'devplatform.invalid_id', 'missing :id');
      const artifact = await deps.jobStore.getArtifact(id);
      if (!artifact) throw new DevPlatformError(404, 'devplatform.artifact_not_found', 'no such artifact');
      res.status(200).type('text/plain; charset=utf-8').send(artifact.content);
    }),
  );

  // Body-parser / unexpected-error boundary → `{ code, message }`, no stack.
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const e = (err ?? {}) as { status?: number; statusCode?: number; type?: string };
    const status = e.status ?? e.statusCode ?? 500;
    if (status === 413 || e.type === 'entity.too.large') {
      res.status(413).json({ code: 'devplatform.payload_too_large', message: 'request body exceeds the limit' });
      return;
    }
    if (e.type === 'entity.parse.failed' || status === 400) {
      res.status(400).json({ code: 'devplatform.invalid_body', message: 'request body could not be parsed' });
      return;
    }
    res.status(500).json({ code: 'devplatform.internal', message: 'internal error' });
  });

  return router;
}

// ---------------------------------------------------------------------------
// SSE — the single job-event tail (spec §9). Replay from `dev_job_events.id`,
// then live events from the bus, with no gap and no double-send across a
// provision boundary. `id:` is ALWAYS the identity `id`, never `seq`.
// ---------------------------------------------------------------------------

function registerJobEventsRoute(router: Router, deps: DevPlatformRouterDeps): void {
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const setTimer =
    deps.setTimer ??
    ((fn, ms) => {
      const t = setInterval(fn, ms);
      if (typeof t.unref === 'function') t.unref();
      return t;
    });
  const clearTimer = deps.clearTimer ?? ((t) => clearInterval(t as NodeJS.Timeout));

  router.get('/jobs/:id/events', (req: Request, res: Response) => {
    void (async () => {
      try {
        requireCaller(req);
      } catch (err) {
        sendError(res, err);
        return;
      }
      const jobId = readParam(req, 'id');
      if (!jobId) {
        sendError(res, new DevPlatformError(400, 'devplatform.invalid_id', 'missing :id'));
        return;
      }
      const job = await deps.jobStore.getJob(jobId);
      if (!job) {
        sendError(res, new DevPlatformError(404, 'devplatform.job_not_found', 'no such job'));
        return;
      }

      // Open the SSE stream — headers copied from builderEvents.ts.
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      res.write('retry: 3000\n\n');
      res.write(': connected\n\n');

      let closed = false;
      let lastSentId = readAfterId(req);
      let replaying = true;
      const pending: DevJobEvent[] = [];

      const close = (): void => {
        if (closed) return;
        closed = true;
        clearTimer(heartbeat);
        unsubscribe();
        if (!res.writableEnded) res.end();
      };

      const writeEvent = (ev: DevJobEvent): void => {
        if (closed) return;
        // Monotonic identity ordering — never resend, never regress. This is what
        // makes reconnect + the provision boundary lossless.
        if (lastSentId !== undefined && ev.id <= lastSentId) return;
        try {
          res.write(`id: ${String(ev.id)}\n`);
          res.write(`event: ${ev.type}\n`);
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
          lastSentId = ev.id;
        } catch {
          close();
          return;
        }
        if (isTerminalStatusEvent(ev)) close();
      };

      // Subscribe BEFORE replaying so an event committed mid-replay is buffered,
      // not lost. Buffered events flush (in id order) once replay completes.
      const unsubscribe = deps.eventBus.subscribe(jobId, (ev) => {
        if (closed) return;
        if (replaying) pending.push(ev);
        else writeEvent(ev);
      });

      const heartbeat =
        heartbeatMs > 0
          ? setTimer(() => {
              if (closed) return;
              try {
                res.write(': ping\n\n');
              } catch {
                close();
              }
            }, heartbeatMs)
          : ({ unref(): void {} } as ReturnType<typeof setTimer>);

      res.once('close', close);

      try {
        // Replay from the DB in ascending `id` pages until drained.
        for (;;) {
          const page = await deps.jobStore.listEvents(jobId, lastSentId, SSE_REPLAY_PAGE);
          if (page.length === 0) break;
          for (const ev of page) writeEvent(ev);
          if (closed) return;
          if (page.length < SSE_REPLAY_PAGE) break;
        }
        replaying = false;
        // Flush anything the bus delivered during replay (id-guarded).
        for (const ev of pending.splice(0)) writeEvent(ev);
        if (closed) return;

        // If the job is already terminal and nothing more will arrive, end now.
        const fresh = await deps.jobStore.getJob(jobId);
        if (fresh && isTerminalDevJobStatus(fresh.status)) close();
      } catch {
        close();
      }
    })().catch(() => {
      if (!res.headersSent) sendError(res, new DevPlatformError(500, 'devplatform.internal', 'internal error'));
    });
  });
}

// ---------------------------------------------------------------------------
// Local helpers.
// ---------------------------------------------------------------------------

async function loadJob(deps: DevPlatformRouterDeps, req: Request): Promise<DevJob> {
  const id = readParam(req, 'id');
  if (!id) throw new DevPlatformError(400, 'devplatform.invalid_id', 'missing :id');
  const job = await deps.jobStore.getJob(id);
  if (!job) throw new DevPlatformError(404, 'devplatform.job_not_found', 'no such job');
  return job;
}

/** A human-readable, id-free branch label for the brief header. The authoritative
 *  `omadia/job-<id8>-<slug>` branch is pinned by the worker unit before provision;
 *  this is only the instructional text the agent reads. */
function provisionalBranchName(kind: DevJobKind, body: Record<string, unknown>): string {
  const issue = asIntOrNull(body['issueNumber']);
  const slug = issue !== null ? `issue-${String(issue)}` : slugify(asString(body['brief'])) || kind;
  return `omadia/job-${slug}`.slice(0, 80);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function asIntOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number.parseInt(v.trim(), 10);
  return null;
}

/** Read the SSE resume point: `Last-Event-ID` header wins over `?afterId=`. */
function readAfterId(req: Request): number | undefined {
  const header = req.header('last-event-id');
  const q = req.query['afterId'];
  const raw = typeof header === 'string' && header.length > 0 ? header : typeof q === 'string' ? q : '';
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
