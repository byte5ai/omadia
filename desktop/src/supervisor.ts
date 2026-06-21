import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  kernelEntry,
  kernelCwd,
  webUiEntry,
  webUiCwd,
  platformDataDir,
} from './paths';
import { findFreePorts, isPortFree } from './ports';
import { startEmbeddedDb, EmbeddedDb } from './embeddedDb';
import { vaultKey, allProviderKeys } from './secrets';
import { log } from './log';

export type BootPhase =
  | 'starting-db'
  | 'starting-kernel'
  | 'waiting-kernel'
  | 'starting-ui'
  | 'ready'
  | 'error';

export interface BootProgress {
  phase: BootPhase;
  message: string;
  detail?: string;
}

/**
 * Owns the lifecycle of the local omadia stack: embedded DB → kernel → web-ui.
 * Children are forked from Electron's own binary running in pure-Node mode
 * (ELECTRON_RUN_AS_NODE=1), so we ship no separate Node runtime.
 */
export class Supervisor extends EventEmitter {
  private db: EmbeddedDb | null = null;
  private kernel: ChildProcess | null = null;
  private ui: ChildProcess | null = null;
  private uiUrl: string | null = null;
  /** Single-flight guard: only one start/restart/stop runs at a time. */
  private state: 'idle' | 'starting' | 'running' | 'stopping' = 'idle';
  /**
   * Bumped on every stop/restart. A child's exit handler and the in-flight
   * health-poll loops compare against this so a process we intentionally killed
   * (or a boot we superseded) is never misreported as a crash.
   */
  private generation = 0;

  /** Health-check window — mirrors the compose healthcheck start_period (90s). */
  private static readonly KERNEL_BOOT_TIMEOUT_MS = 90_000;

  /**
   * Fixed loopback port for the kernel. The web-ui's `/bot-api` → kernel rewrite
   * is frozen into the Next standalone build AT BUILD TIME (routes-manifest.json),
   * so the kernel URL the UI talks to cannot be a per-launch random port — it
   * must match what the UI was built with. We bake `http://127.0.0.1:8769` into
   * the UI and pin the kernel here. (Only the UI's own listen port stays
   * dynamic.) Collisions on a single-user desktop are rare; a future version can
   * patch the staged UI to a chosen port instead.
   */
  private static readonly KERNEL_PORT = 8769;

  getUiUrl(): string | null {
    return this.uiUrl;
  }

  private progress(phase: BootPhase, message: string, detail?: string): void {
    log.info(`[boot] ${phase}: ${message}${detail ? ` — ${detail}` : ''}`);
    this.emit('progress', { phase, message, detail } satisfies BootProgress);
  }

  /** Boot the whole stack. Resolves with the UI URL once the UI is serving. */
  async start(): Promise<string> {
    if (this.state === 'starting' || this.state === 'stopping') {
      throw new Error(`Cannot start while ${this.state}.`);
    }
    if (this.state === 'running' && this.uiUrl) {
      return this.uiUrl;
    }
    this.state = 'starting';
    const gen = ++this.generation;

    try {
      this.progress('starting-db', 'Starting embedded database…');
      if (!this.db) {
        this.db = await startEmbeddedDb();
      }

      const kernelPort = Supervisor.KERNEL_PORT;
      // The kernel port is fixed (the web-ui bakes it at build time), so a clash
      // can't be dodged by picking another port. Surface a clear, actionable
      // error instead of an opaque 90s health-check timeout. The app already
      // holds a single-instance lock, so a clash here is some *other* process.
      if (!(await isPortFree(kernelPort))) {
        let hint = `Port ${kernelPort} is already in use by another application.`;
        try {
          const res = await fetch(`http://127.0.0.1:${kernelPort}/health`, {
            signal: AbortSignal.timeout(2_000),
          });
          const body = res.ok ? ((await res.json()) as { status?: string } | null) : null;
          // Only claim it's omadia if the distinctive health shape matches, not
          // any process that happens to answer 200.
          if (body?.status === 'ok') {
            hint = `omadia already appears to be running on port ${kernelPort}.`;
          }
        } catch {
          /* not an omadia health endpoint — keep the generic hint */
        }
        throw new Error(hint);
      }
      const [uiPort] = await findFreePorts(1);

      this.progress('starting-kernel', 'Starting omadia kernel…');
      this.kernel = this.forkNode(kernelEntry(), kernelCwd(), this.kernelEnv(kernelPort), 'kernel', gen);

      this.progress('waiting-kernel', 'Waiting for the kernel to become healthy…');
      await this.waitForKernel(kernelPort, gen);

      this.progress('starting-ui', 'Starting the admin interface…');
      this.ui = this.forkNode(webUiEntry(), webUiCwd(), this.uiEnv(uiPort, kernelPort), 'web-ui', gen);
      this.uiUrl = `http://127.0.0.1:${uiPort}`;
      await this.waitForHttp(`${this.uiUrl}/`, 30_000, 'web-ui', gen);

      this.state = 'running';
      this.progress('ready', 'omadia is ready.');
      return this.uiUrl;
    } catch (err) {
      // If a concurrent stop()/restart() superseded this boot (it bumped the
      // generation), it now owns teardown + the state — do NOT double-tear-down
      // or stomp its state. Only clean up when we're still the live generation.
      if (gen === this.generation) {
        await this.teardownChildren();
        this.state = 'idle';
      }
      throw err;
    }
  }

