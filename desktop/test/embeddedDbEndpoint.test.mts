/**
 * Where the embedded Postgres listens and how the shell tells that its own
 * server holds that place (`embeddedDbEndpoint.ts`, `serverArgs` in
 * `embeddedDbEngine.ts`).
 *
 * What this pins: the server used to listen on a loopback TCP port that any
 * local user could bind while the server was stopped, and the shell took any
 * answer on that port for its server. On macOS and Linux the server now
 * listens only on a Unix socket in a directory no other OS user can enter, and
 * on every platform readiness comes from the server's own postmaster.pid,
 * naming the process the shell spawned, before any credential is sent.
 */
import { describe, it, after } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  chooseSocketDir,
  ensurePrivateDir,
  maxSocketPathBytes,
  parsePostmasterPid,
  servingMismatch,
  socketPathFits,
  SOCKET_DIR_NAME,
  type DbEndpoint,
  type PostmasterState,
} from '../src/embeddedDbEndpoint.ts';
import { serverArgs } from '../src/embeddedDbEngine.ts';

const posixOnly = process.platform === 'win32' ? 'POSIX permissions' : false;
const scratch: string[] = [];
after(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-endpoint-'));
  scratch.push(dir);
  return dir;
}

const modeOf = (dir: string): number => fs.statSync(dir).mode & 0o777;

describe('socket path length', () => {
  it('follows sun_path: 107 bytes on Linux, 103 on macOS', () => {
    assert.equal(maxSocketPathBytes('linux'), 107);
    assert.equal(maxSocketPathBytes('darwin'), 103);
  });

  it('counts the file Postgres creates, in bytes', () => {
    const dir = `/${'d'.repeat(103 - '/.s.PGSQL.54321'.length - 1)}`;
    assert.equal(socketPathFits(dir, 54_321, 'darwin'), true);
    assert.equal(socketPathFits(`${dir}x`, 54_321, 'darwin'), false);
    assert.equal(socketPathFits(`${dir.slice(0, -1)}é`, 54_321, 'darwin'), false, 'é is two bytes');
  });
});

describe('the private socket directory', { skip: posixOnly }, () => {
  it('goes under the app data folder, owner-only', () => {
    const appData = tempRoot();
    const chosen = chooseSocketDir(appData, 54_321, 'linux');
    assert.equal(chosen.dir, path.join(appData, SOCKET_DIR_NAME));
    assert.equal(chosen.temporary, false);
    assert.equal(modeOf(chosen.dir), 0o700);
  });

  it('tightens an existing directory that others could enter', () => {
    const appData = tempRoot();
    const dir = path.join(appData, SOCKET_DIR_NAME);
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    chooseSocketDir(appData, 54_321, 'linux');
    assert.equal(modeOf(dir), 0o700);
  });

  it('never adopts a symlink in its place: a fresh private temp directory instead', () => {
    const appData = tempRoot();
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-elsewhere-'));
    scratch.push(target);
    fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, path.join(appData, SOCKET_DIR_NAME));
    assert.throws(() => ensurePrivateDir(path.join(appData, SOCKET_DIR_NAME)), /not a plain directory/);

    const chosen = chooseSocketDir(appData, 54_321, 'linux', os.tmpdir());
    scratch.push(chosen.dir);
    assert.equal(chosen.temporary, true);
    assert.match(chosen.reason ?? '', /not a plain directory/);
    assert.notEqual(fs.realpathSync(chosen.dir), fs.realpathSync(target));
    assert.equal(modeOf(chosen.dir), 0o700);
    assert.equal(modeOf(target), 0o755, 'the symlink target was left alone');
  });

  it('falls back to a fresh private temp directory when the path would be too long', () => {
    const appData = path.join(tempRoot(), 'a'.repeat(120));
    const chosen = chooseSocketDir(appData, 54_321, 'darwin', os.tmpdir());
    scratch.push(chosen.dir);
    assert.equal(chosen.temporary, true);
    assert.match(chosen.reason ?? '', /too long/);
    assert.equal(path.dirname(chosen.dir), os.tmpdir());
    assert.equal(modeOf(chosen.dir), 0o700);
    assert.ok(socketPathFits(chosen.dir, 54_321, 'darwin'));
    assert.equal(fs.existsSync(path.join(appData, SOCKET_DIR_NAME)), false, 'nothing created at the long path');
  });
});

