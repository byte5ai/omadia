/**
 * Background-job registry.
 *
 * Long-running or periodic work that a plugin contributes — today this is
 * implicit in the kernel (entity syncers for Odoo/Confluence, graph backfill,
 * embedding backfill, NorthData/OpenRegister ingest). As those move into
 * plugin packages in Phase 1+, each package's `activate()` will register
 * its job(s) here instead of starting them directly from `index.ts`.
 *
 * v1 semantics: fire-and-forget lifecycle. `start()` runs every registered
 * job once (for interval-based jobs, the job itself arms its own timer);
 * `stopAll()` invokes each job's returned dispose handle. No built-in
 * scheduler — a job that needs cron-like scheduling brings its own.
 *
 * No registrations land in this registry during Phase 0c; it's infrastructure
 * waiting for its first consumer.
 */

export interface BackgroundJobHandle {
  /** Signal the job to shut down. Must be idempotent and best-effort — the
   *  process may force-exit after a timeout. */
  stop(): Promise<void> | void;
}

export interface BackgroundJob {
  /** Unique label for logging + introspection. */
  readonly name: string;
  /** Start the job. Called once during `start()`. The returned handle is
   *  retained for `stopAll()`. */
  start(): Promise<BackgroundJobHandle> | BackgroundJobHandle;
}

interface RegisteredJob {
  readonly job: BackgroundJob;
  handle?: BackgroundJobHandle;
}

export class BackgroundJobRegistry {
  private readonly jobs: RegisteredJob[] = [];
  private started = false;

  constructor(
    private readonly log: (msg: string, err?: unknown) => void = (msg, err) => {
      if (err === undefined) console.log(msg);
      else {
        const detail =
          err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.error(`${msg}: ${detail}`);
      }
    },
  ) {}

  register(job: BackgroundJob): () => void {
    const entry: RegisteredJob = { job };
    this.jobs.push(entry);
    // If the registry has already been started, start this new job
    // immediately so late-registering plugins (e.g. after an upload) work.
    if (this.started) {
      void this.startOne(entry);
    }
    return () => {
      const idx = this.jobs.indexOf(entry);
      if (idx >= 0) this.jobs.splice(idx, 1);
      if (entry.handle) void this.stopOne(entry);
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const entry of this.jobs) {
      await this.startOne(entry);
    }
  }

  async stopAll(): Promise<void> {
    this.started = false;
    for (const entry of this.jobs) {
      await this.stopOne(entry);
    }
  }

  names(): readonly string[] {
    return this.jobs.map((e) => e.job.name);
  }

  private async startOne(entry: RegisteredJob): Promise<void> {
    try {
      entry.handle = await entry.job.start();
      this.log(`[background-job] started ${entry.job.name}`);
    } catch (err) {
      this.log(`[background-job] start FAILED for ${entry.job.name}`, err);
    }
  }

  private async stopOne(entry: RegisteredJob): Promise<void> {
    if (!entry.handle) return;
    try {
      await entry.handle.stop();
      entry.handle = undefined;
    } catch (err) {
      this.log(`[background-job] stop FAILED for ${entry.job.name}`, err);
    }
  }
}
