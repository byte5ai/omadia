import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { embeddedDbDir, dataRoot, dbSocketParentDir } from './paths';
import { findFreePort, isPortFree } from './ports';
import { log } from './log';
import { embeddedDbCredentials } from './secrets';
import {
  ensureClusterAuth,
  kernelDatabaseUrl,
  type AuthClient,
  type ConnectOptions,
  type DbAuthIo,
} from './embeddedDbAuth';
import {
  chooseSocketDir,
  describeEndpoint,
  LOOPBACK_ADDRESS,
  parsePostmasterPid,
  samePath,
  servingMismatch,
  type DbEndpoint,
  type PostmasterState,
  type SocketDir,
} from './embeddedDbEndpoint';
import { initCluster, pgBin, pgNativeDir, runSingleUser, serverArgs, writeFileAtomic } from './embeddedDbEngine';
import { connectScramOnly } from './scramOnlyConnect';

/**
 * The embedded database engine: a REAL, bundled PostgreSQL 17 + pgvector.
 *
 * We previously embedded PGlite (Postgres compiled to WASM) over the wire
 * protocol via pglite-socket. That worked for builds/boot but the WASM engine
 * crashed (`RuntimeError: unreachable`) under the kernel's real query load, and
 * pglite-socket is single-connection. A native Postgres removes both problems:
 * full SQL compatibility (no WASM traps) and real connection pooling. The
 * binaries and the steps that run without a server live in
 * `embeddedDbEngine.ts`.
 *
 * On macOS and Linux the server listens only on a Unix socket in a directory
 * no other OS user can enter; on Windows on loopback TCP
 * (`embeddedDbEndpoint.ts`). Every connection needs a SCRAM password
 * (`embeddedDbAuth.ts`): the bootstrap superuser `omadia` is the shell's
 * alone, and the kernel connects as the restricted `omadia_kernel`. Both
 * passwords live in `secrets.enc`. The shell's own connections accept SCRAM
 * and nothing else (`scramOnlyConnect.ts`), and the shell treats the server as
 * ready only once its postmaster.pid names the process the shell started.
 */

/**
 * The search_path every maintenance connection the shell opens runs with. It
 * is sent as a startup option, which outranks any `ALTER DATABASE ... SET
 * search_path` or `ALTER ROLE ... SET search_path` a role that owns the kernel
 * database may have set. So the shell's own statements — and any function they
 * call unqualified — resolve against `pg_catalog`, never a schema the kernel
 * controls, even while the shell is connected as the superuser to the
 * kernel-owned database (provisioning, the ownership transfer, extensions).
 * `pg_temp` is named last so nothing in it is searched before `pg_catalog`.
 */
const SHELL_SEARCH_PATH_OPTION = '-c search_path=pg_catalog,pg_temp';

/** How long a start may take until postmaster.pid reports the server ready. */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 150;

export interface EmbeddedDb {
  /** DATABASE_URL the kernel should use to reach this engine. */
  databaseUrl: string;
  /** The server's port; on macOS/Linux it only names the socket file. */
  port: number;
  /**
   * Stop the Postgres server. Resolves true only when the process is confirmed
   * gone; false means the shutdown deadline expired and it may still be
   * holding files (see #927).
   */
  stop(): Promise<boolean>;
}

let current: { proc: ChildProcess; endpoint: DbEndpoint } | null = null;
// Set while we are deliberately shutting the server down, so the `exit` handler
// (registered at spawn) does not misreport an intentional stop as a crash.
let stopping = false;
/** The socket directory of the current start; a temporary one goes with the server. */
let socketDir: SocketDir | null = null;

