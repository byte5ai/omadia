import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import { Client } from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { embeddedDbDir, dataRoot, runtimeIsDev } from './paths';
import { findFreePort, isPortFree } from './ports';
import { log } from './log';
import { embeddedDbCredentials } from './secrets';
import {
  DB_SUPERUSER,
  ensureClusterAuth,
  isAuthFailure,
  kernelDatabaseUrl,
  type AuthClient,
  type ConnectOptions,
  type DbAuthIo,
} from './embeddedDbAuth';

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
 * The server listens on loopback TCP only, and every connection needs a SCRAM
 * password (`embeddedDbAuth.ts`): the bootstrap superuser `omadia` is the
 * shell's alone, and the kernel connects as the restricted `omadia_kernel`.
 * Both passwords live in `secrets.enc`. No GRAPH_POOL_MAX=1 cap needed — real
 * Postgres pools normally.
 */

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name);

export interface EmbeddedDb {
  /** DATABASE_URL the kernel should use to reach this engine. */
  databaseUrl: string;
  /** The bound loopback port. */
  port: number;
  /**
   * Stop the Postgres server. Resolves true only when the process is confirmed
   * gone; false means the shutdown deadline expired and it may still be
   * holding files (see #927).
   */
  stop(): Promise<boolean>;
}

let current: { proc: ChildProcess; port: number } | null = null;
// Set while we are deliberately shutting the server down, so the `exit` handler
// (registered at spawn) does not misreport an intentional stop as a crash.
let stopping = false;

/** @embedded-postgres package name for this platform (win32 → windows). */
function pgPlatform(): string {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  return `${platform}-${process.arch}`;
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

async function startRealEmbeddedDb(): Promise<EmbeddedDb> {
  if (current) return toHandle(current.port, embeddedDbCredentials().kernelPassword);

  const dataDir = embeddedDbDir();
  if (!fs.existsSync(pgBin('postgres'))) {
    throw new Error(
      `Embedded Postgres binary not found at ${pgBin('postgres')} — the installer ` +
        'bundle is incomplete (Postgres engine not staged).',
    );
  }

  // The passwords are in secrets.enc, written and read back, before a cluster
  // is created or its authentication touched: a password that existed only in
  // the cluster would lock the shell out of it. An unreadable secrets file
  // stops the start here, before initdb, and reaches the restore dialog as is.
  const creds = embeddedDbCredentials();

  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    initCluster(dataDir, creds.superuserPassword);
  }

  const port = await stableDbPort();
  log.info(`[db] starting embedded Postgres on 127.0.0.1:${port}…`);
  current = { proc: spawnServer(dataDir, port), port };

  try {
    await waitForReady(port, creds.superuserPassword);
    await ensureClusterAuth(realDbAuthIo(dataDir, port, creds.superuserPassword), creds);
  } catch (err) {
    // Deliberate cleanup of a server that failed to come ready — mark it so the
    // exit handler reports the original failure, not a spurious "exited
    // unexpectedly". This also ends any trust window a failed credential repair
    // could not close itself: no server keeps running on rules nobody checked.
    stopping = true;
    try {
      if (current) await stopProc(current.proc);
    } finally {
      current = null;
      stopping = false;
    }
    throw err;
  }

  log.info(`[db] embedded Postgres ready on 127.0.0.1:${port}`);
  return toHandle(port, creds.kernelPassword);
}

/**
 * First run: a cluster that asks for a SCRAM password from its first second,
 * with the bootstrap superuser's password already set. Locale C avoids the
 * "no suitable text search config for UTF-8 locale" initdb warning.
 */
