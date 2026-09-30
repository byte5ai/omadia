/**
 * The embedded Postgres credential state machine (`embeddedDbAuth.ts`), driven
 * through a simulated cluster (`helpers/fakePgCluster.mts`).
 *
 * What this pins: the cluster used to be initialised with `-A trust`, so every
 * local process, of any OS user, reached the bootstrap superuser without a
 * password. Now pg_hba.conf asks for SCRAM passwords, the kernel gets a
 * restricted role, and the three states a cluster can be found in are each
 * brought there: fresh from initdb, left over from the trust era, and holding
 * passwords the shell no longer has. The orderings are the point: the server
 * never starts with rules the shell did not write, the bootstrap password is
 * set before pg_hba.conf stops trusting (otherwise the shell locks itself
 * out), a lost password is reset with the server stopped (single-user mode, no
 * listener), and the kernel's password is set last, so a half-finished run
 * cannot pass for a finished one.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import crypto from 'node:crypto';

import {
  DB_SUPERUSER,
  ensureClusterAuth,
  hbaMode,
  kernelDatabaseUrl,
  passwordStatement,
  renderHba,
  scramVerifier,
} from '../src/embeddedDbAuth.ts';
import { FakeCluster, type FakeClusterOptions } from './helpers/fakePgCluster.mts';

/** Obviously synthetic 64-hex passwords, the shape `secrets.ts` generates. */
const CREDS = { superuserPassword: '1'.repeat(64), kernelPassword: '2'.repeat(64) } as const;
const OLD = { superuserPassword: '3'.repeat(64), kernelPassword: '4'.repeat(64) } as const;

/** What initdb writes: a comment block that mentions "trust", then the rules. */
function initdbHba(method: string): string {
  return [
    '# METHOD can be "trust", "reject", "md5", "password", "scram-sha-256",',
    '# "gss", "sspi", "ident", "peer", "pam", "ldap", "radius" or "cert".',
    '# Note that "password" sends passwords in clear text; "md5" or',
    '# "scram-sha-256" are preferred since they send encrypted passwords.',
    '',
    '# TYPE  DATABASE        USER            ADDRESS                 METHOD',
    '',
    '# "local" is for Unix domain socket connections only',
    `local   all             all                                     ${method}`,
    '# IPv4 local connections:',
    `host    all             all             127.0.0.1/32            ${method}`,
    '# IPv6 local connections:',
    `host    all             all             ::1/128                 ${method}`,
    `local   replication     all                                     ${method}`,
    `host    replication     all             127.0.0.1/32            ${method}`,
    `host    replication     all             ::1/128                 ${method}`,
    '',
  ].join('\n');
}

function activeLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** A cluster exactly as initdb --auth=scram-sha-256 leaves it. */
function freshCluster(extra: Partial<FakeClusterOptions> = {}): FakeCluster {
  return new FakeCluster({ hba: initdbHba('scram-sha-256'), superuserPassword: CREDS.superuserPassword, ...extra });
}

/** A cluster from before SCRAM: initdb -A trust, a kernel that ran as superuser. */
function trustEraCluster(extra: Partial<FakeClusterOptions> = {}): FakeCluster {
  return new FakeCluster({ hba: initdbHba('trust'), superuserPassword: null, databases: ['omadia'], ...extra });
}

/** A provisioned cluster whose passwords the shell no longer has (lost or regenerated secrets.enc). */
function strangerCluster(extra: Partial<FakeClusterOptions> = {}): FakeCluster {
  return new FakeCluster({
    hba: renderHba(),
    superuserPassword: OLD.superuserPassword,
    kernelRole: { password: OLD.kernelPassword },
    databases: ['omadia'],
    ...extra,
  });
}

/** A cluster as this module leaves it. */
function provisionedCluster(extra: Partial<FakeClusterOptions> = {}): FakeCluster {
  return new FakeCluster({
    hba: renderHba(),
    superuserPassword: CREDS.superuserPassword,
    kernelRole: { password: CREDS.kernelPassword },
    databases: ['omadia'],
    ...extra,
  });
}

