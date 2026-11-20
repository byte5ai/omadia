import pg from 'pg';
import type { Pool } from 'pg';

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
 * LISTEN is session state. It needs ONE server session for as long as the
 * bus runs, which a transaction-mode connection pooler (PgBouncer, Neon's
 * `-pooler` host) does not give: the statement succeeds and no notification
 * ever arrives. So with `listenConnectionString` the bus opens its own
 * connection to that address, which must reach Postgres directly; without it
 * it reserves one connection of `pool`, which is only right when the pool
 * itself connects directly. Either way the periodic reconcile is what the
 * consumer may rely on; LISTEN only makes it faster.
 */

/** Postgres through a transaction-mode pooler? Neon marks the pooled host
 *  with `-pooler`; other poolers cannot be recognised from the address. */
export function isPooledDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return /-pooler\./.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The address for work that needs one server session (LISTEN): the explicit
 * direct URL when the operator set one, else the pooled Neon address with
 * `-pooler` taken out of the host name (Neon serves the same database
 * directly there), else the URL as it is.
 */
export function directDatabaseUrl(url: string | undefined, explicitDirect?: string): string | undefined {
  if (explicitDirect && explicitDirect.trim().length > 0) return explicitDirect.trim();
  if (!url || !isPooledDatabaseUrl(url)) return url;
  const parsed = new URL(url);
  parsed.hostname = parsed.hostname.replace(/-pooler\./, '.');
  return parsed.toString();
}

/** What the bus needs from its LISTEN connection, pooled or its own. */
interface ListenConnection {
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'notification', listener: (msg: { channel: string; payload?: string }) => void): unknown;
  query(text: string): Promise<unknown>;
  /** End the session. LISTEN state must never reach another user of it.
   *  Settles when the session is gone, as far as the connection can tell. */
  close(): Promise<void>;
}

export interface ReloadBusOptions {
  /** Shared Postgres pool — the bus reserves one connection from it for
   *  the lifetime of the bus (LISTEN is per-connection) and never releases
   *  it. Use the same pool the registry's `ConfigStore` is bound to. */
  readonly pool: Pool;
  /**
   * Open a connection of the bus' own to this address for LISTEN instead of
   * reserving one of `pool`. Must reach Postgres DIRECTLY (not through a
   * transaction-mode pooler); see {@link directDatabaseUrl}.
   */
  readonly listenConnectionString?: string;
  /** Called once per coalesced trigger. Should return the diff plan that
   *  was executed (for logging). */
  /** What a notification (or the periodic reconcile) runs. The registry's
   *  bus returns its diff plan; any other consumer returns nothing. */
  readonly reload: () => Promise<DiffPlan | void>;
  /** NOTIFY channel to LISTEN on. Default `agents_changed` (the registry's);
   *  other kernel caches reuse this bus with their own channel (#2043). A
   *  plain identifier — it is interpolated into `LISTEN`. */
  readonly channel?: string;
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
/** How long `stop()` waits for the bus' own LISTEN session to end. */
const CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_NOTIFY_CHANNEL = 'agents_changed';
const CHANNEL_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export class ReloadBus {
  private client: ListenConnection | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelayMs: number;
  private stopped = false;
  private inFlight: Promise<void> | undefined;
  private pending = false;

  private readonly channel: string;

  constructor(private readonly options: ReloadBusOptions) {
    const channel = options.channel ?? DEFAULT_NOTIFY_CHANNEL;
    if (!CHANNEL_NAME_RE.test(channel)) {
      throw new Error(`ReloadBus: '${channel}' is not a valid NOTIFY channel name`);
    }
    this.channel = channel;
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
      const client = this.client;
      this.client = undefined;
      try {
        // The session ends: LISTEN state is connection-bound and would bleed
        // into the next checkout of a pooled connection.
        await client.close();
      } catch {
        // best-effort during shutdown
      }
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
    const client = await this.openListenConnection();
    client.on('error', (err) => {
      this.log(`reloadBus: client error — reconnecting`, {
        error: err.message,
      });
      this.scheduleReconnect();
    });
    client.on('notification', (msg) => {
      if (msg.channel !== this.channel) return;
      this.log(`reloadBus: notify received`, {
        channel: msg.channel,
        payload: msg.payload ?? null,
      });
      void this.fire('notify');
    });

    await client.query(`LISTEN ${this.channel}`);
    if (this.stopped) {
      // Stopped while connecting: nobody else would end this session.
      await client.close().catch(() => undefined);
      return;
    }
    this.client = client;
    this.reconnectDelayMs =
      this.options.reconnectInitialMs ?? DEFAULT_RECONNECT_MS;
    this.log(`reloadBus: subscribed`, { channel: this.channel });
  }

  private async openListenConnection(): Promise<ListenConnection> {
    const connectionString = this.options.listenConnectionString;
    if (connectionString) {
      const own = new pg.Client({ connectionString });
      await own.connect();
      return {
        on: (event: 'error' | 'notification', listener: never) => own.on(event as 'error', listener),
        query: (text) => own.query(text),
        // Bounded: a half-open connection must not hold up a shutdown.
        close: () => {
          let timer: NodeJS.Timeout | undefined;
          const gaveUp = new Promise<void>((done) => {
            timer = setTimeout(done, CLOSE_TIMEOUT_MS);
            timer.unref?.();
          });
          return Promise.race([own.end().catch(() => undefined), gaveUp]).finally(() => clearTimeout(timer));
        },
      };
    }
    const pooled = await this.options.pool.connect();
    return {
      on: (event: 'error' | 'notification', listener: never) => pooled.on(event as 'error', listener),
      query: (text) => pooled.query(text),
      // `release(true)` makes the pool drop the connection instead of recycling it.
      close: () => {
        pooled.release(true);
        return Promise.resolve();
      },
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    if (this.client) {
      const client = this.client;
      this.client = undefined;
      void Promise.resolve()
        .then(() => client.close())
        .catch(() => undefined);
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
    // A stopped bus reloads nothing. Ending the LISTEN session takes a round
    // trip, and a notification already on its way still arrives after
    // `stop()` was called; without this it ran one more reload.
    if (this.stopped) return this.inFlight ?? Promise.resolve();
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
        channel: this.channel,
        ...(plan ? { actions: plan.actions.length, platformChanged: plan.platformChanged } : {}),
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