async function startRealEmbeddedDb(): Promise<EmbeddedDb> {
  if (current) return toHandle(current.endpoint, embeddedDbCredentials().kernelPassword);

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

  const endpoint = await dbEndpoint();

  try {
    // Puts pg_hba.conf and the bootstrap password in order with the server
    // stopped, then starts it through the IO port, then verifies.
    await ensureClusterAuth(realDbAuthIo(dataDir, endpoint), creds);
    // The DSN goes out only while the server this shell started still holds
    // the endpoint it was verified on.
    confirmServing(dataDir);
  } catch (err) {
    // Deliberate cleanup of a server that failed to come ready or failed the
    // verification — mark it so the exit handler reports the original failure,
    // not a spurious "exited unexpectedly". No server keeps running on rules
    // nobody checked.
    stopping = true;
    let gone = true;
    try {
      const proc = runningProc();
      if (proc !== null) gone = await stopProc(proc);
    } finally {
      current = null;
      stopping = false;
      if (gone) releaseSocketDir();
    }
    throw err;
  }

  log.info(`[db] embedded Postgres ready (${describeEndpoint(endpoint)})`);
  return toHandle(endpoint, creds.kernelPassword);
}

/**
 * The server process `ensureClusterAuth` may have started or replaced. A
 * function, not a read of `current` inline: TypeScript would keep the
 * narrowing from the early return above across that call.
 */
function runningProc(): ChildProcess | null {
  return current?.proc ?? null;
}

/**
 * Where this start's server listens: a private socket directory on macOS and
 * Linux, loopback TCP on Windows. The port is stable either way; on a socket
 * it only names the socket file.
 */
async function dbEndpoint(): Promise<DbEndpoint> {
  // A temporary directory left by a server that is gone (a crash) is not reused.
  releaseSocketDir();
  const port = await stableDbPort();
  if (process.platform === 'win32') return { transport: 'tcp', host: LOOPBACK_ADDRESS, port };
  const chosen = chooseSocketDir(dbSocketParentDir(), port);
  if (chosen.temporary) {
    log.info(`[db] using a private temporary socket directory (${chosen.reason ?? 'no reason given'})`);
  }
  socketDir = chosen;
  return { transport: 'socket', host: chosen.dir, port };
}

function releaseSocketDir(): void {
  const dir = socketDir;
  socketDir = null;
  if (dir?.temporary) fs.rmSync(dir.dir, { recursive: true, force: true });
}

