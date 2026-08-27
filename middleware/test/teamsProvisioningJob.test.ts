import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { TimerSeam } from '../src/plugins/jobScheduler.js';
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
  type TeamsProvisioningState,
} from '../src/services/teamsProvisioningJob.js';

/**
 * Unit-level runner tests with a stubbed accessor and a stubbed store, per
 * the wave spec — no Postgres, no connector plugin. Timing is deterministic:
 * the timer seam fires every setTimeout immediately while recording the
 * requested delay, so retry/backoff behaviour (including the
 * ProvisioningThrottledError retry hint) is asserted on recorded values,
 * never on wall-clock waits.
 */

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface RecordingTimers extends TimerSeam {
  readonly delays: number[];
}

function immediateTimers(): RecordingTimers {
  const delays: number[] = [];
  return {
    delays,
    setTimeout(cb, ms) {
      delays.push(ms);
      cb();
      return delays.length;
    },
    clearTimeout() {},
    setInterval() {
      throw new Error('runner must not use setInterval');
    },
    clearInterval() {},
  };
}

interface MemoryStore extends TeamsIdentityJobStore {
  row: TeamsIdentityJobRecord | undefined;
  readonly updates: TeamsIdentityJobUpdate[];
}

function makeStore(overrides: Partial<TeamsIdentityJobRecord> = {}): MemoryStore {
  const initial: TeamsIdentityJobRecord = {
    agentId: 'agent-1',
    botSlug: 'hr-bot',
    displayName: 'HR Bot',
    state: 'pending',
    appId: null,
    tenantId: null,
    teamsAppId: null,
    teamsAppExternalId: null,
    lastError: null,
    ...overrides,
  };
  const updates: TeamsIdentityJobUpdate[] = [];
  const store: MemoryStore = {
    row: initial,
    updates,
    async getByAgentId(agentId) {
      return store.row?.agentId === agentId ? store.row : undefined;
    },
    async update(agentId, patch) {
      assert.ok(store.row && store.row.agentId === agentId, 'row must exist');
      updates.push(patch);
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

interface StubProvisioner extends TeamsProvisionerPort {
  readonly calls: string[];
}

interface StubBehaviour {
  createAppRegistration?: () => Promise<void> | void;
  createBot?: 'registration-only' | (() => Promise<void> | void);
  uploadToCatalog?: () => Promise<void> | void;
  installToTeam?: () => Promise<void> | void;
  catalogAppFound?: string;
}

function makeProvisioner(behaviour: StubBehaviour = {}): StubProvisioner {
  const calls: string[] = [];
  return {
    calls,
    async createAppRegistration(input) {
      calls.push(`createAppRegistration:${input.uniqueName ?? input.displayName}`);
      await behaviour.createAppRegistration?.();
      return {
        outcome: 'created',
        value: { appId: 'app-123', registration: { tenantId: 'tenant-9' } },
      };
    },
    async createBot(input) {
      calls.push(`createBot:${input.botName}:${input.messagingEndpoint}`);
      if (behaviour.createBot === 'registration-only') {
        return {
          kind: 'registration-only',
          reason: 'arm-not-configured',
          missingSetupFields: ['azureSubscriptionId', 'azureResourceGroup'],
        };
      }
      await behaviour.createBot?.();
      return { kind: 'provisioned', bot: { outcome: 'created', value: { botName: input.botName } } };
    },
    buildAppPackage() {
      calls.push('buildAppPackage');
      return new Uint8Array([80, 75]);
    },
    async uploadToCatalog(input) {
      calls.push(`uploadToCatalog:${input.externalId}`);
      await behaviour.uploadToCatalog?.();
      return { outcome: 'created', value: { teamsAppId: 'catalog-77' } };
    },
    async getCatalogApp(input) {
      calls.push(`getCatalogApp:${input.teamsAppExternalId}`);
      if (behaviour.catalogAppFound) {
        return { found: true, teamsAppId: behaviour.catalogAppFound };
      }
      return { found: false };
    },
    async installToTeam(input) {
      calls.push(`installToTeam:${input.teamId}:${input.teamsAppId}`);
      await behaviour.installToTeam?.();
      return {
        outcome: 'created',
        value: { teamId: input.teamId, teamsAppId: input.teamsAppId },
      };
    },
  };
}

const ASSETS: TeamsAppPackageAssets = {
  manifestTemplate: '{"id":"{{APP_ID}}"}',
  params: { APP_ID: 'app-123' },
  icons: { color: new Uint8Array([1]), outline: new Uint8Array([2]) },
  externalId: 'external-abc',
};

const REQUEST: ProvisionTeamsIdentityRequest = {
  agentId: 'agent-1',
  teamId: 'team-42',
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

interface RunnerFixture {
  runner: TeamsProvisioningJobRunner;
  store: MemoryStore;
  provisioner: StubProvisioner;
  timers: RecordingTimers;
}

function makeRunner(opts: {
  storeOverrides?: Partial<TeamsIdentityJobRecord>;
  behaviour?: StubBehaviour;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  getProvisioner?: () => TeamsProvisionerPort;
} = {}): RunnerFixture {
  const store = makeStore(opts.storeOverrides);
  const provisioner = makeProvisioner(opts.behaviour);
  const timers = immediateTimers();
  const runner = new TeamsProvisioningJobRunner({
    store,
    getProvisioner: opts.getProvisioner ?? (() => provisioner),
    buildMessagingEndpoint: (botSlug) =>
      `https://mw.example.com/api/teams/${botSlug}/messages`,
    loadPackageAssets: async () => ASSETS,
    timers,
    maxAttempts: opts.maxAttempts ?? 5,
    baseRetryDelayMs: opts.baseRetryDelayMs ?? 1000,
    ...(opts.maxRetryDelayMs !== undefined
      ? { maxRetryDelayMs: opts.maxRetryDelayMs }
      : {}),
    log: () => {},
  });
  return { runner, store, provisioner, timers };
}

function statesWalked(store: MemoryStore): TeamsProvisioningState[] {
  return store.updates
    .map((u) => u.state)
    .filter((s): s is TeamsProvisioningState => s !== undefined);
}

// ---------------------------------------------------------------------------
// Happy path + resume
// ---------------------------------------------------------------------------

describe('TeamsProvisioningJobRunner — chain and resume', () => {
  it('walks pending → … → installed and drives every accessor step', async () => {
    const { runner, store, provisioner } = makeRunner();
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    assert.deepEqual(statesWalked(store), [
      'app_registered',
      'bot_created',
      'package_built',
      'catalog_uploaded',
      'installed',
    ]);
    assert.deepEqual(provisioner.calls, [
      'createAppRegistration:omadia-teams-bot-hr-bot',
      'createBot:hr-bot:https://mw.example.com/api/teams/hr-bot/messages',
      'getCatalogApp:external-abc',
      'buildAppPackage',
      'uploadToCatalog:external-abc',
      'installToTeam:team-42:catalog-77',
    ]);
    assert.equal(store.row?.state, 'installed');
    assert.equal(store.row?.appId, 'app-123');
    assert.equal(store.row?.tenantId, 'tenant-9');
    assert.equal(store.row?.teamsAppId, 'catalog-77');
    assert.equal(store.row?.teamsAppExternalId, 'external-abc');
    assert.equal(store.row?.lastError, null);
  });

  it('passes the injected messaging endpoint to createBot verbatim', async () => {
    const { runner, provisioner } = makeRunner();
    await runner.enqueue(REQUEST);
    assert.ok(
      provisioner.calls.includes(
        'createBot:hr-bot:https://mw.example.com/api/teams/hr-bot/messages',
      ),
      'endpoint must come from the injected builder',
    );
  });

  it('resumes from app_registered without re-registering the app', async () => {
    const { runner, provisioner } = makeRunner({
      storeOverrides: { state: 'app_registered', appId: 'app-old', tenantId: 't-old' },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    assert.ok(
      !provisioner.calls.some((c) => c.startsWith('createAppRegistration')),
      'createAppRegistration must not run again',
    );
    assert.ok(provisioner.calls.some((c) => c.startsWith('createBot:hr-bot')));
  });

  it('resumes from bot_created without re-creating the bot', async () => {
    const { runner, provisioner } = makeRunner({
      storeOverrides: { state: 'bot_created', appId: 'a', tenantId: 't' },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    assert.ok(!provisioner.calls.some((c) => c.startsWith('createBot')));
    assert.ok(!provisioner.calls.some((c) => c.startsWith('createAppRegistration')));
  });

  it('resumes from catalog_uploaded straight to the install step', async () => {
    const { runner, provisioner } = makeRunner({
      storeOverrides: {
        state: 'catalog_uploaded',
        appId: 'a',
        tenantId: 't',
        teamsAppId: 'catalog-known',
        teamsAppExternalId: 'external-abc',
      },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    assert.deepEqual(provisioner.calls, ['installToTeam:team-42:catalog-known']);
  });

  it('reuses an existing catalog app instead of uploading again', async () => {
    const { runner, store, provisioner } = makeRunner({
      storeOverrides: { state: 'package_built', appId: 'a', tenantId: 't', teamsAppExternalId: 'external-abc' },
      behaviour: { catalogAppFound: 'catalog-existing' },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    assert.ok(!provisioner.calls.some((c) => c.startsWith('uploadToCatalog')));
    assert.equal(store.row?.teamsAppId, 'catalog-existing');
  });

  it('a row already installed is a no-op success', async () => {
    const { runner, store, provisioner } = makeRunner({
      storeOverrides: { state: 'installed', appId: 'a', tenantId: 't', teamsAppId: 'c' },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    assert.deepEqual(provisioner.calls, []);
    assert.deepEqual(store.updates, []);
  });

  it('resumes from failed using evidence columns, without re-creating', async () => {
    const { runner, store, provisioner } = makeRunner({
      storeOverrides: {
        state: 'failed',
        appId: 'app-kept',
        tenantId: 'tenant-kept',
        lastError: 'consent_missing: …',
      },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    assert.ok(
      !provisioner.calls.some((c) => c.startsWith('createAppRegistration')),
      'existing registration must be reused',
    );
    assert.equal(store.row?.state, 'installed');
    assert.equal(store.row?.appId, 'app-kept');
    assert.equal(store.row?.lastError, null);
  });

  it('fails the run when no identity row exists', async () => {
    const { runner } = makeRunner({ maxAttempts: 1 });
    const result = await runner.enqueue({ agentId: 'ghost', teamId: 'team-42' });
    assert.equal(result.status, 'failed');
    assert.ok(
      result.status === 'failed' && result.detail.includes("no teams identity row"),
    );
  });
});

// ---------------------------------------------------------------------------
// Typed-error policy
// ---------------------------------------------------------------------------

describe('TeamsProvisioningJobRunner — connector error policy', () => {
  it('ConsentMissingError is terminal: state failed, scopes recorded, no retry', async () => {
    const { runner, store, provisioner } = makeRunner({
      behaviour: {
        createAppRegistration: () =>
          Promise.reject(
            namedError('ConsentMissingError', '403 from Graph', {
              missingScopes: ['Application.ReadWrite.All', 'AppCatalog.ReadWrite.All'],
              resource: 'graph',
            }),
          ),
      },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'failed');
    assert.equal(result.status === 'failed' && result.reason, 'consent_missing');
    assert.equal(store.row?.state, 'failed');
    assert.ok(store.row?.lastError?.includes('Application.ReadWrite.All'));
    assert.ok(store.row?.lastError?.includes('AppCatalog.ReadWrite.All'));
    assert.equal(
      provisioner.calls.filter((c) => c.startsWith('createAppRegistration')).length,
      1,
      'terminal failure must not be retried',
    );
  });

  it("ArmNotConfigured ('registration-only' outcome) keeps app_registered with actionable last_error", async () => {
    const { runner, store } = makeRunner({ behaviour: { createBot: 'registration-only' } });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'halted');
    assert.ok(
      result.status === 'halted' &&
        result.missingSetupFields.includes('azureSubscriptionId'),
    );
    assert.equal(store.row?.state, 'app_registered');
    assert.ok(store.row?.lastError?.includes('arm_not_configured'));
    assert.ok(store.row?.lastError?.includes('azureSubscriptionId'));
    assert.ok(
      store.row?.lastError?.includes('re-run'),
      'last_error must tell the operator how to proceed',
    );
    // The registration survives — nothing is torn down.
    assert.equal(store.row?.appId, 'app-123');
  });

  it('a thrown ArmNotConfiguredError gets the same non-terminal treatment', async () => {
    const { runner, store } = makeRunner({
      behaviour: {
        createBot: () =>
          Promise.reject(
            namedError('ArmNotConfiguredError', 'ARM not configured', {
              missingSetupFields: ['azureSubscriptionId'],
            }),
          ),
      },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'halted');
    assert.equal(store.row?.state, 'app_registered');
    assert.ok(store.row?.lastError?.includes('azureSubscriptionId'));
  });

  it('honors the ProvisioningThrottledError retryAfterSeconds hint', async () => {
    let uploads = 0;
    const { runner, timers } = makeRunner({
      behaviour: {
        uploadToCatalog: () => {
          uploads += 1;
          if (uploads === 1) {
            return Promise.reject(
              namedError('ProvisioningThrottledError', '429 from Graph', {
                resource: 'graph',
                retryAfterSeconds: 7,
              }),
            );
          }
          return undefined;
        },
      },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    assert.deepEqual(timers.delays, [7000], 'the hint, not the default backoff');
  });

  it('falls back to exponential backoff when the throttle carries no hint', async () => {
    let attempts = 0;
    const { runner, timers } = makeRunner({
      baseRetryDelayMs: 1000,
      behaviour: {
        createBot: () => {
          attempts += 1;
          if (attempts <= 2) {
            return Promise.reject(
              namedError('ProvisioningThrottledError', '429', { resource: 'arm' }),
            );
          }
          return undefined;
        },
      },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    assert.deepEqual(timers.delays, [1000, 2000]);
  });

  it('bounds throttle retries, keeps the reached state, and records the reason', async () => {
    const { runner, store, timers } = makeRunner({
      maxAttempts: 3,
      behaviour: {
        installToTeam: () =>
          Promise.reject(
            namedError('ProvisioningThrottledError', '429 from Graph', {
              resource: 'graph',
              retryAfterSeconds: 1,
            }),
          ),
      },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'retries_exhausted');
    assert.equal(timers.delays.length, 2, 'maxAttempts=3 → 2 delays between attempts');
    assert.equal(
      store.row?.state,
      'catalog_uploaded',
      'real progress is kept — throttling is not a provisioning failure',
    );
    assert.ok(store.row?.lastError?.includes('gave up after 3 attempts'));
  });

  it('a missing provisioner service is retryable and never marks the row failed', async () => {
    const { runner, store } = makeRunner({
      maxAttempts: 2,
      getProvisioner: () => {
        throw namedError('TeamsProvisionerUnavailableError', 'connector not installed', {
          code: 'teams_provisioner_unavailable',
        });
      },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'retries_exhausted');
    assert.equal(store.row?.state, 'pending', 'no progress faked, no failed state');
    assert.ok(store.row?.lastError?.includes('connector not installed'));
  });

  it('unknown errors are retried and end in failed after maxAttempts', async () => {
    let calls = 0;
    const { runner, store, timers } = makeRunner({
      maxAttempts: 2,
      behaviour: {
        createAppRegistration: () => {
          calls += 1;
          return Promise.reject(new Error('socket hang up'));
        },
      },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'failed');
    assert.equal(calls, 2);
    assert.equal(timers.delays.length, 1);
    assert.equal(store.row?.state, 'failed');
    assert.ok(store.row?.lastError?.includes('socket hang up'));
  });
});

// ---------------------------------------------------------------------------
// In-process job semantics
// ---------------------------------------------------------------------------

describe('TeamsProvisioningJobRunner — in-process job semantics', () => {
  it('enqueue is deduplicated per agent: a concurrent enqueue joins the run', async () => {
    let release: (() => void) | undefined;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runner, provisioner } = makeRunner({
      behaviour: {
        createAppRegistration: () => parked,
      },
    });
    // First enqueue parks inside createAppRegistration.
    const first = runner.enqueue(REQUEST);
    await Promise.resolve();
    assert.equal(runner.isRunning('agent-1'), true);
    const second = runner.enqueue(REQUEST);
    assert.equal(first, second, 'same in-flight promise, no second chain');
    assert.equal(
      provisioner.calls.filter((c) => c.startsWith('createAppRegistration')).length,
      1,
    );
    // Release the parked step; the run completes normally.
    release!();
    const result = await first;
    assert.equal(result.status, 'installed');
    assert.equal(runner.isRunning('agent-1'), false);
  });

  it('a finished run leaves the runner free for a follow-up enqueue', async () => {
    const { runner, provisioner } = makeRunner();
    const first = await runner.enqueue(REQUEST);
    assert.equal(first.status, 'installed');
    const second = await runner.enqueue(REQUEST);
    assert.equal(second.status, 'installed');
    // Second run is the no-op resume — installToTeam ran exactly once.
    assert.equal(
      provisioner.calls.filter((c) => c.startsWith('installToTeam')).length,
      1,
    );
  });

  it('stop() ends waiting runs without touching the store (BackgroundJob handle)', async () => {
    let failures = 0;
    const store = makeStore();
    const provisioner = makeProvisioner({
      createAppRegistration: () => {
        failures += 1;
        return Promise.reject(
          namedError('ProvisioningThrottledError', '429', {
            resource: 'graph',
            retryAfterSeconds: 60,
          }),
        );
      },
    });
    // Timer seam that never fires: the run parks in its retry sleep — then
    // stop() must release it.
    const runner = new TeamsProvisioningJobRunner({
      store,
      getProvisioner: () => provisioner,
      buildMessagingEndpoint: (slug) =>
        `https://mw.example.com/api/teams/${slug}/messages`,
      loadPackageAssets: async () => ASSETS,
      timers: {
        setTimeout: () => 1, // never fires
        clearTimeout: () => {},
        setInterval: () => 1,
        clearInterval: () => {},
      },
      log: () => {},
    });
    const job = runner.asBackgroundJob();
    assert.equal(job.name, 'teams-identity-provisioning');
    const handle = await job.start();
    const run = runner.enqueue(REQUEST);
    // Let the first attempt fail and the run park in its sleep.
    await new Promise((r) => setImmediate(r));
    await handle.stop();
    const result = await run;
    assert.equal(result.status, 'stopped');
    assert.equal(failures, 1, 'no further attempts after stop');
    assert.equal(store.row?.state, 'pending', 'stop must not fabricate progress');
  });
});

// ---------------------------------------------------------------------------
// Wave-integration hardening (review findings of the W1a unit reviews)
// ---------------------------------------------------------------------------

describe('TeamsProvisioningJobRunner — wave-integration hardening', () => {
  it('caps a ProvisioningThrottledError hint at maxRetryDelayMs', async () => {
    let uploads = 0;
    const { runner, timers } = makeRunner({
      maxRetryDelayMs: 30_000,
      behaviour: {
        uploadToCatalog: () => {
          uploads += 1;
          if (uploads === 1) {
            return Promise.reject(
              namedError('ProvisioningThrottledError', '429 from Graph', {
                resource: 'graph',
                // An hour-scale hint (and far beyond the 32-bit setTimeout
                // ceiling when multiplied) must not park the run.
                retryAfterSeconds: 3_000_000,
              }),
            );
          }
          return undefined;
        },
      },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    assert.deepEqual(
      timers.delays,
      [30_000],
      'the hint is honored only within the configured delay cap',
    );
  });

  it('a stopAll → start cycle re-arms the runner (BackgroundJobRegistry restart)', async () => {
    const { runner, provisioner } = makeRunner();
    const job = runner.asBackgroundJob();
    const handle = await job.start();
    await handle.stop();
    const stopped = await runner.enqueue(REQUEST);
    assert.equal(stopped.status, 'stopped', 'stopped runner refuses work');
    // Registry restart: start() must clear the stop flag.
    await job.start();
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    assert.ok(
      provisioner.calls.some((c) => c.startsWith('installToTeam')),
      'the re-armed runner drives the chain again',
    );
  });

  it('a concurrent enqueue for a DIFFERENT team is rejected, never handed the in-flight result', async () => {
    let release: (() => void) | undefined;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runner, provisioner } = makeRunner({
      behaviour: { createAppRegistration: () => parked },
    });
    const first = runner.enqueue(REQUEST);
    await Promise.resolve();
    const conflicting = await runner.enqueue({
      agentId: REQUEST.agentId,
      teamId: 'team-OTHER',
    });
    assert.equal(conflicting.status, 'rejected');
    assert.ok(
      conflicting.status === 'rejected' && conflicting.reason === 'team_conflict',
    );
    release!();
    const result = await first;
    assert.equal(result.status, 'installed');
    // Exactly one install, and it targeted the FIRST request's team.
    const installs = provisioner.calls.filter((c) => c.startsWith('installToTeam'));
    assert.deepEqual(installs, ['installToTeam:team-42:catalog-77']);
  });

  it('stop() during an in-flight accessor call ends the run at the next step boundary', async () => {
    let release: (() => void) | undefined;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runner, store, provisioner } = makeRunner({
      behaviour: { createAppRegistration: () => parked },
    });
    const run = runner.enqueue(REQUEST);
    await Promise.resolve();
    runner.stop();
    release!();
    const result = await run;
    assert.equal(result.status, 'stopped');
    // Step 1 completed (its own store write lands), but no later step ran.
    assert.equal(store.row?.state, 'app_registered');
    assert.equal(
      provisioner.calls.filter((c) => c.startsWith('createBot')).length,
      0,
      'no step starts after stop()',
    );
  });
});

// ---------------------------------------------------------------------------
// last_error classifier (W2a, epic #860)
//
// The point of colocating these with the producers: the runner is the only
// writer of last_error, and the operator UI renders from the DECODED form.
// If someone edits a sentence and forgets the classifier, these round-trips
// fail HERE instead of the UI quietly degrading to raw English in production.
// ---------------------------------------------------------------------------

describe('classifyTeamsProvisioningError', () => {
  it('round-trips the consent_missing sentence the runner writes', async () => {
    const scopes = ['Application.ReadWrite.All', 'AppCatalog.ReadWrite.All'];
    const { runner, store } = makeRunner({
      behaviour: {
        createAppRegistration: () =>
          Promise.reject(
            namedError('ConsentMissingError', '403 from Graph', {
              missingScopes: scopes,
              resource: 'graph',
            }),
          ),
      },
    });
    await runner.enqueue(REQUEST);
    const raw = store.row?.lastError;
    assert.ok(raw, 'the runner must have recorded a last_error');
    assert.deepEqual(classifyTeamsProvisioningError(raw), {
      code: 'consent_missing',
      scopes,
      raw,
    });
  });

  it('round-trips the arm_not_configured sentence the runner writes', async () => {
    const { runner, store } = makeRunner({
      behaviour: { createBot: 'registration-only' },
    });
    await runner.enqueue(REQUEST);
    const raw = store.row?.lastError;
    assert.ok(raw, 'the runner must have recorded a last_error');
    const detail = classifyTeamsProvisioningError(raw);
    assert.equal(detail.code, 'arm_not_configured');
    assert.ok(
      detail.fields?.includes('azureSubscriptionId'),
      'the missing setup fields must survive the round-trip',
    );
    assert.equal(detail.raw, raw);
  });

  it('round-trips the throttled sentence incl. the Retry-After hint', async () => {
    const { runner, store } = makeRunner({
      maxAttempts: 2,
      behaviour: {
        installToTeam: () =>
          Promise.reject(
            namedError('ProvisioningThrottledError', '429 from Graph', {
              resource: 'graph',
              retryAfterSeconds: 42,
            }),
          ),
      },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'retries_exhausted');
    const raw = store.row?.lastError;
    assert.ok(raw, 'the runner must have recorded a last_error');
    assert.deepEqual(classifyTeamsProvisioningError(raw), {
      code: 'throttled',
      retryAfterSeconds: 42,
      raw,
    });
  });

  it('omits retryAfterSeconds when the connector gave no hint', () => {
    const raw = throttledDetail('429', 3);
    assert.deepEqual(classifyTeamsProvisioningError(raw), { code: 'throttled', raw });
  });

  it('maps the empty-field sentinel back to an empty list', () => {
    const detail = classifyTeamsProvisioningError(armNotConfiguredDetail([]));
    assert.equal(detail.code, 'arm_not_configured');
    assert.deepEqual(detail.fields, []);
  });

  it('keeps scopes an empty list when the connector named none', () => {
    const detail = classifyTeamsProvisioningError(consentMissingDetail([]));
    assert.equal(detail.code, 'consent_missing');
    assert.deepEqual(detail.scopes, []);
  });

  it('is total: unrecognized sentences classify as unknown with the raw text kept', () => {
    for (const raw of [
      'enqueue_failed: queue down',
      'boom (gave up after 3 attempts)',
      '',
      'consent missing but not the code prefix',
    ]) {
      assert.deepEqual(classifyTeamsProvisioningError(raw), { code: 'unknown', raw });
    }
  });
});
