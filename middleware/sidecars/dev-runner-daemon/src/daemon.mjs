/**
 * Epic #470 W1 — runner daemon control-plane HTTP server (spec §4).
 *
 * The ONLY process in the stack that talks to the docker engine (a host docker
 * socket next to the middleware and its Vault would be RCE — the daemon exists
 * to keep that socket out of the middleware). It exposes a small bearer-gated
 * HTTP API the middleware calls over the `dev-control` network:
 *
 *   POST   /v1/jobs            create/re-attach a job (idempotent on jobId)
 *   DELETE /v1/jobs/:id        kill + clean a job (idempotent)
 *   POST   /v1/jobs/:id/lease  renew a job's lease
 *   GET    /v1/jobs            list live jobs (middleware reap() join source)
 *   GET    /v1/jobs/:id/logs   raw container stdout/stderr (?follow=1)
 *   GET    /v1/health          dind reachability, version, warmth, live count
 *   POST   /v1/warm            pull + record warmed image digests
 *
 * EVERY route is bearer-gated, `/v1/health` included. The server binds ONLY the
 * control-plane interface (`DEV_DAEMON_BIND`) and REFUSES a wildcard bind
 * (0.0.0.0 / ::) so nothing listens toward `dev-engine`, where nested job
 * containers live (spec §2/§4, review finding S3). No express — node builtins
 * only, so the image stays dockerode + zod + node.
 *
 * Built on node's `http` so the tests exercise the REAL server over a real
 * socket (review lesson (c): a component tested only through a hand-built stub
 * is not the component that ships).
 */

import { isIP } from 'node:net';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { isAuthorized, parseDaemonTokens } from './auth.mjs';
import { toDottedQuad } from './netClassify.mjs';
import {
  createDockerEngine,
  EngineNotImplementedError,
  JobCancelledError,
  JobCapacityError,
  JobCleanupError,
  JobManager,
} from './jobs.mjs';
import { SpecRejectedError } from './clamp.mjs';
import { createPolicyClient, parseAllowedImages, parseRequireDigest, PolicyLookupError } from './policyClient.mjs';
import { parseCreateJobRequest, parseRenewLeaseRequest, WireProtocolMismatchError } from './protocol.ts';
import { createReaper, resolveSweepIntervalMs } from './reaper.mjs';

/** Default control-plane port (spec §4). */
export const DEFAULT_DAEMON_PORT = 7411;

/** Bind addresses the daemon REFUSES: a wildcard would expose the control API
 *  toward `dev-engine` and every nested job container.
 *
 *  These are the CANONICAL forms. A literal list is not enough: node binds `0`,
 *  `000.000.000.000`, `::0` and `0:0:0:0:0:0:0:0` to the wildcard too. So the
 *  bind is canonicalised before it is compared — the same rule the egress
 *  classifier follows, for the same reason: a validator that matches spellings
 *  is checking text, while the consumer resolves an address. */
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '', '*']);

/** Canonicalise a bind address the way the network stack will resolve it.
 *  @param {string} bind @returns {string} */
function canonicalBind(bind) {
  const raw = bind.trim();
  if (raw === '' || raw === '*') return raw;
  const family = isIP(raw);
  try {
    // `new URL` normalises numeric/short/zero-padded IPv4 and compresses IPv6.
    const host = new URL(`http://${family === 6 ? `[${raw}]` : raw}/`).hostname;
    const bare = host.startsWith('[') ? host.slice(1, -1) : host;
    // …and an IPv4-mapped IPv6 must be reduced to its v4 form: node listens on
    // `::ffff:0.0.0.0` (which URL compresses to `::ffff:0:0`) as the wildcard.
    return toDottedQuad(bare);
  } catch {
    return raw;
  }
}

/** Max control-plane request body — these are tiny JSON envelopes. */
const MAX_BODY_BYTES = 64 * 1024;

/** Default cap on concurrent `?follow=1` log streams (spec §4 hardening): each
 *  pins a docker log stream + a socket, so an unbounded number of abandoned
 *  follows would exhaust the engine's stream handles. */
const DEFAULT_MAX_LOG_FOLLOWS = 4;
/** A follow stream that emits no bytes for this long is closed (idle timeout). */
const FOLLOW_IDLE_MS = 5 * 60 * 1000;
/** Absolute lifetime cap for a single follow stream, idle or not. */
const FOLLOW_ABSOLUTE_MS = 60 * 60 * 1000;

