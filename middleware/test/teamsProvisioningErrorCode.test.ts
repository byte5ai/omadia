import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  classifyTeamsProvisioningError,
  consentMissingDetail,
  isTeamsProvisioningErrorCode,
  teamsProvisioningErrorDetailOf,
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
 * byte5ai/omadia#897 — the runner persists the STRUCTURED failure.
 *
 * Until #897 the only thing the runner wrote was an English sentence, and the
 * operator route rebuilt `last_error_detail` by parsing it. Now every failure
 * writes `error_code` + `error_detail` (migration 0060) next to the sentence,
 * and the read path takes the columns and only falls back to the classifier
 * for a row that has no code.
 *
 * Three things are pinned here:
 *   1. every failure path the runner can take writes a code, and what the
 *      columns decode to is exactly what the classifier would have decoded
 *      from the same sentence (the wire contract did not move);
 *   2. the sentence is no longer load-bearing — a reworded one keeps its code;
 *   3. the stored columns are validated on the way out, never trusted.
 */

const REQUEST: ProvisionTeamsIdentityRequest = { agentId: 'agent-1', teamId: 'team-42' };

const ASSETS: TeamsAppPackageAssets = {
  manifestTemplate: '{"id":"{{APP_ID}}"}',
  params: { APP_ID: 'app-123' },
  icons: { color: new Uint8Array([1]), outline: new Uint8Array([2]) },
  externalId: 'external-abc',
};

function namedError(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  const err = new Error(message);
  err.name = name;
  Object.assign(err, extra);
  return err;
}

interface MemoryStore extends TeamsIdentityJobStore {
  row: TeamsIdentityJobRecord;
}

/** Mirrors the real store's pairing invariant: a `lastError` write also
 *  writes both structured columns (given values or null). */
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
      errorCode: null,
      errorDetail: null,
    },
    async getByAgentId(agentId) {
      return store.row.agentId === agentId ? store.row : undefined;
    },
    async update(_agentId, patch: TeamsIdentityJobUpdate) {
      const failing = patch.lastError !== undefined && patch.lastError !== null;
      store.row = {
        ...store.row,
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.lastError !== undefined
          ? {
              lastError: patch.lastError,
              errorCode: failing ? (patch.errorCode ?? null) : null,
              errorDetail: failing ? (patch.errorDetail ?? null) : null,
            }
          : {}),
      };
      return store.row;
    },
  };
  return store;
}

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

