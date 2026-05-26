import type { Pool, PoolClient } from 'pg';

import type { DiffPlan } from './applyDiff.js';

/**
 * `ReloadBus` (US5 / T021).
 *
 * Hot-reload signal carrier. Holds a long-lived dedicated `pg.Client`
 * subscribed to `LISTEN agents_changed` (the channel the
 * `notify_agents_changed` trigger fires into) and dispatches every NOTIFY
 * to the registry's `reload()` method. A periodic reconcile timer is the
 * fallback for a dropped LISTEN connection (D3 in `data-model.md`) — every
 * tick re-reads the snapshot whether or not a NOTIFY arrived.
 *
 * Both call paths are coalesced through a single in-flight promise so a
 * burst of NOTIFY events (one per affected row in a multi-row UPDATE)
 * collapses into one reload; the next NOTIFY queues a second reload only
 * if it arrives mid-flight.
 *
 * The bus owns the `pg.Client` lifetime; the registry's `graphPool` is
 * untouched because LISTEN is per-connection and Pool would round-robin
 * sessions away from the subscription.
 */

export interface ReloadBusOptions {
  /** Shared Postgres pool — the bus reserves one connection from it for
   *  the lifetime of the bus (LISTEN is per-connection) and never releases
   *  it. Use the same pool the registry's `ConfigStore` is bound to. */
  readonly pool: Pool;
  /** Called once per coalesced trigger. Should return the diff plan that
   *  was executed (for logging). */
  readonly reload: () => Promise<DiffPlan>;
  /** Periodic reconcile interval. Default 60s. Set to 0 to disable the
   *  fallback (tests that drive the bus by hand). */
  readonly reconcileIntervalMs?: number;
  /** Reconnect back-off when the LISTEN client errors. Default 5s, capped
   *  at 30s by exponential growth. */
  readonly reconnectInitialMs?: number;
  /** Enable the LISTEN/NOTIFY subscription. Default `false` — see `start()`
   *  for why; flip to `true` only when the kg pool max is raised or a
   *  dedicated DATABASE_URL is wired. */
  readonly enableListen?: boolean;
  /** Structured log sink. */
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
}

const DEFAULT_RECONCILE_MS = 60_000;
const DEFAULT_RECONNECT_MS = 5_000;
const MAX_RECONNECT_MS = 30_000;
const NOTIFY_CHANNEL = 'agents_changed';

export class ReloadBus {
  private client: PoolClient | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelayMs: number;
  private stopped = false;
  private inFlight: Promise<void> | undefined;
  private pending = false;

  constructor(private readonly options: ReloadBusOptions) {
    this.reconnectDelayMs =
      options.reconnectInitialMs ?? DEFAULT_RECONNECT_MS;
  }

  /**
   * Start the bus. By default the LISTEN subscription is DISABLED — the
   * subscribed `pool.connect()` reserves a connection for the bus' lifetime
   * and on the kg plugin's default `max: 5` pool that's enough to deadlock
   * concurrent boot-time queries. The periodic reconcile (default 60s)
   * keeps the registry caught up; set `enableListen: true` once the kg
   * pool max is raised or a dedicated DATABASE_URL is wired through.
   */
  async start(): Promise<void> {
    if (this.stopped) throw new Error('ReloadBus.start: already stopped');
    if (this.options.enableListen === true) {
      await this.connect();
    } else {
      this.log(
        `reloadBus: LISTEN disabled — relying on periodic reconcile only`,
        { reconcileIntervalMs: this.options.reconcileIntervalMs ?? DEFAULT_RECONCILE_MS },
      );
    }
    this.scheduleReconcile();
  }

  /** Tear down both the LISTEN connection and the reconcile timer. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.client) {
      try {
        // `release(true)` marks the connection broken so the pool drops it
        // instead of recycling — LISTEN state is connection-bound and would
        // bleed into the next checkout.
        this.client.release(true);
      } catch {
        // best-effort during shutdown
      }
      this.client = undefined;
    }
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // already logged
      }
    }
  }

  /** Imperative trigger — tests use this in place of NOTIFY. */
  triggerNow(): Promise<void> {
    return this.fire('manual');
  }

  private async connect(): Promise<void> {
    const client = await this.options.pool.connect();
    client.on('error', (err) => {
      this.log(`reloadBus: client error — reconnecting`, {
        error: err.message,
      });
      this.scheduleReconnect();
    });
    client.on('notification', (msg) => {
      if (msg.channel !== NOTIFY_CHANNEL) return;
      this.log(`reloadBus: notify received`, {
        channel: msg.channel,
        payload: msg.payload ?? null,
      });
      void this.fire('notify');
    });

    await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
    this.client = client;
    this.reconnectDelayMs =
      this.options.reconnectInitialMs ?? DEFAULT_RECONNECT_MS;
    this.log(`reloadBus: subscribed`, { channel: NOTIFY_CHANNEL });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    if (this.client) {
      try {
        this.client.release(true);
      } catch {
        // ignore
      }
      this.client = undefined;
    }
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      MAX_RECONNECT_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch((err) => {
        this.log(`reloadBus: reconnect FAILED — retrying`, {
          error: (err as Error).message,
        });
        this.scheduleReconnect();
      });
    }, delay);
  }

  private scheduleReconcile(): void {
    const ms = this.options.reconcileIntervalMs ?? DEFAULT_RECONCILE_MS;
    if (ms <= 0) return;
    this.reconcileTimer = setInterval(() => {
      this.log(`reloadBus: periodic reconcile`, { intervalMs: ms });
      void this.fire('reconcile');
    }, ms);
    // Keep Node alive only when there's nothing else; the registry holds
    // the rest of the process open.
    this.reconcileTimer.unref?.();
  }

  /**
   * Coalesce overlapping fire requests into one in-flight reload. If
   * `fire()` is called while a reload is in flight, the second call is
   * queued (collapsed to a single replay).
   */
  private fire(source: 'notify' | 'reconcile' | 'manual'): Promise<void> {
    if (this.inFlight) {
      this.pending = true;
      return this.inFlight;
    }
    this.inFlight = this.runReload(source).finally(() => {
      this.inFlight = undefined;
      if (this.pending) {
        this.pending = false;
        void this.fire('notify');
      }
    });
    return this.inFlight;
  }

  private async runReload(
    source: 'notify' | 'reconcile' | 'manual',
  ): Promise<void> {
    try {
      const plan = await this.options.reload();
      this.log(`reloadBus: reload applied`, {
        source,
        actions: plan.actions.length,
        platformChanged: plan.platformChanged,
      });
    } catch (err) {
      this.log(`reloadBus: reload FAILED`, {
        source,
        error: (err as Error).message,
      });
    }
  }

  private log(msg: string, fields?: Record<string, unknown>): void {
    this.options.log?.(msg, fields);
  }
}