/** UUID form `dev_jobs.id` takes; path params are matched against it so a
 *  traversal/control-char id never reaches the registry or the engine. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @typedef {object} WarmState
 * @property {string[]} digests
 * @property {boolean} warm
 */

/**
 * @typedef {object} DaemonDeps
 * @property {readonly string[]} tokens Accepted bearer tokens (>= 1, each >= 32 chars).
 * @property {import('./policyClient.mjs').PolicyClient} policyClient
 * @property {JobManager} jobManager
 * @property {import('./jobs.mjs').ContainerEngine} engine
 * @property {readonly string[]} [warmImageRefs] Refs `POST /v1/warm` pulls (`DEV_RUNNER_IMAGES`).
 * @property {number} [maxLogFollows] Concurrent `?follow=1` stream cap (default 4).
 * @property {{ warn: (msg: string) => void }} [logger]
 */

/** Reject a wildcard/empty bind so nothing listens toward `dev-engine`.
 *  @param {string} bind @returns {string} the validated bind */
export function assertControlPlaneBind(bind) {
  if (WILDCARD_BINDS.has(canonicalBind(bind))) {
    throw new Error(
      `DEV_DAEMON_BIND=${JSON.stringify(bind)} is a wildcard — refusing to expose the control API toward dev-engine`,
    );
  }
  return bind;
}

/** Parse an optional positive-integer env override. Returns undefined for unset,
 *  non-numeric, or non-positive values so the caller's default applies.
 *  @param {string | undefined} raw @returns {number | undefined} */