/** What PostgreSQL 17 writes into postmaster.pid, line by line (`pidfile.h`). */
function pidFile(lines: { pid: number; port: number; socketDir: string; listen: string; status?: string }): string {
  return [
    String(lines.pid),
    '/synthetic/pgdata',
    '1767225600',
    String(lines.port),
    lines.socketDir,
    lines.listen,
    '  1234567    196608',
    ...(lines.status === undefined ? [] : [lines.status]),
    '',
  ].join('\n');
}

const SOCKET: DbEndpoint = { transport: 'socket', host: '/synthetic/run/pg-socket', port: 54_321 };
const TCP: DbEndpoint = { transport: 'tcp', host: '127.0.0.1', port: 54_321 };

describe('postmaster.pid', () => {
  it('is read for the process, the port, the socket, the listen address and the status', () => {
    const state = parsePostmasterPid(
      pidFile({ pid: 4242, port: 54_321, socketDir: SOCKET.host, listen: '', status: 'ready   ' }),
    );
    assert.deepEqual(state, { pid: 4242, port: 54_321, socketDir: SOCKET.host, listenAddress: '', status: 'ready' });
  });

  it('is not yet a state while it is missing or names no process and port', () => {
    assert.equal(parsePostmasterPid(null), null);
    assert.equal(parsePostmasterPid(''), null);
    assert.equal(parsePostmasterPid('4242\n/synthetic/pgdata\n'), null);
    const starting = parsePostmasterPid(pidFile({ pid: 4242, port: 54_321, socketDir: '', listen: '' }));
    assert.equal(starting?.status, '');
  });
});

describe('servingMismatch: is it the process the shell started, where it should be?', () => {
  const ready = (overrides: Partial<PostmasterState>): PostmasterState => ({
    pid: 4242,
    port: 54_321,
    socketDir: SOCKET.host,
    listenAddress: '',
    status: 'ready',
    ...overrides,
  });

  it('accepts the spawned process, ready, on its socket and no TCP', () => {
    assert.equal(servingMismatch(ready({}), 4242, SOCKET), null);
  });

  it('accepts the spawned process, ready, on loopback TCP', () => {
    assert.equal(servingMismatch(ready({ socketDir: '', listenAddress: '127.0.0.1' }), 4242, TCP), null);
  });

  it('refuses everything else', () => {
    const cases: Array<[PostmasterState | null, number | undefined, DbEndpoint, RegExp]> = [
      [null, 4242, SOCKET, /missing/],
      [ready({}), 4343, SOCKET, /not the server this shell started/],
      [ready({}), undefined, SOCKET, /not the server this shell started/],
      [ready({ port: 5432 }), 4242, SOCKET, /port 5432/],
      [ready({ listenAddress: '127.0.0.1' }), 4242, SOCKET, /also listens on TCP/],
      [ready({ socketDir: '/synthetic/other' }), 4242, SOCKET, /another socket directory/],
      [ready({ socketDir: '', listenAddress: '' }), 4242, TCP, /no TCP address/],
      [ready({ status: 'starting' }), 4242, SOCKET, /is starting/],
      [ready({ status: '' }), 4242, SOCKET, /is starting/],
      [ready({ status: 'stopping' }), 4242, SOCKET, /is stopping/],
    ];
    for (const [state, pid, endpoint, expected] of cases) {
      assert.match(servingMismatch(state, pid, endpoint) ?? 'accepted', expected, JSON.stringify(state));
    }
  });
});

describe('the server command line', () => {
  const value = (args: string[], name: string): string | undefined =>
    args.filter((arg) => arg.startsWith(`${name}=`)).map((arg) => arg.slice(name.length + 1)).at(-1);

  it('on a socket: no TCP listener, the private directory, an owner-only socket', () => {
    const args = serverArgs('/synthetic/pgdata', { ...SOCKET, host: '/synthetic/Application Support,x/pg-"socket' });
    assert.equal(value(args, 'listen_addresses'), '');
    assert.equal(value(args, 'unix_socket_directories'), '"/synthetic/Application Support,x/pg-""socket"');
    assert.equal(value(args, 'unix_socket_permissions'), '0700');
    assert.equal(value(args, 'hba_file'), path.join('/synthetic/pgdata', 'pg_hba.conf'));
    assert.deepEqual(args.slice(0, 4), ['-D', '/synthetic/pgdata', '-p', '54321']);
  });

  it('on TCP: loopback only and no socket', () => {
    const args = serverArgs('/synthetic/pgdata', TCP);
    assert.equal(value(args, 'listen_addresses'), '127.0.0.1');
    assert.equal(value(args, 'unix_socket_directories'), '');
    assert.equal(value(args, 'hba_file'), path.join('/synthetic/pgdata', 'pg_hba.conf'));
  });
});