function initCluster(dataDir: string, superuserPassword: string): void {
  log.info('[db] initialising embedded Postgres cluster (SCRAM authentication)…');
  // initdb reads the password from a file, since argv would show it in `ps`.
  // A fresh private temp dir, never the data folder (which may be
  // cloud-synced), and gone again whatever initdb does.
  const pwDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-initdb-'));
  try {
    const pwFile = path.join(pwDir, 'pwfile');
    fs.writeFileSync(pwFile, `${superuserPassword}\n`, { mode: 0o600, flag: 'wx' });
    execFileSync(
      pgBin('initdb'),
      [
        '-D', dataDir,
        '-U', DB_SUPERUSER,
        '--auth=scram-sha-256',
        `--pwfile=${pwFile}`,
        '-E', 'UTF8',
        '--locale=C',
      ],
      { stdio: 'pipe' },
    );
  } finally {
    fs.rmSync(pwDir, { recursive: true, force: true });
  }
}

/**
 * Start the server bound to loopback TCP only (unix sockets disabled — avoids
 * the ~107-char socket-path limit under long userData paths and is moot on
 * Windows). `hba_file` is pinned on the command line, which nothing in
 * postgresql.conf or postgresql.auto.conf can override, so the rules in force
 * are always the ones the shell writes. PG locates its share/lib relative to
 * the binary.
 */
function spawnServer(dataDir: string, port: number): ChildProcess {
  const proc = spawn(
    pgBin('postgres'),
    [
      '-D', dataDir,
      '-p', String(port),
      '-c', 'listen_addresses=127.0.0.1',
      '-c', 'unix_socket_directories=',
      '-c', `hba_file=${path.join(dataDir, 'pg_hba.conf')}`,
      '-c', 'fsync=on',
    ],
    { cwd: pgNativeDir(), stdio: ['ignore', 'pipe', 'pipe'] },
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
  return proc;
}

/**
 * Poll until the server answers. An authentication verdict is an answer: the
 * server is up, and whether the stored password still fits is
 * `ensureClusterAuth`'s question (it repairs what does not).
 */
async function waitForReady(port: number, superuserPassword: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    if (!current || current.proc.exitCode !== null) {
      throw new Error('embedded Postgres exited before becoming ready');
    }
    const client = new Client({
      host: '127.0.0.1',
      port,
      user: DB_SUPERUSER,
      password: superuserPassword,
      database: 'postgres',
      connectionTimeoutMillis: 3000,
    });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (err) {
      await client.end().catch(() => {});
      if (isAuthFailure(err)) return;
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await delay(400);
  }
  throw new Error(`embedded Postgres did not become ready in ${timeoutMs}ms (${lastErr})`);
}

/**
 * Stop the server and start it again on the same port, so it reads
 * pg_hba.conf afresh. The credential repair needs this: while the shell cannot
 * log in, nothing can ask the server for a reload.
 */
async function restartServer(dataDir: string, port: number, superuserPassword: string): Promise<void> {
  const running = current;
  if (running === null) throw new Error('embedded Postgres is not running');
  stopping = true;
  let exited: boolean;
  try {
    exited = await stopProc(running.proc);
  } finally {
    stopping = false;
  }
  if (!exited) throw new Error('embedded Postgres did not stop for the restart');
  log.info(`[db] restarting embedded Postgres on 127.0.0.1:${port}…`);
  current = { proc: spawnServer(dataDir, port), port };
  await waitForReady(port, superuserPassword);
}

/** The running cluster behind `embeddedDbAuth.ts`'s port. */
function realDbAuthIo(dataDir: string, port: number, superuserPassword: string): DbAuthIo {
  const hbaFile = path.join(dataDir, 'pg_hba.conf');
  return {
    readHba: () => {
      try {
        return fs.readFileSync(hbaFile, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    writeHba: async (text) => writeFileAtomic(hbaFile, text),
    connect: (options) => connectClient(port, options),
    restartServer: () => restartServer(dataDir, port, superuserPassword),
    sleep: (ms) => delay(ms),
    info: (message) => log.info(message),
    warn: (message) => log.warn(message),
  };
}

async function connectClient(port: number, options: ConnectOptions): Promise<AuthClient> {
  const client = new Client({
    host: '127.0.0.1',
    port,
    user: options.user,
    password: options.password,
    database: options.database,
    connectionTimeoutMillis: 5_000,
  });
  // A connection the server drops later (a restart) must not surface as an
  // unhandled 'error' event.
  client.on('error', (err) => log.warn(`[db] connection as ${options.user} dropped: ${err.message}`));
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }
  return {
    query: async (sql, params) => ({ rows: (await client.query(sql, params ? [...params] : undefined)).rows }),
    escapeLiteral: (value) => client.escapeLiteral(value),
    end: () => client.end(),
  };
}

/**
 * Temp file, flushed, renamed over the target: a crash leaves the old rules or
 * the new ones, never a torn pg_hba.conf the server refuses to start with.
 */
function writeFileAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function toHandle(port: number, kernelPassword: string): EmbeddedDb {
  return {
    // The restricted kernel role. The bootstrap superuser's password never
    // leaves this process.
    databaseUrl: kernelDatabaseUrl(port, kernelPassword),
    port,
    async stop() {
      return stopEmbeddedDb();
    },
  };
}

/**
 * Fast, clean Postgres shutdown: SIGINT → wait → SIGQUIT → SIGKILL.
 *
 * Resolves true when the process is confirmed gone, false when the 8s deadline
 * expired first. The deadline itself is deliberate (a quit must not hang), but
 * an expired one used to be indistinguishable from a real exit, and a Postgres
 * still running out of the app bundle is exactly what blocks the macOS
 * installer (#926/#927).
 */
function stopProc(proc: ChildProcess): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(t1);
      clearTimeout(t2);
      resolve(exited);
    };
    proc.once('exit', () => finish(true));
    log.info('[db] stopping embedded Postgres (fast shutdown)');
    proc.kill('SIGINT'); // fast shutdown
    const t1 = setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGQUIT'); // immediate shutdown
    }, 4_000);
    const t2 = setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
      log.warn('[db] embedded Postgres did not exit within 8s of SIGINT');
      finish(false);
    }, 8_000);
  });
}

