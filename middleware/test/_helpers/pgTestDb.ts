import { Pool } from 'pg';

/**
 * Resolve a test-Postgres connection string from explicit env vars ONLY —
 * deliberately WITHOUT a hardcoded default port.
 *
 * Issue #572: a fixed default port (55438 / 55439) is a trap. Any scratch
 * container an agent or developer starts on that port silently answers the
 * `SELECT 1` probe and hijacks the suite — a failure that looks like several
 * unrelated tests breaking rather than a port collision. There is no safe
 * port by convention, so these suites require an explicit env var and skip
 * cleanly (with a logged reason) when none is set.
 *
 * Precedence is first-non-empty-wins over `vars`, so callers keep their
 * existing suite-specific variable names (e.g. GRAPH_PG_TEST_URL) as the
 * front of the chain and anyone already exporting one is unaffected.
 *
 * @param vars env var names in precedence order
 * @returns the connection string, or undefined when none is set
 */
export function resolvePgTestUrl(...vars: string[]): string | undefined {
  for (const name of vars) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export interface PgProbeResult {
  /** Resolved connection string, or undefined when no env var was set. */
  url: string | undefined;
  /** True only when a suitable Postgres answered the probe. */
  reachable: boolean;
}

/**
 * Resolve + probe the test Postgres and report whether the suite may run.
 *
 * Every skip path logs a specific reason so a skipped suite never reads as a
 * silently-broken one (the core complaint in issue #572). Never probes a
 * default port: with no env var set it returns `{ reachable: false }` without
 * opening a connection, so a stray container cannot be picked up.
 *
 * With `requireVector`, it also ensures the `vector` (pgvector) extension via
 * `CREATE EXTENSION IF NOT EXISTS vector` — idempotent, and it persists for the
 * suite's own connections since extensions are database-scoped. This bootstraps
 * the extension for the suite's migrations AND catches the exact mismatch from
 * #572 where a plain `postgres:16` image answered the probe but the suite needs
 * pgvector — the suite then skips with a clear message instead of six tests
 * dying on `CREATE EXTENSION vector`.
 */
export async function probePgTest(opts: {
  /** Short suite name for log lines. */
  label: string;
  /** Env var names in precedence order (suite-specific first). */
  vars: string[];
  /** Require the pgvector extension; skip loudly if it is missing. */
  requireVector?: boolean;
  /** Connection timeout for the probe (default 2000ms). */
  timeoutMs?: number;
}): Promise<PgProbeResult> {
  const url = resolvePgTestUrl(...opts.vars);
  if (!url) {
    console.error(
      `[${opts.label}] no test Postgres configured — set one of ` +
        `${opts.vars.join(', ')} to run this suite (skipping; issue #572).`,
    );
    return { url: undefined, reachable: false };
  }

  const probe = new Pool({
    connectionString: url,
    connectionTimeoutMillis: opts.timeoutMs ?? 2000,
  });
  try {
    await probe.query('SELECT 1');
    if (opts.requireVector) {
      // Ensure pgvector: idempotent, and it persists for the suite's own
      // connections (extensions are database-scoped). On a plain-postgres
      // squatter this throws — we skip with a specific reason instead of
      // letting the suite's migrations die on `CREATE EXTENSION vector`.
      try {
        await probe.query('CREATE EXTENSION IF NOT EXISTS vector');
      } catch {
        console.error(
          `[${opts.label}] Postgres at ${url} has no pgvector extension — ` +
            `this suite needs a pgvector image (e.g. pgvector/pgvector:pg16), ` +
            `not plain postgres. Skipping (issue #572).`,
        );
        return { url, reachable: false };
      }
    }
    return { url, reachable: true };
  } catch {
    console.error(
      `[${opts.label}] Postgres at ${url} unreachable — skipping (issue #572).`,
    );
    return { url, reachable: false };
  } finally {
    await probe.end().catch(() => undefined);
  }
}
