/**
 * The delegated catalog upload in the provisioning chain (byte5ai/omadia#924).
 *
 * WHAT THESE PIN, and why each is a regression no render assertion would catch:
 *
 *   - THE UPLOAD ACTUALLY GOES DELEGATED. `POST /appCatalogs/teamsApps` is
 *     delegated-only at Microsoft, so a chain that quietly kept calling the
 *     app-only `uploadToCatalog` would compile, pass every older test, and
 *     fail in every real tenant.
 *   - A ROTATED TOKEN IS PERSISTED. If `refreshed === true` and we do not
 *     write, the refresh token in the vault is already spent and the tenant is
 *     silently signed out until someone investigates a later failure.
 *   - NOT SIGNED IN PARKS, IT DOES NOT FAIL. The Entra app, the Azure bot and
 *     the built package are all real by then. A run that fell to `failed`
 *     because nobody had signed in yet would throw that evidence away and send
 *     an operator hunting a fault that does not exist.
 *   - THE FOUR ERRORS STAY FOUR. Each one sends the operator somewhere else —
 *     start a sign-in, send an admin to a consent URL, sign in again, or go
 *     fix the publisher app. A collapsed code is a dead end on screen.
 *   - THE REFRESHABLE EXPIRY NEVER REACHES A HUMAN. It is recovered in place.
 *   - AN OLDER CONNECTOR STILL WORKS. Feature detection, not configuration.
 *   - NO TOKEN IN THE PROGRESS LOG. The `detail` column is read by a screen.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { TimerSeam } from '../src/plugins/jobScheduler.js';
import type { DelegatedTokenSet } from '../src/platform/teamsDelegatedSignIn.js';
import {
  classifyTeamsProvisioningError,
  DELEGATED_TOKEN_REFRESHED_DETAIL,
  DELEGATED_UPLOAD_DETAIL,
  TeamsProvisioningJobRunner,
  type ProvisioningRunResult,
  type TeamsAppPackageAssets,
  type TeamsDelegatedTokenPort,
  type TeamsIdentityJobRecord,
  type TeamsIdentityJobStore,
  type TeamsIdentityJobUpdate,
  type TeamsProvisioningEventSink,
  type TeamsProvisionerPort,
} from '../src/services/teamsProvisioningJob.js';

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function immediateTimers(): TimerSeam {
  return {
    setTimeout(cb) {
      cb();
      return 0;
    },
    clearTimeout() {},
    setInterval() {
      throw new Error('runner must not use setInterval');
    },
    clearInterval() {},
  };
}

class FakeStore implements TeamsIdentityJobStore {
  public row: TeamsIdentityJobRecord;
  public readonly patches: TeamsIdentityJobUpdate[] = [];

  constructor(overrides: Partial<TeamsIdentityJobRecord> = {}) {
    this.row = {
      agentId: 'agent-1',
      botSlug: 'hr',
      displayName: 'HR Bot',
      state: 'pending',
      appId: null,
      tenantId: null,
      teamsAppId: null,
      teamsAppExternalId: null,
      lastError: null,
      ...overrides,
    };
  }

  getByAgentId(): Promise<TeamsIdentityJobRecord | undefined> {
    return Promise.resolve(this.row);
  }

  update(
    _agentId: string,
    patch: TeamsIdentityJobUpdate,
  ): Promise<TeamsIdentityJobRecord> {
    this.patches.push(patch);
    this.row = { ...this.row, ...patch } as TeamsIdentityJobRecord;
    return Promise.resolve(this.row);
  }
}

class RecordingEvents implements TeamsProvisioningEventSink {
  public readonly written: {
    step: string;
    status: string;
    detail?: string | null;
  }[] = [];

  record(input: {
    step: string;
    status: string;
    detail?: string | null;
  }): Promise<unknown> {
    this.written.push({
      step: input.step,
      status: input.status,
      detail: input.detail ?? null,
    });
    return Promise.resolve(undefined);
  }

  clearForAgent(): Promise<unknown> {
    return Promise.resolve(undefined);
  }
}

class FakeCustody implements TeamsDelegatedTokenPort {
  public writes: DelegatedTokenSet[] = [];

  constructor(private current: DelegatedTokenSet | undefined) {}

  read(): Promise<DelegatedTokenSet | undefined> {
    return Promise.resolve(this.current);
  }

  write(tokens: DelegatedTokenSet): Promise<void> {
    this.writes.push(tokens);
    this.current = tokens;
    return Promise.resolve();
  }
}

function tokens(overrides: Partial<DelegatedTokenSet> = {}): DelegatedTokenSet {
  return {
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scopes: ['AppCatalog.Submit'],
    clientId: 'client-1',
    tenantId: 'tenant-1',
    ...overrides,
  };
}

const ASSETS: TeamsAppPackageAssets = {
  manifestTemplate: '{}',
  params: {},
  icons: { color: new Uint8Array([1]), outline: new Uint8Array([2]) },
  externalId: 'external-1',
};

interface ProvisionerOverrides {
  readonly delegated?: TeamsProvisionerPort['uploadToCatalogDelegated'];
  readonly refresh?: TeamsProvisionerPort['refreshDelegatedToken'];
  readonly appOnlyUploads?: string[];
}

/** A provisioner whose earlier steps always succeed, so every test below is
 *  about the catalog step and nothing else. */
