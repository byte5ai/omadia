import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { TimerSeam } from '../src/plugins/jobScheduler.js';
import {
  armNotConfiguredDetail,
  botHandleUnavailableDetail,
  buildBotHandle,
  BOT_HANDLE_MAX_LENGTH,
  classifyTeamsProvisioningError,
  configSyncFailedDetail,
  consentMissingDetail,
  throttledDetail,
  TeamsProvisioningJobRunner,
  type ProvisionTeamsIdentityRequest,
  type TeamsAppPackageAssets,
  type TeamsIdentityJobRecord,
  type TeamsIdentityJobStore,
  type TeamsIdentityJobUpdate,
  type TeamsInstallJobStore,
  type TeamsBotsConfigSyncPort,
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
      // Like the connector: the app id is handed over the moment the
      // registration exists, BEFORE the secret and the service principal.
      await input.onRegistrationCreated?.(
        { appId: 'app-123', tenantId: 'tenant-9' },
        'created',
      );
      calls.push('registrationCreatedNotified');
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

/** Migration 0051 — persisted bindings, in memory. */
class MemoryInstallStore {
  rows: Array<{ agentId: string; teamId: string; teamDisplayName: string | null }> = [];

  get(agentId: string, teamId: string): Promise<{ teamId: string } | undefined> {
    const row = this.rows.find(
      (entry) => entry.agentId === agentId && entry.teamId === teamId,
    );
    return Promise.resolve(row ? { teamId: row.teamId } : undefined);
  }

  record(input: {
    agentId: string;
    teamId: string;
    teamsAppId?: string | null;
    teamDisplayName?: string | null;
  }): Promise<unknown> {
    this.rows.push({
      agentId: input.agentId,
      teamId: input.teamId,
      teamDisplayName: input.teamDisplayName ?? null,
    });
    return Promise.resolve(undefined);
  }
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
  syncBotConfig?: TeamsBotsConfigSyncPort;
  installs?: TeamsInstallJobStore;
  resolveTeamName?: (teamId: string) => Promise<string | null>;
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
    ...(opts.syncBotConfig ? { syncBotConfig: opts.syncBotConfig } : {}),
    ...(opts.installs ? { installs: opts.installs } : {}),
    ...(opts.resolveTeamName ? { resolveTeamName: opts.resolveTeamName } : {}),
    log: () => {},
  });
  return { runner, store, provisioner, timers };
}

/**
 * Let an enqueued run get as far as it can — up to the parked accessor call.
 *
 * A single `await Promise.resolve()` used to be enough because `enqueue`
 * reached the first accessor call in one microtask hop. It is not a property
 * worth pinning: since #915 the run opens its progress log first, so the hop
 * count is an implementation detail that any future step-boundary work will
 * change again. Draining to a MACROTASK expresses what these tests actually
 * mean — "everything that can run without the parked promise, has run" — and
 * stays true however many awaits the prologue grows.
 */
