/**
 * Platform checks on `/health` (#1385, #1384) — one flat verdict per platform
 * dependency, so a UI can say WHICH part is broken without re-deriving it
 * from the capability picture in `kg`.
 *
 * Why a separate block next to `kg`: `kg` answers "what can recall do", and a
 * database outage shows up there only as `kg.pool: 'dead'` between embedding
 * flags. During a Postgres outage every authenticated route answers 503
 * `auth.unavailable`, so `/health` is the one unauthenticated place left that
 * can still tell the web UI "the database is the problem".
 *
 * Deliberately NOT here: where the vault and keychain master keys came from
 * (#1387, #1332). That posture is only shown while the database is up, so the
 * authenticated `/api/v1/admin/vault-status` serves it, and a public endpoint
 * does not advertise "this instance runs on dev-grade keys" to any scanner.
 */
import type { KgHealth } from './kgHealth.js';

/** Where a master key came from, as `resolveMasterKey` reports it. */
export type MasterKeySource = 'env' | 'dev-file-existed' | 'dev-file-created';

/**
 * - `ok`          — the shared pg pool answered `SELECT 1`.
 * - `unreachable` — the pool is configured and did not answer (Postgres down,
 *                   or the pool itself was ended, #665).
 * - `unknown`     — a database is configured, but no pool exists to ask (the
 *                   knowledge-graph backend is not active, e.g. it failed to
 *                   activate). Not claimed as healthy.
 * - `none`        — no database in use (in-memory backend). Not a fault.
 */
export type DatabaseCheck = 'ok' | 'unreachable' | 'unknown' | 'none';

export interface PlatformChecks {
  database: DatabaseCheck;
}

export interface PlatformChecksInput {
  kg: Pick<KgHealth, 'backend' | 'pool'>;
  /** Is `DATABASE_URL` set? Distinguishes `unknown` from `none`. */
  databaseConfigured: boolean;
}

export function buildPlatformChecks({
  kg,
  databaseConfigured,
}: PlatformChecksInput): PlatformChecks {
  if (kg.pool === 'live') return { database: 'ok' };
  if (kg.pool === 'dead') return { database: 'unreachable' };
  return { database: databaseConfigured || kg.backend === 'neon' ? 'unknown' : 'none' };
}
