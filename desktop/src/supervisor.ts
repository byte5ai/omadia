import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
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
import { startEmbeddedDb, stopEmbeddedDb, isEmbeddedDbRunning } from './embeddedDb';
import type { EmbeddedDb } from './embeddedDb';
import { stopChild, isConfirmedStopped } from './childLifecycle';
import { credentialKeychainKey, vaultKey, allProviderKeys } from './secrets';
import { log } from './log';
import { resolveAugmentedPath } from './pathEnv';

const augmentedPath = resolveAugmentedPath(process.env['PATH']);

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
 * What a shutdown actually achieved.
 *
 * `stop()` used to return `Promise<void>`, so a caller could not tell a real
 * shutdown from one that gave up waiting. The updater relied on that void
 * promise to decide it was safe to hand the app bundle to Squirrel (#926).
 */
export interface StopOutcome {
  /** True only when every process this supervisor started is confirmed gone. */
  readonly clean: boolean;
  /** Labels of the processes that outlived their shutdown deadline. */
  readonly survivors: readonly string[];
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
   * The in-flight full shutdown, if any. A second `stop()` awaits THIS instead
   * of returning immediately: the old early return handed its caller a
   * fulfilled promise while the first stop was still killing children, which
   * is how the updater came to believe the stack was down (#927).
   */
  private stopInFlight: Promise<StopOutcome> | null = null;
  /**
   * Cleanup promises for boots that have not finished yet, each resolving with
   * whatever that boot's own teardown could not kill.
   *
   * A superseded boot cleans up inside its own catch, which nobody used to
   * await. So stop() could resolve `{clean: true}` while a superseded boot was
   * still SIGTERM-ing its kernel - the same lie this class exists to remove.
   */
  private bootsInFlight = new Set<Promise<readonly string[]>>();
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

    // Filled by this attempt's own cleanup with anything it could not kill, so
    // a concurrent stop() can fold it into its outcome instead of reporting
    // clean by omission.
    const ownSurvivors: string[] = [];
    const attempt = this.bootOnce(gen, ownSurvivors);
    // Deliberately never rejects: the rejection belongs to our caller, while a
    // waiting stop() only needs to know when cleanup finished and what is left.
    const tracked = attempt.then(
      (): readonly string[] => ownSurvivors,
      (): readonly string[] => ownSurvivors,
    );
    this.bootsInFlight.add(tracked);
    try {
      return await attempt;
    } finally {
      this.bootsInFlight.delete(tracked);
    }
  }

  private async bootOnce(gen: number, ownSurvivors: string[]): Promise<string> {
    // Processes this particular boot spawned. `this.kernel`/`this.ui` can be
    // reassigned by a newer generation, so a superseded boot must reap what it
    // created from its own locals, not from the shared fields.
    let ownKernel: ChildProcess | null = null;
    let ownUi: ChildProcess | null = null;
    let ownDb: EmbeddedDb | null = null;

    try {
      this.progress('starting-db', 'Starting embedded database…');
      if (!this.db) {
        const db = await startEmbeddedDb();
        // startEmbeddedDb() awaits a free port BEFORE it registers anything in
        // module state, so a stop() inside that window found no database and
        // reported a clean shutdown. Publishing this handle anyway would leave
        // a live Postgres running out of the very bundle the installer is about
        // to replace - the #926 loop, now with false reassurance on top. And
        // assigning it when a stop() already killed it would poison the next
        // boot, which skips `startEmbeddedDb()` whenever `this.db` is set and
        // would then wait out a 90s health timeout against a dead server.
        if (gen !== this.generation) {
          ownDb = db;
          throw new Error('boot superseded');
        }
        this.db = db;
      }
      // A stop() that landed while the database was coming up has already run
      // its teardown; anything we spawn from here on would be an orphan.
      this.assertLiveGeneration(gen);

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

      this.assertLiveGeneration(gen);
      this.progress('starting-kernel', 'Starting omadia kernel…');
      ownKernel = this.forkNode(kernelEntry(), kernelCwd(), this.kernelEnv(kernelPort), 'kernel', gen);
      this.kernel = ownKernel;

      this.progress('waiting-kernel', 'Waiting for the kernel to become healthy…');
      await this.waitForKernel(kernelPort, gen);

      this.assertLiveGeneration(gen);
      this.progress('starting-ui', 'Starting the admin interface…');
      ownUi = this.forkNode(webUiEntry(), webUiCwd(), this.uiEnv(uiPort, kernelPort), 'web-ui', gen);
      this.ui = ownUi;
      this.uiUrl = `http://127.0.0.1:${uiPort}`;
      await this.waitForHttp(`${this.uiUrl}/`, 30_000, 'web-ui', gen);

      // Nothing checks the generation between that poll resolving and the state
      // flip, and a stop() landing there would otherwise be overwritten.
      this.assertLiveGeneration(gen);
      this.state = 'running';
      this.progress('ready', 'omadia is ready.');
      return this.uiUrl;
    } catch (err) {
      const superseded = gen !== this.generation;
      // Always reap our OWN children. When we were superseded the concurrent
      // stop() bumped the generation and tore down whatever existed AT THAT
      // MOMENT — which, for a boot still between phases, was nothing. Skipping
      // cleanup here is what left an unowned kernel and Postgres running out of
      // the app bundle, and ShipIt then waited forever for a bundle it was not
      // allowed to replace (#927 → #926).
      await this.reapOwnChildren(ownKernel, ownUi, ownDb, ownSurvivors);
      // The state and the shared fields belong to the live generation only.
      if (!superseded) {
        this.state = 'idle';
      }
      throw err;
    }
  }

  /** Bail out of a boot that a concurrent stop()/restart() has overtaken. */
  private assertLiveGeneration(gen: number): void {
    if (gen !== this.generation) throw new Error('boot superseded');
  }

  /**
   * Kill the children one specific boot attempt spawned, regardless of which
   * generation is live, and detach them from the shared fields only if they are
   * still the ones recorded there.
   */
  private async reapOwnChildren(
    ownKernel: ChildProcess | null,
    ownUi: ChildProcess | null,
    ownDb: EmbeddedDb | null,
    survivors: string[],
  ): Promise<void> {
    const [uiOutcome, kernelOutcome] = await Promise.all([
      stopChild(ownUi, 'web-ui', log),
      stopChild(ownKernel, 'kernel', log),
    ]);
    if (!isConfirmedStopped(uiOutcome)) survivors.push('web-ui');
    if (!isConfirmedStopped(kernelOutcome)) survivors.push('kernel');
    if (ownUi !== null && this.ui === ownUi) {
      this.ui = null;
      this.uiUrl = null;
    }
    if (ownKernel !== null && this.kernel === ownKernel) {
      this.kernel = null;
    }
    // Only ever set when this boot started the database itself and was then
    // superseded, so there is no live generation depending on it.
    if (ownDb !== null) {
      try {
        if (!(await ownDb.stop())) survivors.push('embedded-postgres');
      } catch (err) {
        log.error(`[db] stop failed for a superseded boot: ${String(err)}`);
        survivors.push('embedded-postgres');
      }
    }
  }

  /**
   * Wait for every in-flight boot to finish its own cleanup, and report what
   * outlived it. Callers must invalidate the generation FIRST, otherwise a boot
   * happily waits out its full 90s kernel health timeout before noticing.
   */
  private async settleInFlightBoots(): Promise<string[]> {
    if (this.bootsInFlight.size === 0) return [];
    const settled = await Promise.all([...this.bootsInFlight]);
    return settled.flatMap((survivors) => [...survivors]);
  }

  private kernelEnv(port: number): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: augmentedPath,
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
      // #578's credential keychain is a separate trust domain with its own
      // master key; the kernel fail-hards in production without it. Missing
      // here = dead fresh install (found the hard way on v0.115.0).
      CREDENTIAL_KEYCHAIN_KEY: credentialKeychainKey(),
      // Core migrations (#802): the orchestrator's default path walk assumes
      // the monorepo/Docker layout and lands in `node_modules/migrations` in
      // the packaged app — second fresh-install killer found on v0.115.0.
      // The explicit override removes the guesswork entirely.
      MULTI_ORCH_MIGRATIONS_DIR: path.join(kernelCwd(), 'migrations'),
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
      PATH: augmentedPath,
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

  /** Kill kernel + UI, reporting any that outlived their deadline. */
  private async teardownChildren(): Promise<string[]> {
    // Invalidate exit handlers + in-flight health polls before we kill anything.
    this.generation++;
    const [uiOutcome, kernelOutcome] = await Promise.all([
      stopChild(this.ui, 'web-ui', log),
      stopChild(this.kernel, 'kernel', log),
    ]);
    this.ui = null;
    this.kernel = null;
    this.uiUrl = null;
    const survivors: string[] = [];
    if (!isConfirmedStopped(uiOutcome)) survivors.push('web-ui');
    if (!isConfirmedStopped(kernelOutcome)) survivors.push('kernel');
    return survivors;
  }

  /** Stop kernel + UI but keep the embedded DB running, then boot again. */
  async restart(): Promise<string> {
    // Both guards matter: `state` catches a concurrent restart (whose teardown
    // sets the state but not the full-stop promise), `stopInFlight` catches a
    // full shutdown already on its way down.
    if (this.state === 'stopping' || this.stopInFlight) {
      throw new Error('Cannot restart while stopping.');
    }
    this.state = 'stopping';
    // Invalidate first, then wait. A boot we superseded stops the database it
    // started itself, so restarting on top of one still in flight could
    // otherwise pull the server out from under the boot we are about to do.
    this.generation++;
    const survivors = [
      ...(await this.settleInFlightBoots()),
      ...(await this.teardownChildren()),
    ];
    if (survivors.length > 0) {
      log.warn(`[boot] restarting with ${[...new Set(survivors)].join(' + ')} still alive`);
    }
    this.state = 'idle';
    return this.start();
  }

  /**
   * Full shutdown: children (awaited) then the embedded DB. Call on app quit.
   *
   * Resolves with what was actually achieved. A second concurrent call awaits
   * the first one's outcome rather than returning a fulfilled promise while the
   * first is still working — that early return is what let the updater proceed
   * to `quitAndInstall()` over a live stack (#927).
   */
  async stop(): Promise<StopOutcome> {
    if (this.stopInFlight) return this.stopInFlight;
    const run = this.runStop();
    this.stopInFlight = run;
    try {
      return await run;
    } finally {
      this.stopInFlight = null;
    }
  }

  private async runStop(): Promise<StopOutcome> {
    this.state = 'stopping';
    // Invalidate in-flight boots BEFORE waiting on them: their next generation
    // checkpoint and their health polls (which re-check every 750ms) are what
    // make them bail out promptly. Waiting first would mean sitting through a
    // full 90s kernel health timeout.
    this.generation++;
    const survivors = [...(await this.settleInFlightBoots())];
    survivors.push(...(await this.teardownChildren()));

    // Reap from module state, not from `this.db`: a start() interrupted before
    // it assigned the handle still left a live Postgres, and the old
    // `if (this.db)` guard walked straight past it (#927).
    survivors.push(...(await this.stopDatabase()));
    // A boot that was inside startEmbeddedDb()'s port lookup when we
    // invalidated it registers its server only afterwards. It has settled by
    // now, so a database still registered here is a real leak, not a race.
    if (isEmbeddedDbRunning()) {
      log.warn('[db] a database was still registered after shutdown; stopping it again');
      survivors.push(...(await this.stopDatabase()));
    }

    this.db = null;
    this.state = 'idle';
    const unique = [...new Set(survivors)];
    if (unique.length > 0) {
      log.error(`[boot] shutdown incomplete — still alive: ${unique.join(', ')}`);
    }
    return { clean: unique.length === 0, survivors: unique };
  }

  /** Stop the embedded database, returning a survivor label if it outlived it. */
  private async stopDatabase(): Promise<string[]> {
    try {
      return (await stopEmbeddedDb()) ? [] : ['embedded-postgres'];
    } catch (err) {
      log.error(`[db] stop failed: ${String(err)}`);
      return ['embedded-postgres'];
    }
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
