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
 * `query` and `connect` pass through. For a plugin that is not bundled, every
 * statement first goes through the table guard (ADR-0255,
 * `sqlTableGuard.ts`): a SQL grant covers the plugin's own tables, and a
 * statement naming a kernel table is refused. Such a borrower also loses the
 * members that hand out what the guard cannot see: the pool's listeners
 * (`on('connect')` receives core's raw clients), its `options` (the
 * connection string), `Client`, and every `_`-prefixed internal. Bundled
 * modules are reviewed in this repository and keep the pool as before.
 *
 * What is blocked for every borrower is LIFECYCLE: `end` and the listener-clearing methods.
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

import { checkedPluginStatement } from './sqlTableGuard.js';

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

/** ADR-0255 — what a guarded borrower may not reach on the pool: listeners
 *  receive core's raw clients, `options` holds the connection string, and
 *  `Client` opens a connection of its own. `_`-prefixed internals too. */
const LISTENER_MEMBERS = ['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'] as const;

const GUARDED_POOL_MEMBERS: ReadonlySet<string> = new Set([
  ...LISTENER_MEMBERS,
  'options',
  'Client',
  'constructor',
]);

/** ADR-0255 — what a guarded borrower may not reach on a client: the wire
 *  connection takes raw protocol messages past `query`. */
const GUARDED_CLIENT_MEMBERS: ReadonlySet<string> = new Set([
  ...LISTENER_MEMBERS,
  'connection',
  'connectionParameters',
  'password',
  'constructor',
]);

export interface BorrowPoolOptions {
  /** ADR-0255 — check each statement against the kernel's tables. Set for
   *  every plugin that is not bundled. */
  readonly guardStatements?: boolean;
}

function hiddenMember(prop: string | symbol, members: ReadonlySet<string>): boolean {
  return typeof prop === 'string' && (members.has(prop) || prop.startsWith('_'));
}

/**
 * The reflection traps of a guarded borrower: a hidden member has no
 * descriptor, is not `in` the object and is not listed, so
 * `Object.getOwnPropertyDescriptor(pool, 'options')` reaches nothing the
 * `get` trap hides. Writes and deletes of any member are refused.
 */
function hidingTraps<T extends object>(members: ReadonlySet<string>, pluginId: string): ProxyHandler<T> {
  return {
    getOwnPropertyDescriptor(target, prop) {
      return hiddenMember(prop, members) ? undefined : Reflect.getOwnPropertyDescriptor(target, prop);
    },
    has(target, prop) {
      return !hiddenMember(prop, members) && Reflect.has(target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter((key) => !hiddenMember(key, members));
    },
    set(_target, prop) {
      throw new PoolLifecycleError(pluginId, `set ${String(prop)}`);
    },
    defineProperty(_target, prop) {
      throw new PoolLifecycleError(pluginId, `define ${String(prop)}`);
    },
    deleteProperty(_target, prop) {
      throw new PoolLifecycleError(pluginId, `delete ${String(prop)}`);
    },
  };
}

/**
 * A `query` that checks its statement before it runs. A refusal arrives the
 * way the caller expects an error: through the callback when one is passed,
 * as a rejected promise otherwise.
 */
function guardedQuery(
  query: (...args: unknown[]) => unknown,
  pluginId: string,
): (...args: unknown[]) => unknown {
  return function query_(...args: unknown[]): unknown {
    let statement: unknown;
    try {
      statement = checkedPluginStatement(pluginId, args[0]);
    } catch (err) {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') {
        queueMicrotask(() => (callback as (e: unknown) => void)(err));
        return undefined;
      }
      return Promise.reject(err);
    }
    return query(statement, ...args.slice(1));
  };
}

/**
 * Wrap the pool for one plugin. Returns a Proxy so the wrapper cannot drift
 * out of date as `pg`'s surface grows: a new passthrough method needs no
 * change here, while anything named in {@link FORBIDDEN_POOL_METHODS} throws
 * however it is reached.
 */
export function borrowPool(pool: Pool, pluginId: string, options: BorrowPoolOptions = {}): Pool {
  const guarded = options.guardStatements === true;
  return new Proxy(pool, {
    ...(guarded ? hidingTraps<Pool>(GUARDED_POOL_MEMBERS, pluginId) : {}),
    get(target, prop, receiver) {
      if (typeof prop === 'string' && FORBIDDEN_POOL_METHODS.has(prop)) {
        return () => {
          throw new PoolLifecycleError(pluginId, prop);
        };
      }
      if (guarded && hiddenMember(prop, GUARDED_POOL_MEMBERS)) {
        throw new PoolLifecycleError(pluginId, String(prop));
      }
      if (prop === 'connect') {
        return async function connect(): Promise<PoolClient> {
          const client = await target.connect();
          return borrowClient(client, pluginId, guarded);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      // Methods must stay bound to the REAL pool. `pg` keeps private state on
      // the instance, so a method invoked with the Proxy as `this` would read
      // through this trap on every internal property access.
      if (typeof value !== 'function') return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      return guarded && prop === 'query' ? guardedQuery(bound, pluginId) : bound;
    },
  });
}

/**
 * Wrap a checked-out client so it cannot be used to reach the pool it came
 * from. `release` and `query` pass through — both are how a borrower is meant
 * to use a client; `query` through the table guard when `guarded`.
 */
function borrowClient(client: PoolClient, pluginId: string, guarded: boolean): PoolClient {
  return new Proxy(client, {
    ...(guarded ? hidingTraps<PoolClient>(GUARDED_CLIENT_MEMBERS, pluginId) : {}),
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
      if (guarded && hiddenMember(prop, GUARDED_CLIENT_MEMBERS)) {
        throw new PoolLifecycleError(pluginId, `connect().${String(prop)}`);
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      return guarded && prop === 'query' ? guardedQuery(bound, pluginId) : bound;
    },
  });
}
