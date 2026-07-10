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
 * DEFENCE IN DEPTH (review round-3, high finding). The middleware is a SEPARATE
 * privilege domain: it holds Vault and the LLM credentials, the daemon holds the
 * dind engine. A courier that runs whatever image the middleware names would
 * collapse those two domains — a compromised or spoofed middleware could then
 * run an arbitrary image inside dind. So the policy the middleware returns is
 * treated as UNTRUSTED input and clamped here, daemon-side:
 *
 *   - the image REPOSITORY must be in `DEV_RUNNER_ALLOWED_IMAGES` (an operator
 *     allowlist the daemon refuses to start without — see `parseAllowedImages`);
 *   - the image must be DIGEST-PINNED (`repo@sha256:<64hex>`) when
 *     `DEV_RUNNER_REQUIRE_DIGEST` is on (default true) — a floating tag is
 *     mutable and is refused;
 *   - the policy `env` must carry ONLY keys on an explicit ALLOWLIST — the exact
 *     set the runner legitimately needs (`ALLOWED_ENV_KEYS`); anything else is
 *     refused by key name.
 *
 * Any violation throws `PolicyLookupError` BEFORE the policy reaches
 * `createJobContainer`, so no container is ever created from a rejected policy.
 *
 * The response shape is validated against the middleware's real return
 * (`devRunnerJobPolicyRoute.ts` — `{ jobId, image, env, egressAllowlist }`)
 * with a local zod schema; a malformed or truncated policy is refused rather
 * than fed to container creation. The body read is BOUNDED (byte cap) and
 * TIMED (the abort signal stays armed across the whole request, headers AND
 * body), so a peer that dribbles or floods the body fails fast.
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

/** Default hard cap on the policy response body. These are tiny JSON envelopes;
 *  256 KiB is orders of magnitude of headroom while still bounding a flood. */
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

/** Default per-lookup timeout (spec §5 connect budget). Covers headers AND the
 *  body read — the signal stays armed until the body is fully consumed. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * A valid content-address digest: `algorithm:hex`, at least 32 hex chars (so a
 * stub like `sha256:abc` — not a real content address — is refused). Covers
 * `sha256:<64hex>` and `sha512:<128hex>`.
 */
const DIGEST_RE = /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[0-9a-f]{32,}$/;

/**
 * The EXACT set of environment keys the daemon will pass into a job container.
 * This is an ALLOWLIST, not a denylist — and that choice is the whole security
 * property here. A denylist has to predict every dangerous key, but the runner's
 * job is to clone and diff repositories and spawn a CLI, so the git/shell/loader
 * families alone already carry command-execution sinks (`GIT_SSH_COMMAND`,
 * `GIT_EXTERNAL_DIFF`, `GIT_PROXY_COMMAND`, `BASH_ENV`, `ENV`, `LD_PRELOAD`,
 * `LD_AUDIT`, `NODE_OPTIONS`, …). A compromised or spoofed middleware — this
 * unit's stated adversary — needs only ONE such key to get arbitrary execution
 * on the next `git`/shell invocation, and every tool the runner image later
 * gains (ssh, make, perl) silently adds more. A denylist cannot enumerate that
 * moving target; an allowlist refuses it by construction. This is the same
 * lesson the W0 shim env (`readShimEnv`) and the W1 egress-proxy headers already
 * learned: name what you accept, refuse everything else.
 *
 * The set is the exhaustive union of what the runner legitimately needs, derived
 * from the code on this branch:
 *   - shim inputs (`packages/dev-runner-shim/src/protocol.ts` `readShimEnv`, and
 *     the gated LLM-passthrough pair in `index.ts`);
 *   - LLM + CLI behaviour keys emitted/consumed by
 *     `src/devplatform/deriveJobPolicy.ts` and the Claude CLI;
 *   - the egress-proxy vars (W1 spec §6) — both UPPER and lower spellings are
 *     accepted because curl/libcurl honour the lowercase names and git/node the
 *     uppercase ones; the docker clamp overrides these per-job anyway, so
 *     admitting them in the policy env is harmless and keeps the two layers from
 *     disagreeing;
 *   - benign locale/tooling keys.
 * `deriveJobPolicy` today emits only a small subset; the rest are admitted so a
 * legitimate future policy is not rejected — the point of the clamp is to refuse
 * the DANGEROUS unknown, not every unknown the derivation might grow into.
 */
