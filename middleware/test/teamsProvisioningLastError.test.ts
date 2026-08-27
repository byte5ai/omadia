import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  armNotConfiguredDetail,
  classifyTeamsProvisioningError,
  consentMissingDetail,
  throttledDetail,
  TeamsProvisioningJobRunner,
  type ProvisionTeamsIdentityRequest,
  type TeamsAppPackageAssets,
  type TeamsIdentityJobRecord,
  type TeamsIdentityJobStore,
  type TeamsIdentityJobUpdate,
  type TeamsProvisionerPort,
} from '../src/services/teamsProvisioningJob.js';
import { projectTeamsIdentityErrorDetail } from '../src/routes/operatorAgents.js';

/**
 * epic byte5ai/omadia#860, wave W2a — the `last_error` round trip.
 *
 * The operator UI renders a localized, actionable hint for a failed Teams
 * provisioning run. It gets that hint from `identity.last_error_detail`,
 * which the middleware derives server-side with
 * {@link classifyTeamsProvisioningError}. The point of THIS file is that the
 * parser and the producers are asserted together: every case below builds a
 * sentence with the very function the job runner calls, then classifies it
 * back. Reword a message and forget the parser and these tests go red — the
 * failure mode that a frontend-side sentence parser would have hidden until
 * an operator hit it in production.
 */

// ---------------------------------------------------------------------------
// Producer → classifier round trip
// ---------------------------------------------------------------------------

describe('classifyTeamsProvisioningError — round trip with the producers', () => {
  it('classifies the consent sentence and recovers the missing scopes', () => {
    const raw = consentMissingDetail([
      'Application.ReadWrite.All',
      'AppCatalog.ReadWrite.All',
    ]);

    const detail = classifyTeamsProvisioningError(raw);

    assert.equal(detail.code, 'consent_missing');
    assert.deepEqual(detail.scopes, [
      'Application.ReadWrite.All',
      'AppCatalog.ReadWrite.All',
    ]);
    assert.equal(detail.raw, raw);
    assert.equal(detail.fields, undefined);
  });

  it('classifies the ARM sentence and recovers the missing setup fields', () => {
    const raw = armNotConfiguredDetail(['azureSubscriptionId', 'azureResourceGroup']);

    const detail = classifyTeamsProvisioningError(raw);

    assert.equal(detail.code, 'arm_not_configured');
    assert.deepEqual(detail.fields, ['azureSubscriptionId', 'azureResourceGroup']);
    assert.equal(detail.scopes, undefined);
  });

  it('keeps an empty list empty instead of inventing a placeholder scope', () => {
    const detail = classifyTeamsProvisioningError(consentMissingDetail([]));

    assert.equal(detail.code, 'consent_missing');
    assert.deepEqual(detail.scopes, []);
  });

  it('classifies an exhausted throttle and recovers the Retry-After hint', () => {
    const raw = throttledDetail('429 from Graph', 3, 42);

    const detail = classifyTeamsProvisioningError(raw);

    assert.equal(detail.code, 'throttled');
    assert.equal(detail.retryAfterSeconds, 42);
    assert.ok(
      detail.raw.includes('gave up after 3 attempts'),
      'the operator-facing sentence keeps the attempt count',
    );
  });

  it('classifies a throttle without a Retry-After header as throttled, hint omitted', () => {
    const raw = throttledDetail('429 from ARM', 2);

    const detail = classifyTeamsProvisioningError(raw);

    assert.equal(detail.code, 'throttled');
    assert.equal(
      detail.retryAfterSeconds,
      undefined,
      'no header means no hint — never a fabricated default',
    );
  });

  it('classifies an exhausted non-throttle error as unknown, message preserved', () => {
    // Not a producer: a non-retryable error keeps its bare message plus the
    // attempt suffix (see handleFailure). It must classify as `unknown` so the
    // UI shows the raw text as a technical detail rather than mislabelling it.
    const raw = 'socket hang up (gave up after 2 attempts)';

    const detail = classifyTeamsProvisioningError(raw);

    assert.equal(detail.code, 'unknown');
    assert.equal(detail.raw, raw);
  });

  it('is total: an unrecognized or blank sentence never throws', () => {
    assert.deepEqual(classifyTeamsProvisioningError('   '), {
      code: 'unknown',
      raw: '   ',
    });
    // What `recordEnqueueFailure` writes — no prefix, still renderable.
    assert.deepEqual(classifyTeamsProvisioningError('runner unavailable'), {
      code: 'unknown',
      raw: 'runner unavailable',
    });
  });
});

// ---------------------------------------------------------------------------
// The wire projection the operator router emits
// ---------------------------------------------------------------------------

const CLEAN_ROW = {
  agentId: 'agent-1',
  botSlug: 'hr-bot',
  displayName: 'HR Bot',
  state: 'failed',
  teamId: 'team-42',
  appId: 'app-123',
  tenantId: 'tenant-1',
  teamsAppId: null,
  teamsAppExternalId: null,
  lastError: null,
} as const;

describe('projectTeamsIdentityErrorDetail — operator wire projection', () => {
  it('emits the classifier shape verbatim and omits members that do not apply', () => {
    const projected = projectTeamsIdentityErrorDetail({
      ...CLEAN_ROW,
      lastError: armNotConfiguredDetail(['azureSubscriptionId']),
    });

    assert.equal(projected?.code, 'arm_not_configured');
    assert.deepEqual(projected?.fields, ['azureSubscriptionId']);
    assert.ok(!('scopes' in (projected as object)));
    assert.ok(!('retryAfterSeconds' in (projected as object)));
  });

  it('keeps retryAfterSeconds camelCase — the UI reads that key', () => {
    const projected = projectTeamsIdentityErrorDetail({
      ...CLEAN_ROW,
      lastError: throttledDetail('429', 3, 7),
    });

    assert.equal(projected?.retryAfterSeconds, 7);
  });

  it('null last_error projects to null — a healthy row carries no detail', () => {
    assert.equal(projectTeamsIdentityErrorDetail(CLEAN_ROW), null);
  });
});