function parsePositiveIntEnv(raw) {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {string} code @param {string} message */
function sendError(res, status, code, message) {
  sendJson(res, status, { code, message });
}

/**
 * Read + JSON-parse a request body with a hard size cap.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<unknown>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new InvalidJsonError());
      }
    });
    req.on('error', reject);
  });
}

class BodyTooLargeError extends Error {
  constructor() {
    super('request body exceeds the control-plane limit');
    this.name = 'BodyTooLargeError';
  }
}
class InvalidJsonError extends Error {
  constructor() {
    super('request body is not valid JSON');
    this.name = 'InvalidJsonError';
  }
}

/**
 * Map a thrown error to an HTTP response. Never leaks a stack or a secret.
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} err
 * @param {{ warn: (msg: string) => void }} logger
 */
function sendMappedError(res, err, logger) {
  if (err instanceof WireProtocolMismatchError) {
    sendError(res, 400, 'daemon.protocol_mismatch', err.message);
    return;
  }
  if (err instanceof BodyTooLargeError) {
    sendError(res, 413, 'daemon.body_too_large', err.message);
    return;
  }
  if (err instanceof InvalidJsonError) {
    sendError(res, 400, 'daemon.invalid_json', err.message);
    return;
  }
  // zod validation failure (bad body shape, extra keys, non-UUID jobId, …).
  if (err && typeof err === 'object' && /** @type {{ name?: string }} */ (err).name === 'ZodError') {
    sendError(res, 400, 'daemon.invalid_request', 'request body failed schema validation');
    return;
  }
  if (err instanceof PolicyLookupError) {
    if (err.status === 404) {
      sendError(res, 404, 'daemon.job_not_found', 'the named job does not exist');
      return;
    }
    if (err.status === 0) {
      sendError(res, 503, 'daemon.policy_unreachable', 'the middleware policy endpoint is unreachable');
      return;
    }
    sendError(res, 502, 'daemon.policy_lookup_failed', 'the middleware could not supply the job policy');
    return;
  }
  if (err instanceof EngineNotImplementedError) {
    sendError(res, 501, err.code, err.message);
    return;
  }
  // The hardening clamp refused the container shape (e.g. a floating-tag image).
  // Never a 500: the request named something the daemon will not run, and the
  // caller must learn that rather than see an internal error.
  if (err instanceof SpecRejectedError) {
    sendError(res, 400, err.code, err.message);
    return;
  }
  // A create that raced a delete: the job was cancelled mid-provision.
  if (err instanceof JobCancelledError) {
    sendError(res, 409, err.code, 'the job was deleted while it was being created');
    return;
  }
  // Admission control refused a new job — the daemon is at capacity.
  if (err instanceof JobCapacityError) {
    sendError(res, 429, err.code, err.message);
    return;
  }
  // A DELETE whose container teardown failed: the job is still tracked, retryable.
  if (err instanceof JobCleanupError) {
    sendError(res, 502, err.code, err.message);
    return;
  }
  logger.warn(`[dev-runner-daemon] unhandled error: ${err instanceof Error ? err.message : String(err)}`);
  sendError(res, 500, 'daemon.internal', 'internal daemon error');
}

/**
 * @param {import('./jobs.mjs').JobRecord} record
 * @returns {{ containerId: string, networkId: string, volumeName: string, leaseExpiresAt: string, imageDigest: string }}
 */
function toCreateResponse(record) {
  return {
    containerId: record.container.containerId,
    networkId: record.container.networkId,
    volumeName: record.container.volumeName,
    leaseExpiresAt: record.leaseExpiresAt,
    imageDigest: record.container.imageDigest,
  };
}

/**
 * @param {import('./jobs.mjs').JobRecord} record
 * @returns {{ jobId: string, containerId: string, networkId: string, volumeName: string, imageDigest: string, leaseExpiresAt: string }}
 */
function toJobSummary(record) {
  return {
    jobId: record.jobId,
    containerId: record.container.containerId,
    networkId: record.container.networkId,
    volumeName: record.container.volumeName,
    imageDigest: record.container.imageDigest,
    leaseExpiresAt: record.leaseExpiresAt,
  };
}

/**
 * Build the daemon HTTP server (not yet listening). Injecting the deps is the
 * test seam: tests pass a fake engine + policy client and a valid token, then
 * drive the real server over a real socket.
 *
 * @param {DaemonDeps} deps
 * @returns {import('node:http').Server}
 */
export function createDaemon(deps) {
  const logger = deps.logger ?? console;
  const warmImageRefs = deps.warmImageRefs ?? [];
  const maxLogFollows = deps.maxLogFollows ?? DEFAULT_MAX_LOG_FOLLOWS;
  /** Count of live `?follow=1` streams — the concurrency-cap denominator. */
  let activeFollows = 0;
  /** @type {WarmState} */
  const warmState = { digests: [], warm: false };
  const { jobManager, engine, policyClient } = deps;

  return createServer((req, res) => {
    void handle(req, res).catch((err) => {
      // Last-ditch guard: a handler that rejects still gets a mapped response
      // rather than a hung socket.
      if (!res.headersSent) sendMappedError(res, err, logger);
      else res.end();
    });
  });

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    // AUTH FIRST — every route is bearer-gated, /v1/health included.
    if (!isAuthorized(req.headers.authorization, deps.tokens)) {
      sendError(res, 401, 'daemon.unauthorized', 'missing or invalid bearer token');
      return;
    }

    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://daemon.local');
    const path = url.pathname;

    // --- collection + singleton routes --------------------------------------
    if (path === '/v1/health' && method === 'GET') {
      const ping = await engine.ping();
      sendJson(res, 200, {
        ok: ping.reachable,
        dindReachable: ping.reachable,
        engineApiVersion: ping.apiVersion,
        warmedDigests: warmState.digests,
        imageWarm: warmState.warm,
        liveJobs: jobManager.size(),
      });
      return;
    }

    if (path === '/v1/warm' && method === 'POST') {
      const digests = await engine.warmImages(warmImageRefs);
      warmState.digests = digests;
      warmState.warm = digests.length > 0;
      sendJson(res, 200, { warmedDigests: digests, imageWarm: warmState.warm });
      return;
    }

    if (path === '/v1/jobs' && method === 'GET') {
      sendJson(res, 200, { jobs: jobManager.list().map(toJobSummary) });
      return;
    }

    if (path === '/v1/jobs' && method === 'POST') {
      const body = await readJsonBody(req);
      // The wire schema is the S3 clamp: it accepts EXACTLY
      // { protocol, jobId, leaseTtlSec } and rejects env/image/egressAllowlist.
      const parsed = parseCreateJobRequest(body);
      const { record, created } = await jobManager.create(parsed.jobId, parsed.leaseTtlSec);
      sendJson(res, created ? 201 : 200, toCreateResponse(record));
      return;
    }

    // --- per-job routes ------------------------------------------------------
    const jobMatch = /^\/v1\/jobs\/([^/]+)(\/lease|\/logs)?$/.exec(path);
    if (jobMatch) {
      // Malformed percent-encoding (`%zz`) makes decodeURIComponent throw. That
      // is a bad request, not a daemon fault — decode defensively so it cannot
      // surface as a 500.
      let jobId;
      try {
        jobId = decodeURIComponent(jobMatch[1] ?? '');
      } catch {
        sendError(res, 400, 'daemon.invalid_job_id', 'jobId is not a valid UUID');
        return;
      }
      const sub = jobMatch[2];
      if (!UUID_RE.test(jobId)) {
        sendError(res, 400, 'daemon.invalid_job_id', 'jobId is not a valid UUID');
        return;
      }

      if (!sub && method === 'DELETE') {
        await jobManager.destroy(jobId); // idempotent: unknown job still succeeds
        sendJson(res, 200, { jobId, deleted: true });
        return;
      }

      if (sub === '/lease' && method === 'POST') {
        const body = await readJsonBody(req);
        const parsed = parseRenewLeaseRequest(body);
        const record = jobManager.renew(jobId, parsed.leaseTtlSec);
        if (!record) {
          sendError(res, 404, 'daemon.job_not_found', 'no live job with that id');
          return;
        }
        sendJson(res, 200, { jobId, leaseExpiresAt: record.leaseExpiresAt });
        return;
      }

      if (sub === '/logs' && method === 'GET') {
        const record = jobManager.get(jobId);
        if (!record) {
          sendError(res, 404, 'daemon.job_not_found', 'no live job with that id');
          return;
        }
        const follow = url.searchParams.get('follow') === '1';
        // Concurrency cap: a follow pins a docker log stream + a socket, so past
        // the bound we refuse rather than let abandoned follows exhaust handles.
        // The slot is RESERVED synchronously, in the same event-loop turn as the
        // check. `engine.streamLogs` awaits real docker I/O spanning several
        // turns, so a check that only counts before the await and increments
        // after it lets an entire concurrent burst past the bound: every request
        // observes activeFollows === 0. Reserve first, release on every exit.
        if (follow) {
          if (activeFollows >= maxLogFollows) {
            sendError(res, 429, 'daemon.too_many_log_follows', 'too many concurrent log-follow streams');
            return;
          }
          activeFollows += 1;
        }
        // The client can vanish while dockerode is still OPENING the stream. If
        // we only listened for 'close' after the await, that disconnect would be
        // missed: the stream resolves into nobody's hands, is never destroyed,
        // and its slot is never released — enough of those and every later
        // follow gets a 429 until the daemon restarts. So the disconnect is
        // recorded from here on, and honoured the moment the stream arrives.
        let clientGone = false;
        const markGone = () => {
          clientGone = true;
        };
        req.on('close', markGone);
        res.on('close', markGone);
        /** @type {import('node:stream').Readable} */
        let stream;
        try {
          stream = await engine.streamLogs(record.container, { follow });
        } catch (err) {
          if (follow) activeFollows -= 1;
          throw err;
        }
        if (clientGone) {
          // The disconnect landed during the await. Nobody is reading, so give
          // the docker stream and the slot straight back.
          if (follow) activeFollows -= 1;
          stream.destroy();
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/octet-stream' });

        // One-shot teardown: destroy the UPSTREAM docker stream, release the
        // follow slot, and clear the timers — so a client disconnect (req/res
        // 'close'/'error') or a timeout can never pin the source stream.
        let torndown = false;
        /** @type {NodeJS.Timeout | undefined} */
        let idleTimer;
        /** @type {NodeJS.Timeout | undefined} */
        let absoluteTimer;
        const teardown = () => {
          if (torndown) return;
          torndown = true;
          if (follow) activeFollows -= 1;
          if (idleTimer) clearTimeout(idleTimer);
          if (absoluteTimer) clearTimeout(absoluteTimer);
          if (!stream.destroyed) stream.destroy();
        };

        if (follow) {
          const armIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
              teardown();
              res.end();
            }, FOLLOW_IDLE_MS);
            idleTimer.unref?.();
          };
          absoluteTimer = setTimeout(() => {
            teardown();
            res.end();
          }, FOLLOW_ABSOLUTE_MS);
          absoluteTimer.unref?.();
          armIdle();
          stream.on('data', armIdle);
        }

        // Client went away, or the response socket errored/closed → tear down.
        res.on('close', teardown);
        res.on('error', teardown);
        req.on('close', teardown);
        req.on('error', teardown);
        // Upstream ended or errored → release the slot; on error also end the res.
        stream.on('end', teardown);
        stream.on('error', () => {
          teardown();
          res.end();
        });
        stream.pipe(res);
        return;
      }
    }

    sendError(res, 404, 'daemon.not_found', 'no such route');
  }
}