const ALLOWED_ENV_KEYS = new Set([
  // shim inputs (readShimEnv) + gated LLM passthrough (index.ts)
  'OMADIA_JOB_BASE_URL',
  'OMADIA_JOB_ID',
  'OMADIA_JOB_TOKEN',
  'OMADIA_WORKSPACE',
  'OMADIA_CLI_BIN',
  'OMADIA_LLM_ENV_ALLOWED',
  'OMADIA_ANTHROPIC_BASE_URL',
  'OMADIA_ANTHROPIC_AUTH_TOKEN',
  // LLM + CLI behaviour (deriveJobPolicy + Claude CLI)
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_AUTOUPDATER',
  'DISABLE_TELEMETRY',
  // egress proxy (W1 spec §6) — both spellings
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  // benign locale / tooling
  'LANG',
  'LC_ALL',
  'TERM',
]);

/**
 * `HOME` and `CLAUDE_CONFIG_DIR` are deliberately ABSENT from the allowlist,
 * even though the container needs both. They are command-execution levers, not
 * settings: a `HOME` under attacker control means an attacker-controlled
 * `~/.gitconfig` (`core.pager`, `core.sshCommand`, `alias.*` all execute) and
 * an attacker-controlled Claude config directory means attacker-controlled
 * hooks. Accepting them from the untrusted policy would reopen, through a side
 * door, exactly the arbitrary-execution class this allowlist exists to shut —
 * the same reason `localProcessBackend` gives the shim a job-scoped `HOME` and
 * never the parent's.
 *
 * The container image sets both to fixed, job-scoped paths. The middleware has
 * no say in them.
 */

/**
 * @typedef {object} DerivedJobPolicy
 * @property {string} jobId
 * @property {string} image
 * @property {Record<string, string>} env
 * @property {string[]} egressAllowlist
 */

/**
 * @typedef {object} ParsedImageRef
 * @property {string} repository The `[registry[:port]/]name` part, no tag/digest.
 * @property {string | undefined} tag The `:tag` part, if any.
 * @property {string | undefined} digest The `@algo:hex` part, if any.
 */

/**
 * Raised at boot when the daemon's image/digest configuration is missing or
 * malformed (e.g. `DEV_RUNNER_ALLOWED_IMAGES` empty). The daemon refuses to
 * start on this — running without an image allowlist is never silently allowed.
 */
export class PolicyConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PolicyConfigError';
  }
}

/**
 * Raised when the policy lookup fails: the middleware was unreachable, returned
 * a non-2xx, returned a body that failed schema validation, or returned a policy
 * that violates the daemon-side clamp (unlisted image, floating tag, reserved
 * env key). `status` is the upstream HTTP status (0 when the request never
 * completed). `code` is a stable `daemon.`-prefixed slug the HTTP layer maps to
 * a response — never a secret.
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
 * Parse `DEV_RUNNER_ALLOWED_IMAGES` — a comma-separated list of BARE image
 * repositories (e.g. `ghcr.io/byte5ai/omadia-dev-runner`). Trims, drops empties,
 * and rejects any entry that carries a tag or digest (an allowlist entry names a
 * repository, not a specific version). Throws `PolicyConfigError` when the result
 * is empty — the daemon must not run without an image allowlist.
 *
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export function parseAllowedImages(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new PolicyConfigError(
      'DEV_RUNNER_ALLOWED_IMAGES is not set — the daemon refuses to run without an image allowlist',
    );
  }
  const images = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (images.length === 0) {
    throw new PolicyConfigError('DEV_RUNNER_ALLOWED_IMAGES contains no non-empty entry');
  }
  for (const image of images) {
    const { tag, digest } = parseImageReference(image);
    if (tag !== undefined || digest !== undefined) {
      throw new PolicyConfigError(
        `DEV_RUNNER_ALLOWED_IMAGES entry must be a bare repository (no tag/digest): ${JSON.stringify(image)}`,
      );
    }
  }
  return images;
}

/**
 * Parse `DEV_RUNNER_REQUIRE_DIGEST`. Default ON — the daemon requires
 * digest-pinned images unless the operator explicitly opts out with a falsey
 * value (`false`/`0`/`no`/`off`).
 *
 * @param {string | undefined} raw
 * @returns {boolean}
 */