function settleUntilParked(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
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
      // app_id reaches the store here, before the chain moves on (#916).
      'registrationCreatedNotified',
      // #921 — ARM gets the QUALIFIED handle; the endpoint keeps the slug.
      `createBot:${buildBotHandle('hr-bot', 'app-123')}:https://mw.example.com/api/teams/hr-bot/messages`,
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
        `createBot:${buildBotHandle('hr-bot', 'app-123')}:https://mw.example.com/api/teams/hr-bot/messages`,
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
    assert.ok(
      provisioner.calls.some((c) =>
        c.startsWith(`createBot:${buildBotHandle('hr-bot', 'app-old')}`),
      ),
    );
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

  // ── migration 0051: the additional-team run ──────────────────────────
  //
  // Steps 1–4 build the agent's Entra app, bot and catalog entry — all
  // per-AGENT and already done. Only step 5 is per-TEAM. So an `installed`
  // identity asked for a team it is NOT yet bound to must still run that one
  // step, instead of returning the no-op success above.

  it('an installed identity still installs into a team it is not bound to', async () => {
    const installs = new MemoryInstallStore();
    installs.rows.push({
      agentId: 'agent-1',
      teamId: 'team-other',
      teamDisplayName: null,
    });
    const { runner, provisioner } = makeRunner({
      storeOverrides: { state: 'installed', appId: 'a', tenantId: 't', teamsAppId: 'c' },
      installs,
      resolveTeamName: () => Promise.resolve('Marketing'),
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    // Exactly the per-team step — nothing re-registered, nothing re-uploaded.
    assert.deepEqual(provisioner.calls, ['installToTeam:team-42:c']);
    // …and the binding is recorded, with the name resolved while we were there.
    assert.deepEqual(
      installs.rows.map((row) => [row.teamId, row.teamDisplayName]),
      [
        ['team-other', null],
        ['team-42', 'Marketing'],
      ],
    );
  });

  it('a binding that already exists stays a no-op success', async () => {
    const installs = new MemoryInstallStore();
    installs.rows.push({ agentId: 'agent-1', teamId: 'team-42', teamDisplayName: null });
    const { runner, provisioner } = makeRunner({
      storeOverrides: { state: 'installed', appId: 'a', tenantId: 't', teamsAppId: 'c' },
      installs,
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    assert.deepEqual(provisioner.calls, []);
    assert.equal(installs.rows.length, 1);
  });

  it('a failing name lookup never fails a run that installed', async () => {
    const installs = new MemoryInstallStore();
    const { runner } = makeRunner({
      installs,
      resolveTeamName: () => Promise.reject(new Error('graph down')),
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    // The binding is still recorded — nameless, which the UI shows as the id.
    assert.deepEqual(
      installs.rows.map((row) => [row.teamId, row.teamDisplayName]),
      [['team-42', null]],
    );
  });

  it('resumes from failed by re-running the idempotent registration step', async () => {
    // A 'failed' row ranks below app_registered, so step 1 runs again — and
    // that is deliberate since byte5ai/omadia#916: app_id alone is no longer
    // evidence that the step FINISHED (it is now written the moment the
    // registration exists, before the secret). Re-running is safe: the
    // connector adopts the existing registration by its uniqueName.
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
      provisioner.calls.some(
        (c) => c === 'createAppRegistration:omadia-teams-bot-hr-bot',
      ),
      'the step re-runs under the same idempotency key',
    );
    assert.ok(
      provisioner.calls.some((c) => c.startsWith('createBot:')),
      'the chain continues past step 1',
    );
    assert.equal(store.row?.state, 'installed');
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
    // `halted` gained a second shape with #924 (the delegated sign-in parks
    // here too), so the reason has to be narrowed before its payload is read.
    assert.ok(
      result.status === 'halted' &&
        result.reason === 'arm_not_configured' &&
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
    await settleUntilParked();
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
    await settleUntilParked();
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

// ---------------------------------------------------------------------------
// #910 — the `teams_bots` config write that ends the run
//
// The point of these tests is the FAILURE posture, not the happy path: by the
// time this port runs, the Entra app, the Azure bot, the catalog entry and the
// team install all exist in Azure and are this agent's. Failing the run over a
// config write would report a provisioning failure that did not happen.
// ---------------------------------------------------------------------------

describe('TeamsProvisioningJobRunner — teams_bots config sync (#910)', () => {
  it('syncs the identity after reaching installed', async () => {
    const seen: TeamsIdentityJobRecord[] = [];
    const { runner, store } = makeRunner({
      syncBotConfig: async (identity) => {
        seen.push(identity);
        return { status: 'synced' };
      },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    assert.equal(seen.length, 1);
    // The record handed over is the row AFTER the terminal write, so the
    // provisioned app/tenant are on it — a projection built from a pre-install
    // snapshot would be `null` and silently write nothing.
    assert.equal(seen[0]?.state, 'installed');
    assert.ok(seen[0]?.appId);
    assert.ok(seen[0]?.tenantId);
    assert.equal(store.row?.lastError, null);
  });

  it('keeps the run installed and records an ACTIONABLE warning when the write fails', async () => {
    const { runner, store } = makeRunner({
      syncBotConfig: async () => {
        throw new Error('teams_bots setup field is not valid JSON');
      },
    });
    const result = await runner.enqueue(REQUEST);
    // Nothing is rolled back and nothing is retried: the identity is real.
    assert.equal(result.status, 'installed');
    assert.equal(store.row?.state, 'installed');
    const lastError = store.row?.lastError ?? '';
    assert.ok(lastError.startsWith('config_sync_failed:'));
    const detail = classifyTeamsProvisioningError(lastError);
    assert.equal(detail.code, 'config_sync_failed');
    assert.equal(detail.reason, 'teams_bots setup field is not valid JSON');
  });

  it('re-asserts the config on a re-run of an ALREADY installed identity', async () => {
    // The chain has nothing left to do, but an operator may have renamed the
    // agent or deleted the entry from the plugin config — "re-run provisioning"
    // must still end with the bot configured.
    const calls: string[] = [];
    const { runner, store } = makeRunner({
      storeOverrides: {
        state: 'installed',
        displayName: 'HR Bot (Renamed)',
        appId: 'app-1',
        tenantId: 'tenant-1',
        teamsAppId: 'catalog-1',
      },
      syncBotConfig: async (identity) => {
        calls.push(identity.displayName);
        return { status: 'synced' };
      },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    assert.deepEqual(calls, ['HR Bot (Renamed)']);
    // No chain step ran — the early return is still an early return.
    assert.deepEqual(store.updates, []);
  });

  it('retires its OWN stale warning when a re-run finally writes the config', async () => {
    const { runner, store } = makeRunner({
      storeOverrides: {
        state: 'installed',
        appId: 'app-1',
        tenantId: 'tenant-1',
        teamsAppId: 'catalog-1',
        lastError: configSyncFailedDetail('teams_bots was not valid JSON'),
      },
      syncBotConfig: async () => ({ status: 'synced' }),
    });
    await runner.enqueue(REQUEST);
    // Otherwise the operator who followed the warning's own advice ("re-run
    // provisioning to retry the write") would still be staring at it.
    assert.equal(store.row?.lastError, null);
    assert.equal(store.row?.state, 'installed');
  });

  it('does NOT clear an unrelated error it did not write', async () => {
    const stale = consentMissingDetail(['Application.ReadWrite.All']);
    const { runner, store } = makeRunner({
      storeOverrides: {
        state: 'installed',
        appId: 'app-1',
        tenantId: 'tenant-1',
        teamsAppId: 'catalog-1',
        lastError: stale,
      },
      syncBotConfig: async () => ({ status: 'synced' }),
    });
    await runner.enqueue(REQUEST);
    assert.equal(store.row?.lastError, stale);
  });

  it('is a no-op when no sync port is wired (the pre-#910 manual path)', async () => {
    const { runner, store } = makeRunner();
    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    assert.equal(store.row?.lastError, null);
  });

  it('does not turn a skip or a no-op report into an error', async () => {
    for (const report of [
      { status: 'skipped' as const, reason: 'plugin_not_installed' },
      { status: 'unchanged' as const },
    ]) {
      const { runner, store } = makeRunner({ syncBotConfig: async () => report });
      const result = await runner.enqueue(REQUEST);
      assert.equal(result.status, 'installed');
      assert.equal(store.row?.lastError, null);
    }
  });

  it('round-trips the config_sync_failed sentence through its own classifier', () => {
    const detail = classifyTeamsProvisioningError(
      configSyncFailedDetail('registry write failed [boom]\n  twice'),
    );
    assert.equal(detail.code, 'config_sync_failed');
    // Brackets and newlines are stripped by the producer so the `[...]` group
    // the classifier reads can never be cut short by the reason itself.
    assert.equal(detail.reason, 'registry write failed boom twice');
  });

  it('round-trips an empty reason to an empty reason, not to "[]"', () => {
    const detail = classifyTeamsProvisioningError(configSyncFailedDetail('   '));
    assert.equal(detail.code, 'config_sync_failed');
    assert.equal(detail.reason, '');
  });
});

// ---------------------------------------------------------------------------
// byte5ai/omadia#916 — the first real run against the byte5 tenant created an
// Entra app whose id never reached the identity row. The runner could then
// neither find it nor create it again: every retry collided with the
// uniqueName of an app it did not know about.
// ---------------------------------------------------------------------------

describe('TeamsProvisioningJobRunner — app_id is persisted early (#916)', () => {
  it('writes app_id before the rest of the registration step finishes', async () => {
    const { runner, store, provisioner } = makeRunner();
    await runner.enqueue(REQUEST);

    const early = store.updates[0];
    assert.ok(early, 'expected an update before anything else');
    assert.equal(early.appId, 'app-123');
    assert.equal(early.tenantId, 'tenant-9');
    assert.equal(
      early.state,
      undefined,
      'the step is not finished yet — the state must not claim it is',
    );
    // …and it really happened inside the step, not after it returned.
    assert.deepEqual(provisioner.calls.slice(0, 2), [
      'createAppRegistration:omadia-teams-bot-hr-bot',
      'registrationCreatedNotified',
    ]);
  });

  it('an interruption after that write leaves a resumable row, not an orphan', async () => {
    // The exact field failure: the app exists, the chain dies before the
    // secret is stored. The row must carry app_id (so nothing is orphaned)
    // AND still re-run step 1 (so the secret is actually created).
    const boom = (): never => {
      throw new Error('connection reset');
    };
    const first = makeRunner({
      maxAttempts: 1,
      behaviour: { createAppRegistration: boom },
    });
    const failed = await first.runner.enqueue(REQUEST);
    assert.equal(failed.status, 'failed');
    assert.equal(first.store.row?.appId, 'app-123', 'app_id survived');
    assert.equal(first.store.row?.tenantId, 'tenant-9');

    // Resume against a row in exactly that shape.
    const second = makeRunner({
      storeOverrides: { state: 'pending', appId: 'app-123', tenantId: 'tenant-9' },
    });
    const result = await second.runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');
    assert.ok(
      second.provisioner.calls.some((c) =>
        c.startsWith('createAppRegistration:omadia-teams-bot-hr-bot'),
      ),
      'app_id alone must not be read as "step 1 completed"',
    );
  });

  it('a completed step 1 is still skipped on resume', async () => {
    const { runner, provisioner } = makeRunner({
      storeOverrides: { state: 'app_registered', appId: 'app-x', tenantId: 't-x' },
    });
    await runner.enqueue(REQUEST);
    assert.ok(
      !provisioner.calls.some((c) => c.startsWith('createAppRegistration')),
      'state app_registered is the evidence that the step finished',
    );
  });
});

// ---------------------------------------------------------------------------
// byte5ai/omadia#921 — the Azure bot handle namespace is GLOBAL
// ---------------------------------------------------------------------------

describe('buildBotHandle (#921)', () => {
  const APP_ID = '7034c271-6847-4be4-aea4-8b9e0c86fcad';
  /** The grammar the connector enforces (`requireBotName`), mirrored so a
   *  divergence between the composer and the validator fails HERE. */
  const BOT_HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{2,40})[A-Za-z0-9]$/;

  it('qualifies the operator slug with the app id — the fix for the reported failure', () => {
    // `test-hr` is the slug that actually collided on the byte5 tenant.
    assert.equal(buildBotHandle('test-hr', APP_ID), 'omadia-test-hr-7034c271');
  });

  it('produces a handle the connector accepts', () => {
    assert.match(buildBotHandle('test-hr', APP_ID), BOT_HANDLE_RE);
  });

  it('never exceeds the 42-char bound, however long the slug', () => {
    for (const length of [1, 10, 26, 27, 40, 64, 200]) {
      const handle = buildBotHandle('a'.repeat(length), APP_ID);
      assert.ok(
        handle.length <= BOT_HANDLE_MAX_LENGTH,
        `slug of ${String(length)} produced a ${String(handle.length)}-char handle`,
      );
      assert.match(handle, BOT_HANDLE_RE, `slug of ${String(length)} produced ${handle}`);
    }
  });

  it('TRUNCATES THE SLUG, never the unique suffix', () => {
    // The whole point: shortening the unique part would reintroduce the
    // collision the qualification exists to prevent.
    const handle = buildBotHandle('a'.repeat(200), APP_ID);
    assert.equal(handle.length, BOT_HANDLE_MAX_LENGTH);
    assert.ok(handle.endsWith('-7034c271'), `suffix lost in ${handle}`);
  });

  it('keeps long distinct slugs apart via the suffix even when both truncate', () => {
    const long = 'a'.repeat(200);
    const other = '9999aaaa-6847-4be4-aea4-8b9e0c86fcad';
    assert.notEqual(buildBotHandle(long, APP_ID), buildBotHandle(long, other));
  });

  it('folds characters no bot handle may carry into hyphens', () => {
    assert.equal(
      buildBotHandle('Sales & Support (EMEA)!!', APP_ID),
      'omadia-sales-support-emea-7034c271',
    );
    for (const slug of ['HR_Bot', 'hr.bot', 'hr bot', 'hr---bot', 'Ümläut']) {
      assert.match(buildBotHandle(slug, APP_ID), BOT_HANDLE_RE, `slug ${slug}`);
    }
  });

  it('never leaves a trailing or leading hyphen from truncation or trimming', () => {
    // A slug whose 26-char budget lands exactly on a hyphen.
    assert.match(buildBotHandle(`${'x'.repeat(26)}-tail`, APP_ID), BOT_HANDLE_RE);
    for (const slug of ['-hr-', '---', '!!!']) {
      const handle = buildBotHandle(slug, APP_ID);
      assert.match(handle, BOT_HANDLE_RE, `slug ${slug} produced ${handle}`);
    }
  });

  it('degrades to prefix+suffix when the slug normalises away entirely', () => {
    assert.equal(buildBotHandle('!!!', APP_ID), 'omadia-7034c271');
  });

  it('is deterministic — a re-run keeps the ARM upsert idempotent', () => {
    assert.equal(buildBotHandle('test-hr', APP_ID), buildBotHandle('test-hr', APP_ID));
  });

  it('rejects an app id with no hex characters to qualify with', () => {
    assert.throws(() => buildBotHandle('hr', '----'), /cannot build a bot handle/);
  });
});

describe('TeamsProvisioningJobRunner — global bot handle (#921)', () => {
  it('passes the QUALIFIED handle to createBot, not the raw slug', async () => {
    const { runner, provisioner } = makeRunner();
    await runner.enqueue(REQUEST);
    const call = provisioner.calls.find((c) => c.startsWith('createBot:'));
    // Default row: botSlug 'hr-bot', appId from createAppRegistration 'app-123'.
    assert.equal(
      call?.split(':')[1],
      buildBotHandle('hr-bot', 'app-123'),
      'the raw slug must never reach ARM',
    );
    assert.notEqual(call?.split(':')[1], 'hr-bot');
  });

  it('keeps the messaging endpoint keyed on the SLUG, not the handle', async () => {
    // The endpoint is the channel-teams route (`/api/teams/<botSlug>/messages`)
    // — qualifying the ARM handle must not silently re-route inbound traffic.
    const { runner, provisioner } = makeRunner();
    await runner.enqueue(REQUEST);
    const call = provisioner.calls.find((c) => c.startsWith('createBot:')) ?? '';
    assert.ok(
      call.endsWith('https://mw.example.com/api/teams/hr-bot/messages'),
      `endpoint lost the slug: ${call}`,
    );
  });

  it('BotHandleUnavailableError fails on attempt ONE — no retry storm', async () => {
    let attempts = 0;
    const { runner, store, timers } = makeRunner({
      behaviour: {
        createBot: () => {
          attempts += 1;
          return Promise.reject(
            namedError(
              'BotHandleUnavailableError',
              "bot_handle_unavailable: Azure bot handle 'omadia-hr-bot-app-123' is already registered to another bot application.",
              { botName: 'omadia-hr-bot-app-123', status: 400 },
            ),
          );
        },
      },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(attempts, 1, 'a deterministic verdict must not be retried');
    assert.deepEqual(timers.delays, [], 'no backoff sleep may be scheduled');
    assert.equal(result.status, 'failed');
    assert.equal(result.status === 'failed' && result.reason, 'bot_handle_unavailable');
    assert.equal(store.row?.state, 'failed');
    assert.ok(
      !store.row?.lastError?.includes('gave up after'),
      'the operator must not be told we tried five times',
    );
  });

  it('records an operator sentence explaining the GLOBAL namespace', async () => {
    const { runner, store } = makeRunner({
      behaviour: {
        createBot: () =>
          Promise.reject(
            namedError(
              'BotHandleUnavailableError',
              'bot_handle_unavailable: taken. Bot handles share ONE global namespace across all Azure customers. omadia qualifies the handle automatically',
              { botName: 'omadia-hr-bot-app-123', status: 400 },
            ),
          ),
      },
    });
    await runner.enqueue(REQUEST);
    const detail = store.row?.lastError ?? '';
    assert.ok(detail.startsWith('bot_handle_unavailable:'), detail);
    assert.match(detail, /global namespace/i);
    assert.match(detail, /qualifies the handle automatically/i);
    assert.equal(classifyTeamsProvisioningError(detail).code, 'bot_handle_unavailable');
  });

  it('an OLDER connector reporting a bare 400 also stops after one attempt', async () => {
    // Version independence: before the connector learned the typed error, the
    // same condition arrived as an untyped deterministic 4xx.
    let attempts = 0;
    const { runner, store } = makeRunner({
      behaviour: {
        createBot: () => {
          attempts += 1;
          return Promise.reject(
            namedError(
              'ProvisioningRequestError',
              'arm botServices.put 400 PUT https://management.azure.com/... body={"error":{"code":"InvalidBotData"}}',
              { resource: 'arm', step: 'botServices.put', status: 400 },
            ),
          );
        },
      },
    });
    const result = await runner.enqueue(REQUEST);
    assert.equal(attempts, 1);
    assert.equal(result.status, 'failed');
    assert.ok(
      store.row?.lastError?.includes('deterministic'),
      String(store.row?.lastError),
    );
    assert.ok(!store.row?.lastError?.includes('gave up after 5'));
  });

  it('still retries a 5xx — the deterministic guard must not swallow transients', async () => {
    let attempts = 0;
    const { runner } = makeRunner({
      behaviour: {
        createBot: () => {
          attempts += 1;
          return Promise.reject(
            namedError('ProvisioningRequestError', 'arm botServices.put 503', {
              resource: 'arm',
              step: 'botServices.put',
              status: 503,
            }),
          );
        },
      },
    });
    await runner.enqueue(REQUEST);
    assert.ok(attempts > 1, `a 503 must still be retried, saw ${String(attempts)} attempt(s)`);
  });

  it('still retries a 429 — time-dependent, not deterministic', async () => {
    let attempts = 0;
    const { runner } = makeRunner({
      behaviour: {
        createBot: () => {
          attempts += 1;
          return Promise.reject(
            namedError('ProvisioningRequestError', 'arm botServices.put 429', {
              resource: 'arm',
              step: 'botServices.put',
              status: 429,
            }),
          );
        },
      },
    });
    await runner.enqueue(REQUEST);
    assert.ok(attempts > 1, `a 429 must still be retried, saw ${String(attempts)} attempt(s)`);
  });
});

describe('botHandleUnavailableDetail (#921)', () => {
  it('passes a connector sentence through — it already carries the code', () => {
    const connector = 'bot_handle_unavailable: handle taken, rename the slug';
    assert.equal(botHandleUnavailableDetail(connector), connector);
  });

  it('prefixes an older connector sentence so the UI can still switch on it', () => {
    const detail = botHandleUnavailableDetail('400 InvalidBotData', 'omadia-hr-1a2b3c4d');
    assert.ok(detail.startsWith('bot_handle_unavailable:'));
    assert.ok(detail.includes('omadia-hr-1a2b3c4d'));
    assert.equal(classifyTeamsProvisioningError(detail).code, 'bot_handle_unavailable');
  });

  it('round-trips through the classifier with the raw sentence preserved', () => {
    const detail = botHandleUnavailableDetail('bot_handle_unavailable: taken');
    const classified = classifyTeamsProvisioningError(detail);
    assert.equal(classified.code, 'bot_handle_unavailable');
    assert.equal(classified.raw, detail);
  });
});
