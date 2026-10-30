/**
 * #1507 / #1508 / #1510 — what the runtime API tells an admin about the
 * Privacy Shield.
 *
 *   GET   /privacy-posture        → is a `privacy.redact@1` provider running
 *                                   (#1507), is the org-wide
 *                                   `OMADIA_PRIVACY_FORCE_GUARDED` clamp on
 *                                   (#1508), which installed plugins provide
 *                                   the shield.
 *   PATCH /installed/:id/config   → `_privacy_bypass_scopes` is editable and
 *                                   stored as the list the dispatch hook
 *                                   reads (#1510); an unknown `_privacy_mode`
 *                                   is refused instead of silently read as
 *                                   `guarded`.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import express, { type Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  PRIVACY_FORCE_GUARDED_ENV_VAR,
  PRIVACY_REDACT_SERVICE_NAME,
  resolveEffectivePrivacyMode,
  type PrivacyNameDetectorStatus,
} from '@omadia/plugin-api';

import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { createRuntimeRouter } from '../src/routes/runtime.js';

const GUARD_ID = '@omadia/plugin-privacy-guard';
const AGENT_ID = '@omadia/agent-confluence';

interface Harness {
  readonly baseUrl: string;
  readonly registry: InMemoryInstalledRegistry;
  readonly audits: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

async function makeHarness(opts: {
  readonly guardInstalled: boolean;
  readonly servicePublished: boolean;
  /** #1562 — the published shield's `nameDetectorStatus`, if any. */
  readonly nameDetectorStatus?: () => Promise<PrivacyNameDetectorStatus>;
  /** #1556 follow-up — the field-classification counter, if wired. */
  readonly countOpenFieldClassification?: () => Promise<{
    needsClarification: number;
    suggested: number;
  }>;
}): Promise<Harness> {
  const registry = new InMemoryInstalledRegistry();
  const installedAt = '2026-10-28T08:00:00.000Z';
  if (opts.guardInstalled) {
    await registry.register({
      id: GUARD_ID,
      installed_version: '0.10.0',
      installed_at: installedAt,
      status: 'active',
      config: {},
    });
  }
  await registry.register({
    id: AGENT_ID,
    installed_version: '1.0.0',
    installed_at: installedAt,
    status: 'active',
    config: { _privacy_mode: 'per_tool' },
  });

  const provides: Record<string, string[]> = {
    [GUARD_ID]: ['privacy.redact@1'],
    [AGENT_ID]: [],
  };
  const catalog = {
    get: (id: string) =>
      id in provides ? { plugin: { provides: provides[id] } } : undefined,
  } as unknown as PluginCatalog;

  const stubReg = {
    names: () => [],
    counts: () => ({ before_turn: 0, after_tool_call: 0, after_turn: 0 }),
  };
  const serviceRegistry = {
    ...stubReg,
    has: (name: string) =>
      opts.servicePublished && name === PRIVACY_REDACT_SERVICE_NAME,
    get: (name: string) =>
      opts.servicePublished && name === PRIVACY_REDACT_SERVICE_NAME
        ? { ...(opts.nameDetectorStatus ? { nameDetectorStatus: opts.nameDetectorStatus } : {}) }
        : undefined,
  };

  const audits: Array<Record<string, unknown>> = [];
  const app: Express = express();
  app.use(express.json());
  app.use(
    '/api/v1/admin/runtime',
    createRuntimeRouter({
      installedRegistry: registry,
      serviceRegistry: serviceRegistry as never,
      turnHookRegistry: stubReg as never,
      backgroundJobRegistry: stubReg as never,
      chatAgentWrapRegistry: { labels: () => [], count: () => 0 } as never,
      promptContributionRegistry: { labels: () => [], count: () => 0 } as never,
      catalog,
      audit: {
        record: async (entry) => {
          audits.push(entry as unknown as Record<string, unknown>);
        },
      },
      verifyConnection: async () => undefined,
      ...(opts.countOpenFieldClassification
        ? { countOpenFieldClassification: opts.countOpenFieldClassification }
        : {}),
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/api/v1/admin/runtime`,
    registry,
    audits,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let harness: Harness | undefined;
const savedEnv = process.env[PRIVACY_FORCE_GUARDED_ENV_VAR];

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  if (savedEnv === undefined) delete process.env[PRIVACY_FORCE_GUARDED_ENV_VAR];
  else process.env[PRIVACY_FORCE_GUARDED_ENV_VAR] = savedEnv;
});

async function posture(): Promise<Record<string, unknown>> {
  assert.ok(harness);
  const res = await fetch(`${harness.baseUrl}/privacy-posture`);
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

async function patchConfig(body: unknown): Promise<Response> {
  assert.ok(harness);
  return fetch(
    `${harness.baseUrl}/installed/${encodeURIComponent(AGENT_ID)}/config`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

describe('GET /privacy-posture (#1507, #1508)', () => {
  it('reports an active shield and its provider', async () => {
    delete process.env[PRIVACY_FORCE_GUARDED_ENV_VAR];
    harness = await makeHarness({ guardInstalled: true, servicePublished: true });
    assert.deepEqual(await posture(), {
      shield_active: true,
      force_guarded: false,
      provider_ids: [GUARD_ID],
      name_detector: null,
      fields_needing_clarification: 0,
      fields_suggested_open: 0,
    });
  });

  it('reports the open field-classification counts (#1556 follow-up)', async () => {
    harness = await makeHarness({
      guardInstalled: true,
      servicePublished: true,
      countOpenFieldClassification: async () => ({ needsClarification: 3, suggested: 2 }),
    });
    const body = await posture();
    assert.equal(body.fields_needing_clarification, 3);
    assert.equal(body.fields_suggested_open, 2);
  });

  it('reports zero open fields when the count fails (table not migrated)', async () => {
    harness = await makeHarness({
      guardInstalled: true,
      servicePublished: true,
      countOpenFieldClassification: async () => {
        throw new Error('relation "privacy_field_candidates" does not exist');
      },
    });
    const body = await posture();
    assert.equal(body.fields_needing_clarification, 0);
    assert.equal(body.fields_suggested_open, 0);
  });

  it('reports the name detector state of the running shield (#1562)', async () => {
    delete process.env[PRIVACY_FORCE_GUARDED_ENV_VAR];
    harness = await makeHarness({
      guardInstalled: true,
      servicePublished: true,
      nameDetectorStatus: async () => ({
        state: 'unreachable',
        source: 'env',
        lastFailureAt: '2026-10-29T10:00:00.000Z',
        promptMasking: true,
      }),
    });
    assert.deepEqual((await posture()).name_detector, {
      state: 'unreachable',
      source: 'env',
      last_failure_at: '2026-10-29T10:00:00.000Z',
      prompt_masking: true,
    });
  });

  it('reports no name detector while the shield is off (#1562)', async () => {
    harness = await makeHarness({ guardInstalled: false, servicePublished: false });
    assert.equal((await posture()).name_detector, null);
  });

  it('reports the shield as off once the guard is uninstalled', async () => {
    delete process.env[PRIVACY_FORCE_GUARDED_ENV_VAR];
    harness = await makeHarness({ guardInstalled: false, servicePublished: false });
    const body = await posture();
    assert.equal(body.shield_active, false);
    assert.deepEqual(body.provider_ids, []);
  });

  it('reports the org clamp exactly when the dispatch hook applies it', async () => {
    harness = await makeHarness({ guardInstalled: true, servicePublished: true });
    for (const value of ['true', 'TRUE', '1', 'false']) {
      process.env[PRIVACY_FORCE_GUARDED_ENV_VAR] = value;
      const clamped =
        resolveEffectivePrivacyMode({
          storedMode: 'bypass',
          storedScopes: undefined,
          toolName: 'confluence_search',
          env: process.env,
        }) === 'guarded';
      assert.equal((await posture()).force_guarded, clamped, `env=${value}`);
    }
  });
});

describe('PATCH /installed/:id/config — privacy keys (#1510)', () => {
  it('stores a comma-separated scope list as the list the dispatch hook bypasses', async () => {
    harness = await makeHarness({ guardInstalled: true, servicePublished: true });
    const res = await patchConfig({
      _privacy_bypass_scopes: ' confluence_get_page, confluence_search ,, ',
    });
    assert.equal(res.status, 200);
    const stored = harness.registry.get(AGENT_ID)?.config['_privacy_bypass_scopes'];
    assert.deepEqual(stored, ['confluence_get_page', 'confluence_search']);
    delete process.env[PRIVACY_FORCE_GUARDED_ENV_VAR];
    assert.equal(
      resolveEffectivePrivacyMode({
        storedMode: 'per_tool',
        storedScopes: stored,
        toolName: 'confluence_search',
        env: process.env,
      }),
      'bypass',
    );
  });

  it('refuses a scope value that is not a string or a list of strings', async () => {
    harness = await makeHarness({ guardInstalled: true, servicePublished: true });
    const res = await patchConfig({ _privacy_bypass_scopes: [1, 2] });
    assert.equal(res.status, 400);
    assert.equal(
      harness.registry.get(AGENT_ID)?.config['_privacy_bypass_scopes'],
      undefined,
    );
  });

  it('refuses an unknown privacy mode and keeps the stored one', async () => {
    harness = await makeHarness({ guardInstalled: true, servicePublished: true });
    const res = await patchConfig({ _privacy_mode: 'off' });
    assert.equal(res.status, 400);
    assert.equal(harness.registry.get(AGENT_ID)?.config['_privacy_mode'], 'per_tool');
  });

  it('still clears a privacy key with null', async () => {
    harness = await makeHarness({ guardInstalled: true, servicePublished: true });
    const res = await patchConfig({ _privacy_mode: null });
    assert.equal(res.status, 200);
    assert.equal(harness.registry.get(AGENT_ID)?.config['_privacy_mode'], undefined);
  });

  it('records a privacy change in the admin audit trail, and nothing for other keys', async () => {
    harness = await makeHarness({ guardInstalled: true, servicePublished: true });
    assert.equal((await patchConfig({ _privacy_mode: 'bypass' })).status, 200);
    assert.equal(harness.audits.length, 1);
    assert.equal(harness.audits[0]?.action, 'plugin.privacy_change');
    assert.equal(harness.audits[0]?.target, `plugin:${AGENT_ID}`);
    assert.deepEqual(harness.audits[0]?.before, {
      _privacy_mode: 'per_tool',
      _privacy_bypass_scopes: null,
    });
    assert.deepEqual(harness.audits[0]?.after, {
      _privacy_mode: 'bypass',
      _privacy_bypass_scopes: null,
    });

    assert.equal((await patchConfig({ some_setting: 'x' })).status, 200);
    assert.equal(harness.audits.length, 1);
  });

  it('records a manual non_personal_fields edit in the audit trail (#1556 follow-up)', async () => {
    harness = await makeHarness({ guardInstalled: true, servicePublished: true });
    const res = await fetch(
      `${harness.baseUrl}/installed/${encodeURIComponent(GUARD_ID)}/config`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ non_personal_fields: 'odoo_execute:department_id' }),
      },
    );
    assert.equal(res.status, 200);
    assert.equal(harness.audits.length, 1);
    assert.equal(harness.audits[0]?.action, 'plugin.privacy_change');
    assert.equal(harness.audits[0]?.target, `plugin:${GUARD_ID}`);
    assert.deepEqual(harness.audits[0]?.before, {
      _privacy_mode: null,
      _privacy_bypass_scopes: null,
    });
    assert.deepEqual(harness.audits[0]?.after, {
      _privacy_mode: null,
      _privacy_bypass_scopes: null,
      non_personal_fields: 'odoo_execute:department_id',
    });
  });
});