function provisioner(overrides: ProvisionerOverrides = {}): TeamsProvisionerPort {
  const base: TeamsProvisionerPort = {
    createAppRegistration: () =>
      Promise.resolve({
        outcome: 'created',
        value: { appId: 'app-1', registration: { tenantId: 'tenant-1' } },
      }),
    createBot: () =>
      Promise.resolve({
        kind: 'provisioned',
        bot: { outcome: 'created', value: { botName: 'omadia-hr-app1' } },
      }),
    buildAppPackage: () => new Uint8Array([9, 9, 9]),
    uploadToCatalog: ({ externalId }) => {
      overrides.appOnlyUploads?.push(externalId);
      return Promise.resolve({
        outcome: 'created',
        value: { teamsAppId: 'teams-app-app-only' },
      });
    },
    getCatalogApp: () => Promise.resolve({ found: false }),
    installToTeam: () =>
      Promise.resolve({
        outcome: 'created',
        value: { teamId: 'team-1', teamsAppId: 'teams-app-1' },
      }),
  };
  return {
    ...base,
    ...(overrides.delegated ? { uploadToCatalogDelegated: overrides.delegated } : {}),
    ...(overrides.refresh ? { refreshDelegatedToken: overrides.refresh } : {}),
  };
}

interface RunnerParts {
  readonly store: FakeStore;
  readonly events: RecordingEvents;
  readonly custody: FakeCustody;
  readonly run: () => Promise<ProvisioningRunResult>;
}

function makeRunner(input: {
  readonly provisioner: TeamsProvisionerPort;
  readonly custody?: FakeCustody;
  readonly store?: FakeStore;
  /** Seamed so "is this token nearly spent?" is testable without waiting an
   *  hour. Absent = the real clock, i.e. production behaviour. */
  readonly now?: () => Date;
}): RunnerParts {
  const store = input.store ?? new FakeStore();
  const events = new RecordingEvents();
  const custody = input.custody ?? new FakeCustody(tokens());
  const runner = new TeamsProvisioningJobRunner({
    store,
    events,
    delegatedTokens: custody,
    getProvisioner: () => input.provisioner,
    buildMessagingEndpoint: (slug) => `https://omadia.test/api/teams/${slug}/messages`,
    loadPackageAssets: () => Promise.resolve(ASSETS),
    timers: immediateTimers(),
    maxAttempts: 2,
    baseRetryDelayMs: 0,
    ...(input.now ? { now: input.now } : {}),
    log: () => undefined,
  });
  return {
    store,
    events,
    custody,
    run: () => runner.enqueue({ agentId: 'agent-1', teamId: 'team-1' }),
  };
}

/** Build a connector-shaped error: name + fields, no shared class — exactly
 *  how it crosses the plugin boundary in production. */
