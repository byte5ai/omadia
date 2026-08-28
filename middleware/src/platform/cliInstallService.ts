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
import { existsSync, mkdirSync } from 'node:fs';
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
/** Cap for the searched-PATH line in a no-output failure detail (#925). */
const MAX_PATH_DETAIL_CHARS = 512;

/**
 * Spawn errno -> which help path tells the truth (#933, OM-68).
 *
 * A spawn failure means the OS never started npm, so there is no failed
 * install and no log to read. The two buckets are deliberately NOT merged:
 * `ENOEXEC`/`EACCES`/`EPERM` mean a file WAS found and refused execution, so
 * the operator has to look at that file; `ENOENT` means there was nothing to
 * execute, which is what `no_output` already says and what its searched-PATH
 * line already answers. Telling an operator with no npm that "the npm file
 * found is not executable" is the same class of untrue message this issue was
 * filed about.
 *
 * Measured on Node v22.23.2 spawning bare `npm` off a doctored PATH: a 0-byte
 * `+x` file throws ENOEXEC synchronously; a file without `+x` AND a directory
 * both report EACCES. `EISDIR` is mapped for completeness but is unreachable
 * that way on POSIX, so it buys no coverage on its own.
 */
const SPAWN_FAILURE_KINDS: Readonly<Record<string, 'unrunnable' | 'not_found'>> = {
  ENOEXEC: 'unrunnable',
  EACCES: 'unrunnable',
  EPERM: 'unrunnable',
  EISDIR: 'unrunnable',
  ENOENT: 'not_found',
};

/** Candidate npm filenames, in the order the OS would try them. */
const NPM_FILENAMES: readonly string[] =
  process.platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'];

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

interface InstallRunResult {
  readonly ok: boolean;
  readonly output: string;
  /**
   * The raw child-process failure, when there was one. Present so the caller
   * can tell "npm ran and exited non-zero" from "the OS never started npm"
   * (#933) — the errno and syscall live on this object and nowhere else, and
   * discarding it is why every spawn failure used to read as a failed install.
   */
  readonly failure?: unknown;
}

type InstallRunner = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<InstallRunResult>;

