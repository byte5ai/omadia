/**
 * Epic #470 W1 — the hardening clamp (spec §4). THE CLAMP IS THE ISOLATION.
 *
 * `buildContainerCreateOptions` is the single, PURE authority that turns a job id
 * plus its already-derived policy into the EXACT dockerode create-options object
 * the engine hands to `docker.createContainer`. Three review lessons shape it:
 *
 *  (a) It builds the create-options from NOTHING and adds only the fields the
 *      clamp allows — it never takes a caller object and strips fields. The clamp
 *      is an ALLOWLIST over docker's HostConfig, not a scrub-list, so a field the
 *      clamp does not set can never appear (no `Privileged`, no `Devices`, no host
 *      `PidMode`/`IpcMode`/`NetworkMode`, no extra `Binds`).
 *  (b) The object this function returns IS the object the engine passes to
 *      dockerode — the engine does not re-derive or mutate it — so a table test on
 *      this function's output is a test on the container that actually runs.
 *  (d) The image is classified (digest-pinned?) AFTER canonicalisation via the
 *      shared `parseImageReference`, never by ad-hoc string matching.
 *
 * The policy handed in is the ALREADY-CLAMPED `DerivedJobPolicy` from the policy
 * client: image digest-pinned + allowlisted, env past the key allowlist with the
 * daemon-owned keys injected, egress canonicalised. This module does NOT re-derive
 * policy; it enforces the CONTAINER shape and refuses anything the clamp forbids
 * with a `spec_rejected`-shaped error rather than silently granting or dropping it.
 */

/**
 * @typedef {import('./policyClient.mjs').DerivedJobPolicy} DerivedJobPolicy
 */

import { parseImageReference } from './policyClient.mjs';

/**
 * A valid content-address digest: `algorithm:hex`, ≥32 hex chars — a stub like
 * `sha256:abc` is refused. Mirrors `policyClient`'s internal `DIGEST_RE`; the
 * `netClassify`↔`ssrfGuard` parity test is the model for keeping such copies
 * honest, but a floating-tag reject here is defence-in-depth: the policy client
 * already enforces the digest when `DEV_RUNNER_REQUIRE_DIGEST` is on (default),
 * so this is the last line if that knob is ever turned off.
 */
const DIGEST_RE = /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[0-9a-f]{32,}$/;

/**
 * Raised when the clamp refuses a job's requested container shape (spec §4:
 * "anything the clamp forbids fails the job with `spec_rejected`, never silently
 * granted"). Carries a stable `daemon.`-prefixed code and a non-sensitive
 * `reason` slug so the HTTP layer can surface WHY without leaking policy detail.
 */
export class SpecRejectedError extends Error {
  /** @param {string} reason A short non-sensitive slug, e.g. `image_not_digest_pinned`. @param {string} detail */
  constructor(reason, detail) {
    super(`spec rejected (${reason}): ${detail}`);
    this.name = 'SpecRejectedError';
    /** @type {string} */
    this.code = 'daemon.spec_rejected';
    /** @type {string} */
    this.reason = reason;
  }
}

/** 4 GiB — the memory limit floor (spec §4/§8). */
const DEFAULT_MEM_BYTES = 4 * 1024 ** 3;
/** 2 CPUs. */
const DEFAULT_CPUS = 2;
/** Max process count inside a job (fork-bomb bound). */
const DEFAULT_PIDS = 512;
/** tmpfs size for `/tmp`, in MiB. */
const DEFAULT_TMPFS_MB = 512;
/** open-file ulimit (soft==hard). */
const DEFAULT_NOFILE = 4096;

/**
 * Resolved, always-present numeric limits for the clamp. Every field is a hard
 * bound — none can be absent (an absent `Memory` means UNLIMITED, the exact DoS
 * the clamp exists to prevent), so a missing/invalid env value falls back to the
 * floor rather than removing the limit.
 * @typedef {object} ClampLimits
 * @property {number} memoryBytes
 * @property {number} nanoCpus
 * @property {number} pidsLimit
 * @property {number} tmpfsMb
 * @property {number} nofile
 */

/**
 * Parse a docker-style size (`4g`, `512m`, `1048576`) to bytes (binary units).
 * Returns null on anything unparseable so the caller falls back to a floor.
 * @param {string | undefined} raw
 * @returns {number | null}
 */
export function parseSizeBytes(raw) {
  if (raw === undefined || raw === null) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(String(raw).trim());
  if (!m) return null;
  const numStr = m[1];
  if (numStr === undefined) return null;
  const n = Number(numStr);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? '').toLowerCase();
  const mult =
    unit === 't' ? 1024 ** 4 : unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1;
  return Math.round(n * mult);
}

/**
 * Parse a positive number (int or float). Null on non-positive/non-finite.
 * @param {string | undefined} raw
 * @returns {number | null}
 */
function parsePositiveNumber(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve the clamp's numeric limits from the daemon env (spec §8). Isolation
 * fields (non-root, read-only rootfs, dropped caps, host-mount refusal) are NOT
 * configurable and live in `buildContainerCreateOptions`; only the resource
 * BOUNDS are env-tunable, and every one always resolves to a positive value so a
 * limit is never removed.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ClampLimits}
 */