  private kernelEnv(port: number): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(port),
      // Loopback-only. The kernel otherwise binds dual-stack `::` (all
      // interfaces), which would expose the local install on the LAN.
      HOST: '127.0.0.1',
      DATABASE_URL: this.db?.databaseUrl ?? '',
      // Signals the kernel that DATABASE_URL points at our embedded Postgres,
      // whose loopback port can change between launches (collision → new port).
      // The knowledge-graph plugin then treats the live env DSN as authoritative
      // over the first-boot value frozen in the vault, so a port change can't
      // crash-loop boot against a dead port. Cloud/server leave this unset and
      // keep vault precedence.
      OMADIA_EMBEDDED_DB: '1',
      VAULT_KEY: vaultKey(),
      PLATFORM_DATA_DIR: platformDataDir(),
      // The browser opens signed diagram URLs against this host base.
      DIAGRAM_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      ...allProviderKeys(),
    };
    // v1 wires only persistence + LLM. Embeddings (in-process), diagrams (hosted),
    // and the filesystem attachment store are later milestones; leaving their env
    // unset means the kernel degrades gracefully rather than failing.
    return env;
  }

  private uiEnv(uiPort: number, kernelPort: number): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(uiPort),
      HOSTNAME: '127.0.0.1',
      MIDDLEWARE_URL: `http://127.0.0.1:${kernelPort}`,
    };
  }

  private forkNode(
    entry: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    label: string,
    gen: number,
  ): ChildProcess {
    log.info(`[${label}] spawning ${entry} (cwd=${cwd})`);
    const child = spawn(process.execPath, [entry], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => log.info(`[${label}] ${d.toString().trimEnd()}`));
    child.stderr?.on('data', (d: Buffer) => log.warn(`[${label}] ${d.toString().trimEnd()}`));
    child.on('exit', (code, signal) => {
      log.warn(`[${label}] exited code=${code} signal=${signal}`);
      // Only a crash if this child belongs to the live generation AND we believed
      // the stack was up. An intentional stop/restart bumps `generation`, so a
      // killed child's exit lands here as a no-op instead of a false alarm.
      if (gen === this.generation && this.state === 'running') {
        this.state = 'idle';
        this.emit('child-exit', { label, code, signal });
        this.progress('error', `${label} stopped unexpectedly (code ${code ?? signal}).`);
      }
    });
    return child;
  }

  private async waitForKernel(port: number, gen: number): Promise<void> {
    // Cold Windows boots / AV scanning / large migration sets can exceed the
    // default 90s; allow an override without a rebuild.
    const timeout =
      Number(process.env['OMADIA_BOOT_TIMEOUT_MS']) || Supervisor.KERNEL_BOOT_TIMEOUT_MS;
    await this.waitForHttp(`http://127.0.0.1:${port}/health`, timeout, 'kernel', gen);
  }

  private async waitForHttp(
    url: string,
    timeoutMs: number,
    label: string,
    gen: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr = '';
    while (Date.now() < deadline) {
      if (gen !== this.generation) throw new Error('boot superseded');
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(4_000) });
        if (res.ok) return;
        lastErr = `HTTP ${res.status}`;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
      }
      await delay(750);
    }
    throw new Error(`${label} did not become healthy within ${timeoutMs}ms (${lastErr})`);
  }

  /** SIGTERM a child, wait for it to actually exit, escalate to SIGKILL if needed. */
  private killAndWait(child: ChildProcess | null, label: string, graceMs = 4_000): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(hardStop);
        resolve();
      };
      child.once('exit', finish);
      child.kill('SIGTERM');
      // Escalate if it ignores SIGTERM (notably on Windows, where SIGTERM is not
      // a real graceful signal).
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          log.warn(`[${label}] did not exit on SIGTERM; sending SIGKILL`);
          child.kill('SIGKILL');
        }
      }, graceMs);
      // Absolute backstop so a never-firing 'exit' can't hang shutdown forever.
      const hardStop = setTimeout(finish, graceMs * 2);
    });
  }

  private async teardownChildren(): Promise<void> {
    // Invalidate exit handlers + in-flight health polls before we kill anything.
    this.generation++;
    await Promise.all([
      this.killAndWait(this.ui, 'web-ui'),
      this.killAndWait(this.kernel, 'kernel'),
    ]);
    this.ui = null;
    this.kernel = null;
    this.uiUrl = null;
  }

  /** Stop kernel + UI but keep the embedded DB running, then boot again. */
  async restart(): Promise<string> {
    if (this.state === 'stopping') throw new Error('Cannot restart while stopping.');
    this.state = 'stopping';
    await this.teardownChildren();
    this.state = 'idle';
    return this.start();
  }

  /** Full shutdown: children (awaited) then the embedded DB. Call on app quit. */
  async stop(): Promise<void> {
    if (this.state === 'stopping') return;
    this.state = 'stopping';
    await this.teardownChildren();
    if (this.db) {
      try {
        await this.db.stop();
      } catch (err) {
        log.error(`[db] stop failed: ${String(err)}`);
      }
      this.db = null;
    }
    this.state = 'idle';
  }
}

// Track the live supervisor so the app's quit handler (main.ts) can await a
// clean shutdown. We deliberately do NOT register our own before-quit here —
// main.ts owns the single blocking handler so the DB is flushed before exit.
let active: Supervisor | null = null;
export function setActiveSupervisor(s: Supervisor): void {
  active = s;
}
export function getActiveSupervisor(): Supervisor | null {
  return active;
}
