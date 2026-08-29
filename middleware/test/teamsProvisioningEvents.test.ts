import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { TimerSeam } from '../src/plugins/jobScheduler.js';
import {
  retryDetail,
  SKIPPED_DETAIL,
  TeamsProvisioningJobRunner,
  type ProvisionTeamsIdentityRequest,
  type TeamsAppPackageAssets,
  type TeamsIdentityJobRecord,
  type TeamsIdentityJobStore,
  type TeamsIdentityJobUpdate,
  type TeamsProvisioningEventSink,
  type TeamsProvisionerPort,
} from '../src/services/teamsProvisioningJob.js';

/**
 * The provisioning progress log (migration 0053, byte5ai/omadia#915).
 *
 * WHAT THESE PIN, and why each one is a regression that no render assertion
 * would catch:
 *
 *   - The ORDER of events. A timeline is only useful if it is true; a `started`
 *     without its `succeeded`, or a step logged after the one that follows it,
 *     tells an operator the opposite of what happened.
 *   - SKIPPED STEPS ARE STILL LOGGED. A resume that silently omits the steps
 *     it re-entered above produces a timeline that starts at step 3, which
 *     reads as two lost steps rather than two finished ones.
 *   - RETRIES CARRY THEIR NUMBERS. The attempt counter and the backoff delay
 *     are the copy the operator actually needs during the minutes this feature
 *     exists to explain, and they are structured arguments — not a sentence
 *     the UI would have to parse.
 *   - A BROKEN SINK CANNOT KILL A RUN. The log is decoration; a run that
 *     failed because its diary could not be written would be an outage
 *     manufactured by an observability feature.
 *   - `failed` IS NEVER `running` (#915). The terminal state is committed to
 *     Postgres a driver round trip before the runner's own continuation
 *     resumes, and a status request served in that gap used to read
 *     `state: 'failed', running: true`. The fix is ordering inside the runner,
 *     so it is asserted from a MACROTASK observer — the same vantage point an
 *     Express handler has.
 */

// ---------------------------------------------------------------------------
// Test doubles
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

interface RecordedEvent {
  readonly step: string;
  readonly status: string;
  readonly attempt: number | null;
  readonly detail: string | null;
}

interface MemoryEventSink extends TeamsProvisioningEventSink {
  readonly events: RecordedEvent[];
  readonly clears: string[];
}

function makeSink(): MemoryEventSink {
  const events: RecordedEvent[] = [];
  const clears: string[] = [];
  return {
    events,
    clears,
    record(input) {
      events.push({
        step: input.step,
        status: input.status,
        attempt: input.attempt ?? null,
        detail: input.detail ?? null,
      });
      return Promise.resolve(undefined);
    },
    clearForAgent(agentId) {
      clears.push(agentId);
      return Promise.resolve(undefined);
    },
  };
}

/** A sink that fails at everything — the "my diary is broken" fixture. */
function makeBrokenSink(): TeamsProvisioningEventSink {
  return {
    record() {
      return Promise.reject(new Error('events table is unreachable'));
    },
    clearForAgent() {
      return Promise.reject(new Error('events table is unreachable'));
    },
  };
}

interface MemoryStore extends TeamsIdentityJobStore {
  row: TeamsIdentityJobRecord | undefined;
}

function makeStore(
  overrides: Partial<TeamsIdentityJobRecord> = {},
  hooks: {
    /** Runs AFTER the patch is applied but BEFORE `update` resolves — the
     *  window in which a committed row is already readable while the runner
     *  is still suspended. */
    readonly afterApply?: (patch: TeamsIdentityJobUpdate) => Promise<void>;
  } = {},
): MemoryStore {
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
      ...overrides,
    },
    getByAgentId(agentId) {
      return Promise.resolve(
        store.row?.agentId === agentId ? store.row : undefined,
      );
    },
    async update(agentId, patch) {
      assert.ok(store.row && store.row.agentId === agentId, 'row must exist');
      store.row = {
        ...store.row,
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.appId !== undefined ? { appId: patch.appId } : {}),
        ...(patch.tenantId !== undefined ? { tenantId: patch.tenantId } : {}),
        ...(patch.teamsAppId !== undefined
          ? { teamsAppId: patch.teamsAppId }
          : {}),
        ...(patch.teamsAppExternalId !== undefined
          ? { teamsAppExternalId: patch.teamsAppExternalId }
          : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
      };
      await hooks.afterApply?.(patch);
      return store.row;
    },
  };
  return store;
}