export function parseRequireDigest(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'no' || v === 'off');
}

/**
 * Split an OCI image reference into `{ repository, tag, digest }`.
 * Grammar: `[registry[:port]/]repository[:tag][@digest]`. The tag is the LAST
 * `:` that falls after the last `/` (so a `registry:port` colon is not mistaken
 * for a tag); the digest is everything after `@`.
 *
 * @param {string} ref
 * @returns {ParsedImageRef}
 */
export function parseImageReference(ref) {
  let rest = ref;
  /** @type {string | undefined} */
  let digest;
  const at = rest.indexOf('@');
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  const lastSlash = rest.lastIndexOf('/');
  const lastColon = rest.lastIndexOf(':');
  /** @type {string | undefined} */
  let tag;
  let repository = rest;
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    repository = rest.slice(0, lastColon);
  }
  return { repository, tag, digest };
}

/**
 * Clamp the policy image against the daemon-side allowlist + digest policy.
 * Throws `PolicyLookupError` (mapped by the HTTP layer to a generic 502) if the
 * repository is not allowlisted, or a digest is required but absent/malformed.
 *
 * @param {string} image
 * @param {readonly string[]} allowedImages
 * @param {boolean} requireDigest
 * @param {number} status Upstream status to attach (the policy fetch itself was 2xx).
 */
function assertPolicyImage(image, allowedImages, requireDigest, status) {
  const { repository, digest } = parseImageReference(image);
  if (!allowedImages.includes(repository)) {
    throw new PolicyLookupError(
      status,
      'daemon.image_not_allowed',
      'policy names an image whose repository is not in the daemon allowlist',
    );
  }
  if (requireDigest) {
    if (digest === undefined) {
      throw new PolicyLookupError(
        status,
        'daemon.image_requires_digest',
        'policy image is not digest-pinned (a floating tag is refused)',
      );
    }
    if (!DIGEST_RE.test(digest)) {
      throw new PolicyLookupError(status, 'daemon.image_bad_digest', 'policy image digest is malformed');
    }
  }
}

/**
 * Clamp the policy env against the ALLOWLIST. Throws `PolicyLookupError` on the
 * first key that is not in `ALLOWED_ENV_KEYS`. The message names the offending
 * KEY (a key name is not a secret) but NEVER its value — a spoof attempt smuggles
 * the payload in the value (e.g. `GIT_SSH_COMMAND=sh -c <cmd>`), so logging the
 * value would echo the attack; the key alone is enough to diagnose.
 *
 * @param {Record<string, string>} env
 * @param {number} status
 */
function assertPolicyEnv(env, status) {
  for (const key of Object.keys(env)) {
    if (!ALLOWED_ENV_KEYS.has(key)) {
      throw new PolicyLookupError(
        status,
        'daemon.env_key_not_allowed',
        `policy env carries a key that is not on the daemon allowlist: ${JSON.stringify(key)}`,
      );
    }
  }
}

/**
 * Read a response body under a hard byte cap, cancelling (and aborting the whole
 * request) the moment the cap is exceeded, so an oversized body never buffers to
 * exhaustion. Reads the WHATWG stream directly; falls back to `text()` for a
 * fetch impl (test fake) that returns no stream body.
 *
 * @param {Response} res
 * @param {number} maxBytes
 * @param {AbortController} controller
 * @returns {Promise<string>}
 */
