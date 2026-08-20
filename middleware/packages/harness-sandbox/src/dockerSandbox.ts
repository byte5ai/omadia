import { createHash } from 'node:crypto';

import type { AgentComputerProfile } from './agentComputerProfile.js';
import { execDockerViaSpawn, type DockerExec } from './dockerExec.js';
import { clampSandboxPathPosix } from './pathGuard.js';
import type { SandboxRegistry } from './sandboxRegistry.js';
import type {
  Sandbox,
  SandboxBackend,
  SandboxListOutcome,
  SandboxReadOutcome,
  SandboxRunOptions,
  SandboxRunResult,
  SandboxWriteOutcome,
} from './sandbox.js';

/**
 * v1 backend (issue #576 P1): plain local Docker. `buildSandbox.ts`'s
 * injectable-spawn pattern is the model — see `dockerExec.ts`.
 *
 * ## Durability without a registry (yet)
 *
 * The container NAME is a deterministic function of the scope key
 * (`omadia-sbx-<sha256(scopeKey)[0:24]>`), so `provision()` re-attaches to an
 * already-running container across backend-instance restarts without needing
 * P3's DB-backed registry — Docker itself is the durable store for "which
 * container belongs to this scope". What P3's registry adds on top is
 * bookkeeping Docker does not give for free: last-used timestamps for the
 * reaper, content-hash fingerprints for the RO-layer sync, and — once a
 * second backend exists — the scope→backend routing table. This backend
 * works correctly with none of that; P3 makes it OPERABLE at fleet scale.
 *
 * ## Egress: profile.egress is WIRED, not declared
 *
 * `profile.egress === false` becomes `--network none` on `docker run` —
 * verified by `dockerSandbox.test.ts`'s stub-level assertion on the exact
 * argv, AND (behind `SANDBOX_DOCKER_TEST=1`) by a real container attempting
 * an outbound request and observing it fail. See `agentComputerProfile.ts`
 * for why this distinction is load-bearing.
 */
export interface DockerSandboxBackendOptions {
  /** Container image. Small, POSIX shell, busybox coreutils (`ls -1p`, `cat`,
   *  `timeout`) — alpine satisfies all of it and ships `wget` for the egress
   *  proof. */
  readonly image?: string;
  /** In-container root every `run/read/write/list` is rooted at. */
  readonly workDir?: string;
  /** Test seam — see `dockerExec.ts`. Defaults to the real `docker` CLI. */
  readonly execDocker?: DockerExec;
  /**
   * #576 P3 — optional durable bookkeeping. Omitted (the default): this
   * backend behaves EXACTLY as P1/P2 shipped it — deterministic container
   * naming is the only durability, `provision()` never touches anything
   * beyond Docker itself. Provided: `provision()` additionally records
   * (scope → container name) with a `lastUsedAt` the reaper can act on, and
   * re-attaches via the registry's stored `sandboxRef` rather than
   * recomputing the deterministic name — the seam a future non-deterministic
   * backend (one where Docker/the platform assigns the id) would need, kept
   * exercised now via the Docker backend's own deterministic case.
   */
  readonly registry?: SandboxRegistry;
}

const DEFAULT_IMAGE = 'alpine:3.20';
const DEFAULT_WORK_DIR = '/workspace';
const CONTAINER_NAME_PREFIX = 'omadia-sbx-';
const SCOPE_LABEL = 'omadia.sandbox.scope-hash';

function containerNameFor(scopeKey: string): string {
  const digest = createHash('sha256').update(scopeKey, 'utf8').digest('hex').slice(0, 24);
  return `${CONTAINER_NAME_PREFIX}${digest}`;
}

export class DockerSandboxBackend implements SandboxBackend {
  private readonly image: string;
  private readonly workDir: string;
  private readonly execDocker: DockerExec;
  /** Process-local cache so repeated `provision()` calls for the same live
   *  scope within one process return the identical `Sandbox` object rather
   *  than re-probing Docker every time. Cross-process durability comes from
   *  the deterministic container name, not from this map. */
  private readonly live = new Map<string, DockerSandbox>();
  private readonly registry: SandboxRegistry | undefined;

