/**
 * A connection for work that holds SESSION state across several statements:
 * the stale-vector clear and the vector-column migration keep a session-level
 * advisory lock while they run many short transactions.
 *
 * Behind a transaction-mode connection pooler (PgBouncer, Neon's `-pooler`
 * host) a client has no server session of its own outside a transaction: the
 * lock would be taken on one server session and released on another, and stay
 * held by a session nobody owns. In the registry's lock namespace that does
 * not degrade anything, it hangs `decideRegistry`.
 *
 * So when the pool's address is a pooled one, this work gets its own
 * connection straight to Postgres, closed when the work is done (which also
 * ends every session lock it still held). Otherwise it is an ordinary pool
 * checkout, exactly as before.
 *
 * The same address rule as the kernel's `directDatabaseUrl`
 * (`@omadia/orchestrator`, reloadBus.ts): `DATABASE_URL_DIRECT` when set,
 * else a Neon `-pooler` host without `-pooler`. Repeated here because this
 * package does not depend on that one. A pooler that cannot be recognised
 * from its address needs `DATABASE_URL_DIRECT`.
 */

import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

function isPooledHost(url: string): boolean {
  try {
    return /-pooler\./.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The direct address this work must use, or `undefined` when the pool's own
 * connections are fine (not recognisably pooled, or the address is unknown).
 */
export function directAddressFor(
  poolConnectionString: string | undefined,
  explicitDirect: string | undefined = process.env['DATABASE_URL_DIRECT'],
): string | undefined {
  if (!poolConnectionString) return undefined;
  const direct = explicitDirect?.trim();
  if (direct) return direct === poolConnectionString ? undefined : direct;
  if (!isPooledHost(poolConnectionString)) return undefined;
  const parsed = new URL(poolConnectionString);
  parsed.hostname = parsed.hostname.replace(/-pooler\./, '.');
  return parsed.toString();
}

/**
 * Check out a connection that owns its server session. `release(destroy)`
 * keeps the meaning it has on a pooled client; a direct connection is always
 * closed, whatever `destroy` says.
 */
export async function connectForSession(pool: Pool): Promise<PoolClient> {
  const options = (pool as { options?: pg.PoolConfig }).options;
  const direct = directAddressFor(options?.connectionString);
  if (!direct) return pool.connect();
  const client = new pg.Client({ ...options, connectionString: direct });
  await client.connect();
  return Object.assign(client, {
    release: (): void => {
      void client.end().catch(() => undefined);
    },
  }) as unknown as PoolClient;
}