function connectorError(
  name: string,
  fields: Record<string, unknown> = {},
  message = 'connector says no',
): Error {
  const err = new Error(message);
  err.name = name;
  return Object.assign(err, fields);
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('#924 the chain uploads through the tenant sign-in', () => {
  it('calls uploadToCatalogDelegated with the stored tokens, not uploadToCatalog', async () => {
    const appOnlyUploads: string[] = [];
    let seen: DelegatedTokenSet | undefined;
    const parts = makeRunner({
      provisioner: provisioner({
        appOnlyUploads,
        delegated: (input) => {
          seen = input.tokens;
          return Promise.resolve({
            app: { value: { teamsAppId: 'teams-app-delegated' } },
            tokens: input.tokens,
            refreshed: false,
          });
        },
      }),
    });

    const result = await parts.run();
    assert.equal(result.status, 'installed');
    // The app-only call is the one Microsoft refuses — it must not have run.
    assert.deepEqual(appOnlyUploads, []);
    assert.equal(seen?.accessToken, 'at');
    assert.equal(parts.store.row.teamsAppId, 'teams-app-delegated');
  });

  it('records the delegated upload in the timeline without naming a credential', async () => {
    const parts = makeRunner({
      provisioner: provisioner({
        delegated: (input) =>
          Promise.resolve({
            app: { value: { teamsAppId: 'teams-app-delegated' } },
            tokens: input.tokens,
            refreshed: false,
          }),
      }),
    });
    await parts.run();

    const catalog = parts.events.written.filter((e) => e.step === 'catalog_uploaded');
    assert.ok(
      catalog.some((e) => e.status === 'progress' && e.detail === DELEGATED_UPLOAD_DETAIL),
      'the operator gets a line saying the upload runs on the tenant sign-in',
    );
    // The whole progress log, searched: a token or an account name in this
    // column would be rendered on a screen and stored for the run's lifetime.
    const serialized = JSON.stringify(parts.events.written);
    for (const secret of ['"at"', 'rt', 'tenant-1', 'client-1']) {
      assert.equal(
        serialized.includes(`"detail":"${secret}`),
        false,
        `progress detail leaked ${secret}`,
      );
    }
  });

  it('persists a rotated token set the moment the connector reports one', async () => {
    const rotated = tokens({ accessToken: 'at-2', refreshToken: 'rt-2' });
    const parts = makeRunner({
      provisioner: provisioner({
        delegated: () =>
          Promise.resolve({
            app: { value: { teamsAppId: 'teams-app-delegated' } },
            tokens: rotated,
            refreshed: true,
          }),
      }),
    });
    await parts.run();

    assert.equal(parts.custody.writes.length, 1);
    assert.equal(parts.custody.writes[0]?.accessToken, 'at-2');
    assert.ok(
      parts.events.written.some(
        (e) => e.detail === DELEGATED_TOKEN_REFRESHED_DETAIL,
      ),
      'a silent rotation is worth one line — it is a pause with no fault behind it',
    );
  });

  it('an older connector keeps using the app-only upload', async () => {
    const appOnlyUploads: string[] = [];
    // No `uploadToCatalogDelegated` at all — the pre-0.6.0 shape.
    const parts = makeRunner({ provisioner: provisioner({ appOnlyUploads }) });
    const result = await parts.run();
    assert.equal(result.status, 'installed');
    assert.deepEqual(appOnlyUploads, ['external-1']);
  });
});

// ---------------------------------------------------------------------------
// Parking
// ---------------------------------------------------------------------------

describe('#924 a run with nobody signed in parks, resumably', () => {
  it('halts instead of failing, and keeps the state it reached', async () => {
    const parts = makeRunner({
      provisioner: provisioner({
        delegated: () => {
          throw new Error('must not be called without tokens');
        },
      }),
      custody: new FakeCustody(undefined),
    });

    const result = await parts.run();
    assert.equal(result.status, 'halted');
    assert.equal(
      result.status === 'halted' ? result.reason : null,
      'delegated_sign_in_required',
    );
    // The evidence of three completed steps survives — that is what makes the
    // next run resume here instead of re-walking the chain.
    assert.equal(parts.store.row.state, 'package_built');
    assert.equal(parts.store.row.appId, 'app-1');
    // No patch anywhere in the run may have written `failed`.
    assert.equal(
      parts.store.patches.some((p) => p.state === 'failed'),
      false,
      'a missing sign-in is a missing human action, not a failure',
    );
  });

  it('explains itself in last_error, decodable back to a code the UI switches on', async () => {
    const parts = makeRunner({
      provisioner: provisioner({ delegated: () => Promise.reject(new Error('x')) }),
      custody: new FakeCustody(undefined),
    });
    await parts.run();

    const raw = parts.store.row.lastError;
    assert.ok(raw, 'the operator is told why nothing is moving');
    assert.equal(
      classifyTeamsProvisioningError(raw).code,
      'delegated_sign_in_required',
    );
  });

  it('resumes and completes once a sign-in exists', async () => {
    const custody = new FakeCustody(undefined);
    const prov = provisioner({
      delegated: (input) =>
        Promise.resolve({
          app: { value: { teamsAppId: 'teams-app-delegated' } },
          tokens: input.tokens,
          refreshed: false,
        }),
    });
    const store = new FakeStore();

    const first = makeRunner({ provisioner: prov, custody, store });
    assert.equal((await first.run()).status, 'halted');

    // The admin signs in. Nothing else changes — same row, same connector.
    await custody.write(tokens());
    const second = makeRunner({ provisioner: prov, custody, store });
    const result = await second.run();

    assert.equal(result.status, 'installed');
    assert.equal(store.row.state, 'installed');
    assert.equal(store.row.lastError, null);
  });
});

// ---------------------------------------------------------------------------
// The four errors
// ---------------------------------------------------------------------------

describe('#924 the four delegated errors stay distinguishable', () => {
  /** Drive one connector error through the chain and report what came out. */
  async function runWith(err: Error): Promise<{
    readonly result: ProvisioningRunResult;
    readonly store: FakeStore;
  }> {
    const parts = makeRunner({
      provisioner: provisioner({ delegated: () => Promise.reject(err) }),
    });
    return { result: await parts.run(), store: parts.store };
  }

  it('DelegatedSignInRequiredError → park, "sign in"', async () => {
    const { result, store } = await runWith(
      connectorError('DelegatedSignInRequiredError', {
        step: 'catalog-upload',
        requiredScopes: ['AppCatalog.Submit'],
      }),
    );
    assert.equal(result.status, 'halted');
    const detail = classifyTeamsProvisioningError(store.row.lastError ?? '');
    assert.equal(detail.code, 'delegated_sign_in_required');
    // The scopes survive the round trip, so the panel can name them.
    assert.deepEqual(detail.scopes, ['AppCatalog.Submit']);
    assert.notEqual(store.row.state, 'failed');
  });

  it('DelegatedConsentRequiredError → park, and the consent URL comes back out', async () => {
    const url = 'https://login.microsoftonline.com/tenant-1/adminconsent?client_id=x';
    const { result, store } = await runWith(
      connectorError('DelegatedConsentRequiredError', {
        requiredScopes: ['AppCatalog.Submit'],
        adminConsentUrl: url,
      }),
    );
    assert.equal(result.status, 'halted');
    const detail = classifyTeamsProvisioningError(store.row.lastError ?? '');
    assert.equal(detail.code, 'delegated_consent_required');
    // Without this the operator is told to "grant consent" with nowhere to go.
    assert.equal(detail.adminConsentUrl, url);
  });

  it('a non-https consent URL is dropped rather than rendered as a link', async () => {
    const { store } = await runWith(
      connectorError('DelegatedConsentRequiredError', {
        requiredScopes: [],
        adminConsentUrl: 'javascript:alert(1)',
      }),
    );
    const detail = classifyTeamsProvisioningError(store.row.lastError ?? '');
    assert.equal(detail.code, 'delegated_consent_required');
    assert.equal(detail.adminConsentUrl, undefined);
  });

  it('DelegatedTokenExpiredError (refresh-token-invalid) → park, "sign in AGAIN"', async () => {
    const { result, store } = await runWith(
      connectorError('DelegatedTokenExpiredError', {
        reason: 'refresh-token-invalid',
        recoverableByRefresh: false,
      }),
    );
    assert.equal(result.status, 'halted');
    // Its OWN code: "your sign-in expired" and "nobody ever signed in" send an
    // operator to the same button for different reasons, and only one of them
    // is worth investigating.
    assert.equal(
      classifyTeamsProvisioningError(store.row.lastError ?? '').code,
      'delegated_token_expired',
    );
  });

  it('DeviceCodeFlowError → terminal, "go look at the publisher app"', async () => {
    const { result, store } = await runWith(
      connectorError(
        'DeviceCodeFlowError',
        { oauthError: 'invalid_client', status: 400 },
        'the tenant refuses device-code flows',
      ),
    );
    assert.equal(result.status, 'failed');
    assert.equal(
      result.status === 'failed' ? result.reason : null,
      'device_code_flow_failed',
    );
    // Terminal on purpose: the flow is refused by configuration, so retrying
    // it produces the same refusal five times over.
    assert.equal(store.row.state, 'failed');
    const detail = classifyTeamsProvisioningError(store.row.lastError ?? '');
    assert.equal(detail.code, 'device_code_flow_failed');
    assert.equal(detail.reason, 'invalid_client');
  });

  it('all four classify to four different codes', async () => {
    const codes = new Set<string>();
    for (const err of [
      connectorError('DelegatedSignInRequiredError'),
      connectorError('DelegatedConsentRequiredError'),
      connectorError('DelegatedTokenExpiredError', { recoverableByRefresh: false }),
      connectorError('DeviceCodeFlowError'),
    ]) {
      const { store } = await runWith(err);
      codes.add(classifyTeamsProvisioningError(store.row.lastError ?? '').code);
    }
    assert.equal(codes.size, 4, `expected four distinct codes, got ${[...codes].join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// The one error a human must never see
// ---------------------------------------------------------------------------

describe('#924 a refreshable expiry never reaches the operator', () => {
  it('refreshes in place, retries once, and finishes installed', async () => {
    let uploadCalls = 0;
    let refreshCalls = 0;
    const parts = makeRunner({
      provisioner: provisioner({
        delegated: (input) => {
          uploadCalls += 1;
          if (uploadCalls === 1) {
            return Promise.reject(
              connectorError('DelegatedTokenExpiredError', {
                reason: 'access-token-expired',
                recoverableByRefresh: true,
              }),
            );
          }
          return Promise.resolve({
            app: { value: { teamsAppId: 'teams-app-delegated' } },
            tokens: input.tokens,
            refreshed: false,
          });
        },
        refresh: () => {
          refreshCalls += 1;
          return Promise.resolve(tokens({ accessToken: 'at-refreshed' }));
        },
      }),
    });

    const result = await parts.run();
    assert.equal(result.status, 'installed');
    assert.equal(refreshCalls, 1);
    assert.equal(uploadCalls, 2);
    // The rotation is persisted, and the second upload used it.
    assert.equal(parts.custody.writes.at(-1)?.accessToken, 'at-refreshed');
    // Nothing was ever written to last_error: the operator saw no failure at all.
    assert.equal(parts.store.row.lastError, null);
  });

  it('a refresh that itself fails becomes the visible "sign in again"', async () => {
    const parts = makeRunner({
      provisioner: provisioner({
        delegated: () =>
          Promise.reject(
            connectorError('DelegatedTokenExpiredError', {
              reason: 'access-token-expired',
              recoverableByRefresh: true,
            }),
          ),
        refresh: () =>
          Promise.reject(
            connectorError('DelegatedTokenExpiredError', {
              reason: 'refresh-token-invalid',
              recoverableByRefresh: false,
            }),
          ),
      }),
    });

    const result = await parts.run();
    assert.equal(result.status, 'halted');
    assert.equal(
      classifyTeamsProvisioningError(parts.store.row.lastError ?? '').code,
      'delegated_token_expired',
    );
  });
});

// ---------------------------------------------------------------------------
// Refreshing BEFORE the call, not after it failed
// ---------------------------------------------------------------------------

/**
 * The reactive path works, but it can only run once an upload has already
 * failed: a package re-sent, and a recovery that hinges on the failure being
 * classified exactly as "expired". If Graph answers with anything else — or a
 * connector labels it differently — a run dies for a reason no human needs to
 * fix. Reading the clock before the call removes that whole class of failure.
 *
 * What is pinned here is the SHAPE of the guarantee, not the margin's value:
 * a token well inside its life is left alone, one inside the margin is
 * refreshed first, a rotation is persisted immediately, the reactive path
 * survives as the fallback it is — and a failing pre-emptive refresh is never
 * worse than not having tried.
 */
describe('#924 the runner refreshes before it spends a token', () => {
  const NOW = new Date('2026-08-28T12:00:00.000Z');
  const at = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();

  function delegatedSeeing(
    seen: DelegatedTokenSet[],
  ): NonNullable<TeamsProvisionerPort['uploadToCatalogDelegated']> {
    return (input: { tokens: DelegatedTokenSet }) => {
      seen.push(input.tokens);
      return Promise.resolve({
        app: { value: { teamsAppId: 'teams-app-delegated' } },
        tokens: input.tokens,
        refreshed: false,
      });
    };
  }

  it('leaves a token that is comfortably alive alone', async () => {
    const refreshes: number[] = [];
    const parts = makeRunner({
      now: () => NOW,
      custody: new FakeCustody(tokens({ expiresAt: at(30 * 60_000) })),
      provisioner: provisioner({
        delegated: delegatedSeeing([]),
        refresh: () => {
          refreshes.push(1);
          return Promise.resolve(tokens());
        },
      }),
    });
    const result = await parts.run();

    assert.equal(result.status, 'installed');
    // Half an hour of life left. Refreshing here would spend a rotation of the
    // refresh token on every single run, which is the cost that decides the
    // margin's size.
    assert.deepEqual(refreshes, []);
    assert.equal(parts.custody.writes.length, 0);
  });

  it('refreshes a token inside the margin and uploads with the NEW one', async () => {
    const seen: DelegatedTokenSet[] = [];
    const rotated = tokens({ accessToken: 'at-fresh', expiresAt: at(60 * 60_000) });
    const parts = makeRunner({
      now: () => NOW,
      // Two minutes left: not expired, so nothing would have failed — and
      // that is exactly the window the reactive path cannot see.
      custody: new FakeCustody(tokens({ expiresAt: at(2 * 60_000) })),
      provisioner: provisioner({
        delegated: delegatedSeeing(seen),
        refresh: () => Promise.resolve(rotated),
      }),
    });
    const result = await parts.run();

    assert.equal(result.status, 'installed');
    // The upload must ride on the refreshed set, or the refresh was pointless.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.accessToken, 'at-fresh');
    // Persisted BEFORE the upload: a rotation the vault never saw is a refresh
    // token already spent, and a crash here would sign the tenant out silently.
    assert.equal(parts.custody.writes.length, 1);
    assert.equal(parts.custody.writes[0]?.accessToken, 'at-fresh');
    assert.ok(
      parts.events.written.some((e) => e.detail === DELEGATED_TOKEN_REFRESHED_DETAIL),
    );
  });

  it('refreshes a token that is already past its expiry', async () => {
    const seen: DelegatedTokenSet[] = [];
    const parts = makeRunner({
      now: () => NOW,
      custody: new FakeCustody(tokens({ expiresAt: at(-60_000) })),
      provisioner: provisioner({
        delegated: delegatedSeeing(seen),
        refresh: () => Promise.resolve(tokens({ accessToken: 'at-fresh' })),
      }),
    });

    assert.equal((await parts.run()).status, 'installed');
    assert.equal(seen[0]?.accessToken, 'at-fresh');
  });

  it('carries on with the stored token when the pre-emptive refresh fails', async () => {
    const seen: DelegatedTokenSet[] = [];
    const parts = makeRunner({
      now: () => NOW,
      custody: new FakeCustody(tokens({ expiresAt: at(-60_000) })),
      provisioner: provisioner({
        delegated: delegatedSeeing(seen),
        refresh: () => Promise.reject(new Error('token endpoint unreachable')),
      }),
    });
    const result = await parts.run();

    // OUR clock may be the thing that is wrong. A token we wrongly believed
    // spent can work perfectly — and when it does not, the reactive path
    // below takes over. The worst case of trying is today's behaviour.
    assert.equal(result.status, 'installed');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.accessToken, 'at');
    assert.equal(parts.custody.writes.length, 0);
  });

  it('keeps the REACTIVE path for a token the server killed early', async () => {
    // Valid by the clock, dead at Microsoft — a revoked session, a password
    // change, a Conditional Access policy. No expiry arithmetic sees this
    // coming, which is why the fallback is not dead code.
    const seen: DelegatedTokenSet[] = [];
    let firstCall = true;
    const parts = makeRunner({
      now: () => NOW,
      custody: new FakeCustody(tokens({ expiresAt: at(45 * 60_000) })),
      provisioner: provisioner({
        delegated: (input) => {
          if (firstCall) {
            firstCall = false;
            return Promise.reject(
              connectorError('DelegatedTokenExpiredError', {
                reason: 'access-token-expired',
                recoverableByRefresh: true,
              }),
            );
          }
          seen.push(input.tokens);
          return Promise.resolve({
            app: { value: { teamsAppId: 'teams-app-delegated' } },
            tokens: input.tokens,
            refreshed: false,
          });
        },
        refresh: () => Promise.resolve(tokens({ accessToken: 'at-recovered' })),
      }),
    });
    const result = await parts.run();

    assert.equal(result.status, 'installed');
    assert.equal(seen[0]?.accessToken, 'at-recovered');
    assert.equal(parts.custody.writes.length, 1);
    assert.equal(parts.custody.writes[0]?.accessToken, 'at-recovered');
  });

  it('does not try to refresh against a connector that cannot', async () => {
    // Pre-0.6.0: no `refreshDelegatedToken`. Feature-detected, never called
    // blind — an expired token there still needs a human, as it always did.
    const seen: DelegatedTokenSet[] = [];
    const parts = makeRunner({
      now: () => NOW,
      custody: new FakeCustody(tokens({ expiresAt: at(-60_000) })),
      provisioner: provisioner({ delegated: delegatedSeeing(seen) }),
    });

    assert.equal((await parts.run()).status, 'installed');
    assert.equal(seen[0]?.accessToken, 'at');
    assert.equal(parts.custody.writes.length, 0);
  });
});
