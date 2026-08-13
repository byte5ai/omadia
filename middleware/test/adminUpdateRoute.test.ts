import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

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
 * rather than the happy path alone — a mistyped confirmation, a floating tag,
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
  close(): Promise<void>;
}

let open: Harness | null = null;

async function harness(deps: Partial<AdminUpdateDeps> = {}): Promise<Harness> {
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
      releaseLookup: fakeLookup(),
      ...deps,
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  open = {
    baseUrl: `http://127.0.0.1:${port}/api/v1/admin/update`,
    close: () => new Promise((r) => server.close(() => r())),
  };
  return open;
}

afterEach(async () => {
  await open?.close();
  open = null;
});

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
  };
  auditAvailable: boolean;
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
    const { baseUrl } = await harness();
    const body = await readJson<StatusBody>(await fetch(`${baseUrl}/status`));

    assert.deepEqual(body.current, { version: 'v0.74.0', source: 'release' });
    assert.equal(body.latest?.tag, 'v0.75.0');
    assert.equal(body.updateAvailable, true);
  });

  it('answers with the executor marked absent in notify-only mode', async () => {
    const { baseUrl } = await harness();
    const body = await readJson<StatusBody>(await fetch(`${baseUrl}/status`));
    assert.deepEqual(body.executor, { configured: false, reachable: false });
    assert.equal(body.auditAvailable, false);
  });

  it('distinguishes a configured-but-unreachable executor from an absent one', async () => {
    const { baseUrl } = await harness({
      updater: {
        getStatus: async () => ({ ok: false, error: 'ECONNREFUSED' }),
        requestUpdate: async () => ({ ok: true }),
      },
    });
    const body = await readJson<StatusBody>(await fetch(`${baseUrl}/status`));
    assert.equal(body.executor.configured, true);
    assert.equal(body.executor.reachable, false);
    assert.equal(body.executor.error, 'ECONNREFUSED');
  });

  it('still answers when the release check is offline', async () => {
    const { baseUrl } = await harness({
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

  it('settles open audit rows against the version now running', async () => {
    const audit = fakeAudit();
    const seen: string[] = [];
    audit.store.reconcileOpenEntries = async (version: string) => {
      seen.push(version);
    };
    const { baseUrl } = await harness({ audit: audit.store });
    await fetch(`${baseUrl}/status`);
    assert.deepEqual(seen, ['v0.74.0']);
  });
});

describe('POST /api/v1/admin/update', () => {
  it('accepts a correctly confirmed release tag and returns 202', async () => {
    const updater = fakeUpdater();
    const audit = fakeAudit();
    const { baseUrl } = await harness({ updater: updater.client, audit: audit.store });

    const res = await post(baseUrl, {
      targetVersion: 'v0.75.0',
      confirm: 'v0.75.0',
    });

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
    const { baseUrl } = await harness({
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
        requestUpdate: async () => {
          order.push('execute');
          return { ok: true };
        },
      },
    });

    await post(baseUrl, { targetVersion: 'v0.75.0', confirm: 'v0.75.0' });

    assert.deepEqual(
      order,
      ['audit', 'execute'],
      'the process that triggers the update is the process the update kills',
    );
    assert.equal(audit.rows[0]?.actor, 'operator@example.com');
    assert.equal(audit.rows[0]?.fromVersion, 'v0.74.0');
    assert.equal(audit.rows[0]?.toVersion, 'v0.75.0');
  });

  it('rejects a mistyped confirmation without contacting the executor', async () => {
    const updater = fakeUpdater();
    const audit = fakeAudit();
    const { baseUrl } = await harness({ updater: updater.client, audit: audit.store });

    const res = await post(baseUrl, {
      targetVersion: 'v0.75.0',
      confirm: 'v0.75.1',
    });

    assert.equal(res.status, 400);
    assert.equal((await readJson<ErrorBody>(res)).error, 'confirmation_mismatch');
    assert.deepEqual(updater.requested, []);
    assert.deepEqual(audit.rows, []);
  });

  it('accepts a confirmation that differs only by the v prefix', async () => {
    const updater = fakeUpdater();
    const audit = fakeAudit();
    const { baseUrl } = await harness({ updater: updater.client, audit: audit.store });

    const res = await post(baseUrl, { targetVersion: 'v0.75.0', confirm: '0.75.0' });

    assert.equal(res.status, 202);
    assert.deepEqual(updater.requested, ['v0.75.0']);
  });

  it('rejects a floating tag — rollback and the health gate need a fixed target', async () => {
    const updater = fakeUpdater();
    const audit = fakeAudit();
    const { baseUrl } = await harness({ updater: updater.client, audit: audit.store });

    for (const target of ['latest', 'edge', 'sha-1a2b3c4', 'v0.75']) {
      const res = await post(baseUrl, { targetVersion: target, confirm: target });
      assert.equal(res.status, 400, `${target} must be refused`);
      assert.equal((await readJson<ErrorBody>(res)).error, 'invalid_target_version');
    }
    assert.deepEqual(updater.requested, []);
  });

  it('refuses to execute in notify-only mode', async () => {
    const audit = fakeAudit();
    const { baseUrl } = await harness({ audit: audit.store });

    const res = await post(baseUrl, { targetVersion: 'v0.75.0', confirm: 'v0.75.0' });

    assert.equal(res.status, 409);
    assert.equal((await readJson<ErrorBody>(res)).error, 'updater_not_configured');
    assert.deepEqual(audit.rows, []);
  });

  it('refuses to execute when the change could not be audited', async () => {
    const updater = fakeUpdater();
    const { baseUrl } = await harness({ updater: updater.client });

    const res = await post(baseUrl, { targetVersion: 'v0.75.0', confirm: 'v0.75.0' });

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
    const { baseUrl } = await harness({ updater: updater.client, audit: audit.store });

    const res = await post(baseUrl, { targetVersion: 'v0.76.0', confirm: 'v0.76.0' });

    assert.equal(res.status, 409);
    assert.equal((await readJson<ErrorBody>(res)).error, 'update_in_progress');
    assert.deepEqual(audit.rows, [], 'no audit row for a rejected request');
  });

  it('refuses to "update" to the version already running', async () => {
    const updater = fakeUpdater();
    const audit = fakeAudit();
    const { baseUrl } = await harness({ updater: updater.client, audit: audit.store });

    const res = await post(baseUrl, { targetVersion: 'v0.74.0', confirm: 'v0.74.0' });

    assert.equal(res.status, 400);
    assert.equal((await readJson<ErrorBody>(res)).error, 'already_on_target');
  });

  it('surfaces an executor that rejects the job, with the audit id', async () => {
    const audit = fakeAudit();
    const { baseUrl } = await harness({
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
        requestUpdate: async () => ({ ok: false, error: 'invalid_target_version', status: 400 }),
      },
    });

    const res = await post(baseUrl, { targetVersion: 'v0.75.0', confirm: 'v0.75.0' });

    assert.equal(res.status, 502);
    const body = await readJson<ErrorBody>(res);
    assert.equal(body.error, 'updater_rejected');
    assert.equal(body.auditId, audit.rows[0]?.id);
  });

  it('rejects a malformed body', async () => {
    const { baseUrl } = await harness();
    const res = await post(baseUrl, { confirm: 'v0.75.0' });
    assert.equal(res.status, 400);
    assert.equal((await readJson<ErrorBody>(res)).error, 'invalid_request');
  });
});

describe('GET /api/v1/admin/update/history', () => {
  it('reports unavailable rather than empty when there is no store', async () => {
    const { baseUrl } = await harness();
    const body = await readJson<HistoryBody>(await fetch(`${baseUrl}/history`));
    assert.deepEqual(body, { entries: [], available: false });
  });

  it('returns the trail newest first', async () => {
    const audit = fakeAudit();
    const { baseUrl } = await harness({
      audit: audit.store,
      updater: fakeUpdater().client,
    });
    await post(baseUrl, { targetVersion: 'v0.75.0', confirm: 'v0.75.0' });
    await post(baseUrl, { targetVersion: 'v0.76.0', confirm: 'v0.76.0' });

    const body = await readJson<HistoryBody>(await fetch(`${baseUrl}/history`));
    assert.equal(body.available, true);
    assert.deepEqual(
      body.entries.map((e: UpdateAuditEntry) => e.toVersion),
      ['v0.76.0', 'v0.75.0'],
    );
  });
});
