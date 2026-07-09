/**
 * Epic #470 W0 — `LocalProcessBackend`: the jailed walking-skeleton backend
 * (spec §1/§5). W1's `DockerBackend` supersedes it and demotes it to a
 * DEV_ALLOW_LOCAL_BACKEND escape hatch.
 *
 * Jail shape, in order of what actually does the work:
 *
 *   1. The env ALLOWLIST is the control, not a scrub-list (spec §1). The shim
 *      child env is constructed from nothing (`buildShimEnv`): PATH/LANG/TERM
 *      for tooling, a job-scoped HOME (NEVER the parent HOME — that holds the
 *      operator's real `~/.claude`), the five `OMADIA_*` shim inputs, and the
 *      gated LLM passthrough. `VAULT_KEY`, `DATABASE_URL`,
 *      `CLAUDE_CONFIG_DIR`, cloud credentials — none of it can leak because
 *      none of it is ever added.
 *   2. The shim runs as a dedicated unprivileged uid (`DEV_PLATFORM_LOCAL_UID`,
 *      spec §10 — required, and never 0).
 *   3. It executes neither dependency install nor the repo's tests: this
 *      backend refuses any repo with `runs_tests = true` and any source other
 *      than `admin`, mirroring the route-level check as a boundary, not a
 *      message.
 *   4. `OMADIA_LLM_ENV_ALLOWED=true` (the shim's gate for wiring
 *      `ANTHROPIC_*` into the CLI, see `ShimEnv.llmEnvAllowed` in
 *      `packages/dev-runner-shim/src/protocol.ts`) is set if and only if the
 *      operator acknowledged the jail with `DEV_PLATFORM_UNSAFE_LOCAL=true` —
 *      which is also the only way this class constructs at all.
 *
 * Lifecycle: `provision()` = mkdtemp under the workspace root, spawn the shim
 * detached in its own process group, pid file for post-restart reaping.
 * `terminate()` = SIGTERM the group → SIGKILL after the grace window → remove
 * the workspace. `reap()` = kill orphan pids from previous middleware runs and
 * dead tracked runners, remove leftover dirs, return the reaped handles so the
 * worker can `finalizeDevJob(..., 'stalled')`.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { chown, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  RunnerBackendError,
  assertProvisionContext,
  type DevJobProvisionContext,
  type DevJobProvisionInput,
  type RunnerBackend,
  type RunnerHandle,
} from './runnerBackend.js';

/** Workspace dirs are `job-<id8>-<mkdtemp suffix>` under the workspace root. */
export const LOCAL_WORKSPACE_PREFIX = 'job-';

/** Written into each workspace so `reap()` finds orphans across a restart. */
export const SHIM_PID_FILE = 'shim.pid';

/** SIGTERM → SIGKILL escalation window (spec §5: 10 s). */
const DEFAULT_KILL_GRACE_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 200;

/** Minimal child surface so tests can inject a fake without faking Node. */
export interface SpawnedShim {
  pid?: number | undefined;
  unref(): void;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
}

export type SpawnShimFn = (command: string, args: string[], options: SpawnOptions) => SpawnedShim;

export interface LocalProcessBackendOptions {
  /**
   * `DEV_PLATFORM_UNSAFE_LOCAL=true` — the operator's explicit acknowledgment
   * of the W0 jail. The constructor throws without it; there is no way to run
   * this backend un-acknowledged.
   */
  unsafeLocalAck: boolean;
  /** `DEV_PLATFORM_LOCAL_UID` — the dedicated unprivileged uid. Required, never 0. */
  localUid: number;
  /** Optional gid for the shim process. Defaults to leaving the group as-is. */
  localGid?: number;
  /** `DEV_PLATFORM_WORKSPACE_DIR` — every job workspace lives under this root. */
  workspaceDir: string;
  /** Absolute path to the built shim entry (`dev-runner-shim/dist/src/index.js`). */
  shimEntry: string;
  /** Node binary that runs the shim. Default: this process's own. */
  nodeBin?: string;
  /** `DEV_PLATFORM_CLI_BIN` → `OMADIA_CLI_BIN`. Default `claude`. */
  cliBin?: string;
  /**
   * W0 LLM passthrough → `OMADIA_ANTHROPIC_*`. The shim wires these into the
   * CLI only under the `OMADIA_LLM_ENV_ALLOWED` gate; W1's per-job proxy
   * tokens replace this entirely.
   */
  llm?: { anthropicBaseUrl?: string; anthropicAuthToken?: string };
  killGraceMs?: number;
  pollIntervalMs?: number;
  log?: (msg: string) => void;
  /** Test hooks. */
  spawnFn?: SpawnShimFn;
  procKill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  now?: () => Date;
}