// ---------------------------------------------------------------------------
// The anti-drift assertion: sentences the RUNNER actually persisted
//
// The tests above pin producer ↔ parser. This one closes the last gap — that
// the runner still routes its failures THROUGH those producers — by driving
// the real runner into each failure and classifying whatever landed in the
// store.
// ---------------------------------------------------------------------------

const REQUEST: ProvisionTeamsIdentityRequest = {
  agentId: 'agent-1',
  teamId: 'team-42',
};

const ASSETS: TeamsAppPackageAssets = {
  manifestTemplate: '{"id":"{{APP_ID}}"}',
  params: { APP_ID: 'app-123' },
  icons: { color: new Uint8Array([1]), outline: new Uint8Array([2]) },
  externalId: 'external-abc',
};

function namedError(
  name: string,
  message: string,
  extra: Record<string, unknown> = {},
): Error {
  const err = new Error(message);
  err.name = name;
  Object.assign(err, extra);
  return err;
}

interface MemoryStore extends TeamsIdentityJobStore {
  row: TeamsIdentityJobRecord;
}

function makeStore(): MemoryStore {
  const store: MemoryStore = {
    row: {
      agentId: 'agent-1',
      botSlug: 'hr-bot',
      displayName: 'HR Bot',
      state: 'pending',
      appId: null,
      tenantId: null,
      teamsAppId: null,
      teamsAppExternalId: null,
      lastError: null,
    },
    async getByAgentId(agentId) {
      return store.row.agentId === agentId ? store.row : undefined;
    },
    async update(_agentId, patch: TeamsIdentityJobUpdate) {
      store.row = {
        ...store.row,
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.appId !== undefined ? { appId: patch.appId } : {}),
        ...(patch.tenantId !== undefined ? { tenantId: patch.tenantId } : {}),
        ...(patch.teamsAppId !== undefined ? { teamsAppId: patch.teamsAppId } : {}),
        ...(patch.teamsAppExternalId !== undefined
          ? { teamsAppExternalId: patch.teamsAppExternalId }
          : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
      };
      return store.row;
    },
  };
  return store;
}

/** A provisioner whose FIRST chain step rejects, so every scenario reaches
 *  `handleFailure` through the same path regardless of the error thrown. */
function rejectingProvisioner(err: Error): TeamsProvisionerPort {
  return {
    createAppRegistration: () => Promise.reject(err),
    createBot: () => Promise.reject(new Error('unreachable')),
    buildAppPackage: () => new Uint8Array([80, 75]),
    uploadToCatalog: () => Promise.reject(new Error('unreachable')),
    getCatalogApp: () => Promise.resolve({ found: false }),
    installToTeam: () => Promise.reject(new Error('unreachable')),
  };
}

function runnerRejectingWith(
  err: Error,
  maxAttempts: number,
): { runner: TeamsProvisioningJobRunner; store: MemoryStore } {
  const store = makeStore();
  const runner = new TeamsProvisioningJobRunner({
    store,
    getProvisioner: () => rejectingProvisioner(err),
    buildMessagingEndpoint: (botSlug) =>
      `https://mw.example.com/api/teams/${botSlug}/messages`,
    loadPackageAssets: async () => ASSETS,
    timers: {
      setTimeout(cb) {
        cb();
        return 1;
      },
      clearTimeout() {},
      setInterval() {
        throw new Error('runner must not use setInterval');
      },
      clearInterval() {},
    },
    maxAttempts,
    baseRetryDelayMs: 1,
    log: () => {},
  });
  return { runner, store };
}

describe('classifyTeamsProvisioningError — against what the runner persisted', () => {
  it('a real consent failure lands as a classifiable consent_missing row', async () => {
    const { runner, store } = runnerRejectingWith(
      namedError('ConsentMissingError', '403 from Graph', {
        missingScopes: ['Application.ReadWrite.All'],
        resource: 'graph',
      }),
      1,
    );

    await runner.enqueue(REQUEST);

    assert.ok(store.row.lastError, "the runner persisted a sentence");
    const detail = classifyTeamsProvisioningError(store.row.lastError);
    assert.equal(detail.code, 'consent_missing');
    assert.deepEqual(detail.scopes, ['Application.ReadWrite.All']);
  });

  it('a real ARM-not-configured failure lands as arm_not_configured', async () => {
    const { runner, store } = runnerRejectingWith(
      namedError('ArmNotConfiguredError', 'ARM setup incomplete', {
        missingSetupFields: ['azureSubscriptionId'],
      }),
      1,
    );

    await runner.enqueue(REQUEST);

    assert.ok(store.row.lastError, "the runner persisted a sentence");
    const detail = classifyTeamsProvisioningError(store.row.lastError);
    assert.equal(detail.code, 'arm_not_configured');
    assert.deepEqual(detail.fields, ['azureSubscriptionId']);
  });

  it('a real exhausted throttle lands as throttled with the hint intact', async () => {
    const { runner, store } = runnerRejectingWith(
      namedError('ProvisioningThrottledError', '429 from Graph', {
        resource: 'graph',
        retryAfterSeconds: 5,
      }),
      2,
    );

    await runner.enqueue(REQUEST);

    assert.ok(store.row.lastError, "the runner persisted a sentence");
    const detail = classifyTeamsProvisioningError(store.row.lastError);
    assert.equal(detail.code, 'throttled');
    assert.equal(detail.retryAfterSeconds, 5);
  });
});
