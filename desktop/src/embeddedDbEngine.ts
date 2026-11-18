import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimeIsDev } from './paths';
import { log } from './log';
import { DB_SUPERUSER } from './embeddedDbAuth';
import type { DbEndpoint } from './embeddedDbEndpoint';

/**
 * The bundled PostgreSQL binaries and what the shell runs with them: the
 * server's command line, and the steps that need no running server (initdb,
 * single-user mode, pg_hba.conf writes).
 *
 * The binaries (initdb/postgres) + pgvector ship with the app (dev: the
 * @embedded-postgres platform package in node_modules; packaged: staged to
 * `resourcesPath/omadia-pg` as extraResources, so they're executable on disk,
 * never trapped inside the asar archive). They are driven directly rather than
 * through the embedded-postgres wrapper, which is asar-unaware.
 */

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name);

/** @embedded-postgres package name for this platform (win32 → windows). */
function pgPlatform(): string {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  return `${platform}-${process.arch}`;
}

/** The staged Postgres "native" dir (contains bin/, lib/, share/). */
export function pgNativeDir(): string {
  if (runtimeIsDev) {
    return path.join(__dirname, '..', 'node_modules', '@embedded-postgres', pgPlatform(), 'native');
  }
  return path.join(process.resourcesPath, 'omadia-pg');
}

export function pgBin(name: string): string {
  return path.join(pgNativeDir(), 'bin', exe(name));
}

/** A directory for `unix_socket_directories`: double-quoted, so a comma or space in the path stays part of it. */
function quotedDirectory(dir: string): string {
  return `"${dir.replaceAll('"', '""')}"`;
}

/**
 * The server's command line. On a socket endpoint it opens no TCP port at all
 * and its socket file is owner-only on top of the private directory; on a TCP
 * endpoint it listens on loopback and opens no socket. `hba_file` is pinned
 * here, which nothing in postgresql.conf or postgresql.auto.conf can override,
 * so the rules in force are always the ones the shell writes.
 */
export function serverArgs(dataDir: string, endpoint: DbEndpoint): string[] {
  const listen =
    endpoint.transport === 'socket'
      ? [
          '-c', 'listen_addresses=',
          '-c', `unix_socket_directories=${quotedDirectory(endpoint.host)}`,
          '-c', 'unix_socket_permissions=0700',
        ]
      : ['-c', `listen_addresses=${endpoint.host}`, '-c', 'unix_socket_directories='];
  return [
    '-D', dataDir,
    '-p', String(endpoint.port),
    ...listen,
    '-c', `hba_file=${path.join(dataDir, 'pg_hba.conf')}`,
    '-c', 'fsync=on',
  ];
}

/**
 * First run: a cluster that asks for a SCRAM password from its first second,
 * with the bootstrap superuser's password already set. Locale C avoids the
 * "no suitable text search config for UTF-8 locale" initdb warning.
 */
export function initCluster(dataDir: string, superuserPassword: string): void {
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
      ['-D', dataDir, '-U', DB_SUPERUSER, '--auth=scram-sha-256', `--pwfile=${pwFile}`, '-E', 'UTF8', '--locale=C'],
      { stdio: 'pipe' },
    );
  } finally {
    fs.rmSync(pwDir, { recursive: true, force: true });
  }
}

/** Single-user mode must finish well within a boot; it normally takes well under a second. */
const SINGLE_USER_TIMEOUT_MS = 120_000;

/**
 * One statement in single-user mode (`postgres --single`), which opens no
 * listener, reads no pg_hba.conf and runs as the bootstrap superuser. The
 * caller makes sure the server is stopped; with `exit_on_error` a failing
 * statement exits non-zero.
 */
export function runSingleUser(dataDir: string, statement: string): void {
  try {
    execFileSync(
      pgBin('postgres'),
      ['--single', '-D', dataDir, '-c', 'exit_on_error=on', 'postgres'],
      { cwd: pgNativeDir(), input: `${statement}\n`, stdio: 'pipe', timeout: SINGLE_USER_TIMEOUT_MS },
    );
  } catch (err) {
    // Only the server's own verdict: the statement (a SCRAM verifier) and the
    // rest of its output stay out of the message.
    const stderr = String((err as { stderr?: unknown }).stderr ?? '');
    const verdict = stderr.split('\n').filter((line) => /\b(FATAL|ERROR|PANIC):/.test(line)).join(' | ');
    const status = (err as { status?: unknown }).status;
    const fallback = err instanceof Error ? err.message : String(err);
    throw new Error(`[db] single-user mode failed (exit ${String(status)}): ${verdict || fallback}`);
  }
}

/**
 * Temp file, flushed, renamed over the target: a crash leaves the old rules or
 * the new ones, never a torn pg_hba.conf the server refuses to start with.
 */
export function writeFileAtomic(file: string, text: string): void {
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