async function persistedFor(err: Error, maxAttempts: number): Promise<TeamsIdentityJobRecord> {
  const store = makeStore();
  const runner = new TeamsProvisioningJobRunner({
    store,
    getProvisioner: () => rejectingProvisioner(err),
    buildMessagingEndpoint: (botSlug) => `https://mw.example.com/api/teams/${botSlug}/messages`,
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
  await runner.enqueue(REQUEST);
  return store.row;
}

const CONSENT_URL = 'https://login.microsoftonline.com/tenant-1/adminconsent?client_id=x';

const SCENARIOS: ReadonlyArray<{
  readonly name: string;
  readonly err: Error;
  readonly maxAttempts: number;
  readonly code: string;
  readonly detail: unknown;
}> = [
  {
    name: 'consent missing',
    err: namedError('ConsentMissingError', '403 from Graph', {
      missingScopes: ['Application.ReadWrite.All', 'AppCatalog.ReadWrite.All'],
    }),
    maxAttempts: 1,
    code: 'consent_missing',
    detail: { scopes: ['Application.ReadWrite.All', 'AppCatalog.ReadWrite.All'] },
  },
  {
    name: 'ARM not configured',
    err: namedError('ArmNotConfiguredError', 'ARM setup incomplete', {
      missingSetupFields: ['azureSubscriptionId', 'azureResourceGroup'],
    }),
    maxAttempts: 1,
    code: 'arm_not_configured',
    detail: { fields: ['azureSubscriptionId', 'azureResourceGroup'] },
  },
  {
    name: 'bot handle taken',
    err: namedError('BotHandleUnavailableError', 'handle taken', { botName: 'omadia-hr-bot' }),
    maxAttempts: 3,
    code: 'bot_handle_unavailable',
    detail: null,
  },
  {
    name: 'throttle exhausted with a Retry-After hint',
    err: namedError('ProvisioningThrottledError', '429 from Graph', { retryAfterSeconds: 5 }),
    maxAttempts: 2,
    code: 'throttled',
    detail: { retryAfterSeconds: 5 },
  },
  {
    name: 'throttle exhausted without a hint',
    err: namedError('ProvisioningThrottledError', '429 from ARM'),
    maxAttempts: 2,
    code: 'throttled',
    detail: null,
  },
  {
    name: 'delegated sign-in required',
    err: namedError('DelegatedSignInRequiredError', 'no sign-in', {
      requiredScopes: ['AppCatalog.Submit'],
      step: 'catalog-upload',
    }),
    maxAttempts: 1,
    code: 'delegated_sign_in_required',
    detail: { scopes: ['AppCatalog.Submit'] },
  },
  {
    name: 'delegated consent required, with a consent URL',
    err: namedError('DelegatedConsentRequiredError', 'consent needed', {
      requiredScopes: ['AppCatalog.Submit'],
      adminConsentUrl: CONSENT_URL,
    }),
    maxAttempts: 1,
    code: 'delegated_consent_required',
    detail: { scopes: ['AppCatalog.Submit'], adminConsentUrl: CONSENT_URL },
  },
  {
    name: 'delegated token expired',
    err: namedError('DelegatedTokenExpiredError', 'expired', {
      reason: 'refresh-token-invalid',
    }),
    maxAttempts: 1,
    code: 'delegated_token_expired',
    detail: null,
  },
  {
    name: 'device-code flow refused',
    err: namedError('DeviceCodeFlowError', 'AADSTS50059 refused', {
      oauthError: 'invalid_client',
    }),
    maxAttempts: 3,
    code: 'device_code_flow_failed',
    detail: { reason: 'invalid_client' },
  },
  {
    name: 'deterministic 4xx',
    err: namedError('ProvisioningRequestError', 'graph applications 400 bad request', {
      status: 400,
    }),
    maxAttempts: 3,
    code: 'unknown',
    detail: null,
  },
  {
    name: 'non-throttle retry budget exhausted',
    err: new Error('socket hang up'),
    maxAttempts: 2,
    code: 'unknown',
    detail: null,
  },
];

describe('the runner persists the structured code (#897)', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name} → ${scenario.code}`, async () => {
      const row = await persistedFor(scenario.err, scenario.maxAttempts);

      assert.ok(row.lastError, 'the human sentence is still written');
      assert.equal(row.errorCode, scenario.code);
      assert.deepEqual(row.errorDetail, scenario.detail);
      // Parity: the columns decode to exactly what the classifier reads out
      // of the same sentence — the wire contract of last_error_detail does
      // not depend on which path produced it.
      assert.deepEqual(
        teamsProvisioningErrorDetailOf(row.lastError, row.errorCode, row.errorDetail),
        classifyTeamsProvisioningError(row.lastError),
      );
    });
  }
});

// ---------------------------------------------------------------------------
// The sentence is no longer load-bearing
// ---------------------------------------------------------------------------

const REWORDED = 'Admin consent is missing — ask your tenant admin.';

const LEGACY_FREE_ROW = {
  agentId: 'agent-1',
  botSlug: 'hr-bot',
  displayName: 'HR Bot',
  state: 'failed',
  teamId: 'team-42',
  appId: 'app-123',
  tenantId: 'tenant-1',
  teamsAppId: null,
  teamsAppExternalId: null,
  lastError: REWORDED,
  errorCode: 'consent_missing',
  errorDetail: { scopes: ['A', 'B'] },
} as const;

describe('a reworded sentence keeps its meaning (#897)', () => {
  it('teamsProvisioningErrorDetailOf reads the code, not the prose', () => {
    // The classifier alone would call this `unknown` — no prefix, no brackets.
    assert.equal(classifyTeamsProvisioningError(REWORDED).code, 'unknown');
    assert.deepEqual(teamsProvisioningErrorDetailOf(REWORDED, 'consent_missing', { scopes: ['A', 'B'] }), {
      code: 'consent_missing',
      scopes: ['A', 'B'],
      raw: REWORDED,
    });
  });

  it('the operator wire projection reads the persisted columns', () => {
    assert.deepEqual(projectTeamsIdentityErrorDetail(LEGACY_FREE_ROW), {
      code: 'consent_missing',
      scopes: ['A', 'B'],
      raw: REWORDED,
    });
  });

  it('a row without a code (pre-0060) is still classified from its sentence', () => {
    const raw = consentMissingDetail(['Group.Read.All']);
    const projected = projectTeamsIdentityErrorDetail({
      ...LEGACY_FREE_ROW,
      lastError: raw,
      errorCode: null,
      errorDetail: null,
    });
    assert.deepEqual(projected, { code: 'consent_missing', scopes: ['Group.Read.All'], raw });
  });
});

// ---------------------------------------------------------------------------
// Stored columns are validated on the way out
// ---------------------------------------------------------------------------

describe('teamsProvisioningErrorDetailOf validates what it reads (#897)', () => {
  const raw = consentMissingDetail(['X']);

  it('falls back to the classifier for a NULL or an unknown code', () => {
    for (const code of [null, undefined, 'enqueue_failed', 'a_code_from_a_newer_build', 7]) {
      assert.deepEqual(
        teamsProvisioningErrorDetailOf(raw, code, { scopes: ['ignored'] }),
        classifyTeamsProvisioningError(raw),
      );
    }
  });

  it('drops a consent URL that is not absolute https', () => {
    for (const adminConsentUrl of ['javascript:alert(1)', 'http://x.example', '/relative', 42]) {
      assert.deepEqual(
        teamsProvisioningErrorDetailOf('s', 'delegated_consent_required', {
          scopes: ['AppCatalog.Submit'],
          adminConsentUrl,
        }),
        { code: 'delegated_consent_required', scopes: ['AppCatalog.Submit'], raw: 's' },
      );
    }
  });

  it('turns a non-list into [] and drops non-string entries', () => {
    assert.deepEqual(teamsProvisioningErrorDetailOf('s', 'consent_missing', { scopes: 'A' }), {
      code: 'consent_missing',
      scopes: [],
      raw: 's',
    });
    assert.deepEqual(
      teamsProvisioningErrorDetailOf('s', 'arm_not_configured', { fields: ['a', 1, null, 'b'] }),
      { code: 'arm_not_configured', fields: ['a', 'b'], raw: 's' },
    );
    assert.deepEqual(teamsProvisioningErrorDetailOf('s', 'consent_missing', null), {
      code: 'consent_missing',
      scopes: [],
      raw: 's',
    });
    assert.deepEqual(teamsProvisioningErrorDetailOf('s', 'consent_missing', ['A']), {
      code: 'consent_missing',
      scopes: [],
      raw: 's',
    });
  });

  it('omits a Retry-After hint that is not a finite, non-negative number', () => {
    for (const retryAfterSeconds of [-1, '5', Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(teamsProvisioningErrorDetailOf('s', 'throttled', { retryAfterSeconds }), {
        code: 'throttled',
        raw: 's',
      });
    }
    assert.deepEqual(teamsProvisioningErrorDetailOf('s', 'throttled', { retryAfterSeconds: 0 }), {
      code: 'throttled',
      retryAfterSeconds: 0,
      raw: 's',
    });
  });

  it('keeps config_sync_failed.reason a string and device-code reason optional', () => {
    assert.deepEqual(teamsProvisioningErrorDetailOf('s', 'config_sync_failed', { reason: 3 }), {
      code: 'config_sync_failed',
      reason: '',
      raw: 's',
    });
    assert.deepEqual(teamsProvisioningErrorDetailOf('s', 'device_code_flow_failed', { reason: '' }), {
      code: 'device_code_flow_failed',
      raw: 's',
    });
  });

  it('carries no arguments for codes that have none, whatever is stored', () => {
    assert.deepEqual(
      teamsProvisioningErrorDetailOf('s', 'bot_handle_unavailable', { scopes: ['x'], reason: 'y' }),
      { code: 'bot_handle_unavailable', raw: 's' },
    );
  });

  it('isTeamsProvisioningErrorCode knows the closed set and nothing else', () => {
    assert.equal(isTeamsProvisioningErrorCode('rsc_permissions_mismatch'), true);
    assert.equal(isTeamsProvisioningErrorCode('unknown'), true);
    assert.equal(isTeamsProvisioningErrorCode('toString'), false);
    assert.equal(isTeamsProvisioningErrorCode('enqueue_failed'), false);
    assert.equal(isTeamsProvisioningErrorCode(null), false);
  });
});