/** Index of the first call matching `pattern` at or after `from`, asserting it exists. */
function indexOf(calls: readonly string[], pattern: string | RegExp, from = 0): number {
  const index = calls.findIndex(
    (call, i) => i >= from && (typeof pattern === 'string' ? call === pattern : pattern.test(call)),
  );
  assert.notEqual(index, -1, `expected a call matching ${String(pattern)}; got\n${calls.join('\n')}`);
  return index;
}

function assertInOrder(calls: readonly string[], patterns: ReadonlyArray<string | RegExp>): void {
  let from = 0;
  for (const pattern of patterns) {
    from = indexOf(calls, pattern, from) + 1;
  }
}

/** The server never listens with rules the shell did not write. */
function assertEveryStartWithShellRules(cluster: FakeCluster): void {
  const starts = cluster.calls.filter((call) => call.startsWith('startServer('));
  assert.ok(starts.length > 0, 'the server was started');
  assert.deepEqual(
    starts.filter((call) => call !== 'startServer(scram)'),
    [],
    `every start uses the shell's password-only rules; got ${starts.join(', ')}`,
  );
}

const warnings = (cluster: FakeCluster): string[] => cluster.logs.filter((line) => line.startsWith('warn:'));
const hbaWrites = (cluster: FakeCluster): string[] => cluster.calls.filter((call) => call.startsWith('writeHba('));
const singleUserRuns = (cluster: FakeCluster): string[] =>
  cluster.calls.filter((call) => call.startsWith('singleUser: '));

describe('pg_hba.conf rendering', () => {
  it('has no trust rule and admits only the two roles, by password', () => {
    const lines = activeLines(renderHba());
    assert.ok(lines.length > 0);
    for (const line of lines) {
      const tokens = line.split(/\s+/);
      assert.ok(!tokens.includes('trust'), `no trust rule: ${line}`);
      assert.equal(tokens.at(-1), 'scram-sha-256', line);
      assert.ok(tokens.includes('omadia,omadia_kernel'), `only the shell's roles: ${line}`);
    }
    assert.ok(lines.some((line) => line.includes('127.0.0.1/32')));
    assert.ok(lines.some((line) => line.includes('::1/128')));
    assert.equal(hbaMode(renderHba()), 'scram');
  });

  it('is classified by its rules, not by the comments that mention trust', () => {
    assert.equal(hbaMode(initdbHba('scram-sha-256')), 'scram');
    assert.equal(hbaMode(initdbHba('trust')), 'trust');
    assert.equal(hbaMode(`${renderHba()}host all omadia 127.0.0.1/32 trust\n`), 'trust');
    assert.equal(hbaMode(initdbHba('md5')), 'unknown');
    assert.equal(hbaMode('# only a comment\n\n'), 'unknown');
    assert.equal(hbaMode('this is not a pg_hba.conf'), 'unknown');
    assert.equal(hbaMode(''), 'unknown');
    assert.equal(hbaMode(null), 'unknown');
  });
});

describe('kernelDatabaseUrl', () => {
  it('names the restricted role on 127.0.0.1 and URL-encodes the password', () => {
    const password = 'p@ss:/?#word';
    const url = new URL(kernelDatabaseUrl(54_321, password));
    assert.equal(url.protocol, 'postgresql:');
    assert.equal(url.username, 'omadia_kernel');
    assert.notEqual(url.username, DB_SUPERUSER);
    assert.equal(decodeURIComponent(url.password), password);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.port, '54321');
    assert.equal(url.pathname, '/omadia');
  });
});