/** Default runner: `npm <args>` — no shell, bounded time and output. */
const npmRunner: InstallRunner = (args, env) =>
  new Promise((resolve) => {
    execFile(
      'npm',
      [...args],
      { timeout: INSTALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, env, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          output: `${String(stdout ?? '')}\n${String(stderr ?? '')}`,
          ...(err ? { failure: err } : {}),
        });
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
    .then(({ ok, output, failure }) => {
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
        const spawnFailure = asSpawnFailure(failure);
        if (spawnFailure?.kind === 'unrunnable') {
          job.code = 'cli_install.spawn_failed';
          job.error = spawnFailedDetail(spawnFailure, env);
        } else if (spawnFailure?.kind === 'not_found') {
          // Explicit rather than leaning on `logTail` being empty. It happens
          // to be empty for npmRunner today, but a resolved ENOENT carrying
          // any stderr would otherwise fall through to npm_failed — the exact
          // conflation this classification exists to remove.
          job.code = 'cli_install.no_output';
          job.error = noOutputDetail(env, { proven: true });
        } else if (job.logTail) {
          job.code = 'cli_install.npm_failed';
          job.error = 'npm install failed — see the log tail.';
        } else {
          job.code = 'cli_install.no_output';
          job.error = noOutputDetail(env);
        }
      }
    })
    .catch((err: unknown) => {
      job.finishedAt = Date.now();
      job.status = 'failed';
      const spawnFailure = asSpawnFailure(err);
      if (spawnFailure?.kind === 'unrunnable') {
        // npm never started, so "npm ran, but the installation failed" and
        // "check the log details below" are both untrue — and there is no log
        // tail to check either (#933).
        job.code = 'cli_install.spawn_failed';
        job.error = spawnFailedDetail(spawnFailure, env);
        return;
      }
      if (spawnFailure?.kind === 'not_found') {
        job.code = 'cli_install.no_output';
        job.error = noOutputDetail(env, { proven: true });
        return;
      }
      // Any other thrown runner error still has a concrete failure message, so
      // keep it on the generic npm-failed help path.
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

/**
 * The PATH the npm child was actually handed, capped. A `no_output` failure is
 * almost always "npm is not on this PATH", and naming the directories that
 * were searched turns an opaque failure into a one-look diagnosis instead of a
 * manual `which npm` on the host (#925). Deliberately the spawn env's value
 * rather than a later `process.env` read, so it stays truthful in the desktop
 * app (which hands its children a hand-built PATH) as well as in Docker.
 */
function searchedPathDetail(env: NodeJS.ProcessEnv): string {
  const searchedPath = env['PATH'];
  if (!searchedPath) return '(unset)';
  return searchedPath.length > MAX_PATH_DETAIL_CHARS
    ? `${searchedPath.slice(0, MAX_PATH_DETAIL_CHARS)}… (truncated)`
    : searchedPath;
}

/** A child process that never started, and which of the two ways it failed. */
interface SpawnFailure {
  readonly kind: 'unrunnable' | 'not_found';
  readonly errno: string;
  /** The file the OS refused, when it names one. */
  readonly file?: string;
}

/**
 * Recognise a failure to START the child, by shape rather than by message.
 *
 * Node puts `code` (the errno) and `syscall` (`spawn` / `spawn npm`) on these
 * errors. The syscall check is what keeps an `EACCES` from some unrelated fs
 * call inside a runner from being reported as "npm is not executable"; it is
 * tolerated when absent, since starting the child is all the runner does.
 */
function asSpawnFailure(failure: unknown): SpawnFailure | undefined {
  if (!(failure instanceof Error)) return undefined;
  const { code, syscall, path: failedFile } = failure as Error & {
    code?: unknown;
    syscall?: unknown;
    path?: unknown;
  };
  if (typeof code !== 'string') return undefined;
  const kind = SPAWN_FAILURE_KINDS[code];
  if (!kind) return undefined;
  if (typeof syscall === 'string' && !syscall.startsWith('spawn')) return undefined;
  const file = asNamedFile(failedFile);
  return { kind, errno: code, ...(file ? { file } : {}) };
}

/**
 * `err.path`, but only when it actually names a file.
 *
 * Node sets `path` to the spawnfile EXACTLY as passed, and `npmRunner` passes
 * bare `npm` — so on every callback-delivered failure (EACCES, ENOENT) this is
 * the string `'npm'`, which identifies nothing. Measured on Node v22.23.2.
 * Accepting it would silently defeat {@link resolvedNpmFile}, which exists
 * precisely to turn this failure into one the operator can act on, and would
 * make the help copy's promise that the file is named untrue in the COMMON
 * case while staying true in the rare one.
 */
function asNamedFile(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const namesAPath = path.isAbsolute(value) || value.includes(path.sep);
  return namesAPath ? value : undefined;
}

/**
 * The npm file the OS would have executed, resolved off the PATH the child was
 * actually handed. `npmRunner` spawns bare `npm` and lets the OS resolve it, so
 * on an `ENOEXEC` nothing in the error names the broken file — and naming it is
 * the only thing that turns this failure into one the operator can act on
 * (#933; the reporter's own npm-cli.js was a 0-byte file).
 */
function resolvedNpmFile(env: NodeJS.ProcessEnv): string | undefined {
  const searchedPath = env['PATH'];
  if (!searchedPath) return undefined;
  for (const dir of searchedPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const filename of NPM_FILENAMES) {
      // existsSync reports false for anything it cannot stat, including an
      // unreadable directory or a malformed name, and never throws.
      const candidate = path.join(dir, filename);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Operator-facing detail for a spawn failure: the errno and the actual file. */
function spawnFailedDetail(failure: SpawnFailure, env: NodeJS.ProcessEnv): string {
  const file = failure.file ?? resolvedNpmFile(env);
  return (
    `npm could not be started (${failure.errno}) — npm never ran, so nothing was installed.` +
    `\nnpm file: ${file ?? '(could not be resolved from PATH)'}`
  );
}

/**
 * Operator-facing detail for the "npm was not found" path (#925).
 *
 * `proven` is set when a spawn `ENOENT` established the absence, as opposed to
 * it being inferred from npm having produced no output. The classifier knows
 * the difference now, so the sentence stops hedging (#933).
 */
function noOutputDetail(env: NodeJS.ProcessEnv, opts?: { readonly proven: boolean }): string {
  const cause = opts?.proven
    ? 'npm was not found on the PATH, so it never ran.'
    : 'no output at all; npm was most likely not found.';
  return `npm install failed — ${cause}\nSearched PATH: ${searchedPathDetail(env)}`;
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