async function readCappedBody(res, maxBytes, controller) {
  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          controller.abort();
          try {
            await reader.cancel();
          } catch {
            // best-effort — the abort already tore the stream down.
          }
          throw new PolicyLookupError(
            res.status,
            'daemon.policy_too_large',
            `job-policy response exceeds the ${maxBytes}-byte cap`,
          );
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore — nothing more to read.
      }
    }
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  // Fallback: a fetch fake with no stream body. Still cap the decoded length.
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new PolicyLookupError(res.status, 'daemon.policy_too_large', `job-policy response exceeds the ${maxBytes}-byte cap`);
  }
  return text.trim();
}

/**
 * @typedef {object} PolicyClient
 * @property {(jobId: string) => Promise<DerivedJobPolicy>} fetchJobPolicy
 */

/**
 * @typedef {object} PolicyClientDeps
 * @property {string} middlewareUrl Base URL of the middleware (e.g. `http://middleware:8080`).
 * @property {string} daemonToken The daemon bearer used to authenticate the lookup.
 * @property {readonly string[]} allowedImages Repositories the daemon will run (non-empty).
 * @property {boolean} [requireDigest] Require a digest-pinned image; defaults to true.
 * @property {typeof fetch} [fetchImpl] Test seam; defaults to global `fetch`.
 * @property {number} [timeoutMs] Per-lookup timeout; defaults to 10s (spec §5 connect budget).
 * @property {number} [maxBodyBytes] Hard cap on the policy body; defaults to 256 KiB.
 */

/**
 * Build a policy client bound to one middleware URL + daemon token + image
 * allowlist. Refuses to construct without a non-empty allowlist — the clamp is
 * not optional.
 *
 * @param {PolicyClientDeps} deps
 * @returns {PolicyClient}
 */
export function createPolicyClient(deps) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const requireDigest = deps.requireDigest ?? true;
  const allowedImages = deps.allowedImages ?? [];
  if (allowedImages.length === 0) {
    throw new PolicyConfigError('createPolicyClient requires a non-empty image allowlist (DEV_RUNNER_ALLOWED_IMAGES)');
  }
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
      // ONE timer covers the whole exchange — headers AND the body read — so a
      // peer that answers headers fast then dribbles the body still fails fast.
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
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
            // The endpoint is configured and pinned; a 30x would move the request
            // off it. Refuse to follow — a redirect is a lookup failure.
            redirect: 'error',
          });
        } catch (err) {
          if (err instanceof PolicyLookupError) throw err;
          const reason = err instanceof Error ? err.message : String(err);
          throw new PolicyLookupError(0, 'daemon.policy_unreachable', `job-policy lookup failed: ${reason}`);
        }

        let raw;
        try {
          raw = await readCappedBody(res, maxBodyBytes, controller);
        } catch (err) {
          if (err instanceof PolicyLookupError) throw err;
          const reason = err instanceof Error ? err.message : String(err);
          throw new PolicyLookupError(
            typeof res.status === 'number' ? res.status : 0,
            'daemon.policy_unreachable',
            `job-policy body read failed: ${reason}`,
          );
        }

        if (!res.ok) {
          // Surface the middleware's own error code when it sent one, so a caller
          // can distinguish "no such job" (404) from an auth/derivation failure.
          let code = 'daemon.policy_lookup_failed';
          try {
            const body = /** @type {{ code?: unknown }} */ (JSON.parse(raw));
            if (typeof body?.code === 'string') code = body.code;
          } catch {
            // Non-JSON error body — keep the generic code.
          }
          throw new PolicyLookupError(res.status, code, `job-policy lookup returned HTTP ${res.status}`);
        }

        /** @type {unknown} */
        let body;
        try {
          body = JSON.parse(raw);
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

        // Daemon-side clamp on the UNTRUSTED upstream policy (round-3 high finding):
        // an unlisted image, a floating tag, or a reserved env key is refused here,
        // before the policy can reach createJobContainer.
        assertPolicyImage(parsed.data.image, allowedImages, requireDigest, res.status);
        assertPolicyEnv(parsed.data.env, res.status);
        return parsed.data;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