function makeProvisioner(
  behaviour: { readonly createBot?: () => never } = {},
): TeamsProvisionerPort {
  return {
    async createAppRegistration(input) {
      await input.onRegistrationCreated?.(
        { appId: 'app-123', tenantId: 'tenant-9' },
        'created',
      );
      return {
        outcome: 'created',
        value: { appId: 'app-123', registration: { tenantId: 'tenant-9' } },
      };
    },
    createBot(input) {
      behaviour.createBot?.();
      return Promise.resolve({
        kind: 'provisioned',
        bot: { outcome: 'created', value: { botName: input.botName } },
      });
    },
    buildAppPackage() {
      return new Uint8Array([80, 75]);
    },
    uploadToCatalog() {
      return Promise.resolve({
        outcome: 'created',
        value: { teamsAppId: 'catalog-77' },
      });
    },
    getCatalogApp() {
      return Promise.resolve({ found: false });
    },
    installToTeam(input) {
      return Promise.resolve({
        outcome: 'created',
        value: { teamId: input.teamId, teamsAppId: input.teamsAppId },
      });
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

function makeRunner(opts: {
  readonly store: MemoryStore;
  readonly events?: TeamsProvisioningEventSink;
  readonly provisioner?: TeamsProvisionerPort;
  readonly maxAttempts?: number;
  readonly baseRetryDelayMs?: number;
}): TeamsProvisioningJobRunner {
  return new TeamsProvisioningJobRunner({
    store: opts.store,
    getProvisioner: () => opts.provisioner ?? makeProvisioner(),
    buildMessagingEndpoint: (botSlug) =>
      `https://mw.example.com/api/teams/${botSlug}/messages`,
    loadPackageAssets: () => Promise.resolve(ASSETS),
    timers: immediateTimers(),
    maxAttempts: opts.maxAttempts ?? 5,
    baseRetryDelayMs: opts.baseRetryDelayMs ?? 1000,
    ...(opts.events ? { events: opts.events } : {}),
    log: () => {},
  });
}

function namedError(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/** `step/status` pairs, in the order they were written. */
function trace(sink: MemoryEventSink): string[] {
  return sink.events.map((e) => `${e.step}/${e.status}`);
}

// ---------------------------------------------------------------------------
// The happy path writes a readable timeline
// ---------------------------------------------------------------------------

describe('TeamsProvisioningJobRunner — progress log (#915)', () => {
  it('logs the run and every chain step, in order', async () => {
    const store = makeStore();
    const sink = makeSink();
    const runner = makeRunner({ store, events: sink });

    const result = await runner.enqueue(REQUEST);

    assert.equal(result.status, 'installed');
    assert.deepEqual(trace(sink), [
      'run/started',
      'app_registered/started',
      // The one honest intra-step signal the connector's contract exposes:
      // the registration exists, the Entra replication wait is what follows.
      'app_registered/progress',
      'app_registered/succeeded',
      'bot_created/started',
      'bot_created/succeeded',
      'package_built/started',
      'package_built/succeeded',
      'catalog_uploaded/started',
      'catalog_uploaded/succeeded',
      'installed/started',
      'installed/succeeded',
      'run/succeeded',
    ]);
    // The log describes ONE run, so it opens by dropping the previous one.
    assert.deepEqual(sink.clears, ['agent-1']);
  });

  it('logs steps a resume skipped, instead of leaving a hole in the timeline', async () => {
    // Re-entering at `catalog_uploaded`: the first three steps are already
    // done. A timeline starting at step 5 would read as three lost steps.
    const store = makeStore({
      state: 'catalog_uploaded',
      appId: 'app-123',
      tenantId: 'tenant-9',
      teamsAppId: 'catalog-77',
    });
    const sink = makeSink();
    const runner = makeRunner({ store, events: sink });

    await runner.enqueue(REQUEST);

    assert.deepEqual(trace(sink), [
      'run/started',
      'app_registered/succeeded',
      'bot_created/succeeded',
      'package_built/succeeded',
      'catalog_uploaded/succeeded',
      'installed/started',
      'installed/succeeded',
      'run/succeeded',
    ]);
    for (const step of [
      'app_registered',
      'bot_created',
      'package_built',
      'catalog_uploaded',
    ]) {
      const event = sink.events.find(
        (e) => e.step === step && e.status === 'succeeded',
      );
      assert.equal(
        event?.detail,
        SKIPPED_DETAIL,
        `${step} must be marked as skipped, not as freshly done`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Retries — the gaps this whole feature exists to explain
  // -------------------------------------------------------------------------

  it('records each retry with its attempt number and the wait it is serving', async () => {
    let botCalls = 0;
    const store = makeStore();
    const sink = makeSink();
    const provisioner = makeProvisioner({
      createBot: () => {
        botCalls += 1;
        if (botCalls <= 2) {
          throw namedError('ProvisioningThrottledError', 'too many requests');
        }
        return undefined as never;
      },
    });
    const runner = makeRunner({
      store,
      events: sink,
      provisioner,
      baseRetryDelayMs: 1000,
      maxAttempts: 5,
    });

    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'installed');

    const retries = sink.events.filter((e) => e.status === 'retrying');
    assert.equal(retries.length, 2, 'two failures, two retry events');
    assert.deepEqual(
      retries.map((e) => e.attempt),
      [1, 2],
      'the attempt counter must survive the process — it is the copy',
    );
    assert.deepEqual(
      retries.map((e) => e.step),
      ['bot_created', 'bot_created'],
      'a retry names the step it is retrying, not the run',
    );
    // Exponential backoff, structured rather than prosaic: 1s then 2s.
    assert.deepEqual(
      retries.map((e) => e.detail),
      [retryDetail(1000, 5), retryDetail(2000, 5)],
    );
  });

  it('marks the step that died and gives the run a terminal event', async () => {
    const store = makeStore();
    const sink = makeSink();
    const provisioner = makeProvisioner({
      createBot: () => {
        throw namedError('ConsentMissingError', 'admin consent required');
      },
    });
    const runner = makeRunner({ store, events: sink, provisioner });

    const result = await runner.enqueue(REQUEST);

    assert.equal(result.status, 'failed');
    // A run that died in step 2 must be legible as exactly that.
    assert.deepEqual(trace(sink).slice(-2), ['bot_created/failed', 'run/failed']);
    const terminal = sink.events.at(-1);
    assert.equal(terminal?.detail, 'consent_missing');
  });

  // -------------------------------------------------------------------------
  // The log must never be able to break the run
  // -------------------------------------------------------------------------

  it('completes the run even when every single log write fails', async () => {
    const store = makeStore();
    const runner = makeRunner({ store, events: makeBrokenSink() });

    const result = await runner.enqueue(REQUEST);

    assert.equal(
      result.status,
      'installed',
      'a broken progress log must not turn a healthy run into a failure',
    );
    assert.equal(store.row?.state, 'installed');
    assert.equal(store.row?.lastError, null);
  });

  it('runs unchanged with no sink bound at all (pre-0053 mounts)', async () => {
    const store = makeStore();
    const runner = makeRunner({ store });

    const result = await runner.enqueue(REQUEST);

    assert.equal(result.status, 'installed');
    assert.equal(store.row?.state, 'installed');
  });

  // -------------------------------------------------------------------------
  // #915 — a terminal state is never reported as running
  // -------------------------------------------------------------------------

  it('never lets a reader see state=failed together with running=true', async () => {
    // The vantage point of an Express handler: a MACROTASK, scheduled while
    // the runner is suspended mid-write. `afterApply` models the driver round
    // trip between "the row is committed and readable" and "the runner's own
    // continuation resumes" — the gap #915 was observed in.
    const observations: Array<{ state: string; running: boolean }> = [];
    const store = makeStore({}, {
      afterApply: () =>
        new Promise<void>((resolve) => {
          setImmediate(() => {
            observations.push({
              state: store.row?.state ?? 'unknown',
              running: runner.isRunning('agent-1'),
            });
            resolve();
          });
        }),
    });
    const provisioner = makeProvisioner({
      createBot: () => {
        throw namedError('ConsentMissingError', 'admin consent required');
      },
    });
    const runner = makeRunner({ store, events: makeSink(), provisioner });

    const result = await runner.enqueue(REQUEST);
    assert.equal(result.status, 'failed');

    const contradictions = observations.filter(
      (o) => o.state === 'failed' && o.running,
    );
    assert.deepEqual(
      contradictions,
      [],
      'a run whose verdict is already readable must not still call itself running',
    );
    // Guard against a vacuous pass: the observer really did look at the row
    // after the terminal write.
    assert.ok(
      observations.some((o) => o.state === 'failed'),
      'the observer must have seen the terminal state at least once',
    );
  });

  it('stops reporting a run as in flight as soon as the chain is installed', async () => {
    const observations: boolean[] = [];
    const store = makeStore({}, {
      afterApply: (patch) =>
        new Promise<void>((resolve) => {
          if (patch.state !== 'installed') {
            resolve();
            return;
          }
          setImmediate(() => {
            observations.push(runner.isRunning('agent-1'));
            resolve();
          });
        }),
    });
    const runner = makeRunner({ store, events: makeSink() });

    await runner.enqueue(REQUEST);

    assert.deepEqual(
      observations,
      [false],
      'once `installed` is readable the run is bookkeeping, not work in flight',
    );
  });

  it('still refuses a re-target while the entry is held, settled or not', async () => {
    // `runningTeamId` predicts enqueue's refusal, so it must stay keyed on the
    // held entry — a route trusting the softer `isRunning` would accept a
    // re-target the runner then rejects behind its back.
    const store = makeStore();
    const runner = makeRunner({ store, events: makeSink() });

    const run = runner.enqueue(REQUEST);
    assert.equal(runner.runningTeamId('agent-1'), 'team-42');
    await run;
    assert.equal(
      runner.runningTeamId('agent-1'),
      null,
      'the entry is released once the run is done',
    );
  });
});
