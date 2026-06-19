import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import fs from 'node:fs';
import path from 'node:path';
import { findFreePort, isPortFree } from './ports';
import { embeddedDbDir, dataRoot } from './paths';
import { log } from './log';

/**
 * The embedded Postgres engine.
 *
 * This is the piece that dissolves omadia's "postgres+pgvector is the blocker"
 * constraint for a no-Docker install. PGlite is a full Postgres compiled to WASM
 * that runs in-process and persists to disk; the `vector` extension gives us
 * pgvector. We then expose it over the Postgres *wire protocol* on a loopback
 * port via PGLiteSocketServer, so the kernel connects through its existing
 * node-postgres (`pg`) code path with a normal `DATABASE_URL` — zero kernel
 * changes, and all existing SQL migrations run unmodified.
 *
 * Caveat (documented): PGlite is single-connection. The socket server serializes
 * client connections, so the kernel's pool effectively runs queries one at a
 * time. Acceptable for a single-tenant local install; the fallback if this ever
 * bottlenecks is a bundled native Postgres.
 */

const DB_NAME = 'omadia';
const DB_USER = 'omadia';
const DB_PASSWORD = 'omadia';

export interface EmbeddedDb {
  /** DATABASE_URL the kernel should use to reach this engine. */
  databaseUrl: string;
  /** The bound loopback port. */
  port: number;
  /** Snapshot the on-disk data directory (used before applying an app update). */
  stop(): Promise<void>;
}

let current: { db: PGlite; server: PGLiteSocketServer; port: number } | null = null;

export async function startEmbeddedDb(): Promise<EmbeddedDb> {
  if (current) {
    return toHandle(current);
  }

  const dir = embeddedDbDir();
  log.info(`[db] opening embedded Postgres at ${dir}`);
  // The kernel's KG migrations require `vector` (pgvector, embedding similarity)
  // and `pg_trgm` (turn full-text search); both must be registered on the PGlite
  // instance for the migrations' `CREATE EXTENSION` to succeed. Load + install
  // them up front, and translate a bundling/staging miss into a clear error
  // instead of a cryptic module-resolution or mid-migration failure.
  const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  // A failure to LOAD the extension module is unambiguously a bundling/staging
  // problem (the package isn't fully shipped) — say so clearly.
  // pg_trgm's contrib subpath is ESM-only, so load it dynamically (this file
  // compiles to CommonJS). `vector` ships a CJS build and imports statically.
  let pg_trgm: unknown;
  try {
    ({ pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm'));
  } catch (err) {
    throw new Error(
      'Embedded Postgres extension module (pg_trgm) failed to load — the installer ' +
        `bundle is likely incomplete (@electric-sql/pglite not fully staged). Underlying: ${msg(err)}`,
      { cause: err },
    );
  }

  // Opening the DB can fail for bundling reasons OR storage reasons (unwritable /
  // corrupt data dir, disk full) — don't pin the blame on the bundle here.
  let db: PGlite;
  try {
    db = await PGlite.create({ dataDir: dir, extensions: { vector, pg_trgm: pg_trgm as never } });
    await db.exec('CREATE EXTENSION IF NOT EXISTS vector;');
    await db.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm;');
  } catch (err) {
    throw new Error(
      `Failed to open the embedded Postgres database at ${dir} — this is usually an ` +
        `incomplete bundle or an unwritable/corrupt data directory. Underlying: ${msg(err)}`,
      { cause: err },
    );
  }
  // (pgcrypto is intentionally NOT required: the kernel migrations only used it
  // for gen_random_uuid(), which is core since Postgres 13.)

  const port = await stableDbPort();
  const server = new PGLiteSocketServer({
    db,
    port,
    host: '127.0.0.1',
  });
  await server.start();
  log.info(`[db] embedded Postgres listening on 127.0.0.1:${port}`);

  current = { db, server, port };
  return toHandle(current);
}

function toHandle(c: { db: PGlite; server: PGLiteSocketServer; port: number }): EmbeddedDb {
  const databaseUrl =
    `postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${c.port}/${DB_NAME}`;
  return {
    databaseUrl,
    port: c.port,
    async stop() {
      log.info('[db] stopping embedded Postgres');
      try {
        await c.server.stop();
      } finally {
        await c.db.close();
        current = null;
      }
    },
  };
}

export function isEmbeddedDbRunning(): boolean {
  return current !== null;
}

/**
 * Returns a STABLE loopback port for the embedded DB, persisted across restarts.
 *
 * The kernel records its `database_url` (port included) in its config store on
 * first boot, and that persisted value wins over the env var on later boots. If
 * the embedded DB picked a fresh random port each launch, the kernel would keep
 * dialing the first-ever port and fail with ECONNREFUSED. So we choose a port
 * once, store it, and reuse it — only re-picking if it's genuinely taken.
 */
async function stableDbPort(): Promise<number> {
  const file = path.join(dataRoot(), 'db-port.txt');
  let stored: number | null = null;
  try {
    const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    if (Number.isInteger(n) && n > 1023 && n < 65536) stored = n;
  } catch {
    /* no stored port yet */
  }
  if (stored !== null && (await isPortFree(stored))) {
    return stored;
  }
  if (stored !== null) {
    log.warn(`[db] stored port ${stored} is busy; picking a new one (kernel db_url may need a reset)`);
  }
  const port = await findFreePort('127.0.0.1');
  fs.writeFileSync(file, String(port), 'utf8');
  return port;
}
