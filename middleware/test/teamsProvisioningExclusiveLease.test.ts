/**
 * A teardown and a provisioning run must never overlap.
 *
 * WHY THIS NEEDS ITS OWN LOCK AND NOT JUST AN `isRunning` CHECK. A reset
 * deletes the Entra app registration the chain is mid-way through building
 * on. `isRunning` answers a question about the instant it was read; between
 * that read and the reset's first delete, an enqueue can arrive and start
 * creating exactly the objects the teardown is about to remove. Whichever one
 * lands second reports an outcome that is not true.
 *
 * So the runner — the only thing that already knows what is in flight — hands
 * out a lease, and the exclusion holds in BOTH directions:
 *
 *   * a teardown cannot start while a run is in flight;
 *   * a run cannot start while a teardown holds the agent, and it is refused
 *     with a reason that names the teardown rather than inventing a team
 *     conflict that does not exist.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { TimerSeam } from '../src/plugins/jobScheduler.js';
import {
  TeamsProvisioningJobRunner,
  type TeamsAppPackageAssets,
  type TeamsIdentityJobRecord,
  type TeamsProvisionerPort,
} from '../src/services/teamsProvisioningJob.js';

const IDLE_TIMERS: TimerSeam = {
  setTimeout: (cb) => {
    cb();
    return 1;
  },
  clearTimeout() {},
  setInterval() {
    throw new Error('runner must not use setInterval');
  },
  clearInterval() {},
};

const ROW: TeamsIdentityJobRecord = {
  agentId: 'agent-1',
  botSlug: 'acme',
  displayName: 'Acme',
  state: 'pending',
  appId: null,
  appObjectId: null,
  tenantId: null,
  teamsAppId: null,
  teamsAppExternalId: null,
  lastError: null,
};

/** A runner whose chain never actually runs — every test here is about the
 *  lock, not about provisioning. */
function runner(
  onCreate?: () => Promise<void>,
): TeamsProvisioningJobRunner {
  let row = ROW;
  const provisioner: TeamsProvisionerPort = {
    createAppRegistration: async () => {
      await onCreate?.();
      return {
        outcome: 'created',
        value: { appId: 'app-1', registration: { tenantId: 'tenant-1' } },
      };
    },
    createBot: async () => ({
      kind: 'provisioned',
      bot: { outcome: 'created', value: { botName: 'bot' } },
    }),
    buildAppPackage: () => new Uint8Array([1]),
    uploadToCatalog: async () => ({
      outcome: 'created',
      value: { teamsAppId: 'catalog-1' },
    }),
    getCatalogApp: async () => ({ found: false }),
    installToTeam: async () => ({ outcome: 'created', value: {} }),
  } as unknown as TeamsProvisionerPort;

  return new TeamsProvisioningJobRunner({
    store: {
      getByAgentId: async () => row,
      update: async (_id, patch) => {
        row = { ...row, ...patch } as TeamsIdentityJobRecord;
        return row;
      },
    },
    getProvisioner: () => provisioner,
    buildMessagingEndpoint: (slug) => `https://example.test/api/teams/${slug}/messages`,
    loadPackageAssets: async () =>
      ({
        manifestTemplate: '{}',
        params: {},
        icons: { color: new Uint8Array([1]), outline: new Uint8Array([1]) },
        externalId: 'ext-1',
      }) as unknown as TeamsAppPackageAssets,
    timers: IDLE_TIMERS,
    maxAttempts: 1,
  });
}

describe('teams provisioning — the exclusive lease', () => {
  it('refuses a lease while a provisioning run is in flight', async () => {
    // The run is held open inside `createAppRegistration`, so it is genuinely
    // mid-chain when the teardown asks — not merely enqueued.
    let releaseRun = (): void => {};
    const held = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const jobs = runner(() => held);
    const run = jobs.enqueue({ agentId: 'agent-1', teamId: 'team-1' });

    assert.equal(
      jobs.acquireExclusive('agent-1', 'teams_identity_reset'),
      null,
      'a teardown must not start on top of a live run',
    );

    releaseRun();
    await run;
  });

  it('refuses an enqueue while a teardown holds the agent, and says which', async () => {
    const jobs = runner();
    const release = jobs.acquireExclusive('agent-1', 'teams_identity_reset');
    assert.notEqual(release, null);

    const result = await jobs.enqueue({ agentId: 'agent-1', teamId: 'team-1' });

    assert.equal(result.status, 'rejected');
    assert.equal(
      result.status === 'rejected' ? result.reason : null,
      'exclusive_lease',
      "not 'team_conflict' — there is no second team, and naming the wrong problem sends the operator hunting for one",
    );
    assert.ok(
      result.status === 'rejected' && result.detail.includes('teams_identity_reset'),
    );
  });

  it('reports the agent as running while a teardown holds it', () => {
    const jobs = runner();
    assert.equal(jobs.isRunning('agent-1'), false);
    const release = jobs.acquireExclusive('agent-1', 'teams_identity_reset');
    // Deleting an app registration is work, and a UI that showed the agent as
    // idle would offer a second teardown next to the one already going.
    assert.equal(jobs.isRunning('agent-1'), true);
    assert.equal(jobs.exclusiveLease('agent-1'), 'teams_identity_reset');
    release?.();
    assert.equal(jobs.isRunning('agent-1'), false);
    assert.equal(jobs.exclusiveLease('agent-1'), null);
  });

  it('refuses a second lease, and releases idempotently', async () => {
    const jobs = runner();
    const first = jobs.acquireExclusive('agent-1', 'teams_identity_reset');
    assert.equal(jobs.acquireExclusive('agent-1', 'teams_identity_reset'), null);
    first?.();
    // A `finally` that runs twice must not hand the agent to somebody else.
    first?.();
    const second = jobs.acquireExclusive('agent-1', 'teams_identity_reset');
    assert.notEqual(second, null);
    second?.();
    await Promise.resolve();
  });

  it('does not lock unrelated agents', () => {
    const jobs = runner();
    const release = jobs.acquireExclusive('agent-1', 'teams_identity_reset');
    assert.notEqual(jobs.acquireExclusive('agent-2', 'teams_identity_reset'), null);
    release?.();
  });
});
