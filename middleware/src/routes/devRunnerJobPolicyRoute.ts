/**
 * Epic #470 W1 — the internal job-policy route, split out of `devRunnerApi.ts`
 * to keep that file within the repo's 500-line rule (spec §4, §6).
 *
 * `GET /api/v1/dev-runner/internal/job-policy/:jobId` is fetched by the DAEMON
 * (not a runner) at provision time. It returns the job's server-derived policy —
 * image, env, egress allowlist — computed by `deriveJobPolicy` from the
 * `dev_repos` row, NEVER from the caller (review finding S3). Its authentication
 * is the daemon token, a DIFFERENT credential from the per-job `djr_` runner
 * bearer: a runner token is rejected here, or any runner could read another
 * job's policy. It therefore does NOT use the runner router's job-bearer
 * `authMw`; it has its own daemon-token guard below.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import type { NextFunction, Request, Response, Router } from 'express';

import {
  deriveJobPolicy,
  JobPolicyError,
  type DeriveJobPolicyConfig,
} from '../devplatform/deriveJobPolicy.js';
import type { DevJob, DevRepo } from '../devplatform/types.js';

/** The narrow slices this route needs from the runner router's deps. */
export interface JobPolicyRouteDeps {
  store: { getJob(jobId: string): Promise<DevJob | null> };
  repos: {
    getRepo(id: string): Promise<Pick<DevRepo, 'cloneUrl' | 'egressAllowlist'> | null>;
  };
  /** The daemon's shared bearer secret (`DEV_RUNNER_DAEMON_TOKEN`). Absent ⇒ 503. */
  daemonToken?: string | undefined;
  /** Derivation config (spec §6). Absent ⇒ 503. */
  jobPolicyConfig?: DeriveJobPolicyConfig | undefined;
}

/** `{ code, message }` — codes prefixed `devplatform.`, never a secret/stack. */
function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ code, message });
}

/** Extract the bearer token. `Bearer <token>`, case-insensitive; else null. */
function bearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const m = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() || null : null;
}

/** Constant-time string equality. Hashing both sides keeps the compare
 *  fixed-width so neither the daemon token's length nor its bytes leak through a
 *  timing side channel (the same construction `verifyRunnerToken` uses). */
function timingSafeStrEqual(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a, 'utf8').digest();
  const bh = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ah, bh);
}

/** Register `GET /internal/job-policy/:jobId` on the runner router. */
export function mountJobPolicyRoute(router: Router, deps: JobPolicyRouteDeps): void {
  const { store, repos } = deps;

  const daemonAuthMw = (req: Request, res: Response, next: NextFunction): void => {
    // Not configured ⇒ the DockerBackend is not wired; the endpoint does not
    // exist for practical purposes. Same 503 the rest of the stack reports.
    if (!deps.daemonToken) {
      fail(res, 503, 'devplatform.daemon_not_configured', 'daemon token is not configured');
      return;
    }
    const token = bearerToken(req);
    if (!token) {
      fail(res, 401, 'devplatform.unauthorized', 'missing or malformed bearer token');
      return;
    }
    // A per-job `djr_` runner token can never equal the daemon secret, so the
    // constant-time compare already rejects it — this is the S3 guarantee.
    if (!timingSafeStrEqual(token, deps.daemonToken)) {
      fail(res, 401, 'devplatform.unauthorized', 'invalid daemon token');
      return;
    }
    next();
  };

  router.get('/internal/job-policy/:jobId', daemonAuthMw, async (req, res) => {
    if (!deps.jobPolicyConfig) {
      fail(res, 503, 'devplatform.daemon_not_configured', 'job policy config is not available');
      return;
    }
    const rawId = req.params['jobId'];
    const jobId = typeof rawId === 'string' ? rawId : '';
    const job = await store.getJob(jobId);
    if (!job) {
      // The daemon named a job that does not exist — a plain not-found, not an
      // auth failure (the daemon is already authenticated).
      fail(res, 404, 'devplatform.job_not_found', 'no such job');
      return;
    }
    const repo = await repos.getRepo(job.repoId);
    if (!repo) {
      fail(res, 500, 'devplatform.repo_unavailable', 'job repository is not available');
      return;
    }
    let policy;
    try {
      policy = deriveJobPolicy(repo, job, deps.jobPolicyConfig);
    } catch (err) {
      // JobPolicyError (e.g. an unparseable clone_url) is a server-side
      // misconfiguration; never echo its message (defence-in-depth) or a stack.
      const code =
        err instanceof JobPolicyError ? 'devplatform.policy_underivable' : 'devplatform.internal';
      fail(res, 500, code, 'job policy could not be derived');
      return;
    }
    res.json({
      jobId: job.id,
      image: policy.image,
      env: policy.env,
      egressAllowlist: policy.egressAllowlist,
    });
  });
}