export function resolveClampLimits(env = {}) {
  const cpus = parsePositiveNumber(env.DEV_JOB_CPUS) ?? DEFAULT_CPUS;
  return {
    memoryBytes: parseSizeBytes(env.DEV_JOB_MEM) ?? DEFAULT_MEM_BYTES,
    nanoCpus: Math.round(cpus * 1_000_000_000),
    pidsLimit: Math.round(parsePositiveNumber(env.DEV_JOB_PIDS) ?? DEFAULT_PIDS),
    tmpfsMb: Math.round(parsePositiveNumber(env.DEV_JOB_TMPFS_MB) ?? DEFAULT_TMPFS_MB),
    nofile: Math.round(parsePositiveNumber(env.DEV_JOB_NOFILE) ?? DEFAULT_NOFILE),
  };
}

/**
 * The content-address digest of an image reference, or undefined for a floating
 * tag. Canonicalises via the shared parser (lesson (d)) — never string-matching.
 * @param {string} ref
 * @returns {string | undefined}
 */
export function imageDigestOf(ref) {
  return parseImageReference(ref).digest;
}

/**
 * The per-job docker network name (spec §2: `omadia-job-<jobId>`). One job per
 * network → no job-to-job lateral traffic. Deterministic from the UUID job id so
 * the reaper can reconcile it from labels alone.
 * @param {string} jobId
 * @returns {string}
 */
export function jobNetworkName(jobId) {
  return `omadia-job-${jobId}`;
}

/**
 * The per-job workspace volume name (spec §2). Same UUID-derived name; a separate
 * docker namespace from the network, so sharing the string is safe.
 * @param {string} jobId
 * @returns {string}
 */
export function jobVolumeName(jobId) {
  return `omadia-job-${jobId}`;
}

/**
 * Build the FULL §4 clamp as a dockerode create-options object. Pure: no docker
 * I/O, no clock, no mutation of its inputs. The engine hands the returned object
 * verbatim to `docker.createContainer`, so every guarantee asserted on this
 * output holds for the container that actually runs.
 *
 * @param {object} args
 * @param {string} args.jobId UUID.
 * @param {DerivedJobPolicy} args.policy Already-clamped policy (image/env/egress).
 * @param {string} args.leaseExpiresAt ISO-8601 lease expiry (a label).
 * @param {string} args.networkName Per-job bridge; becomes `NetworkMode`.
 * @param {string} args.volumeName Per-job workspace volume; the ONLY bind.
 * @param {string} args.createdBy Principal recorded in the `createdBy` label.
 * @param {ClampLimits} args.limits Resolved resource bounds.
 * @returns {import('dockerode').ContainerCreateOptions}
 */
export function buildContainerCreateOptions(args) {
  const { jobId, policy, leaseExpiresAt, networkName, volumeName, createdBy, limits } = args;

  // (d) Canonicalise, THEN classify: the image must be digest-pinned. A floating
  // tag is refused with a spec_rejected error, never launched.
  const { digest } = parseImageReference(policy.image);
  if (digest === undefined) {
    throw new SpecRejectedError('image_not_digest_pinned', 'the job image is a floating tag, not a digest reference');
  }
  if (!DIGEST_RE.test(digest)) {
    throw new SpecRejectedError('image_bad_digest', 'the job image digest is not a valid content address');
  }

  // (a) Env is the already-clamped policy env — the daemon-owned proxy/job keys
  // are ALREADY injected by the policy client, so it passes through as-is; it is
  // NOT re-scrubbed here. Sorted for a deterministic, testable ordering.
  const Env = Object.keys(policy.env)
    .sort()
    .map((k) => `${k}=${policy.env[k]}`);

  // Everything below is BUILT, not copied. Fields the clamp forbids are absent by
  // construction: no `Privileged`, no `CapAdd`, no `Devices`, no `PidMode`/
  // `IpcMode`, no host `NetworkMode`, no extra `Binds`, no `Mounts`.
  return {
    Image: policy.image,
    // Non-root (spec §4). uid:gid, not a name, so it holds regardless of the
    // image's /etc/passwd.
    User: '1000:1000',
    Env,
    WorkingDir: '/workspace',
    Labels: {
      'ai.omadia.dev.jobId': jobId,
      'ai.omadia.dev.createdBy': createdBy,
      'ai.omadia.dev.leaseExpiresAt': leaseExpiresAt,
    },
    HostConfig: {
      // The per-job bridge ONLY — never the default bridge, never host.
      NetworkMode: networkName,
      // The per-job workspace volume is the ONLY writable bind; any host mount is
      // impossible because nothing else is ever added here.
      Binds: [`${volumeName}:/workspace`],
      // Read-only rootfs; writable surfaces are exactly the volume above and the
      // tmpfs below. `noexec` is deliberately NOT set on /tmp — npm needs exec in
      // tmp (spec §4, documented).
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': `rw,size=${limits.tmpfsMb}m` },
      // Drop every Linux capability and add none.
      CapDrop: ['ALL'],
      // Block privilege escalation via setuid binaries.
      SecurityOpt: ['no-new-privileges:true'],
      // Explicit even though it is the default: the clamp states the guarantee.
      Privileged: false,
      // Resource bounds. MemorySwap == Memory disables swap (no swap escape hatch
      // around the memory cap).
      Memory: limits.memoryBytes,
      MemorySwap: limits.memoryBytes,
      NanoCpus: limits.nanoCpus,
      PidsLimit: limits.pidsLimit,
      Ulimits: [{ Name: 'nofile', Soft: limits.nofile, Hard: limits.nofile }],
      // A job container never restarts — a dead job is a dead job.
      RestartPolicy: { Name: 'no' },
    },
  };
}
