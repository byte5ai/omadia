import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import { Client } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { embeddedDbDir, dataRoot, runtimeIsDev } from './paths';
import { findFreePort, isPortFree } from './ports';
import { log } from './log';

/**
 * The embedded database engine: a REAL, bundled PostgreSQL 17 + pgvector.
 *
 * We previously embedded PGlite (Postgres compiled to WASM) over the wire
 * protocol via pglite-socket. That worked for builds/boot but the WASM engine
 * crashed (`RuntimeError: unreachable`) under the kernel's real query load, and
 * pglite-socket is single-connection. A native Postgres removes both problems:
 * full SQL compatibility (no WASM traps) and real connection pooling.
 *
 * The Postgres server binaries (initdb/postgres) + pgvector ship with the app
 * (dev: the @embedded-postgres platform package in node_modules; packaged: staged
 * to `resourcesPath/omadia-pg` as extraResources, so they're executable on disk
 * — never trapped inside the asar archive). We drive initdb/postgres directly
 * rather than via the embedded-postgres wrapper, which is asar-unaware.
 *
 * The kernel connects over loopback TCP with trust auth (loopback-only; no LAN
 * exposure). No GRAPH_POOL_MAX=1 cap needed — real Postgres pools normally.
 */

const DB_NAME = 'omadia';
const DB_USER = 'omadia';
const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name);

export interface EmbeddedDb {
  /** DATABASE_URL the kernel should use to reach this engine. */
  databaseUrl: string;
  /** The bound loopback port. */
  port: number;
  /** Stop the Postgres server. */
  stop(): Promise<void>;
}

let current: { proc: ChildProcess; port: number } | null = null;
// Set while we are deliberately shutting the server down, so the `exit` handler
// (registered at spawn) does not misreport an intentional stop as a crash.
let stopping = false;

/** @embedded-postgres package name for this platform (win32 → windows). */
function pgPlatform(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  return `${os}-${process.arch}`;
}

/** The staged Postgres "native" dir (contains bin/, lib/, share/). */
function pgNativeDir(): string {
  if (runtimeIsDev) {
    return path.join(__dirname, '..', 'node_modules', '@embedded-postgres', pgPlatform(), 'native');
  }
  return path.join(process.resourcesPath, 'omadia-pg');
}

function pgBin(name: string): string {
  return path.join(pgNativeDir(), 'bin', exe(name));
}

export async function startEmbeddedDb(): Promise<EmbeddedDb> {
  if (current) return toHandle(current.port);

  const dataDir = embeddedDbDir();
  const nativeDir = pgNativeDir();
  if (!fs.existsSync(pgBin('postgres'))) {
    throw new Error(
      `Embedded Postgres binary not found at ${pgBin('postgres')} — the installer ` +
        'bundle is incomplete (Postgres engine not staged).',
    );
  }

  // First run: initialise the data cluster. `-A trust` (loopback-only) + locale C
  // (avoids the "no suitable text search config for UTF-8 locale" initdb warning).
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    log.info('[db] initialising embedded Postgres cluster…');
    const pwFile = path.join(dataDir, '..', '.pg-init-noop');
    fs.mkdirSync(path.dirname(pwFile), { recursive: true });
    execFileSync(
      pgBin('initdb'),
      ['-D', dataDir, '-U', DB_USER, '-A', 'trust', '-E', 'UTF8', '--locale=C'],
      { stdio: 'pipe' },
    );
  }

  const port = await stableDbPort();

  // Start the server bound to loopback TCP only (unix sockets disabled — avoids
  // the ~107-char socket-path limit under long userData paths and is moot on
  // Windows). PG locates its share/lib relative to the binary.
  log.info(`[db] starting embedded Postgres on 127.0.0.1:${port}…`);
  const proc = spawn(
    pgBin('postgres'),
    [
      '-D', dataDir,
      '-p', String(port),
      '-c', 'listen_addresses=127.0.0.1',
      '-c', 'unix_socket_directories=',
      '-c', 'fsync=on',
    ],
    { cwd: nativeDir, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stdout?.on('data', (d: Buffer) => log.info(`[postgres] ${d.toString().trimEnd()}`));
  proc.stderr?.on('data', (d: Buffer) => log.info(`[postgres] ${d.toString().trimEnd()}`));
  proc.on('exit', (code, signal) => {
    if (current && current.proc === proc) {
      if (!stopping) {
        log.warn(`[db] embedded Postgres exited unexpectedly code=${code} signal=${signal}`);
      }
      current = null;
    }
  });

  current = { proc, port };

  try {
    await waitForReady(port);
    await ensureDatabase(port);
  } catch (err) {
    // Deliberate cleanup of a server that failed to come ready — mark it so the
    // exit handler reports the original failure, not a spurious "exited
    // unexpectedly". (waitForReady already throws the actionable message.)
    stopping = true;
    await stopProc(proc);
    current = null;
    stopping = false;
    throw err;
  }

  log.info(`[db] embedded Postgres ready on 127.0.0.1:${port}`);
  return toHandle(port);
}

/** Poll until the server accepts a TCP connection and answers a query. */
async function waitForReady(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    if (!current || current.proc.exitCode !== null) {
      throw new Error('embedded Postgres exited before becoming ready');
    }
    const client = new Client({ host: '127.0.0.1', port, user: DB_USER, database: 'postgres', connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      await client.end().catch(() => {});
    }
    await delay(400);
  }
  throw new Error(`embedded Postgres did not become ready in ${timeoutMs}ms (${lastErr})`);
}

/** Ensure the `omadia` database exists (CREATE DATABASE has no IF NOT EXISTS). */
async function ensureDatabase(port: number): Promise<void> {
  const client = new Client({ host: '127.0.0.1', port, user: DB_USER, database: 'postgres' });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
    if (!rowCount) {
      await client.query(`CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}`);
      log.info(`[db] created database "${DB_NAME}"`);
    }
  } finally {
    await client.end();
  }
}

function toHandle(port: number): EmbeddedDb {
  return {
    databaseUrl: `postgresql://${DB_USER}@127.0.0.1:${port}/${DB_NAME}`,
    port,
    async stop() {
      if (current) {
        stopping = true;
        await stopProc(current.proc);
        current = null;
        stopping = false;
      }
    },
  };
}

/** Fast, clean Postgres shutdown: SIGINT → wait → SIGQUIT → SIGKILL. */
function stopProc(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(t1);
      clearTimeout(t2);
      resolve();
    };
    proc.once('exit', finish);
    log.info('[db] stopping embedded Postgres (fast shutdown)');
    proc.kill('SIGINT'); // fast shutdown
    const t1 = setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGQUIT'); // immediate shutdown
    }, 4_000);
    const t2 = setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
      finish();
    }, 8_000);
  });
}

export function isEmbeddedDbRunning(): boolean {
  return current !== null;
}

/**
 * STABLE loopback port, persisted across restarts. The kernel records its
 * `database_url` (port included) in its config store on first boot and that
 * persisted value wins on later boots — so the port must not drift.
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
  if (stored !== null && (await isPortFree(stored))) return stored;
  if (stored !== null) {
    log.warn(`[db] stored port ${stored} busy; picking a new one`);
  }
  const port = await findFreePort('127.0.0.1');
  fs.writeFileSync(file, String(port), 'utf8');
  return port;
}
