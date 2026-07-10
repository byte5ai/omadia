/**
 * Epic #470 W1 — the daemon's job-policy client (spec §4, review finding S3).
 *
 * The daemon NEVER takes a job's execution policy from its caller. `POST
 * /v1/jobs` carries only `{ protocol, jobId, leaseTtlSec }`; the effective
 * policy (image, env, egress allowlist) is fetched HERE, from the middleware's
 * internal endpoint, authenticated with the daemon token:
 *
 *   GET <MIDDLEWARE_URL>/api/v1/dev-runner/internal/job-policy/:jobId
 *   Authorization: Bearer <DEV_RUNNER_DAEMON_TOKEN>
 *
 * The middleware derives it from the `dev_repos` row (`deriveJobPolicy`), so
 * "the caller names a job; it never supplies a policy" is enforced across the
 * whole path, not merely at the daemon's schema boundary.
 *
 * The response shape is validated against the middleware's real return
 * (`devRunnerJobPolicyRoute.ts` — `{ jobId, image, env, egressAllowlist }`)
 * with a local zod schema; a malformed or truncated policy is refused rather
 * than fed to container creation.
 */

import { z } from 'zod';

/**
 * The internal job-policy response. Mirrors `devRunnerJobPolicyRoute.ts`, which
 * returns `deriveJobPolicy`'s output plus the echoed `jobId`. Validated so a
 * broken policy can never reach `createJobContainer`.
 */
const JobPolicyResponseSchema = z.object({
  jobId: z.string(),
  image: z.string().min(1),
  env: z.record(z.string(), z.string()),
  egressAllowlist: z.array(z.string()),
});

/**
 * @typedef {object} DerivedJobPolicy
 * @property {string} jobId
 * @property {string} image
 * @property {Record<string, string>} env
 * @property {string[]} egressAllowlist
 */

/**
 * Raised when the policy lookup fails: the middleware was unreachable, returned
 * a non-2xx, or returned a body that failed schema validation. `status` is the
 * upstream HTTP status (0 when the request never completed). `code` is a stable
 * `daemon.`-prefixed slug the HTTP layer maps to a response — never a secret.
 */
export class PolicyLookupError extends Error {
  /**
   * @param {number} status Upstream HTTP status, or 0 if unreachable.
   * @param {string} code Stable `daemon.`-prefixed error slug.
   * @param {string} message Non-sensitive description.
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'PolicyLookupError';
    /** @type {number} */
    this.status = status;
    /** @type {string} */
    this.code = code;
  }
}

/**
 * @typedef {object} PolicyClient
 * @property {(jobId: string) => Promise<DerivedJobPolicy>} fetchJobPolicy
 */

/**
 * @typedef {object} PolicyClientDeps
 * @property {string} middlewareUrl Base URL of the middleware (e.g. `http://middleware:8080`).
 * @property {string} daemonToken The daemon bearer used to authenticate the lookup.
 * @property {typeof fetch} [fetchImpl] Test seam; defaults to global `fetch`.
 * @property {number} [timeoutMs] Per-lookup timeout; defaults to 10s (spec §5 connect budget).
 */

/**
 * Build a policy client bound to one middleware URL + daemon token.
 *
 * @param {PolicyClientDeps} deps
 * @returns {PolicyClient}
 */
export function createPolicyClient(deps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const base = deps.middlewareUrl.replace(/\/+$/, '');

  return {
    /**
     * @param {string} jobId
     * @returns {Promise<DerivedJobPolicy>}
     */
    async fetchJobPolicy(jobId) {
      // jobId is UUID-validated at the wire schema before we get here; encode it
      // anyway so nothing malformed could ever alter the request path.
      const url = `${base}/api/v1/dev-runner/internal/job-policy/${encodeURIComponent(jobId)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      /** @type {Response} */
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${deps.daemonToken}`,
            accept: 'application/json',
          },
          signal: controller.signal,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new PolicyLookupError(0, 'daemon.policy_unreachable', `job-policy lookup failed: ${reason}`);
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        // Surface the middleware's own error code when it sent one, so a caller
        // can distinguish "no such job" (404) from an auth/derivation failure.
        let code = 'daemon.policy_lookup_failed';
        try {
          const body = /** @type {{ code?: unknown }} */ (await res.json());
          if (typeof body?.code === 'string') code = body.code;
        } catch {
          // Non-JSON error body — keep the generic code.
        }
        throw new PolicyLookupError(res.status, code, `job-policy lookup returned HTTP ${res.status}`);
      }

      /** @type {unknown} */
      let body;
      try {
        body = await res.json();
      } catch {
        throw new PolicyLookupError(res.status, 'daemon.policy_malformed', 'job-policy response was not JSON');
      }
      const parsed = JobPolicyResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new PolicyLookupError(
          res.status,
          'daemon.policy_malformed',
          'job-policy response failed schema validation',
        );
      }
      return parsed.data;
    },
  };
}
