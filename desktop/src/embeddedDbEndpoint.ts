import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where the embedded Postgres listens, and how the shell tells that what
 * listens there is the server it started.
 *
 * macOS and Linux: a Unix-domain socket in a directory only the desktop user
 * can enter (0700, owned by that user), and no TCP listener at all. No other OS
 * user can connect to the server, and none can put a listener of their own
 * where the shell and the kernel connect.
 *
 * Windows: loopback TCP, the transport its Postgres build offers there. Another
 * local user could bind the port while the server is stopped (between port
 * selection and start, or during a single-user repair). The server then fails
 * to start, and the shell, which authenticates every connection with SCRAM
 * only (`scramOnlyConnect.ts`), never hands that listener a password.
 *
 * On both, "ready" is read from the server's own `postmaster.pid`: the process
 * the shell spawned, on the expected port and socket directory or address,
 * with status `ready`. That needs no credentials, so nothing is sent to an
 * endpoint before the shell knows its own server holds it.
 */

export interface DbEndpoint {
  readonly transport: 'socket' | 'tcp';
  /** The socket directory (an absolute path) or the loopback address. */
  readonly host: string;
  readonly port: number;
}

export const LOOPBACK_ADDRESS = '127.0.0.1';

/** The socket directory's name under the app data folder. */
export const SOCKET_DIR_NAME = 'pg-socket';

/**
 * The longest socket path Postgres accepts: `sockaddr_un.sun_path` (108 bytes
 * on Linux, 104 on macOS) minus its terminating NUL.
 */
export function maxSocketPathBytes(platform: NodeJS.Platform): number {
  return (platform === 'linux' ? 108 : 104) - 1;
}

/** Whether `<dir>/.s.PGSQL.<port>`, the path Postgres creates, fits. */
export function socketPathFits(dir: string, port: number, platform: NodeJS.Platform): boolean {
  return Buffer.byteLength(`${dir}/.s.PGSQL.${port}`) <= maxSocketPathBytes(platform);
}

/**
 * Make `dir` a directory only this OS user can enter, or throw: created 0700
 * when missing, tightened to 0700 when looser, refused when it is a symlink,
 * not a directory, or owned by another user.
 */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const found = fs.lstatSync(dir);
  if (found.isSymbolicLink() || !found.isDirectory()) {
    throw new Error(`[db] the socket directory ${dir} is not a plain directory`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && found.uid !== uid) {
    throw new Error(`[db] the socket directory ${dir} belongs to another user`);
  }
  if ((found.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  if ((fs.lstatSync(dir).mode & 0o077) !== 0) {
    throw new Error(`[db] the socket directory ${dir} cannot be made private`);
  }
}

export interface SocketDir {
  readonly dir: string;
  /** A per-start directory under the OS temp dir, removed when the server stops. */
  readonly temporary: boolean;
  /** Why the directory under the app data folder was not used; set when temporary. */
  readonly reason?: string;
}

/**
 * The private directory the server's socket goes in: `<appData>/pg-socket`
 * (never the chosen data folder, which may be cloud-synced). A fresh private
 * directory under the OS temp dir when that path is too long for a socket (a
 * long home directory) or cannot be made private (say, left behind owned by
 * another account).
 */
export function chooseSocketDir(
  appDataDir: string,
  port: number,
  platform: NodeJS.Platform = process.platform,
  tmpDir: string = os.tmpdir(),
): SocketDir {
  const preferred = path.join(appDataDir, SOCKET_DIR_NAME);
  let reason = `${preferred} is too long for a Unix socket`;
  if (socketPathFits(preferred, port, platform)) {
    try {
      ensurePrivateDir(preferred);
      return { dir: preferred, temporary: false };
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
  }
  const dir = fs.mkdtempSync(path.join(tmpDir, 'omadia-pg-'));
  try {
    ensurePrivateDir(dir);
    if (!socketPathFits(dir, port, platform)) {
      throw new Error(`[db] no socket path short enough for the embedded Postgres (tried ${dir})`);
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { dir, temporary: true, reason };
}

/** What `<pgdata>/postmaster.pid` says, as far as the shell reads it. */
export interface PostmasterState {
  readonly pid: number;
  readonly port: number;
  /** The first Unix socket directory; empty when there is none. */
  readonly socketDir: string;
  /** The first TCP listen address; empty when there is no TCP listener. */
  readonly listenAddress: string;
  /** `starting`, `ready`, `stopping` or `standby`; empty until written. */
  readonly status: string;
}

/**
 * Lines 1, 4, 5, 6 and 8 of postmaster.pid (PostgreSQL's `pidfile.h`), or null
 * while the file is missing or too short to name a process and a port.
 */
export function parsePostmasterPid(text: string | null): PostmasterState | null {
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  const pid = Number(lines[0]);
  const port = Number(lines[3]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(port) || port <= 0) return null;
  return {
    pid,
    port,
    socketDir: lines[4] ?? '',
    listenAddress: (lines[5] ?? '').trim(),
    status: (lines[7] ?? '').trim(),
  };
}

/** Whether two paths name the same directory, following symlinks where they exist. */
export function samePath(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  const canonical = (p: string): string => {
    let resolved: string;
    try {
      resolved = fs.realpathSync.native(p);
    } catch {
      resolved = path.resolve(p);
    }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return canonical(a) === canonical(b);
}

/**
 * Why `state` does not show process `pid` serving `endpoint` (and nothing
 * else), or null when it does.
 */
export function servingMismatch(state: PostmasterState | null, pid: number | undefined, endpoint: DbEndpoint): string | null {
  if (state === null) return 'postmaster.pid is missing or incomplete';
  if (pid === undefined || state.pid !== pid) {
    return `postmaster.pid names process ${state.pid}, not the server this shell started`;
  }
  if (state.port !== endpoint.port) return `postmaster.pid names port ${state.port}, not ${endpoint.port}`;
  if (endpoint.transport === 'socket') {
    if (state.listenAddress !== '') return `the server also listens on TCP (${state.listenAddress})`;
    if (!samePath(state.socketDir, endpoint.host)) return 'the server listens in another socket directory';
  } else if (state.listenAddress !== endpoint.host) {
    return `the server listens on ${state.listenAddress === '' ? 'no TCP address' : state.listenAddress}, not ${endpoint.host}`;
  }
  if (state.status !== 'ready') return `the server is ${state.status === '' ? 'starting' : state.status}`;
  return null;
}

/** For log lines: where the server listens. */
export function describeEndpoint(endpoint: DbEndpoint): string {
  return endpoint.transport === 'socket'
    ? `Unix socket ${endpoint.host}/.s.PGSQL.${endpoint.port}`
    : `${endpoint.host}:${endpoint.port}`;
}
