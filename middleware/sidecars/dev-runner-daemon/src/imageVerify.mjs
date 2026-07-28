/**
 * Epic #470 W5 — runner image signature verification at boot (spec §10).
 *
 * The runner image (`ghcr.io/byte5ai/omadia-dev-runner`) is SIGNED in CI with
 * keyless cosign (the release workflow's GitHub OIDC identity — no key material)
 * and carries an SBOM attestation. This unit is the CONSUMER side of that
 * guarantee: before the daemon will run a job, it runs `cosign verify` against
 * the configured image, pinning the certificate identity + OIDC issuer to the
 * exact repo+workflow that is allowed to have signed it. An image whose
 * signature does not check out is NOT run — the daemon refuses to start.
 *
 * Policy:
 *   - `DEV_IMAGE_VERIFY=off`  → verification is DISABLED. The daemon runs the
 *     image unverified (logged loudly). This is the only escape hatch.
 *   - default (`on`) + identity+issuer configured → verify; a failure REFUSES
 *     (throws → the entrypoint exits non-zero).
 *   - `on` but NO identity/issuer configured → SKIP with a warning. You cannot
 *     verify a keyless signature without a pinned identity to check it against,
 *     so there is nothing to enforce; the operator is told so plainly.
 *
 * "At boot and on image change": the runner image is DIGEST-PINNED in the
 * daemon's own config (`DEV_RUNNER_IMAGES` / `DEV_RUNNER_DEFAULT_IMAGE`). The
 * only way that digest changes is an operator editing config and restarting the
 * daemon — which re-runs this boot check on the new digest. So "on image change"
 * is, by construction, "on the next boot after the config change".
 *
 * FLY PATH CAVEAT (documented, not a failure): on Fly.io the platform pulls the
 * image itself at deploy time, so the daemon has no pull hook at which to run
 * cosign — pull-time verification is not possible there. The guarantee for Fly
 * is instead: the image is DIGEST-PINNED in config, and that digest carries a
 * CI-verified keyless signature produced at release. Boot-time `cosign verify`
 * still runs wherever the daemon can reach the registry; where it structurally
 * cannot (Fly's opaque pull), digest-pinning + the release-time signature are
 * the standing guarantee.
 *
 * STANDALONE — node builtins only (matches the rest of the daemon: dockerode +
 * zod + node). The cosign shell-out is injected so the decision logic is
 * testable without a cosign binary present.
 */

import { execFile } from 'node:child_process';

/** Max wall-clock for a single `cosign verify` before it is abandoned. A hung
 *  verify must not wedge daemon boot forever. */
const COSIGN_TIMEOUT_MS = 60 * 1000;
/** Cap on cosign's captured stdout/stderr — these are short human diagnostics. */
const COSIGN_MAX_BUFFER = 4 * 1024 * 1024;

/** Falsey spellings that turn verification OFF. */
const OFF_VALUES = new Set(['off', 'false', '0', 'no']);
/** Truthy spellings that force verification ON (the default anyway). */
const ON_VALUES = new Set(['on', 'true', '1', 'yes']);

/**
 * Raised when a configured image fails signature verification (or when cosign
 * itself could not run) while verification is enforced. The daemon refuses to
 * start on this — an unverified runner image is never silently accepted.
 */
export class ImageVerificationError extends Error {
  /**
   * @param {string} image The image ref that failed verification.
   * @param {string} message Non-sensitive description.
   */
  constructor(image, message) {
    super(message);
    this.name = 'ImageVerificationError';
    /** @type {string} */
    this.image = image;
  }
}

/**
 * Resolve `DEV_IMAGE_VERIFY` to a mode. Default `on` — the operator opts OUT
 * explicitly with a falsey value. An unrecognised value is treated as `on`
 * (fail-safe: an unclear setting must never silently disable verification).
 *
 * @param {string | undefined} raw
 * @returns {'on' | 'off'}
 */
export function resolveImageVerifyMode(raw) {
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (OFF_VALUES.has(v)) return 'off';
    if (ON_VALUES.has(v)) return 'on';
  }
  return 'on';
}

/**
 * @typedef {object} CosignResult
 * @property {number} code Process exit code (0 = success). Non-zero for a failed
 *   verify OR a spawn failure (e.g. cosign not installed).
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @callback CosignExec
 * @param {readonly string[]} args Argument vector passed to the cosign binary.
 * @returns {Promise<CosignResult>}
 */

/**
 * Build the default cosign shell-out. Uses `execFile` (argv array — no shell, so
 * an image ref can never be interpreted as a shell metacharacter). Never
 * rejects: a spawn failure (cosign missing → ENOENT) is surfaced as a non-zero
 * `code`, which the caller treats as a verification failure just like a bad
 * signature.
 *
 * @param {string | undefined} [bin] Override the cosign binary (`DEV_IMAGE_COSIGN_BIN`).
 * @returns {CosignExec}
 */
export function createCosignExec(bin) {
  const cosign = typeof bin === 'string' && bin.trim() !== '' ? bin.trim() : 'cosign';
  return (args) =>
    new Promise((resolve) => {
      execFile(
        cosign,
        [...args],
        { timeout: COSIGN_TIMEOUT_MS, maxBuffer: COSIGN_MAX_BUFFER },
        (err, stdout, stderr) => {
          const errCode = /** @type {{ code?: unknown } | null} */ (err)?.code;
          const code = err == null ? 0 : typeof errCode === 'number' ? errCode : 1;
          resolve({
            code,
            stdout: stdout ? String(stdout) : '',
            stderr: stderr ? String(stderr) : '',
          });
        },
      );
    });
}