  constructor(options: DockerSandboxBackendOptions = {}) {
    this.image = options.image ?? DEFAULT_IMAGE;
    this.workDir = options.workDir ?? DEFAULT_WORK_DIR;
    this.execDocker = options.execDocker ?? execDockerViaSpawn;
    this.registry = options.registry;
  }

  async provision(args: {
    readonly scopeKey: string;
    readonly profile: AgentComputerProfile;
  }): Promise<Sandbox> {
    const cached = this.live.get(args.scopeKey);
    if (cached) {
      // #576 P3: even a process-local cache hit is real usage — the reaper
      // must not treat a scope as idle while its sandbox is actively being
      // reused just because Docker itself wasn't consulted this call.
      if (this.registry) await this.registry.touch(args.scopeKey, new Date());
      return cached;
    }

    // #576 P3: a registered scope re-attaches via its STORED reference
    // rather than recomputing the deterministic name — the seam a future
    // non-deterministic backend needs, exercised here even though this
    // backend's own name is always recomputable.
    const registered = this.registry ? await this.registry.get(args.scopeKey) : undefined;
    const name = registered?.sandboxRef ?? containerNameFor(args.scopeKey);

    const exists = await this.containerExists(name);
    if (!exists) {
      await this.runContainer(name, args.profile);
    } else {
      // Idempotent re-attach: bring an existing-but-stopped container back
      // up. `docker start` on an already-running container is a harmless
      // no-op (exit 0).
      await this.exec(['start', name], { timeoutMs: 15_000 });
    }

    if (this.registry) {
      await this.registry.upsert({
        scopeKey: args.scopeKey,
        backend: 'docker',
        sandboxRef: name,
        profile: args.profile,
        now: new Date(),
      });
    }

    const sandbox = new DockerSandbox({
      id: name,
      scopeKey: args.scopeKey,
      profile: args.profile,
      workDir: this.workDir,
      exec: this.execDocker,
    });
    this.live.set(args.scopeKey, sandbox);
    return sandbox;
  }

  private async containerExists(name: string): Promise<boolean> {
    const result = await this.exec(
      ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'],
      { timeoutMs: 15_000 },
    );
    return result.stdout.trim().split('\n').includes(name);
  }

  private async runContainer(name: string, profile: AgentComputerProfile): Promise<void> {
    const args = [
      'run',
      '-d',
      '--name',
      name,
      '--label',
      `${SCOPE_LABEL}=1`,
      '--workdir',
      this.workDir,
    ];
    // #576 P2 wiring proof: egress:false MUST become a real network
    // constraint, not a value the caller can merely inspect on the profile.
    if (!profile.egress) {
      args.push('--network', 'none');
    }
    args.push(this.image, 'sh', '-c', `mkdir -p '${this.workDir}' && exec sleep infinity`);
    const result = await this.exec(args, { timeoutMs: 60_000 });
    if (result.exitCode !== 0) {
      throw new Error(
        `DockerSandboxBackend: failed to provision container '${name}': ${result.stderr || result.stdout}`,
      );
    }
  }

  private exec(
    args: readonly string[],
    opts: { readonly timeoutMs: number; readonly input?: string },
  ): ReturnType<DockerExec> {
    return this.execDocker({
      args,
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: 4 * 1024 * 1024,
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    });
  }
}

const DEFAULT_RUN_TIMEOUT_SECONDS = 60;

class DockerSandbox implements Sandbox {
  readonly id: string;
  readonly scopeKey: string;
  readonly profile: AgentComputerProfile;
  private readonly workDir: string;
  private readonly exec: DockerExec;

  constructor(args: {
    readonly id: string;
    readonly scopeKey: string;
    readonly profile: AgentComputerProfile;
    readonly workDir: string;
    readonly exec: DockerExec;
  }) {
    this.id = args.id;
    this.scopeKey = args.scopeKey;
    this.profile = args.profile;
    this.workDir = args.workDir;
    this.exec = args.exec;
  }

