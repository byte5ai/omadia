/**
 * Epic #470 W1 — server-side job-policy derivation (spec §4, §6, §6b).
 *
 * The single source of a job's *effective* execution policy: its container
 * image, its environment, and its egress allowlist. The spec has a real
 * ambiguity here — §4 says the internal job-policy endpoint owns allowlist
 * computation, while §5/§6b say `DockerBackend.provision` computes it. This
 * pure helper resolves it: BOTH the endpoint (`routes/devRunnerApi.ts`) and
 * (later in W1) `DockerBackend.provision` call this one function, so they can
 * never disagree. The caller names a job; the policy is derived here, from the
 * `dev_repos` row and the job's own `auth_mode` — never from anything the
 * runner or the daemon supplies (review finding S3: a clamp that trusts
 * caller-supplied policy is not a clamp).
 *
 * Security invariant (regression-tested): the derived `env` carries NO secret.
 * No provider API key, no Vault path, no `DATABASE_URL`, no daemon token. The
 * real secrets are injected downstream by `DockerBackend` (from Vault) and the
 * daemon's reserved-key clamp (proxy creds); this function only ever produces
 * non-secret, structurally-known keys.
 */

import type { DevJob, DevRepo } from './types.js';

/** Environment forced on `auth_mode='subscription'` jobs (spec §6b): the CLI
 *  runs against `api.anthropic.com` directly, so statsig/sentry/autoupdate are
 *  turned off to keep the credential's blast radius to Anthropic alone. */
const SUBSCRIPTION_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
};

/** Egress hosts a subscription job needs to reach Anthropic directly (spec §6b).
 *  API-key jobs never get these — they reach Anthropic only via the middleware
 *  LLM proxy, which is the middleware host and thus already allowlisted. */
const SUBSCRIPTION_HOSTS: readonly string[] = ['api.anthropic.com', 'claude.ai', 'platform.claude.com'];

/** Config the derivation needs beyond the repo/job rows. All values are
 *  operator/deploy configuration, resolved once at wiring time and passed in;
 *  the per-job inputs (`repo`, `job`) are read live on every call so a mutated
 *  `dev_repos.egress_allowlist` takes effect on the next job with no restart. */
export interface DeriveJobPolicyConfig {
  /** Hostname the job container uses to reach the middleware (phone-home + LLM
   *  proxy). Implicit, always-present allowlist entry (spec §6). */
  readonly middlewareHost: string;
  /** `DEV_EGRESS_BASE_ALLOWLIST` — operator default (e.g. `registry.npmjs.org`);
   *  may be emptied by the operator. */
  readonly baseAllowlist: readonly string[];
  /** Digest-pinned runner image the job runs (`DEV_RUNNER_DEFAULT_IMAGE`). */
  readonly image: string;
  /** `ANTHROPIC_BASE_URL` for API-key jobs → the middleware LLM proxy. NEVER
   *  set for subscription jobs (spec §6b / Q4). */
  readonly llmProxyBaseUrl: string;
}

/** The effective, server-derived policy for one job. */
export interface DerivedJobPolicy {
  readonly image: string;
  readonly env: Record<string, string>;
  readonly egressAllowlist: string[];
}

/** The repo fields the derivation reads. A `Pick` so both the endpoint (holding
 *  a full `DevRepo`) and `DockerBackend` can call with the minimal shape. */
export type JobPolicyRepoInput = Pick<DevRepo, 'cloneUrl' | 'egressAllowlist'>;

/** The job fields the derivation reads. */
export type JobPolicyJobInput = Pick<DevJob, 'authMode'>;

/** Raised when the policy cannot be derived (e.g. an unparseable `clone_url`).
 *  The caller maps it to an opaque 5xx — the message never carries a secret. */
export class JobPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobPolicyError';
  }
}

/**
 * The forge hosts a job may reach, derived from the repo's HTTPS clone URL
 * (spec §6). GitHub additionally serves archive/redirect traffic from
 * `codeload.github.com`, so a `github.com` clone URL yields both.
 */
function forgeHostsFromCloneUrl(cloneUrl: string): string[] {
  let host: string;
  try {
    host = new URL(cloneUrl).hostname;
  } catch {
    throw new JobPolicyError('clone_url is not a parseable URL');
  }
  if (!host) throw new JobPolicyError('clone_url has no host');
  const lower = host.toLowerCase();
  if (lower === 'github.com') return ['github.com', 'codeload.github.com'];
  return [lower];
}

/** Append trimmed, non-empty, not-yet-seen hosts to `out` (preserves order). */
function pushHosts(out: string[], seen: Set<string>, hosts: Iterable<string>): void {
  for (const raw of hosts) {
    const host = typeof raw === 'string' ? raw.trim() : '';
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
}

/**
 * Derive a job's effective policy from the `dev_repos` row and the job's
 * `auth_mode`. Pure: same inputs → same output, no I/O, no globals. The single
 * source of truth for both the internal endpoint and `DockerBackend.provision`.
 *
 * Effective egress allowlist (spec §6, evaluated in this order, deduped):
 *   { middleware host } ∪ { forge host(s) from clone_url }
 *     ∪ DEV_EGRESS_BASE_ALLOWLIST ∪ dev_repos.egress_allowlist
 *     ∪ { Anthropic direct hosts }   // subscription jobs only
 */
export function deriveJobPolicy(
  repo: JobPolicyRepoInput,
  job: JobPolicyJobInput,
  config: DeriveJobPolicyConfig,
): DerivedJobPolicy {
  const subscription = job.authMode === 'subscription';

  // --- env: non-secret, structurally-known keys only (never a credential) ---
  const env: Record<string, string> = subscription
    ? { ...SUBSCRIPTION_ENV }
    : { ANTHROPIC_BASE_URL: config.llmProxyBaseUrl };

  // --- egress allowlist -----------------------------------------------------
  const allowlist: string[] = [];
  const seen = new Set<string>();
  pushHosts(allowlist, seen, [config.middlewareHost]);
  pushHosts(allowlist, seen, forgeHostsFromCloneUrl(repo.cloneUrl));
  pushHosts(allowlist, seen, config.baseAllowlist);
  pushHosts(allowlist, seen, repo.egressAllowlist);
  if (subscription) pushHosts(allowlist, seen, SUBSCRIPTION_HOSTS);

  return { image: config.image, env, egressAllowlist: allowlist };
}