/**
 * The allowlist, as a pure function so the "if and only if" of the LLM gate is
 * directly testable. Starts from NOTHING and adds; the parent env contributes
 * PATH/LANG/TERM alone.
 */
export function buildShimEnv(args: {
  input: Pick<DevJobProvisionInput, 'jobId' | 'jobToken' | 'baseUrl'>;
  workspace: string;
  cliBin: string;
  unsafeLocalAck: boolean;
  llm?: { anthropicBaseUrl?: string; anthropicAuthToken?: string } | undefined;
  parentEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const parent = args.parentEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {
    PATH: parent['PATH'] ?? '/usr/bin:/bin',
    // Job-scoped HOME: the shim process must never see the parent HOME (the
    // shim gives the CLI its own `<workspace>/home` on top of this).
    HOME: args.workspace,
    LANG: parent['LANG'] ?? 'C.UTF-8',
    ...(parent['TERM'] ? { TERM: parent['TERM'] } : {}),
    OMADIA_JOB_BASE_URL: args.input.baseUrl,
    OMADIA_JOB_ID: args.input.jobId,
    OMADIA_JOB_TOKEN: args.input.jobToken,
    OMADIA_WORKSPACE: args.workspace,
    OMADIA_CLI_BIN: args.cliBin,
  };
  // The gate, if and ONLY if the jail acknowledgment is present. Anything
  // other than the literal 'true' keeps the shim from wiring ANTHROPIC_* into
  // the child CLI (ShimEnv.llmEnvAllowed), so the key is simply omitted
  // otherwise — there is no 'false' value to typo around.
  if (args.unsafeLocalAck === true) {
    env['OMADIA_LLM_ENV_ALLOWED'] = 'true';
    if (args.llm?.anthropicBaseUrl) env['OMADIA_ANTHROPIC_BASE_URL'] = args.llm.anthropicBaseUrl;
    if (args.llm?.anthropicAuthToken) env['OMADIA_ANTHROPIC_AUTH_TOKEN'] = args.llm.anthropicAuthToken;
  }
  return env;
}

export class LocalProcessBackend implements RunnerBackend {
  readonly kind = 'local' as const;

  private readonly opts: LocalProcessBackendOptions;
  private readonly workspaceRoot: string;
  private readonly spawnFn: SpawnShimFn;
  private readonly procKill: (pid: number, signal: NodeJS.Signals | 0) => void;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;
  private readonly killGraceMs: number;
  private readonly pollIntervalMs: number;
  /** Live handles keyed by workspace dir (= `RunnerHandle.id`). */
  private readonly live = new Map<string, RunnerHandle>();
  /** Dirs mid-`provision()` — `reap()` must not eat a workspace being born. */
  private readonly provisioning = new Set<string>();

  constructor(opts: LocalProcessBackendOptions) {
    if (opts.unsafeLocalAck !== true) {
      throw new RunnerBackendError(
        'devplatform.local_backend_disabled',
        'LocalProcessBackend requires the explicit DEV_PLATFORM_UNSAFE_LOCAL=true acknowledgment; refusing to start',
      );
    }
    if (!Number.isInteger(opts.localUid) || opts.localUid <= 0) {
      throw new RunnerBackendError(
        'devplatform.local_uid_required',
        'DEV_PLATFORM_LOCAL_UID must be a dedicated unprivileged uid (a positive integer, never 0/root)',
      );
    }
    this.opts = opts;
    this.workspaceRoot = path.resolve(opts.workspaceDir);
    this.spawnFn = opts.spawnFn ?? (spawn as unknown as SpawnShimFn);
    this.procKill = opts.procKill ?? ((pid, signal) => process.kill(pid, signal));
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((msg) => console.warn(msg));
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    // The boot warning the spec requires (§1): name the restriction.
    this.log(
      '[dev-platform] DEV_PLATFORM_UNSAFE_LOCAL=true — LocalProcessBackend (W0 walking skeleton) enabled. ' +
        `Shim runs as uid ${String(opts.localUid)} with an allowlist-built env; ` +
        'no dependency install, no test execution; repos with runs_tests=true and non-admin sources are refused. ' +
        'Use the container backend (W1) for anything beyond this.',
    );
  }

  async provision(input: DevJobProvisionContext): Promise<RunnerHandle> {
    assertProvisionContext(input);
    // Boundary admission (spec §5) — same facts as the route check, enforced
    // where the process is actually born.
    if (input.repo.runsTests) {
      throw new RunnerBackendError(
        'devplatform.local_backend_requires_no_exec',
        'the local backend cannot run a repo whose tests execute; use the container backend',
      );
    }
    if (input.source !== 'admin') {
      throw new RunnerBackendError(
        'devplatform.local_backend_admin_only',
        `the local backend accepts admin-initiated jobs only (got source '${input.source}')`,
      );
    }

    await mkdir(this.workspaceRoot, { recursive: true });
    const id8 = input.jobId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'job';
    const dir = await mkdtemp(path.join(this.workspaceRoot, `${LOCAL_WORKSPACE_PREFIX}${id8}-`));
    this.provisioning.add(dir);
    try {
      // Hand the workspace to the jail uid so the shim can write its clone and
      // job-scoped HOME. Requires the middleware to be privileged enough to
      // setuid at spawn; if chown fails anyway, the spawn will fail loudly too.
      try {
        await chown(dir, this.opts.localUid, this.opts.localGid ?? -1);
      } catch (err) {
        this.log(
          `[dev-platform] could not chown workspace to uid ${String(this.opts.localUid)}: ${errText(err)} — jail degraded`,
        );
      }

      const env = buildShimEnv({
        input,
        workspace: dir,
        cliBin: this.opts.cliBin ?? 'claude',
        unsafeLocalAck: this.opts.unsafeLocalAck,
        llm: this.opts.llm,
      });
      const child = this.spawnFn(this.opts.nodeBin ?? process.execPath, [this.opts.shimEntry], {
        cwd: dir,
        env,
        // Own process group: terminate/reap kill the WHOLE tree (shim + CLI).
        detached: true,
        stdio: 'ignore',
        uid: this.opts.localUid,
        ...(this.opts.localGid !== undefined ? { gid: this.opts.localGid } : {}),
      });
      await new Promise<void>((resolve, reject) => {
        child.once('error', (err) => reject(err));
        child.once('spawn', () => resolve());
      });
      const pid = child.pid;
      if (typeof pid !== 'number') {
        throw new RunnerBackendError('devplatform.local_spawn_failed', 'shim spawned without a pid');
      }
      child.unref();
      await writeFile(path.join(dir, SHIM_PID_FILE), `${String(pid)}\n`, 'utf8');
      const handle: RunnerHandle = {
        backend: 'local',
        id: dir,
        pid,
        startedAt: this.now().toISOString(),
      };
      this.live.set(dir, handle);
      return handle;
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      if (err instanceof RunnerBackendError) throw err;
      throw new RunnerBackendError('devplatform.local_spawn_failed', `failed to spawn the runner shim: ${errText(err)}`);
    } finally {
      this.provisioning.delete(dir);
    }
  }

  /** SIGTERM the shim's process group, escalate to SIGKILL after the grace
   *  window, then remove the workspace. Idempotent on an already-dead runner. */
  async terminate(handle: RunnerHandle): Promise<void> {
    if (handle.backend !== 'local') {
      throw new RunnerBackendError(
        'devplatform.wrong_backend',
        `LocalProcessBackend cannot terminate a '${handle.backend}' handle`,
      );
    }
    const dir = this.assertWorkspacePath(handle.id);
    const pid = handle.pid;
    if (typeof pid === 'number' && this.isAlive(pid)) {
      this.killTree(pid, 'SIGTERM');
      const exited = await this.waitForExit(pid, this.killGraceMs);
      if (!exited) {
        this.killTree(pid, 'SIGKILL');
        await this.waitForExit(pid, this.killGraceMs);
      }
    }
    this.live.delete(dir);
    await rm(dir, { recursive: true, force: true });
  }

  /**
   * Kill dead/orphan runners and remove leftover workspaces. Orphans (dirs
   * from a previous middleware process, identified by their pid file) are
   * SIGKILLed outright — nothing owns them anymore. Live tracked runners are
   * left alone. Returns the reaped handles so the worker finalizes the jobs
   * (`finalizeDevJob(..., 'stalled')`).
   */
  async reap(): Promise<RunnerHandle[]> {
    const reaped: RunnerHandle[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.workspaceRoot);
    } catch {
      return reaped; // no workspace root yet — nothing to reap
    }
    for (const name of entries) {
      if (!name.startsWith(LOCAL_WORKSPACE_PREFIX)) continue;
      const dir = path.join(this.workspaceRoot, name);
      if (this.provisioning.has(dir)) continue; // being born right now
      const tracked = this.live.get(dir);
      if (tracked) {
        if (typeof tracked.pid === 'number' && this.isAlive(tracked.pid)) continue; // healthy
        this.live.delete(dir);
        await rm(dir, { recursive: true, force: true });
        reaped.push(tracked);
        continue;
      }
      // Orphan from a previous middleware run.
      const pid = await this.readPidFile(dir);
      if (pid !== null && this.isAlive(pid)) this.killTree(pid, 'SIGKILL');
      const startedAt = await stat(dir)
        .then((s) => s.mtime.toISOString())
        .catch(() => this.now().toISOString());
      await rm(dir, { recursive: true, force: true });
      reaped.push({ backend: 'local', id: dir, ...(pid !== null ? { pid } : {}), startedAt });
    }
    return reaped;
  }

  /** `handle.id` round-trips through `dev_jobs.runner_handle` (DB JSONB); a
   *  tampered row must not become an arbitrary `rm -rf`. */
  private assertWorkspacePath(id: string): string {
    const dir = path.resolve(id);
    const inRoot = dir.startsWith(this.workspaceRoot + path.sep);
    if (!inRoot || !path.basename(dir).startsWith(LOCAL_WORKSPACE_PREFIX)) {
      throw new RunnerBackendError(
        'devplatform.local_workspace_escape',
        `refusing to touch '${id}': not a job workspace under ${this.workspaceRoot}`,
      );
    }
    return dir;
  }

  private async readPidFile(dir: string): Promise<number | null> {
    try {
      const raw = await readFile(path.join(dir, SHIM_PID_FILE), 'utf8');
      const pid = Number.parseInt(raw.trim(), 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  private isAlive(pid: number): boolean {
    try {
      this.procKill(pid, 0);
      return true;
    } catch (err) {
      // EPERM = alive but not ours; anything else (ESRCH) = gone.
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  /** Signal the whole process group (detached ⇒ the shim leads one); fall back
   *  to the single pid if the group is already gone. */
  private killTree(pid: number, signal: NodeJS.Signals): void {
    try {
      this.procKill(-pid, signal);
    } catch {
      try {
        this.procKill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  }

  private async waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isAlive(pid)) return true;
      await sleep(this.pollIntervalMs);
    }
    return !this.isAlive(pid);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
