import { RSC_FETCH_TIMEOUT_MS, type VaultStatusResponse } from './api';
import type { DisclosureHealthDto } from './disclosure';

/**
 * The middleware's own `GET /health`, read server-side (#1385, #1384, #1332).
 *
 * ## Why not the web UI's `/health`
 *
 * On the web UI origin `/health` is the web UI's liveness route
 * (`app/health/route.ts`): it answers `ok` even while the database is down.
 * The middleware's endpoint lives outside the `/api` mount, so the browser
 * proxy does not reach it either. Server components fetch it directly from
 * `MIDDLEWARE_URL`, the same way `fetchDisclosurePosture` always did.
 *
 * ## Why this matters during an outage
 *
 * With Postgres stopped every authenticated route answers 503
 * `auth.unavailable`, so the pages had nothing left to explain the outage
 * with. `/health` is unauthenticated and still answers — with a 503 AND the
 * full snapshot (#665) — so it is the one source that can say "the database
 * is the problem". The body is therefore parsed regardless of the status.
 */

/** Mirrors `DatabaseCheck` in middleware/src/health/platformHealth.ts. */
export type DatabaseCheck = 'ok' | 'unreachable' | 'unknown' | 'none';
/**
 * The `checks` block of `GET /health`. Absent on middleware builds before
 * #1385. Master-key posture is deliberately not on this public endpoint; it
 * comes from the authenticated vault-status (see `devMasterKeysOf`).
 */
export interface PlatformChecksDto {
  database: DatabaseCheck;
}

/** The fields of the `kg` block the UI renders (see middleware kgHealth.ts). */
export interface KgHealthDto {
  backend: 'neon' | 'inmemory' | 'none';
  embeddings: boolean;
  semanticRecall: boolean;
  pool: 'live' | 'dead' | 'skipped';
  warnings: string[];
}

export interface MiddlewareHealthDto {
  status?: 'ok' | 'error';
  version?: string;
  checks?: PlatformChecksDto;
  kg?: KgHealthDto;
  disclosure?: DisclosureHealthDto;
}

/** `reachable: false` — no parseable answer at all (transport error, timeout, HTML). */
export type MiddlewareHealth =
  | { reachable: true; body: MiddlewareHealthDto }
  | { reachable: false };

function healthUrl(): string {
  const base = process.env['MIDDLEWARE_URL'] ?? 'http://localhost:3979';
  return `${base}/health`;
}

/**
 * Fetch the middleware's health snapshot. Never throws: an unreachable
 * middleware is a result here, not an error — it is one of the states the
 * callers exist to report. Bounded by the same 10 s ceiling as every other
 * server-rendered call, so a hanging middleware cannot freeze a page render.
 */
export async function fetchMiddlewareHealth(): Promise<MiddlewareHealth> {
  try {
    const res = await fetch(healthUrl(), {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(RSC_FETCH_TIMEOUT_MS),
    });
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return { reachable: false };
    return { reachable: true, body: body as MiddlewareHealthDto };
  } catch {
    return { reachable: false };
  }
}

/**
 * The database verdict, also for a middleware older than the `checks` block:
 * there a dead pool was already reported as `kg.pool: 'dead'`.
 */
export function databaseCheckOf(health: MiddlewareHealth): DatabaseCheck | null {
  if (!health.reachable) return null;
  const { checks, kg } = health.body;
  if (checks) return checks.database;
  if (kg?.pool === 'dead') return 'unreachable';
  if (kg?.pool === 'live') return 'ok';
  return null;
}

/** Which master keys still come from the dev file. Empty when both are set. */
export type DevMasterKey = 'vault' | 'keychain';

/**
 * From `/api/v1/admin/vault-status` (#1387): a key is a dev key unless it came
 * from its env var. A missing `keychain_key_source` (older middleware) is not
 * reported, rather than guessed.
 */
export function devMasterKeysOf(vault: VaultStatusResponse | null): DevMasterKey[] {
  if (vault === null) return [];
  const { master_key_source: vaultKey, keychain_key_source: keychainKey } = vault.vault;
  return [
    ...(vaultKey !== 'env' ? (['vault'] as const) : []),
    ...(keychainKey !== undefined && keychainKey !== 'env' ? (['keychain'] as const) : []),
  ];
}

/**
 * What the shared platform banner on the dashboard and `/admin` says. Only the
 * most severe state is shown: during an outage a dev-key warning is noise, and
 * the outage line already tells the operator where to look. `devMasterKey` is
 * a posture warning the operator may wave away for the page view; the other
 * two are outages.
 */
export type PlatformNotice =
  | { kind: 'middlewareUnreachable' }
  | { kind: 'databaseUnreachable' }
  | { kind: 'devMasterKey'; which: 'vault' | 'keychain' | 'both' };

export interface PlatformNoticeInput {
  health: MiddlewareHealth;
  /** The authenticated vault status, the source of the dev-key warning. */
  vault?: VaultStatusResponse | null;
  /**
   * Did an API call on this page come back 503 `auth.unavailable`? That is
   * the database outage as the authenticated routes report it (#1384), and it
   * counts even if `/health` itself could not be read.
   */
  databaseUnavailable?: boolean;
}

export function platformNotice({
  health,
  vault = null,
  databaseUnavailable = false,
}: PlatformNoticeInput): PlatformNotice | null {
  if (databaseUnavailable || databaseCheckOf(health) === 'unreachable') {
    return { kind: 'databaseUnreachable' };
  }
  if (!health.reachable) return { kind: 'middlewareUnreachable' };
  const devKeys = devMasterKeysOf(vault);
  if (devKeys.length === 0) return null;
  return {
    kind: 'devMasterKey',
    which: devKeys.length === 2 ? 'both' : (devKeys[0] ?? 'vault'),
  };
}
