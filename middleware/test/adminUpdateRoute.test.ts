import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import express from 'express';

import { createAdminUpdateRouter } from '../src/routes/adminUpdate.js';
import type { AdminUpdateDeps } from '../src/routes/adminUpdate.js';
import type {
  UpdateAuditEntry,
  UpdateAuditStore,
} from '../src/update/auditStore.js';
import type { ReleaseLookup } from '../src/update/releaseLookup.js';
import type { UpdaterClient, UpdaterStatus } from '../src/update/updaterClient.js';
import type { AppVersion } from '../src/update/version.js';

/**
 * #432 slice 3 — `/api/v1/admin/update`.
 *
 * The route that matters is the POST: it replaces every application container
 * in the stack. The tests below are written against the ways that can go wrong
 * rather than the happy path alone — a floating tag,
 * a missing executor, a second click while one update is already running, and
 * (the one that would be invisible in production) an execution that happens
 * without an audit record.
 */

const RELEASE = {
  tag: 'v0.75.0',
  url: 'https://github.com/byte5ai/omadia/releases/tag/v0.75.0',
  publishedAt: '2026-08-13T13:00:41Z',
  prerelease: false,
};

function fakeLookup(release = RELEASE, stale = false): ReleaseLookup {
  return {
    get: async () => ({ release, checkedAt: 1, stale }),
    list: async () => ({
      releases: release === null ? [] : [release],
      checkedAt: 1,
      stale,
    }),
  };
}

function fakeUpdater(overrides: Partial<UpdaterStatus> = {}): {
  client: UpdaterClient;
  requested: string[];
} {
  const requested: string[] = [];
  const status: UpdaterStatus = {
    state: 'idle',
    targetVersion: null,
    previousVersion: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    steps: [],
    ...overrides,
  };
  return {
    requested,
    client: {
      getStatus: async () => ({ ok: true, status }),
      preflight: async (target: string) => ({
        ok: true as const,
        result: {
          targetVersion: target,
          ok: true,
          images: [
            {
              service: 'middleware',
              currentImage: 'ghcr.io/byte5ai/omadia-middleware:v0.74.0',
              image: `ghcr.io/byte5ai/omadia-middleware:${target}`,
              available: true,
              reason: null,
            },
          ],
        },
      }),
      requestUpdate: async (target: string) => {
        requested.push(target);
        return { ok: true };
      },
    },
  };
}

function fakeAudit(): { store: UpdateAuditStore; rows: UpdateAuditEntry[] } {
  const rows: UpdateAuditEntry[] = [];
  return {
    rows,
    store: {
      recordRequest: async ({ actor, fromVersion, toVersion }) => {
        const entry: UpdateAuditEntry = {
          id: `a${rows.length + 1}`,
          actor,
          fromVersion,
          toVersion,
          outcome: 'requested',
          detail: null,
          createdAt: new Date(0).toISOString(),
        };
        rows.push(entry);
        return entry;
      },
      list: async () => [...rows].reverse(),
      reconcileOpenEntries: async () => {},
    },
  };
}

const RUNNING: AppVersion = { version: 'v0.74.0', source: 'release' };

interface Harness {
  baseUrl: string;
}

/**
 * ONE HTTP server for the whole file, not one per test.
 *
 * The suite already spins up a lot of short-lived Express servers on
 * localhost, and `.github/workflows/ci.yml` records that this is the exact
 * source of its non-deterministic failures (three consecutive full runs, three
 * DIFFERENT tests, every one passing in isolation) — which is why
 * `--test-concurrency` is pinned. Eighteen more listen/close cycles from this
 * file would push on precisely that. The router reads `updater`, `audit` and
 * `releaseLookup` off its deps object at REQUEST time, so per-test wiring is a
 * mutation of that object rather than a new server.
 */
let currentDeps: Partial<AdminUpdateDeps> = {};
let server: Server;
let baseUrl: string;

