/**
 * Runtime install of vendor LLM CLIs (#309 extension, enabler for #294).
 *
 * The public Docker image deliberately does NOT bundle the vendor CLIs
 * (`INSTALL_SUBSCRIPTION_CLIS=false` — redistributing proprietary CLIs needs
 * legal review). This service closes the resulting dead end in the admin UI:
 * an operator-triggered `npm install` from the public npm registry into a
 * writable, persisted tools directory. Installing from the registry at the
 * operator's request is distribution by npm, not redistribution by us.
 *
 * Hard rules (mirroring `cliBackendDetector`):
 *  - **No shell, no user input in argv.** The package name comes from a fixed
 *    allowlist keyed by backend id; an optional version is validated against a
 *    strict semver pattern before it may appear in the argv.
 *  - **Single-flight.** One install at a time, host-global (single sticky
 *    runtime) — a concurrent request is rejected, not queued.
 *  - **Bounded.** Hard timeout and capped output; the log tail is kept for the
 *    status endpoint so a failure is diagnosable from the UI.
 *
 * The install prefix is `CLI_TOOLS_DIR` (defaults under `PLATFORM_DATA_DIR`,
 * e.g. the persisted `/data` volume on Fly) so an install survives machine
 * restarts. `resolveCliBin` in the detector prefers this prefix over PATH.
 */
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  cliToolsDir,
  detectCliBackends,
  getInstallPackage,
  scrubbedEnv,
  __resetCliBackendCache,
} from './cliBackendDetector.js';

export type CliInstallState = 'idle' | 'running' | 'succeeded' | 'failed';

export interface CliInstallStatus {
  readonly cliId: string;
  readonly status: CliInstallState;
  readonly error?: string;
  /** Machine-readable classifier the UI maps to install-help text. */
  readonly code?: string;
  /** Last lines of npm output — enough to diagnose a failure from the UI. */
  readonly logTail?: string;
  readonly startedAt?: number;
  readonly finishedAt?: number;
}

/** Backend id is not in the install allowlist. */
export class UnknownCliBackendError extends Error {}
/** Another install is still running (single-flight). */
export class CliInstallConflictError extends Error {}
/** The optional `version` field failed strict semver validation. */
export class InvalidCliVersionError extends Error {}

/** `1.2.3` or `1.2.3-tag.1` — nothing else may reach the npm argv. */
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
/** npm may resolve + download platform binaries; well below CI patience. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const LOG_TAIL_CHARS = 2000;

interface InstallJob {
  readonly cliId: string;
  status: CliInstallState;
  readonly startedAt: number;
  finishedAt?: number;
  error?: string;
  code?: string;
  logTail?: string;
}

let current: InstallJob | undefined;

type InstallRunner = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ ok: boolean; output: string }>;

/** Default runner: `npm <args>` — no shell, bounded time and output. */
const npmRunner: InstallRunner = (args, env) =>
  new Promise((resolve) => {
    execFile(
      'npm',
      [...args],
      { timeout: INSTALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, env, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({ ok: !err, output: `${String(stdout ?? '')}\n${String(stderr ?? '')}` });
      },
    );
  });

let runner: InstallRunner = npmRunner;
let detect: typeof detectCliBackends = detectCliBackends;

/**
 * Start installing a backend's CLI. Resolves as soon as the job is accepted
 * (or found unnecessary) — the install itself runs in the background and is
 * observed via {@link getCliInstallStatus}.
 */
export async function startCliInstall(
  cliId: string,
  version?: string,
): Promise<{ started: boolean; alreadyInstalled: boolean }> {
  const pkg = getInstallPackage(cliId);
  if (!pkg) {
    throw new UnknownCliBackendError(`"${cliId}" cannot be installed from here.`);
  }
  if (version !== undefined && !SEMVER_RE.test(version)) {
    throw new InvalidCliVersionError('version must be a plain semver like 1.2.3');
  }
  if (current?.status === 'running') {
    throw new CliInstallConflictError(
      `An install of "${current.cliId}" is already running. Wait for it to finish.`,
    );
  }

  // Reserve the single-flight slot BEFORE any await: the idempotency probe
  // below yields for seconds, and two concurrent versionless requests passing
  // the check above would otherwise both run `npm install -g` into the same
  // prefix — which can corrupt the tree.
  const job: InstallJob = { cliId, status: 'running', startedAt: Date.now() };
  current = job;

  // Idempotency: a backend that is already present needs no install. With an
  // explicit version we still run npm (it is the authority on version moves).
  if (version === undefined) {
    let snap;
    try {
      snap = await detect({ force: true });
    } catch (err) {
      current = undefined;
      throw err;
    }
    if (snap.backends.find((b) => b.id === cliId)?.installed) {
      current = undefined;
      return { started: false, alreadyInstalled: true };
    }
  }

  const dir = cliToolsDir();
  try {
    mkdirSync(path.join(dir, '.npm-cache'), { recursive: true });
  } catch (err) {
    current = undefined; // release the slot — nothing is running
    throw err;
  }

  const env: NodeJS.ProcessEnv = {
    ...scrubbedEnv(),
    npm_config_cache: path.join(dir, '.npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };

  void runner(['install', '-g', '--prefix', dir, `${pkg}@${version ?? 'latest'}`], env)
    .then(({ ok, output }) => {
      job.logTail = output.trim().slice(-LOG_TAIL_CHARS);
      job.finishedAt = Date.now();
      if (ok) {
        job.status = 'succeeded';
        // The freshly installed binary must show up on the next detection.
        // Guarded so a throw here can never retro-flip a success to 'failed'
        // via the trailing catch.
        try {
          __resetCliBackendCache();
        } catch {
          /* cache reset is best-effort */
        }
      } else {
        job.status = 'failed';
        if (job.logTail) {
          job.code = 'cli_install.npm_failed';
          job.error = 'npm install failed — see the log tail.';
        } else {
          job.code = 'cli_install.no_output';
          job.error = 'npm install failed — no output at all; npm was most likely not found.';
        }
      }
    })
    .catch((err: unknown) => {
      job.finishedAt = Date.now();
      job.status = 'failed';
      // A thrown runner error still has a concrete failure message, so keep it
      // on the generic npm-failed help path rather than the "no output" one.
      job.code = 'cli_install.npm_failed';
      job.error = err instanceof Error ? err.message : String(err);
    });

  return { started: true, alreadyInstalled: false };
}

/** Current install state for a backend (host-global single-flight). */
export function getCliInstallStatus(cliId: string): CliInstallStatus {
  if (!current || current.cliId !== cliId) {
    return { cliId, status: 'idle' };
  }
  return {
    cliId,
    status: current.status,
    ...(current.error ? { error: current.error } : {}),
    ...(current.code ? { code: current.code } : {}),
    ...(current.logTail ? { logTail: current.logTail } : {}),
    startedAt: current.startedAt,
    ...(current.finishedAt ? { finishedAt: current.finishedAt } : {}),
  };
}

/** Test seams. */
export function __setCliInstallRunner(fn: InstallRunner | undefined): void {
  runner = fn ?? npmRunner;
}
export function __setCliInstallDetector(fn: typeof detectCliBackends | undefined): void {
  detect = fn ?? detectCliBackends;
}
export function __resetCliInstallState(): void {
  current = undefined;
}
