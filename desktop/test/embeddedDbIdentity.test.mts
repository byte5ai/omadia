/**
 * The embedded Postgres must prove it is the cluster the shell started before
 * the shell believes anything it says (`ensureClusterAuth`, driven through
 * the simulated cluster in `helpers/fakePgCluster.mts`).
 *
 * What this pins: readiness used to be "something on the port answered", and
 * an authentication error counted as an answer. A listener in the server's
 * place got the bootstrap password from the readiness probe and the kernel
 * password from the next step, and one that refused wrong passwords and
 * reported an unprivileged kernel role passed the verification, after which
 * the shell handed out a DSN pointing at it. Now the first connection after
 * every start is the bootstrap role's, over SCRAM only, and it must find this
 * cluster's data directory; a server that will not do SCRAM stops the start
 * rather than passing for one that refused a password; and the server must
 * still hold its endpoint before provisioning and before the verification.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { ensureClusterAuth, renderHba } from '../src/embeddedDbAuth.ts';
import { isScramRefusal } from '../src/scramOnlyConnect.ts';
import { FakeCluster, type FakeClusterOptions } from './helpers/fakePgCluster.mts';

/** Obviously synthetic 64-hex passwords, the shape `secrets.ts` generates. */
const CREDS = { superuserPassword: '1'.repeat(64), kernelPassword: '2'.repeat(64) } as const;
const OLD = { superuserPassword: '3'.repeat(64), kernelPassword: '4'.repeat(64) } as const;
const ELSEWHERE = '/synthetic/elsewhere/pgdata';

/** Shell rules and a bootstrap password, nothing provisioned yet. */
function freshCluster(extra: Partial<FakeClusterOptions> = {}): FakeCluster {
  return new FakeCluster({ hba: renderHba(), superuserPassword: CREDS.superuserPassword, ...extra });
}

/** A cluster as `ensureClusterAuth` leaves it. */
function provisionedCluster(extra: Partial<FakeClusterOptions> = {}): FakeCluster {
  return new FakeCluster({
    hba: renderHba(),
    superuserPassword: CREDS.superuserPassword,
    kernelRole: { password: CREDS.kernelPassword },
    databases: ['omadia'],
    ...extra,
  });
}

/** Provisioned with passwords the shell no longer has (a lost `secrets.enc`). */
function strangerCluster(extra: Partial<FakeClusterOptions> = {}): FakeCluster {
  return new FakeCluster({
    hba: renderHba(),
    superuserPassword: OLD.superuserPassword,
    kernelRole: { password: OLD.kernelPassword },
    databases: ['omadia'],
    ...extra,
  });
}

const kernelConnects = (cluster: FakeCluster): string[] =>
  cluster.calls.filter((call) => call.startsWith('connect(omadia_kernel@'));
/** Statements other than the identity check: provisioning, verification. */
const workStatements = (cluster: FakeCluster): string[] =>
  cluster.statements().filter((statement) => !statement.endsWith(': data directory?'));
const singleUserRuns = (cluster: FakeCluster): string[] =>
  cluster.calls.filter((call) => call.startsWith('singleUser: '));

function indexAfter(calls: readonly string[], from: number, match: (call: string) => boolean): number {
  const index = calls.findIndex((call, i) => i > from && match(call));
  assert.notEqual(index, -1, `no matching call after #${from}:\n${calls.join('\n')}`);
  return index;
}

