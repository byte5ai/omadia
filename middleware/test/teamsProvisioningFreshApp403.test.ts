/**
 * #2043 D22 — a 403 right after creating the app registration is not missing
 * consent.
 *
 * Live: the first provisioning run of a new facilitator failed 8 s after
 * `POST /applications` with `consent_missing … Application.ReadWrite.OwnedBy`,
 * although that permission is granted (it had just created the application).
 * The re-run succeeded. The connector reports every 403 as missing consent;
 * this one answered `addPassword` on an object Entra had not replicated yet,
 * and the UI told the operator to grant something that was granted.
 *
 * The runner now waits a bounded time for such a 403 and reports, if it
 * stays, a code of its own that does not ask for a consent.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  TeamsProvisioningJobRunner,
  appRegistrationNotReadyFailure,
  classifyTeamsProvisioningError,
  isFollowUpRefusalOnAppRegistration,
  type TeamsIdentityJobRecord,
  type TeamsProvisionerPort,
} from '../src/services/teamsProvisioningJob.js';

const SCOPE = 'Application.ReadWrite.OwnedBy';

/** The error exactly as the connector's HTTP layer builds it (http.ts). */
function consentMissing(step: string, resource: 'graph' | 'arm' = 'graph'): Error {
  return Object.assign(new Error('consent_missing'), {
    name: 'ConsentMissingError',
    missingScopes: [SCOPE],
    resource,
    cause: new Error(
      `${resource} ${step} 403 body={"error":{"code":"Authorization_RequestDenied","message":"Insufficient privileges to complete the operation."}}`,
    ),
  });
}

function harness(createAppRegistration: () => Promise<unknown>, opts: Record<string, unknown> = {}) {
  let row = {
    agentId: 'agent-1',
    botSlug: 'rita',
    displayName: 'Rita',
    state: 'pending',
    teamId: 'team-42',
    appId: null,
    tenantId: null,
    teamsAppId: null,
    teamsAppExternalId: null,
    lastError: null,
  } as TeamsIdentityJobRecord;
  const sleeps: number[] = [];
  const events: { step: string; status: string; detail?: string }[] = [];
  const provisioner = {
    createAppRegistration,
    // The chain is stopped here: this suite is about the step before.
    async createBot() {
      throw Object.assign(new Error("bot_app_id_retired: stop"), { name: 'BotAppIdRetiredError' });
    },
  } as unknown as TeamsProvisionerPort;
  const runner = new TeamsProvisioningJobRunner({
    store: {
      getByAgentId: async () => row,
      update: async (_id: string, patch: Partial<TeamsIdentityJobRecord>) => {
        row = { ...row, ...patch } as TeamsIdentityJobRecord;
        return row;
      },
    } as never,
    getProvisioner: () => provisioner,
    buildMessagingEndpoint: (slug: string) => `https://mw.example.com/api/teams/${slug}/messages`,
    loadPackageAssets: async () => {
      throw new Error('not reached');
    },
    timers: {
      setTimeout: (fn: () => void, ms?: number) => {
        sleeps.push(ms ?? 0);
        fn();
        return 0 as never;
      },
      clearTimeout: () => undefined,
    } as never,
    events: {
      record: async (event: { step: string; status: string; detail?: string }) => {
        events.push(event);
      },
      clearForAgent: async () => undefined,
    } as never,
    log: () => undefined,
    ...opts,
  } as never);
  return { runner, sleeps, events, row: () => row };
}

describe('a 403 on a follow-up call to the app registration (D22)', () => {
  it('is recognised by the step the connector names, and only for those steps', () => {
    for (const step of ['applications.addPassword', 'servicePrincipals.create', 'applications.get', 'applications.awaitReplication']) {
      assert.equal(isFollowUpRefusalOnAppRegistration(consentMissing(step)), true, step);
    }
    // The create itself and the lookup: there the permission really is missing.
    assert.equal(isFollowUpRefusalOnAppRegistration(consentMissing('applications.create')), false);
    assert.equal(isFollowUpRefusalOnAppRegistration(consentMissing('applications.findByUniqueName')), false);
    // Another API, another error, no cause: unchanged.
    assert.equal(isFollowUpRefusalOnAppRegistration(consentMissing('botService.create', 'arm')), false);
    assert.equal(isFollowUpRefusalOnAppRegistration(new Error('graph applications.addPassword 403')), false);
    assert.equal(
      isFollowUpRefusalOnAppRegistration(Object.assign(new Error('x'), { name: 'ConsentMissingError', missingScopes: [SCOPE] })),
      false,
    );
  });

  it('the live case: the first call is refused, the run waits and then goes on', async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      if (calls === 1) throw consentMissing('applications.addPassword');
      return { outcome: 'created', value: { appId: 'app-123', registration: { tenantId: 'tenant-9' } } };
    });
    const result = await h.runner.enqueue({ agentId: 'agent-1', teamId: 'team-42' });
    assert.equal(calls, 2, 'the app registration step ran again and resumed');
    assert.notEqual((result as { reason?: string }).reason, 'consent_missing');
    assert.notEqual(h.row().errorCode, 'consent_missing');
    assert.equal(h.row().appId, 'app-123', 'the chain went on past the app registration');
    assert.ok(h.sleeps.includes(5_000), `waited 5 s first (${JSON.stringify(h.sleeps)})`);
    assert.ok(
      h.events.some((e) => e.status === 'retrying' && e.detail === 'awaiting_entra_replication'),
      'the operator sees that the run is waiting for Entra, not a consent request',
    );
  });

  it('still refused after the bounded wait: its own code, no request for a consent', async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      throw consentMissing('servicePrincipals.create');
    });
    const result = await h.runner.enqueue({ agentId: 'agent-1', teamId: 'team-42' });
    assert.equal(calls, 5, 'one call and four waits');
    assert.deepEqual(
      h.sleeps.filter((ms) => ms >= 5_000),
      [5_000, 10_000, 20_000, 20_000],
      'bounded backoff, about a minute in all',
    );
    assert.equal(result.status, 'failed');
    assert.equal((result as { reason?: string }).reason, 'app_registration_not_ready');
    assert.equal(h.row().state, 'failed');
    assert.equal(h.row().errorCode, 'app_registration_not_ready');
    assert.match(h.row().lastError ?? '', /^app_registration_not_ready: .*this is not missing admin consent/);
    assert.match(h.row().lastError ?? '', /servicePrincipals\.create 403/, 'the connector text is kept as technical detail');
    assert.equal(classifyTeamsProvisioningError(h.row().lastError ?? '').code, 'app_registration_not_ready');
  });

  it('a 403 on the create itself stays what it is: missing consent, at once', async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      throw consentMissing('applications.create');
    });
    const result = await h.runner.enqueue({ agentId: 'agent-1', teamId: 'team-42' });
    assert.equal(calls, 1);
    assert.equal((result as { reason?: string }).reason, 'consent_missing');
    assert.equal(h.row().errorCode, 'consent_missing');
    assert.deepEqual(h.sleeps.filter((ms) => ms >= 5_000), []);
  });

  it('the wait can be switched off, and the failure sentence is bounded', async () => {
    const h = harness(
      async () => {
        throw consentMissing('applications.addPassword');
      },
      { appReplicationAttempts: 0 },
    );
    const result = await h.runner.enqueue({ agentId: 'agent-1', teamId: 'team-42' });
    assert.equal((result as { reason?: string }).reason, 'app_registration_not_ready');
    assert.ok(appRegistrationNotReadyFailure('x'.repeat(5_000)).lastError.length <= 1200);
  });
});