function spawnServer(dataDir: string, endpoint: DbEndpoint): ChildProcess {
  // PG locates its share/lib relative to the binary.
  const proc = spawn(pgBin('postgres'), serverArgs(dataDir, endpoint), {
    cwd: pgNativeDir(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (d: Buffer) => log.info(`[postgres] ${d.toString().trimEnd()}`));
  proc.stderr?.on('data', (d: Buffer) => log.info(`[postgres] ${d.toString().trimEnd()}`));
  proc.on('error', (err) => {
    log.warn(`[db] could not run the embedded Postgres: ${err.message}`);
    if (current && current.proc === proc) current = null;
  });
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

function isAlive(proc: ChildProcess): boolean {
  return proc.exitCode === null && proc.signalCode === null;
}

function readPostmasterState(dataDir: string): PostmasterState | null {
  try {
    return parsePostmasterPid(fs.readFileSync(path.join(dataDir, 'postmaster.pid'), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Why the server this shell started does not (or no longer) serve its endpoint, or null. */
function servingProblem(dataDir: string): string | null {
  const running = current;
  if (running === null || !isAlive(running.proc)) return 'the embedded Postgres this shell started is not running';
  return servingMismatch(readPostmasterState(dataDir), running.proc.pid, running.endpoint);
}

/**
 * Poll the server's own postmaster.pid until it shows the process just started
 * serving its endpoint. No connection, so no credential goes to whatever might
 * answer there; an authenticated round-trip follows in `ensureClusterAuth`.
 */
async function waitUntilServing(dataDir: string, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'postmaster.pid not written yet';
  while (Date.now() < deadline) {
    const running = current;
    if (running === null || !isAlive(running.proc)) {
      throw new Error('embedded Postgres exited before becoming ready');
    }
    const problem = servingProblem(dataDir);
    if (problem === null) return;
    last = problem;
    await delay(READY_POLL_MS);
  }
  throw new Error(`embedded Postgres did not become ready in ${timeoutMs}ms (${last})`);
}

function confirmServing(dataDir: string): void {
  const problem = servingProblem(dataDir);
  if (problem !== null) throw new Error(`[db] the embedded Postgres no longer serves its endpoint: ${problem}`);
}

async function startServer(dataDir: string, endpoint: DbEndpoint): Promise<void> {
  if (current !== null) throw new Error('embedded Postgres is already running');
  log.info(`[db] starting embedded Postgres (${describeEndpoint(endpoint)})…`);
  current = { proc: spawnServer(dataDir, endpoint), endpoint };
  await waitUntilServing(dataDir);
}

async function stopServer(): Promise<void> {
  const running = current;
  if (running === null) return;
  stopping = true;
  let exited: boolean;
  try {
    exited = await stopProc(running.proc);
  } finally {
    stopping = false;
  }
  if (!exited) throw new Error('embedded Postgres did not stop');
}

/** The cluster behind `embeddedDbAuth.ts`'s port. */
function realDbAuthIo(dataDir: string, endpoint: DbEndpoint): DbAuthIo {
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
    writeHba: async (text) => {
      if (current !== null) throw new Error('pg_hba.conf is only rewritten while the embedded Postgres is stopped');
      writeFileAtomic(hbaFile, text);
    },
    runSingleUser: async (statement) => {
      if (current !== null) throw new Error('single-user mode needs the embedded Postgres stopped');
      runSingleUser(dataDir, statement);
    },
    startServer: () => startServer(dataDir, endpoint),
    stopServer: () => stopServer(),
    confirmServing: async () => confirmServing(dataDir),
    isClusterDirectory: (reported) => samePath(reported, dataDir),
    connect: (options) => connectShellClient(endpoint, options),
    info: (message) => log.info(message),
    warn: (message) => log.warn(message),
  };
}

/**
 * A shell connection to the embedded Postgres: SCRAM-SHA-256 only, so no
 * password reaches whatever answers the endpoint and a server that cannot
 * prove it holds the verifier is refused, and the search_path pinned (see
 * SHELL_SEARCH_PATH_OPTION). Exported for tests.
 */
export async function connectShellClient(endpoint: DbEndpoint, options: ConnectOptions): Promise<AuthClient> {
  const client = await connectScramOnly({
    host: endpoint.host,
    port: endpoint.port,
    user: options.user,
    password: options.password,
    database: options.database,
    options: SHELL_SEARCH_PATH_OPTION,
    connectionTimeoutMillis: 5_000,
  });
  // A connection the server drops later (a stop) must not surface as an
  // unhandled 'error' event.
  client.on('error', (err) => log.warn(`[db] connection as ${options.user} dropped: ${err.message}`));
  return {
    query: async (sql, params) => ({ rows: (await client.query(sql, params ? [...params] : undefined)).rows }),
    end: () => client.end(),
  };
}

function toHandle(endpoint: DbEndpoint, kernelPassword: string): EmbeddedDb {
  return {
    // The restricted kernel role. The bootstrap superuser's password never
    // leaves this process.
    databaseUrl: kernelDatabaseUrl(endpoint, kernelPassword),
    port: endpoint.port,
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
  if (!current) {
    releaseSocketDir();
    return true;
  }
  stopping = true;
  let gone = false;
  try {
    gone = await stopProc(current.proc);
    return gone;
  } finally {
    current = null;
    stopping = false;
    if (gone) releaseSocketDir();
  }
}

function isRealEmbeddedDbRunning(): boolean {
  return current !== null;
}

/**
 * STABLE port, persisted across restarts. The kernel records its
 * `database_url` (port included) in its config store on first boot; on the
 * desktop the live DATABASE_URL wins over that copy, but a stable port keeps
 * the two from drifting apart needlessly.
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
  const port = await findFreePort(LOOPBACK_ADDRESS);
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