/**
 * Stop whatever embedded Postgres this process started, whether or not anyone
 * still holds its handle.
 *
 * A `start()` interrupted between `startEmbeddedDb()` and the assignment of the
 * supervisor's `db` field leaves a running server nobody owns; the old
 * `if (this.db)` check in Supervisor.stop() then skipped it and Postgres
 * survived the app quit (#927). Reaping from module state closes that window.
 */
async function stopRealEmbeddedDb(): Promise<boolean> {
  if (!current) return true;
  stopping = true;
  try {
    return await stopProc(current.proc);
  } finally {
    current = null;
    stopping = false;
  }
}

function isRealEmbeddedDbRunning(): boolean {
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

/**
 * Test seam for the database lifecycle (#932).
 *
 * Same pattern as `cliInstallService.__setCliInstallRunner`. The supervisor's
 * generation races cannot be exercised against a real Postgres, and the defect
 * they guard against is specifically about *when* this module registers its
 * server relative to a concurrent stop() -- so a test has to own that timing.
 */
export interface EmbeddedDbHooks {
  start: () => Promise<EmbeddedDb>;
  stop: () => Promise<boolean>;
  isRunning: () => boolean;
}

let hooks: EmbeddedDbHooks | null = null;

export function __setEmbeddedDbHooks(next: EmbeddedDbHooks | null): void {
  hooks = next;
}

export function startEmbeddedDb(): Promise<EmbeddedDb> {
  return hooks === null ? startRealEmbeddedDb() : hooks.start();
}

export function stopEmbeddedDb(): Promise<boolean> {
  return hooks === null ? stopRealEmbeddedDb() : hooks.stop();
}

export function isEmbeddedDbRunning(): boolean {
  return hooks === null ? isRealEmbeddedDbRunning() : hooks.isRunning();
}