describe('scramVerifier and passwordStatement', () => {
  it('derive the keys of the RFC 7677 example exchange', () => {
    // RFC 7677 §3: user "user", password "pencil", this salt, 4096 iterations.
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
    const verifier = scramVerifier('pencil', salt, 4096);
    const match = /^SCRAM-SHA-256\$4096:W22ZaJ0SNY7soEsUEjb6gQ==\$([^:]+):(.+)$/.exec(verifier);
    assert.ok(match, verifier);
    const storedKey = Buffer.from(match[1] ?? '', 'base64');
    const serverKey = Buffer.from(match[2] ?? '', 'base64');

    const nonce = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
    const authMessage =
      'n=user,r=rOprNGfwEbeRWgbNEkqO,' +
      `r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,` +
      `c=biws,r=${nonce}`;
    const hmac = (key: Buffer): Buffer => crypto.createHmac('sha256', key).update(authMessage).digest();
    // The server signature the RFC's server sends back...
    assert.equal(hmac(serverKey).toString('base64'), '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
    // ...and the client proof it accepts: SHA-256(proof XOR HMAC(StoredKey)) is StoredKey.
    const proof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
    const signature = hmac(storedKey);
    const clientKey = Buffer.from(proof.map((byte, i) => byte ^ (signature[i] ?? 0)));
    assert.deepEqual(crypto.createHash('sha256').update(clientKey).digest(), storedKey);
  });

  it('salt every verifier freshly and never carry the password', () => {
    const first = scramVerifier(CREDS.kernelPassword);
    const second = scramVerifier(CREDS.kernelPassword);
    assert.notEqual(first, second);
    const statement = passwordStatement('omadia_kernel', CREDS.kernelPassword);
    for (const text of [first, second, statement]) {
      assert.ok(!text.includes(CREDS.kernelPassword));
    }
    // Single-user mode reads one statement per line.
    assert.match(statement, /^ALTER ROLE omadia_kernel WITH PASSWORD 'SCRAM-SHA-256\$4096:[A-Za-z0-9+/=$:]+'$/);
  });
});

describe('ensureClusterAuth — a cluster fresh from initdb', () => {
  it('adopts the shell rules before the server starts, then creates the restricted role, its database and extensions', async () => {
    const cluster = freshCluster();
    await ensureClusterAuth(cluster, CREDS);

    assertInOrder(cluster.calls, ['writeHba(scram)', 'startServer(scram)']);
    assert.deepEqual(singleUserRuns(cluster), [], 'initdb already set the bootstrap password');
    const statements = cluster.statements();
    const createRole = statements.find((s) => s.startsWith('omadia@postgres: create role omadia_kernel'));
    assert.ok(createRole, statements.join('\n'));
    for (const attribute of ['LOGIN', 'NOSUPERUSER', 'NOCREATEDB', 'NOCREATEROLE', 'NOREPLICATION', 'NOBYPASSRLS']) {
      assert.ok(createRole.split(' ').includes(attribute), `${attribute} in ${createRole}`);
    }
    // PG15+ grants CREATE on `public` through the implicit pg_database_owner
    // membership, which a NOINHERIT role does not use.
    assert.ok(!createRole.includes('NOINHERIT'));
    assert.ok(statements.includes('omadia@postgres: create database omadia owner omadia_kernel'));
    // pgvector is not a trusted extension: only the superuser can create it,
    // and the kernel's own CREATE EXTENSION IF NOT EXISTS then finds it.
    assert.ok(statements.includes('omadia@omadia: extension vector'));
    assert.ok(statements.includes('omadia@omadia: extension pg_trgm'));
    assert.equal(cluster.hbaOnDisk, renderHba());
    assert.ok(cluster.accepts('omadia_kernel', CREDS.kernelPassword));
    assert.deepEqual(warnings(cluster), [], 'a fresh cluster is not a migration');
  });

  it('sets the kernel password last, after everything the kernel depends on', async () => {
    const cluster = freshCluster();
    await ensureClusterAuth(cluster, CREDS);
    assertInOrder(cluster.calls, [
      /create database omadia owner omadia_kernel$/,
      /: extension vector$/,
      /: transfer ownership$/,
      'sql omadia@omadia: password(omadia_kernel)',
    ]);
  });

  it('a failure half way leaves the kernel locked out, so the next start provisions again', async () => {
    const cluster = freshCluster({ failOn: /^CREATE DATABASE/ });
    await assert.rejects(ensureClusterAuth(cluster, CREDS), /synthetic failure/);
    assert.equal(cluster.accepts('omadia_kernel', CREDS.kernelPassword), false);

    await cluster.stopServer(); // what embeddedDb.ts does with a start that failed
    cluster.failOn = undefined;
    cluster.calls.length = 0;
    await ensureClusterAuth(cluster, CREDS);
    assert.ok(cluster.statements().includes('omadia@postgres: create database omadia owner omadia_kernel'));
    assert.ok(cluster.accepts('omadia_kernel', CREDS.kernelPassword));
  });
});

describe('ensureClusterAuth — a cluster from the trust era', () => {
  it('sets the bootstrap password in single-user mode, then the shell rules, before the server listens', async () => {
    const cluster = trustEraCluster();
    await ensureClusterAuth(cluster, CREDS);
    assertInOrder(cluster.calls, [
      'singleUser: password(omadia)',
      'writeHba(scram)',
      'startServer(scram)',
      /create role omadia_kernel/,
      'sql omadia@postgres: alter database omadia owner omadia_kernel',
      'sql omadia@omadia: transfer ownership',
      'sql omadia@omadia: password(omadia_kernel)',
      'connect(omadia_kernel@omadia)',
    ]);
    assertEveryStartWithShellRules(cluster);
    assert.ok(cluster.accepts('omadia', CREDS.superuserPassword));
    assert.equal(cluster.hbaOnDisk, renderHba());
    assert.ok(warnings(cluster).some((line) => /trust-authenticated/.test(line)), 'the migration is logged');
  });

  it('keeps the trust-era rules and never starts when the bootstrap password cannot be set', async () => {
    const cluster = trustEraCluster({ failOn: /^ALTER ROLE omadia WITH PASSWORD/ });
    await assert.rejects(ensureClusterAuth(cluster, CREDS), /synthetic failure: password\(omadia\)/);
    assert.deepEqual(hbaWrites(cluster), []);
    assert.ok(!cluster.calls.some((call) => call.startsWith('startServer(')), 'a trust cluster is never started');
  });
});

describe('ensureClusterAuth — passwords the cluster no longer accepts', () => {
  it('stops the server and sets the password in single-user mode, so nobody gets in without one meanwhile', async () => {
    const cluster = strangerCluster();
    await ensureClusterAuth(cluster, CREDS);
    assertInOrder(cluster.calls, [
      'startServer(scram)',
      'connect(omadia@postgres)',
      'stopServer',
      'singleUser: password(omadia)',
      'startServer(scram)',
      'connect(omadia@postgres)',
      'sql omadia@omadia: password(omadia_kernel)',
    ]);
    assert.deepEqual(hbaWrites(cluster), [], 'the rules were the shell\'s all along');
    assertEveryStartWithShellRules(cluster);
    assert.ok(warnings(cluster).some((line) => /single-user/.test(line)), 'the repair is logged at warn');
    assert.ok(cluster.accepts('omadia', CREDS.superuserPassword));
    assert.ok(cluster.accepts('omadia_kernel', CREDS.kernelPassword));
    assert.equal(cluster.accepts('omadia_kernel', OLD.kernelPassword), false);
  });

  it('reports a failing single-user run and leaves the server stopped', async () => {
    const cluster = strangerCluster({ failOn: /^ALTER ROLE omadia WITH PASSWORD/ });
    await assert.rejects(ensureClusterAuth(cluster, CREDS), /synthetic failure: password\(omadia\)/);
    assert.equal(cluster.running, false);
    assert.equal(cluster.calls.at(-1), 'singleUser: password(omadia)');
  });

  it('reports a server that does not come back', async () => {
    const cluster = strangerCluster({ failStart: 2 });
    await assert.rejects(ensureClusterAuth(cluster, CREDS), /did not come back/);
    assert.equal(cluster.running, false);
  });
});

describe('ensureClusterAuth — the verification fails closed', () => {
  it('refuses to finish while the running server accepts a wrong password', async () => {
    // A server that does not apply the shell's rules, whatever the file says.
    const cluster = freshCluster({ ignoresHba: true });
    await assert.rejects(ensureClusterAuth(cluster, CREDS), /wrong password/);
  });

  it('refuses a kernel role that reports superuser', async () => {
    const cluster = freshCluster({ kernelReports: { rolsuper: true } });
    await assert.rejects(ensureClusterAuth(cluster, CREDS), /superuser/);
  });
});

describe('ensureClusterAuth — steady state', () => {
  it("only verifies when the rules are the shell's and the kernel logs in", async () => {
    const cluster = provisionedCluster();
    await ensureClusterAuth(cluster, CREDS);
    assert.deepEqual(hbaWrites(cluster), []);
    assert.deepEqual(singleUserRuns(cluster), []);
    assert.deepEqual(cluster.calls.filter((call) => call.startsWith('startServer(')), ['startServer(scram)']);
    assert.deepEqual(
      cluster.statements().filter((s) => s.startsWith('omadia@')),
      [],
      'no superuser session on a normal start',
    );
    assert.deepEqual(warnings(cluster), []);
  });

  it('re-provisions a kernel role that is no longer restricted instead of handing it out', async () => {
    const cluster = provisionedCluster({ kernelReportsUntilAltered: { rolsuper: true } });
    await ensureClusterAuth(cluster, CREDS);
    assert.ok(
      cluster.statements().some((s) => s.startsWith('omadia@postgres: alter role omadia_kernel LOGIN NOSUPERUSER')),
      cluster.statements().join('\n'),
    );
  });

  it("replaces initdb's rules with the shell's without resetting passwords or warning", async () => {
    const cluster = new FakeCluster({
      hba: initdbHba('scram-sha-256'),
      superuserPassword: CREDS.superuserPassword,
      kernelRole: { password: CREDS.kernelPassword },
      databases: ['omadia'],
    });
    await ensureClusterAuth(cluster, CREDS);
    assertInOrder(cluster.calls, ['writeHba(scram)', 'startServer(scram)']);
    assert.deepEqual(singleUserRuns(cluster), []);
    assert.deepEqual(warnings(cluster), []);
  });

  it('treats rules it did not write like unverified ones: password first, then its own rules', async () => {
    for (const hba of [initdbHba('md5'), null]) {
      const cluster = new FakeCluster({ hba, superuserPassword: CREDS.superuserPassword, databases: ['omadia'] });
      await ensureClusterAuth(cluster, CREDS);
      assertInOrder(cluster.calls, ['singleUser: password(omadia)', 'writeHba(scram)', 'startServer(scram)']);
    }
  });
});

describe('ensureClusterAuth — extensions', () => {
  it('continues without an extension the engine does not ship, and says so', async () => {
    const cluster = freshCluster({ extensions: ['pg_trgm'] });
    await ensureClusterAuth(cluster, CREDS);
    assert.ok(warnings(cluster).some((line) => line.includes('"vector"')));
    assert.ok(cluster.accepts('omadia_kernel', CREDS.kernelPassword));
  });

  it('any other extension failure stops the start', async () => {
    const cluster = freshCluster({ failOn: /^CREATE EXTENSION IF NOT EXISTS vector/ });
    await assert.rejects(ensureClusterAuth(cluster, CREDS), /synthetic failure: extension vector/);
    assert.equal(cluster.accepts('omadia_kernel', CREDS.kernelPassword), false);
  });
});
