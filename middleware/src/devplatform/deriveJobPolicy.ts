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

import { isInternalHost, isInternalIp } from '../services/ssrfGuard.js';
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
 *
 * SSRF hardening (review S-finding): the clone_url is operator/repo-supplied and
 * flows straight into the job's egress allowlist, so a hostile row like
 * `https://github.com@169.254.169.254/x` (userinfo confusion) would otherwise
 * allowlist the cloud-metadata endpoint. We therefore require an https scheme,
 * reject any userinfo, and refuse an IP-literal or internal-resolving hostname
 * via the SAME predicate the egress SSRF guard uses (`isInternalHost`).
 */
function forgeHostsFromCloneUrl(cloneUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(cloneUrl);
  } catch {
    throw new JobPolicyError('clone_url is not a parseable URL');
  }
  if (url.protocol !== 'https:') {
    throw new JobPolicyError('clone_url must use https');
  }
  if (url.username || url.password) {
    // `https://github.com@169.254.169.254/x` parses with hostname
    // 169.254.169.254 and username github.com — the classic confusion.
    throw new JobPolicyError('clone_url must not carry userinfo');
  }
  const host = url.hostname;
  if (!host) throw new JobPolicyError('clone_url has no host');
  const lower = normalizeHostname(host);
  // A trailing-dot FQDN (`metadata.google.internal.`, `localhost.`) resolves to
  // the same target as its dotless form but would slip past the `.internal`/
  // `localhost` predicates; `normalizeHostname` strips exactly one trailing dot,
  // and anything still malformed after that (empty, `..`, embedded NUL, a second
  // trailing dot) is refused rather than allowlisted.
  if (!lower || lower.endsWith('.') || lower.includes('..') || lower.includes('\0')) {
    throw new JobPolicyError('clone_url host is malformed');
  }
  if (isInternalHost(lower)) {
    throw new JobPolicyError('clone_url host resolves to an internal address');
  }
  if (lower === 'github.com') return ['github.com', 'codeload.github.com'];
  return [lower];
}

/** Canonicalise a hostname for the internal-host checks and the egress
 *  allowlist: lowercase, strip IPv6 brackets, and strip a SINGLE trailing FQDN
 *  dot. A residual trailing dot (i.e. `..`) is left in place so the caller can
 *  reject it. */
function normalizeHostname(raw: string): string {
  const h = raw.toLowerCase().replace(/^\[|\]$/g, '');
  return h.endsWith('.') ? h.slice(0, -1) : h;
}

/** One dot-separated DNS label: 1–63 chars, alphanumerics + inner hyphens. */
const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A valid egress-allowlist entry is a BARE hostname — no scheme, no userinfo, no
 * port, no path/query/fragment, no wildcard, no whitespace/control chars — and
 * NOT an IP literal (a private-IP literal such as `169.254.169.254` or `10.0.0.1`
 * would otherwise become effective egress policy for the sandboxed job). We keep
 * operator-chosen internal *names* (e.g. `artifactory.internal`) — those are a
 * deliberate allowlist choice, unlike a raw metadata-range IP literal — but drop
 * everything that is not a plain resolvable hostname. Returns null for a valid
 * host (its lowercased form), or a reason string for the caller to log.
 */