/**
 * Wire the daemon from the environment and start listening. Constructs the real
 * dockerode engine (TLS to dind), the policy client, and the job manager.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<import('node:http').Server>}
 */
export async function main(env = process.env) {
  const tokens = parseDaemonTokens(env.DEV_RUNNER_DAEMON_TOKEN);
  const middlewareUrl = env.OMADIA_INTERNAL_API_URL ?? env.DEV_RUNNER_MIDDLEWARE_URL;
  if (!middlewareUrl) {
    throw new Error('OMADIA_INTERNAL_API_URL is not set — the daemon cannot fetch job policy');
  }
  // Refuse a wildcard bind; default to loopback (never 0.0.0.0). In compose the
  // operator sets DEV_DAEMON_BIND to the dev-control interface address.
  const bind = assertControlPlaneBind(env.DEV_DAEMON_BIND ?? '127.0.0.1');
  const port = env.DEV_DAEMON_PORT ? Number(env.DEV_DAEMON_PORT) : DEFAULT_DAEMON_PORT;

  // Daemon-side image allowlist + digest policy (round-3 high finding): the
  // daemon refuses to start without an allowlist, and refuses any policy naming
  // an unlisted or non-digest-pinned image.
  const allowedImages = parseAllowedImages(env.DEV_RUNNER_ALLOWED_IMAGES);
  const requireDigest = parseRequireDigest(env.DEV_RUNNER_REQUIRE_DIGEST);

  const engine = createDockerEngine({ env });
  const policyClient = createPolicyClient({
    middlewareUrl,
    daemonToken: tokens[0] ?? '',
    allowedImages,
    requireDigest,
    // Daemon-owned runner env (never policy-supplied): the runner phones home to
    // the daemon's OWN middleware URL (a hostile policy can no longer redirect
    // it), clones into the container's fixed workspace, and spawns the daemon's
    // configured CLI — not a binary the policy names.
    jobBaseUrl: env.DEV_RUNNER_JOB_BASE_URL ?? middlewareUrl,
    workspacePath: env.DEV_RUNNER_WORKSPACE,
    cliBin: env.DEV_RUNNER_CLI_BIN,
    // Egress proxy is deployment topology (a static IP), never per-job policy: the
    // daemon injects HTTP(S)_PROXY/NO_PROXY into every job from its own config and
    // refuses a policy that carries them.
    egressProxyUrl: env.DEV_RUNNER_EGRESS_PROXY_URL,
    noProxy: env.DEV_RUNNER_NO_PROXY,
  });
  // Admission bounds (spec §4 hardening): a bearer-authed caller must not drive
  // unbounded container creation / stream handles. Each is an optional positive
  // integer override; a non-positive/non-numeric value falls back to the default.
  const maxLiveJobs = parsePositiveIntEnv(env.DEV_RUNNER_MAX_LIVE_JOBS);
  const maxInflight = parsePositiveIntEnv(env.DEV_RUNNER_MAX_INFLIGHT_JOBS);
  const maxLogFollows = parsePositiveIntEnv(env.DEV_RUNNER_MAX_LOG_FOLLOWS);
  const jobManager = new JobManager({ engine, policyClient, maxLiveJobs, maxInflight });
  const warmImageRefs = (env.DEV_RUNNER_IMAGES ?? env.DEV_RUNNER_DEFAULT_IMAGE ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  const server = createDaemon({ tokens, policyClient, jobManager, engine, warmImageRefs, maxLogFollows });

  // The lease reaper is the daemon's self-authority for containers (spec §7): it
  // rebuilds the registry from engine labels at boot (so a restart does not
  // orphan live jobs), then enforces lease expiry and sweeps orphans on a timer —
  // a wedged or compromised middleware can no longer pin containers forever.
  const reaper = createReaper({ jobManager, engine, intervalMs: resolveSweepIntervalMs(env) });
  // Rebuild + first sweep BEFORE accepting traffic, so a create for an already
  // running (re-adopted) job is idempotent from the first request.
  await reaper.start();
  server.on('close', () => reaper.stop());

  await new Promise((resolve) => server.listen(port, bind, () => resolve(undefined)));
  console.log(`[dev-runner-daemon] listening on ${bind}:${port}`);
  return server;
}

// Run main() only when executed as the entrypoint, so importing this module in
// a test never starts a listening server or touches docker.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[dev-runner-daemon] failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
