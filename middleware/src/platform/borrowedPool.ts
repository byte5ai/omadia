/**
 * Lifecycle guard for the pool a plugin borrows. Epic #470, item C7 / G4.
 *
 * WHY THIS EXISTS
 * ---------------
 * `graphPool` is not a copy of the operator's database handle, it IS the
 * handle — the same `pg.Pool` core writes user data through. `services.get`
 * previously returned it naked, which meant one line in one plugin
 *
 *     ctx.services.get<Pool>('graphPool')?.end();
 *
 * tore down the connection pool for the entire middleware. That is not
 * hypothetical in this repo: `routes/adminEmbeddingProvider.ts` documents the
 * same class of bug having already happened once, on the pool the kernel
 * captured.
 *
 * C7 is the change that widens who can reach the pool — from a short audited
 * allowlist to any plugin an operator grants — so it is the change that owes
 * the guard.
 *
 * WHAT IS AND IS NOT BLOCKED
 * --------------------------
 * `query` and `connect` pass straight through. A granted plugin running
 * arbitrary SQL is the INTENDED, operator-consented behaviour of
 * `permissions.sql`; pretending otherwise would be theatre, and
 * `runPluginMigrations` needs `connect()` to do its job at all.
 *
 * What is blocked is LIFECYCLE: `end` and the listener-clearing methods.
 * Those are core's to call, they affect every other consumer of the pool, and
 * no plugin has a legitimate reason to reach for them — a plugin does not own
 * the pool, it borrows it.
 *
 * A borrowed client from `connect()` is wrapped too. `client.release()` must
 * keep working (a plugin that cannot return a connection would leak the pool
 * dry), but a `PoolClient` also exposes the pool it came from, which would be
 * a trivial way around the guard.
 */

import type { Pool, PoolClient } from 'pg';

/** Thrown when a plugin reaches for the pool's lifecycle instead of its data. */
export class PoolLifecycleError extends Error {
  public readonly pluginId: string;
  public readonly method: string;

  constructor(pluginId: string, method: string) {
    super(
      `plugin '${pluginId}' called graphPool.${method}() — the pool is the operator's, shared with core, and is borrowed rather than owned. ` +
        'Use query() or connect(); lifecycle belongs to the middleware that opened it.',
    );
    this.name = 'PoolLifecycleError';
    this.pluginId = pluginId;
    this.method = method;
  }
}

/** Pool methods a borrower must not call. `end` destroys the shared pool;
 *  the listener removers would silently unhook core's own error handling. */
const FORBIDDEN_POOL_METHODS: ReadonlySet<string> = new Set([
  'end',
  'removeAllListeners',
]);

/**
 * Wrap the pool for one plugin. Returns a Proxy so the wrapper cannot drift
 * out of date as `pg`'s surface grows: a new passthrough method needs no
 * change here, while anything named in {@link FORBIDDEN_POOL_METHODS} throws
 * however it is reached.
 */
export function borrowPool(pool: Pool, pluginId: string): Pool {
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && FORBIDDEN_POOL_METHODS.has(prop)) {
        return () => {
          throw new PoolLifecycleError(pluginId, prop);
        };
      }
      if (prop === 'connect') {
        return async function connect(): Promise<PoolClient> {
          const client = await target.connect();
          return borrowClient(client, pluginId);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      // Methods must stay bound to the REAL pool. `pg` keeps private state on
      // the instance, so a method invoked with the Proxy as `this` would read
      // through this trap on every internal property access.
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/**
 * Wrap a checked-out client so it cannot be used to reach the pool it came
 * from. `release` and `query` pass through — both are how a borrower is meant
 * to use a client.
 */
function borrowClient(client: PoolClient, pluginId: string): PoolClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      // `pg` hangs the owning Pool off the client. Without this the guard is
      // one property access deep: `(await pool.connect()).pool.end()`.
      if (prop === 'pool') {
        throw new PoolLifecycleError(pluginId, 'connect().pool');
      }
      if (typeof prop === 'string' && FORBIDDEN_POOL_METHODS.has(prop)) {
        return () => {
          throw new PoolLifecycleError(pluginId, `connect().${prop}`);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