/** @param {string} s @returns {string} The first non-empty line, trimmed. */
function firstLine(s) {
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (t !== '') return t;
  }
  return '';
}

/**
 * @typedef {object} VerifyOutcome
 * @property {boolean} verified True only when cosign verified the signature.
 * @property {boolean} skipped True when verification did not run (disabled, or no
 *   identity configured).
 * @property {'disabled' | 'no-identity' | undefined} [reason] Why it was skipped.
 */

/**
 * @typedef {object} VerifyRunnerImageDeps
 * @property {string} image The image ref to verify (ideally digest-pinned).
 * @property {string | undefined} identity Pinned certificate identity (the signer's
 *   OIDC subject — the release workflow ref). Required to enforce.
 * @property {string | undefined} issuer Pinned OIDC issuer (e.g. GitHub's token issuer).
 * @property {'on' | 'off'} mode Verification mode (see `resolveImageVerifyMode`).
 * @property {CosignExec} exec The cosign shell-out (injected; test seam).
 * @property {{ warn?: (msg: string) => void, info?: (msg: string) => void }} [logger]
 */

/**
 * Decide-and-verify one runner image. THE testable decision core:
 *
 *   - `mode === 'off'`            → skip, no cosign call (returns skipped).
 *   - no identity / no issuer     → skip with a warning (can't verify keyless
 *                                   without a pinned identity).
 *   - `mode === 'on'` + identity  → run `cosign verify --certificate-identity
 *                                   <id> --certificate-oidc-issuer <issuer>
 *                                   <image>`. Exit 0 → verified; non-zero →
 *                                   THROW `ImageVerificationError` (refuse).
 *
 * @param {VerifyRunnerImageDeps} deps
 * @returns {Promise<VerifyOutcome>}
 */
export async function verifyRunnerImage(deps) {
  const { image, identity, issuer, mode, exec } = deps;
  const logger = deps.logger ?? console;

  if (mode === 'off') {
    logger.warn?.(
      `[dev-runner-daemon] image verification DISABLED (DEV_IMAGE_VERIFY=off) — running ${image} UNVERIFIED`,
    );
    return { verified: false, skipped: true, reason: 'disabled' };
  }

  if (!identity || !issuer) {
    logger.warn?.(
      '[dev-runner-daemon] image verification is on but no cosign identity/issuer is configured ' +
        '(DEV_IMAGE_COSIGN_IDENTITY / DEV_IMAGE_COSIGN_ISSUER) — cannot verify a keyless signature ' +
        `without a pinned identity, so verification of ${image} is SKIPPED. Set both to enforce signatures.`,
    );
    return { verified: false, skipped: true, reason: 'no-identity' };
  }

  const args = [
    'verify',
    '--certificate-identity',
    identity,
    '--certificate-oidc-issuer',
    issuer,
    image,
  ];
  const result = await exec(args);
  if (result.code !== 0) {
    const detail = firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.code}`;
    throw new ImageVerificationError(
      image,
      `cosign verify failed for ${image}: ${detail} — refusing to run an unverified runner image ` +
        '(set DEV_IMAGE_VERIFY=off to override).',
    );
  }
  logger.info?.(`[dev-runner-daemon] verified signature for ${image}`);
  return { verified: true, skipped: false };
}

/**
 * @typedef {object} VerifyConfiguredImagesDeps
 * @property {readonly string[]} images Configured image refs to verify at boot.
 * @property {string | undefined} identity Pinned certificate identity.
 * @property {string | undefined} issuer Pinned OIDC issuer.
 * @property {'on' | 'off'} mode Verification mode.
 * @property {CosignExec} exec The cosign shell-out (injected).
 * @property {{ warn?: (msg: string) => void, info?: (msg: string) => void }} [logger]
 */

/**
 * Boot-time verification over every configured image. Short-circuits the
 * skip cases once (so N images do not emit N identical warnings), then verifies
 * each in turn — the FIRST failure throws `ImageVerificationError` and aborts
 * boot. Returns the per-image outcomes when nothing threw.
 *
 * @param {VerifyConfiguredImagesDeps} deps
 * @returns {Promise<{ mode: 'on' | 'off', results: VerifyOutcome[] }>}
 */
export async function verifyConfiguredImages(deps) {
  const { images, identity, issuer, mode, exec } = deps;
  const logger = deps.logger ?? console;

  if (mode === 'off') {
    logger.warn?.(
      '[dev-runner-daemon] image verification DISABLED (DEV_IMAGE_VERIFY=off) — runner images run UNVERIFIED',
    );
    return { mode, results: [] };
  }
  if (!identity || !issuer) {
    logger.warn?.(
      '[dev-runner-daemon] image verification is on but no cosign identity/issuer is configured ' +
        '(DEV_IMAGE_COSIGN_IDENTITY / DEV_IMAGE_COSIGN_ISSUER) — verification SKIPPED. Set both to enforce signatures.',
    );
    return { mode, results: [] };
  }
  if (images.length === 0) {
    logger.warn?.(
      '[dev-runner-daemon] image verification is enabled but no images are configured ' +
        '(DEV_RUNNER_IMAGES / DEV_RUNNER_DEFAULT_IMAGE) — nothing to verify at boot',
    );
    return { mode, results: [] };
  }

  /** @type {VerifyOutcome[]} */
  const results = [];
  for (const image of images) {
    results.push(await verifyRunnerImage({ image, identity, issuer, mode, exec, logger }));
  }
  return { mode, results };
}