describe('ensureClusterAuth — the server proves it is this cluster first', () => {
  it('logs in as the bootstrap role and reads the data directory before any kernel password goes out', async () => {
    const cluster = provisionedCluster();
    await ensureClusterAuth(cluster, CREDS);
    const calls = cluster.calls;
    const started = calls.indexOf('startServer(scram)');
    const identity = calls.indexOf('sql omadia@postgres: data directory?');
    const firstKernel = calls.findIndex((call) => call.startsWith('connect(omadia_kernel@'));
    assert.ok(started !== -1 && identity > started, calls.join('\n'));
    assert.equal(
      calls.slice(started + 1, identity).filter((call) => call.startsWith('connect(')).join(),
      'connect(omadia@postgres)',
      'the first connection after the start is the shell login',
    );
    assert.ok(identity < firstKernel, 'the kernel password is offered only to a server that proved itself');
  });

  it('refuses a server that reports another data directory, before any kernel password goes out', async () => {
    const cluster = provisionedCluster({ reportsDataDirectory: ELSEWHERE });
    await assert.rejects(ensureClusterAuth(cluster, CREDS), /not this cluster/);
    assert.deepEqual(kernelConnects(cluster), []);
    assert.deepEqual(workStatements(cluster), []);
  });

  it('after a password repair, the restarted server still has to prove it is this cluster', async () => {
    const cluster = strangerCluster({ reportsDataDirectory: ELSEWHERE });
    await assert.rejects(ensureClusterAuth(cluster, CREDS), /not this cluster/);
    assert.deepEqual(singleUserRuns(cluster), ['singleUser: password(omadia)'], 'the repair ran');
    assert.deepEqual(kernelConnects(cluster), []);
    assert.deepEqual(workStatements(cluster), []);
  });
});

describe('ensureClusterAuth — a server that will not do SCRAM', () => {
  it('is not taken for one that refused the password: no repair, no restart, no kernel login', async () => {
    const cluster = provisionedCluster({ refusesScramFor: ['omadia'] });
    await assert.rejects(ensureClusterAuth(cluster, CREDS), (err: unknown) => isScramRefusal(err));
    assert.ok(!cluster.calls.includes('stopServer'));
    assert.deepEqual(singleUserRuns(cluster), []);
    assert.deepEqual(kernelConnects(cluster), []);
  });

  it('on the kernel login, stops the start instead of provisioning', async () => {
    const cluster = provisionedCluster({ refusesScramFor: ['omadia_kernel'] });
    await assert.rejects(ensureClusterAuth(cluster, CREDS), (err: unknown) => isScramRefusal(err));
    assert.deepEqual(workStatements(cluster), [], 'nothing provisioned, no password set');
  });
});

describe('ensureClusterAuth — the server must still hold its endpoint', () => {
  it('is confirmed before provisioning and again before the verification', async () => {
    const cluster = freshCluster();
    await ensureClusterAuth(cluster, CREDS);
    const calls = cluster.calls;
    const kernelLoginFailed = calls.indexOf('connect(omadia_kernel@omadia)');
    const provisioning = calls.indexOf('sql omadia@postgres: role exists?');
    assert.ok(
      calls.slice(kernelLoginFailed, provisioning).includes('confirmServing'),
      `confirmed between the kernel login and provisioning:\n${calls.join('\n')}`,
    );
    const kernelPassword = calls.indexOf('sql omadia@omadia: password(omadia_kernel)');
    const nextConnect = indexAfter(calls, kernelPassword, (call) => call.startsWith('connect('));
    assert.ok(
      calls.slice(kernelPassword, nextConnect).includes('confirmServing'),
      `confirmed before the verification's first connection:\n${calls.join('\n')}`,
    );
  });

  it('a server that lost its endpoint is not provisioned', async () => {
    const cluster = freshCluster({ notServing: true });
    await assert.rejects(ensureClusterAuth(cluster, CREDS), /postmaster\.pid names another process/);
    assert.deepEqual(workStatements(cluster), []);
  });

  it('a server that lost its endpoint is not verified, so no DSN goes out', async () => {
    const cluster = provisionedCluster({ notServing: true });
    await assert.rejects(ensureClusterAuth(cluster, CREDS), /postmaster\.pid names another process/);
    assert.ok(
      !cluster.statements().some((statement) => statement.endsWith(': memberships?')),
      'the verification never ran',
    );
  });
});