  async run(command: string, options: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    const seconds = Math.min(
      options.timeoutSeconds ?? this.profile.maxRunSeconds,
      this.profile.maxRunSeconds,
    );
    const cwdArgs: string[] = [];
    if (options.cwd !== undefined) {
      const clamped = clampSandboxPathPosix(this.workDir, options.cwd);
      if (clamped.ok) cwdArgs.push('-w', clamped.absolutePath);
      // A rejected cwd falls back to the sandbox's default workdir rather
      // than failing the whole run — the command itself still runs, just
      // not "escaped" to wherever the caller tried to point it.
    }
    const envArgs: string[] = [];
    for (const [key, value] of Object.entries(options.env ?? {})) {
      envArgs.push('-e', `${key}=${value}`);
    }

    const start = Date.now();
    const result = await this.exec(
      {
        args: [
          'exec',
          ...cwdArgs,
          ...envArgs,
          this.id,
          'timeout',
          `${String(Math.max(1, Math.trunc(seconds)))}s`,
          'sh',
          '-c',
          command,
        ],
        timeoutMs: (seconds + 10) * 1000,
        maxOutputBytes: this.profile.maxOutputBytes,
      },
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - start,
      // exit 124 is `timeout`'s own "command timed out" signal.
      timedOut: result.timedOut || result.exitCode === 124,
      outputTruncated: result.outputTruncated,
    };
  }

  async read(relativePath: string): Promise<SandboxReadOutcome> {
    const clamped = clampSandboxPathPosix(this.workDir, relativePath);
    if (!clamped.ok) {
      return { ok: false, reason: 'path_rejected', detail: clamped.reason };
    }
    const result = await this.exec({
      args: ['exec', this.id, 'cat', '--', clamped.absolutePath],
      timeoutMs: 15_000,
      maxOutputBytes: this.profile.maxOutputBytes,
    });
    if (result.exitCode === 0) {
      return { ok: true, content: result.stdout };
    }
    if (/is a directory/i.test(result.stderr)) {
      return { ok: false, reason: 'is_directory', detail: result.stderr.trim() };
    }
    return { ok: false, reason: 'not_found', detail: result.stderr.trim() || 'no such file' };
  }

  async write(relativePath: string, content: string): Promise<SandboxWriteOutcome> {
    const clamped = clampSandboxPathPosix(this.workDir, relativePath);
    if (!clamped.ok) {
      return { ok: false, reason: 'path_rejected', detail: clamped.reason };
    }
    const parentDir = clamped.absolutePath.slice(0, clamped.absolutePath.lastIndexOf('/')) || '/';
    const result = await this.exec({
      args: [
        'exec',
        '-i',
        this.id,
        'sh',
        '-c',
        `mkdir -p '${parentDir}' && cat > '${clamped.absolutePath}'`,
      ],
      timeoutMs: 30_000,
      maxOutputBytes: this.profile.maxOutputBytes,
      input: content,
    });
    if (result.exitCode === 0) return { ok: true };
    return { ok: false, reason: 'write_failed', detail: result.stderr.trim() };
  }

  async list(relativePath: string): Promise<SandboxListOutcome> {
    const clamped = clampSandboxPathPosix(this.workDir, relativePath);
    if (!clamped.ok) {
      return { ok: false, reason: 'path_rejected', detail: clamped.reason };
    }
    const result = await this.exec({
      args: ['exec', this.id, 'ls', '-1p', '--', clamped.absolutePath],
      timeoutMs: 15_000,
      maxOutputBytes: this.profile.maxOutputBytes,
    });
    if (result.exitCode !== 0) {
      if (/not a directory/i.test(result.stderr)) {
        return { ok: false, reason: 'not_a_directory', detail: result.stderr.trim() };
      }
      return { ok: false, reason: 'not_found', detail: result.stderr.trim() || 'no such file' };
    }
    const entries = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        if (line.endsWith('/')) return { name: line.slice(0, -1), kind: 'dir' as const };
        return { name: line, kind: 'file' as const };
      });
    return { ok: true, entries };
  }

  async teardown(): Promise<void> {
    await this.exec({ args: ['rm', '-f', this.id], timeoutMs: 30_000, maxOutputBytes: 65_536 });
  }
}

export const _internal = { containerNameFor, DEFAULT_RUN_TIMEOUT_SECONDS };