before(async () => {
  const app = express();
  app.use(express.json());
  // Stand in for requireAuth, which the real mount puts in front of this router.
  app.use((req, _res, next) => {
    req.session = {
      sub: 'op',
      email: 'operator@example.com',
      display_name: 'Operator',
      provider: 'local',
      role: 'admin',
    } as NonNullable<typeof req.session>;
    next();
  });
  app.use(
    '/api/v1/admin/update',
    createAdminUpdateRouter({
      currentVersion: RUNNING,
      get platform() {
        return currentDeps.platform ?? { kind: 'unknown' as const };
      },
      // Delegate every per-request read to whatever the running test wired up.
      get releaseLookup() {
        return currentDeps.releaseLookup ?? fakeLookup();
      },
      get updater() {
        return currentDeps.updater;
      },
      get audit() {
        return currentDeps.audit;
      },
    }),
  );
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api/v1/admin/update`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  currentDeps = {};
});

function harness(deps: Partial<AdminUpdateDeps> = {}): Harness {
  currentDeps = deps;
  return { baseUrl };
}

async function post(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** `Response.json()` is `unknown` under this tsconfig; assert the shape once
 *  here rather than casting at twenty call sites. */
async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface StatusBody {
  current: { version: string; source: string };
  latest: { tag: string } | null;
  updateAvailable: boolean;
  check: { checkedAt: number | null; stale: boolean; error?: string };
  executor: {
    configured: boolean;
    reachable: boolean;
    state?: string;
    error?: string;
    phase?: string | null;
    failure?: unknown;
    startedAt?: string | null;
    finishedAt?: string | null;
    previousVersion?: string | null;
  };
  auditAvailable: boolean;
  platform: { kind: string; appName?: string; machineId?: string };
}

interface ErrorBody {
  error: string;
  message?: string;
  auditId?: string;
}

interface AcceptedBody {
  accepted: boolean;
  targetVersion: string;
  auditId: string;
}

interface HistoryBody {
  entries: UpdateAuditEntry[];
  available: boolean;
}

describe('GET /api/v1/admin/update/status', () => {
  it('reports the running version, the latest release, and that one is newer', async () => {
    const { baseUrl } = harness();
    const body = await readJson<StatusBody>(await fetch(`${baseUrl}/status`));

    assert.deepEqual(body.current, { version: 'v0.74.0', source: 'release' });
    assert.equal(body.latest?.tag, 'v0.75.0');
    assert.equal(body.updateAvailable, true);
  });

  it('answers with the executor marked absent in notify-only mode', async () => {
    const { baseUrl } = harness();
    const body = await readJson<StatusBody>(await fetch(`${baseUrl}/status`));
    assert.deepEqual(body.executor, { configured: false, reachable: false });
    assert.equal(body.auditAvailable, false);
  });

  it('distinguishes a configured-but-unreachable executor from an absent one', async () => {
    const { baseUrl } = harness({
      updater: {
        getStatus: async () => ({ ok: false, error: 'ECONNREFUSED' }),
        preflight: async () => ({ ok: false as const, error: 'not_wired' }),
        requestUpdate: async () => ({ ok: true }),
      },
    });
    const body = await readJson<StatusBody>(await fetch(`${baseUrl}/status`));
    assert.equal(body.executor.configured, true);
    assert.equal(body.executor.reachable, false);
    assert.equal(body.executor.error, 'ECONNREFUSED');
  });

  it('passes the sidecar job phase, timestamps and structured failure through', async () => {
    const { client } = fakeUpdater({
      state: 'rolled_back',
      targetVersion: 'v0.120.0',
      previousVersion: 'v0.90.1',
      startedAt: '2026-08-21T09:56:19.000Z',
      finishedAt: '2026-08-21T10:02:47.000Z',
      error: 'health gate failed: never_reachable (observed version: none)',
      phase: 'rollback',
      failure: { kind: 'health_gate', reason: 'never_reachable', observedVersion: null },
    });
    const { baseUrl } = harness({ updater: client });
    const body = await readJson<StatusBody>(await fetch(`${baseUrl}/status`));
    assert.equal(body.executor.state, 'rolled_back');
    assert.equal(body.executor.phase, 'rollback');
    assert.deepEqual(body.executor.failure, {
      kind: 'health_gate',
      reason: 'never_reachable',
      observedVersion: null,
    });
    assert.equal(body.executor.previousVersion, 'v0.90.1');
    assert.equal(body.executor.startedAt, '2026-08-21T09:56:19.000Z');
    assert.equal(body.executor.finishedAt, '2026-08-21T10:02:47.000Z');
  });

  it('normalises phase/failure to null for a sidecar that predates them', async () => {
    const { client } = fakeUpdater({ state: 'idle' });
    const { baseUrl } = harness({ updater: client });
    const body = await readJson<StatusBody>(await fetch(`${baseUrl}/status`));
    assert.equal(body.executor.phase, null);
    assert.equal(body.executor.failure, null);
  });

  it('still answers when the release check is offline', async () => {
    const { baseUrl } = harness({
      releaseLookup: {
        get: async () => ({
          release: null,
          checkedAt: null,
          stale: true,
          error: 'ENOTFOUND',
        }),
      },
    });
    const res = await fetch(`${baseUrl}/status`);
    assert.equal(res.status, 200);
    const body = await readJson<StatusBody>(res);
    assert.equal(body.latest, null);
    assert.equal(body.updateAvailable, false);
    assert.equal(body.check.stale, true);
  });

  it('passes the detected platform through so the UI can name the real app', async () => {
    const { baseUrl } = harness({
      platform: { kind: 'fly', appName: 'omadia-middleware-a1b2c3' },
    });
    const body = await readJson<StatusBody>(await fetch(`${baseUrl}/status`));
    assert.deepEqual(body.platform, {
      kind: 'fly',
      appName: 'omadia-middleware-a1b2c3',
    });
  });

  it('reports an unknown platform without inventing one', async () => {
    const { baseUrl } = harness();
    const body = await readJson<StatusBody>(await fetch(`${baseUrl}/status`));
    assert.deepEqual(body.platform, { kind: 'unknown' });
  });

  it('settles open audit rows against the version now running', async () => {
    const audit = fakeAudit();
    const seen: string[] = [];
    audit.store.reconcileOpenEntries = async (version: string) => {
      seen.push(version);
    };
    const { baseUrl } = harness({ audit: audit.store });
    await fetch(`${baseUrl}/status`);
    assert.deepEqual(seen, ['v0.74.0']);
  });
});

describe('GET /api/v1/admin/update/releases', () => {
  it('lists the releases the operator may pick between', async () => {
    const { baseUrl } = harness({ releaseLookup: fakeLookup() });
    const res = await fetch(`${baseUrl}/releases`);
    assert.equal(res.status, 200);
    const body = await readJson<{
      releases: { tag: string }[];
      current: { version: string };
      check: { stale: boolean };
    }>(res);
    assert.deepEqual(body.releases.map((r) => r.tag), ['v0.75.0']);
    assert.equal(body.current.version, 'v0.74.0');
    assert.equal(body.check.stale, false);
  });

  it('degrades to an empty list rather than an error when GitHub is unreachable', async () => {
    const { baseUrl } = harness({
      releaseLookup: {
        get: async () => ({ release: null, checkedAt: null, stale: true, error: 'offline' }),
        list: async () => ({ releases: [], checkedAt: null, stale: true, error: 'offline' }),
      },
    });
    const res = await fetch(`${baseUrl}/releases`);
    assert.equal(res.status, 200);
    const body = await readJson<{ releases: unknown[]; check: { stale: boolean } }>(res);
    assert.deepEqual(body.releases, []);
    assert.equal(body.check.stale, true);
  });
});

describe('GET /api/v1/admin/update/preflight', () => {
  it('reports the per-service image verdict', async () => {
    const updater = fakeUpdater();
    const { baseUrl } = harness({ updater: updater.client });
    const res = await fetch(`${baseUrl}/preflight?targetVersion=v0.75.0`);
    assert.equal(res.status, 200);
    const body = await readJson<{ ok: boolean; images: { image: string }[] }>(res);
    assert.equal(body.ok, true);
    assert.equal(body.images[0]?.image, 'ghcr.io/byte5ai/omadia-middleware:v0.75.0');
  });

  it('rejects a floating tag', async () => {
    const updater = fakeUpdater();
    const { baseUrl } = harness({ updater: updater.client });
    const res = await fetch(`${baseUrl}/preflight?targetVersion=latest`);
    assert.equal(res.status, 400);
    assert.equal((await readJson<ErrorBody>(res)).error, 'invalid_target_version');
  });

  // An old sidecar answers 404. That is "could not look", NOT "image missing" —
  // conflating the two would talk an operator out of a good update.
  it('distinguishes an unsupported check from a failed one', async () => {
    const { baseUrl } = harness({
      updater: {
        getStatus: async () => ({ ok: false as const, error: 'unused' }),
        preflight: async () => ({ ok: false as const, error: 'not_found', status: 404 }),
        requestUpdate: async () => ({ ok: true as const }),
      },
    });
    const res = await fetch(`${baseUrl}/preflight?targetVersion=v0.75.0`);
    assert.equal(res.status, 501);
    assert.equal((await readJson<ErrorBody>(res)).error, 'preflight_unsupported');
  });

  it('refuses without an executor', async () => {
    const { baseUrl } = harness();
    const res = await fetch(`${baseUrl}/preflight?targetVersion=v0.75.0`);
    assert.equal(res.status, 409);
    assert.equal((await readJson<ErrorBody>(res)).error, 'updater_not_configured');
  });
});

describe('POST /api/v1/admin/update', () => {
  it('accepts a release tag and returns 202', async () => {
    const updater = fakeUpdater();
    const audit = fakeAudit();
    const { baseUrl } = harness({ updater: updater.client, audit: audit.store });

    const res = await post(baseUrl, { targetVersion: 'v0.75.0' });

    assert.equal(res.status, 202, 'the update outlives this request');
    const body = await readJson<AcceptedBody>(res);
    assert.equal(body.accepted, true);
    assert.equal(body.targetVersion, 'v0.75.0');
    assert.deepEqual(updater.requested, ['v0.75.0']);
  });

  it('writes the audit row BEFORE handing off to the executor', async () => {
    const order: string[] = [];
    const audit = fakeAudit();
    const wrapped: UpdateAuditStore = {
      ...audit.store,
      recordRequest: async (input) => {
        order.push('audit');
        return audit.store.recordRequest(input);
      },
    };
    const { baseUrl } = harness({
      audit: wrapped,
      updater: {
        getStatus: async () => ({
          ok: true,
          status: {
            state: 'idle',
            targetVersion: null,
            previousVersion: null,
            startedAt: null,
            finishedAt: null,
            error: null,
            steps: [],
          },
        }),
        preflight: async () => ({ ok: false as const, error: 'not_wired' }),
        requestUpdate: async () => {
          order.push('execute');
          return { ok: true };
        },
      },
    });

    await post(baseUrl, { targetVersion: 'v0.75.0' });

    assert.deepEqual(
      order,
      ['audit', 'execute'],
      'the process that triggers the update is the process the update kills',
    );
    assert.equal(audit.rows[0]?.actor, 'operator@example.com');
    assert.equal(audit.rows[0]?.fromVersion, 'v0.74.0');
    assert.equal(audit.rows[0]?.toVersion, 'v0.75.0');
  });

  // The type-to-confirm gate is gone (an update is health-gated and rolled
  // back; a purge is not), but an older admin page still posts the field.
  it('ignores a leftover confirm field instead of refusing the request', async () => {
    const updater = fakeUpdater();
    const audit = fakeAudit();
    const { baseUrl } = harness({ updater: updater.client, audit: audit.store });

    const res = await post(baseUrl, {
      targetVersion: 'v0.75.0',
      confirm: 'something else entirely',
    });

    assert.equal(res.status, 202);
    assert.deepEqual(updater.requested, ['v0.75.0']);
  });

  it('canonicalises a target given without the v prefix', async () => {
    const updater = fakeUpdater();
    const audit = fakeAudit();
    const { baseUrl } = harness({ updater: updater.client, audit: audit.store });

    const res = await post(baseUrl, { targetVersion: '0.75.0' });

    assert.equal(res.status, 202);
    assert.deepEqual(updater.requested, ['v0.75.0']);
  });

  // A rollback to a known-good build is a legitimate target: the picker offers
  // older releases, so the route must not quietly require "newer than running".
  it('accepts a downgrade', async () => {
    const updater = fakeUpdater();
    const audit = fakeAudit();
    const { baseUrl } = harness({ updater: updater.client, audit: audit.store });

    const res = await post(baseUrl, { targetVersion: 'v0.70.0' });

    assert.equal(res.status, 202);
    assert.deepEqual(updater.requested, ['v0.70.0']);
  });

  it('rejects a floating tag — rollback and the health gate need a fixed target', async () => {
    const updater = fakeUpdater();
    const audit = fakeAudit();
    const { baseUrl } = harness({ updater: updater.client, audit: audit.store });

    for (const target of ['latest', 'edge', 'sha-1a2b3c4', 'v0.75']) {
      const res = await post(baseUrl, { targetVersion: target });
      assert.equal(res.status, 400, `${target} must be refused`);
      assert.equal((await readJson<ErrorBody>(res)).error, 'invalid_target_version');
    }
    assert.deepEqual(updater.requested, []);
  });

  it('refuses to execute in notify-only mode', async () => {
    const audit = fakeAudit();
    const { baseUrl } = harness({ audit: audit.store });

    const res = await post(baseUrl, { targetVersion: 'v0.75.0' });

    assert.equal(res.status, 409);
    assert.equal((await readJson<ErrorBody>(res)).error, 'updater_not_configured');
    assert.deepEqual(audit.rows, []);
  });

  it('refuses to execute when the change could not be audited', async () => {
    const updater = fakeUpdater();
    const { baseUrl } = harness({ updater: updater.client });

    const res = await post(baseUrl, { targetVersion: 'v0.75.0' });

    assert.equal(res.status, 409);
    assert.equal((await readJson<ErrorBody>(res)).error, 'audit_unavailable');
    assert.deepEqual(
      updater.requested,
      [],
      'an unauditable one-click stack replacement is not a trade worth making',
    );
  });

  it('refuses a second update while one is in flight', async () => {
    const updater = fakeUpdater({ state: 'updating', targetVersion: 'v0.75.0' });
    const audit = fakeAudit();
    const { baseUrl } = harness({ updater: updater.client, audit: audit.store });

    const res = await post(baseUrl, { targetVersion: 'v0.76.0' });

    assert.equal(res.status, 409);
    assert.equal((await readJson<ErrorBody>(res)).error, 'update_in_progress');
    assert.deepEqual(audit.rows, [], 'no audit row for a rejected request');
  });

  it('refuses to "update" to the version already running', async () => {
    const updater = fakeUpdater();
    const audit = fakeAudit();
    const { baseUrl } = harness({ updater: updater.client, audit: audit.store });

    const res = await post(baseUrl, { targetVersion: 'v0.74.0' });

    assert.equal(res.status, 400);
    assert.equal((await readJson<ErrorBody>(res)).error, 'already_on_target');
  });

  it('surfaces an executor that rejects the job, with the audit id', async () => {
    const audit = fakeAudit();
    const { baseUrl } = harness({
      audit: audit.store,
      updater: {
        getStatus: async () => ({
          ok: true,
          status: {
            state: 'idle',
            targetVersion: null,
            previousVersion: null,
            startedAt: null,
            finishedAt: null,
            error: null,
            steps: [],
          },
        }),
        preflight: async () => ({ ok: false as const, error: 'not_wired' }),
        requestUpdate: async () => ({ ok: false, error: 'invalid_target_version', status: 400 }),
      },
    });

    const res = await post(baseUrl, { targetVersion: 'v0.75.0' });

    assert.equal(res.status, 502);
    const body = await readJson<ErrorBody>(res);
    assert.equal(body.error, 'updater_rejected');
    assert.equal(body.auditId, audit.rows[0]?.id);
  });

  it('rejects a malformed body', async () => {
    const { baseUrl } = harness();
    const res = await post(baseUrl, { notTheTarget: 'v0.75.0' });
    assert.equal(res.status, 400);
    assert.equal((await readJson<ErrorBody>(res)).error, 'invalid_request');
  });
});

describe('GET /api/v1/admin/update/history', () => {
  it('reports unavailable rather than empty when there is no store', async () => {
    const { baseUrl } = harness();
    const body = await readJson<HistoryBody>(await fetch(`${baseUrl}/history`));
    assert.deepEqual(body, { entries: [], available: false });
  });

  it('returns the trail newest first', async () => {
    const audit = fakeAudit();
    const { baseUrl } = harness({
      audit: audit.store,
      updater: fakeUpdater().client,
    });
    await post(baseUrl, { targetVersion: 'v0.75.0' });
    await post(baseUrl, { targetVersion: 'v0.76.0' });

    const body = await readJson<HistoryBody>(await fetch(`${baseUrl}/history`));
    assert.equal(body.available, true);
    assert.deepEqual(
      body.entries.map((e: UpdateAuditEntry) => e.toVersion),
      ['v0.76.0', 'v0.75.0'],
    );
  });
});