function classifyEgressEntry(raw: unknown): { host: string } | { reject: string } {
  if (typeof raw !== 'string') return { reject: 'not a string' };
  const trimmed = raw.trim();
  if (!trimmed) return { reject: 'empty' };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f]/.test(trimmed)) return { reject: 'whitespace/control char' };
  if (trimmed.includes('://') || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return { reject: 'has a scheme' };
  if (/[/?#@]/.test(trimmed)) return { reject: 'has a path/userinfo' };
  if (trimmed.includes('*')) return { reject: 'wildcard not supported' };
  if (trimmed.includes(':')) return { reject: 'has a port or is an IPv6 literal' };
  if (trimmed.includes('\0')) return { reject: 'embedded NUL' };
  // Same normalisation as the clone_url path: strip a single trailing FQDN dot so
  // a trailing-dot literal (`169.254.169.254.`) is caught by the IP checks below
  // and a `foo.internal.` name is validated in canonical form.
  const lower = normalizeHostname(trimmed);
  // Canonicalise the entry the way a network consumer will: parse it as a URL
  // authority and read the hostname back. WHATWG URL parsing rewrites numeric,
  // hex, octal, and short-form IPv4 spellings to dotted-quad (`2130706433` →
  // `127.0.0.1`, `0x7f.0.0.1` → `127.0.0.1`, `017700000001` → `127.0.0.1`,
  // `3232235777` → `192.168.1.1`, `127.1` → `127.0.0.1`). A label-shaped pattern
  // match would happily accept those all-digit/hex strings as a "hostname" and so
  // allowlist loopback/RFC1918 under a non-dotted spelling. So if the parser
  // rewrites the host AT ALL, it was not the plain hostname it appeared to be —
  // reject the whole class here rather than enumerate spellings.
  let canonical: string;
  try {
    canonical = new URL(`http://${lower}/`).hostname;
  } catch {
    return { reject: 'not a valid hostname' };
  }
  if (canonical !== lower) return { reject: `not a bare hostname (URL parser rewrote it to ${canonical})` };
  // Reject IPv4 literals outright — including internal ones (metadata/RFC1918) and
  // bracketed IPv6 literals (a `:` was already refused above, but the canonical
  // form is checked for defence in depth).
  if (/^[0-9]+(\.[0-9]+){3}$/.test(canonical) || canonical.startsWith('[') || isInternalIp(canonical))
    return { reject: 'IP literal' };
  const labels = lower.split('.');
  if (!labels.every((l) => HOSTNAME_LABEL.test(l))) return { reject: 'not a valid hostname' };
  return { host: lower };
}

/** Append trimmed, non-empty, not-yet-seen hosts to `out` (preserves order).
 *  Trusted, server-derived hosts (middleware + forge) skip validation; the two
 *  untrusted allowlists (base + repo row) are validated by the caller. */
function pushHosts(out: string[], seen: Set<string>, hosts: Iterable<string>): void {
  for (const raw of hosts) {
    const host = typeof raw === 'string' ? raw.trim() : '';
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
}

/** Validate each entry as a bare hostname, dropping (and loudly logging) any that
 *  is not — a scheme, port, path, wildcard, CIDR, control char, or IP literal. */
function pushValidatedHosts(
  out: string[],
  seen: Set<string>,
  hosts: Iterable<string>,
  source: string,
  log: (msg: string) => void,
): void {
  for (const raw of hosts) {
    const classified = classifyEgressEntry(raw);
    if ('reject' in classified) {
      log(`[dev-platform] dropped invalid egress entry from ${source} (${classified.reject}): ${JSON.stringify(raw)}`);
      continue;
    }
    if (seen.has(classified.host)) continue;
    seen.add(classified.host);
    out.push(classified.host);
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
  log: (msg: string) => void = () => {},
): DerivedJobPolicy {
  const subscription = job.authMode === 'subscription';

  // --- env: non-secret, structurally-known keys only (never a credential) ---
  const env: Record<string, string> = subscription
    ? { ...SUBSCRIPTION_ENV }
    : { ANTHROPIC_BASE_URL: config.llmProxyBaseUrl };

  // --- egress allowlist -----------------------------------------------------
  // Server-derived hosts (middleware + forge) are trusted; the two operator/repo
  // allowlists are validated as bare hostnames, dropping malformed/IP-literal
  // entries (review S-finding: '*', schemes, ports, CIDRs, private-IP literals
  // must never become effective egress policy).
  const allowlist: string[] = [];
  const seen = new Set<string>();
  pushHosts(allowlist, seen, [config.middlewareHost]);
  pushHosts(allowlist, seen, forgeHostsFromCloneUrl(repo.cloneUrl));
  pushValidatedHosts(allowlist, seen, config.baseAllowlist, 'DEV_EGRESS_BASE_ALLOWLIST', log);
  pushValidatedHosts(allowlist, seen, repo.egressAllowlist, 'dev_repos.egress_allowlist', log);
  if (subscription) pushHosts(allowlist, seen, SUBSCRIPTION_HOSTS);

  return { image: config.image, env, egressAllowlist: allowlist };
}
