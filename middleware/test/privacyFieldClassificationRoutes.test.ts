/**
 * #1556 follow-up — the field-classification admin API against an in-memory
 * store and installed registry (express on 127.0.0.1 + fetch, like the other
 * admin-route suites). Confirm and revert edit exactly one `tool:field` line
 * of the privacy guard's `non_personal_fields`; reject / keep_masked never
 * touch config; every decision lands in the audit trail with its actor.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { PRIVACY_REDACT_SERVICE_NAME, type FieldObservation } from '@omadia/plugin-api';

import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { createFieldClassificationRoutes } from '../src/privacy/fieldClassification/routes.js';
import { InMemoryFieldClassificationStore } from '../src/privacy/fieldClassification/store.js';
import { candidateFingerprint } from '../src/privacy/fieldClassification/engine.js';

const GUARD_ID = '@omadia/plugin-privacy-guard';
const USER_ID = '7b1f4a52-1111-4222-8333-444455556666';

interface Harness {
  readonly baseUrl: string;
  readonly registry: InMemoryInstalledRegistry;
  readonly store: InMemoryFieldClassificationStore;
  readonly audits: Array<Record<string, unknown>>;
  readonly updates: number[];
  close(): Promise<void>;
}

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function observation(fieldPath: string): FieldObservation {
  return {
    toolName: 'odoo_execute',
    fieldPath,
    valueShape: 'm2o',
    sourceModels: ['hr.employee'],
    seenCount: 2,
    firstSeenAt: '2026-10-30T08:00:00.000Z',
    lastSeenAt: '2026-10-30T09:00:00.000Z',
  };
}

/** Seed one classified candidate; returns its id and fingerprint. */
async function seed(
  store: InMemoryFieldClassificationStore,
  fieldPath: string,
  relation: string,
): Promise<{ id: string; fingerprint: string }> {
  await store.upsertObservation(observation(fieldPath));
  const row = (await store.list()).find((c) => c.fieldPath === fieldPath)!;
  const fingerprint = candidateFingerprint({
    sourceModels: row.sourceModels,
    relationModels: [relation],
    valueShape: 'm2o',
  });
  await store.saveClassification(row.id, {
    relationModels: [relation],
    status: 'suggested',
    reasons: [],
    fingerprint,
    sampleVerdict: { sampleCount: 4, identityHit: false, c1: 'clean', hitTypes: [] },
    maskedPreview: ['•••••••• & •••••••••••'],
    computedAt: '2026-10-30T10:00:00.000Z',
  });
  return { id: row.id, fingerprint };
}

async function makeHarness(config: Record<string, unknown> = {}): Promise<Harness> {
  const registry = new InMemoryInstalledRegistry();
  await registry.register({
    id: GUARD_ID,
    installed_version: '0.14.0',
    installed_at: '2026-10-30T08:00:00.000Z',
    status: 'active',
    config,
  });
  const updates: number[] = [];
  const original = registry.updateConfig.bind(registry);
  registry.updateConfig = async (id, next) => {
    updates.push(1);
    await original(id, next);
  };
  const catalog = {
    get: (id: string) => (id === GUARD_ID ? { plugin: { provides: ['privacy.redact@1'] } } : undefined),
  } as unknown as PluginCatalog;
  const store = new InMemoryFieldClassificationStore();
  const audits: Array<Record<string, unknown>> = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { session?: unknown }).session = {
      sub: 'admin@example.com',
      uid: USER_ID,
      email: 'admin@example.com',
    } as never;
    next();
  });
  app.use(
    '/api/v1/admin/privacy/field-classification',
    createFieldClassificationRoutes({
      store,
      installedRegistry: registry,
      catalog,
      serviceRegistry: {
        get: <T,>(name: string) =>
          (name === PRIVACY_REDACT_SERVICE_NAME
            ? { maskedFieldPreview: () => ['live'] }
            : undefined) as T | undefined,
      },
      audit: {
        record: async (entry) => {
          audits.push(entry as unknown as Record<string, unknown>);
        },
      },
      recompute: async () => ({ computedAt: '2026-10-30T11:00:00.000Z', candidates: 0, observations: 0 }),
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/api/v1/admin/privacy/field-classification`,
    registry,
    store,
    audits,
    updates,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function decide(id: string, action: string, fingerprint: string): Promise<Response> {
  assert.ok(harness);
  return fetch(`${harness.baseUrl}/${id}/decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, fingerprint }),
  });
}

const npf = (): unknown => harness?.registry.get(GUARD_ID)?.config['non_personal_fields'];

describe('field-classification routes', () => {
  it('lists candidates with live status, counts and new-since-last-visit', async () => {
    harness = await makeHarness();
    await seed(harness.store, 'department_id', 'hr.department');
    await seed(harness.store, 'partner_id', 'res.partner');
    const res = await fetch(harness.baseUrl);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
      counts: Record<string, number>;
      newSinceLastVisit: number;
      computedAt: string;
    };
    assert.equal(body.items.length, 2);
    const dept = body.items.find((i) => i['fieldPath'] === 'department_id')!;
    assert.equal(dept['status'], 'suggested');
    assert.equal(dept['configEntry'], 'odoo_execute:department_id');
    assert.equal(body.counts['personal'], 1);
    assert.equal(body.counts['suggested'], 1);
    assert.equal(body.newSinceLastVisit, 1);
    assert.equal(body.computedAt, '2026-10-30T10:00:00.000Z');
    // No value anywhere in the payload: only shapes, models and codes.
    assert.equal(JSON.stringify(body).includes('••'), false);

    const again = (await (await fetch(harness.baseUrl)).json()) as { newSinceLastVisit: number };
    assert.equal(again.newSinceLastVisit, 0);
    const filtered = (await (await fetch(`${harness.baseUrl}?status=personal`)).json()) as {
      items: unknown[];
    };
    assert.equal(filtered.items.length, 1);
  });

  it('confirm appends exactly tool:field and writes an audit row with the actor; revert removes it', async () => {
    harness = await makeHarness({ non_personal_fields: '*:job_id' });
    const { id, fingerprint } = await seed(harness.store, 'department_id', 'hr.department');

    const res = await decide(id, 'confirm', fingerprint);
    assert.equal(res.status, 200);
    const { item } = (await res.json()) as { item: Record<string, unknown> };
    assert.equal(item['status'], 'confirmed');
    assert.deepEqual(item['decision'], {
      action: 'confirm',
      by: 'admin@example.com',
      at: (item['decision'] as { at: string }).at,
    });
    assert.equal(npf(), '*:job_id\nodoo_execute:department_id');
    assert.equal(harness.audits.length, 1);
    const audit = harness.audits[0]!;
    assert.equal(audit['action'], 'privacy.field_classification');
    assert.equal(audit['target'], 'privacy-field:odoo_execute:department_id');
    assert.deepEqual(audit['actor'], { id: USER_ID, email: 'admin@example.com' });
    assert.deepEqual(audit['before'], { status: 'suggested', non_personal_fields: '*:job_id' });
    assert.equal((audit['after'] as Record<string, unknown>)['non_personal_fields'], '*:job_id\nodoo_execute:department_id');
    assert.equal(await harness.store.countOpen().then((c) => c.suggested), 0);

    const revert = await decide(id, 'revert', fingerprint);
    assert.equal(revert.status, 200);
    assert.equal(((await revert.json()) as { item: { status: string } }).item.status, 'suggested');
    assert.equal(npf(), '*:job_id');
    assert.equal(harness.audits.length, 2);
    assert.equal((harness.audits[1]!['after'] as Record<string, unknown>)['decision'], 'revert');
  });

  it('refuses to revert a field a wildcard entry covers', async () => {
    harness = await makeHarness({ non_personal_fields: '*:department_id' });
    const { id, fingerprint } = await seed(harness.store, 'department_id', 'hr.department');
    const res = await decide(id, 'revert', fingerprint);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'covered_by_wildcard', entry: '*:department_id' });
    assert.equal(npf(), '*:department_id');
    assert.equal(harness.updates.length, 0);
  });

  it('answers 409 on a stale fingerprint, and 404 on an unknown id', async () => {
    harness = await makeHarness();
    const { id } = await seed(harness.store, 'department_id', 'hr.department');
    const res = await decide(id, 'confirm', 'not-the-current-one');
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: string }).error, 'stale_fingerprint');
    assert.equal(npf(), undefined);
    const missing = await decide('0f5c1c3a-1111-4222-8333-444455556666', 'confirm', 'x');
    assert.equal(missing.status, 404);
  });

  it('reject and keep_masked never touch config; revert clears them', async () => {
    harness = await makeHarness({ non_personal_fields: 'odoo_execute:other_id' });
    const a = await seed(harness.store, 'department_id', 'hr.department');
    const b = await seed(harness.store, 'partner_id', 'res.partner');

    const rejected = await decide(a.id, 'reject', a.fingerprint);
    assert.equal(rejected.status, 200);
    assert.equal(((await rejected.json()) as { item: { status: string } }).item.status, 'rejected');
    const kept = await decide(b.id, 'keep_masked', b.fingerprint);
    assert.equal(kept.status, 200);
    assert.equal(((await kept.json()) as { item: { status: string } }).item.status, 'kept_masked');
    assert.equal(npf(), 'odoo_execute:other_id');
    assert.equal(harness.updates.length, 0);
    assert.equal(harness.audits.length, 2);

    const revert = await decide(a.id, 'revert', a.fingerprint);
    assert.equal(((await revert.json()) as { item: { status: string } }).item.status, 'suggested');
    const revertKept = await decide(b.id, 'revert', b.fingerprint);
    assert.equal(((await revertKept.json()) as { item: { status: string } }).item.status, 'personal');
    assert.equal(harness.updates.length, 0);
    assert.equal(harness.audits.length, 4);
  });

  it('a personal field can only be kept masked', async () => {
    harness = await makeHarness();
    const { id, fingerprint } = await seed(harness.store, 'partner_id', 'res.partner');
    const res = await decide(id, 'confirm', fingerprint);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'action_not_allowed', status: 'personal' });
    assert.equal(npf(), undefined);
  });

  it('a listed field that points to a person is confirmed_conflict; confirm acknowledges without writing', async () => {
    harness = await makeHarness({ non_personal_fields: 'odoo_execute:partner_id' });
    const { id, fingerprint } = await seed(harness.store, 'partner_id', 'res.partner');

    const list = (await (await fetch(harness.baseUrl)).json()) as {
      items: Array<{ status: string; reasons: Array<{ code: string }> }>;
      counts: Record<string, number>;
      newSinceLastVisit: number;
    };
    assert.equal(list.items[0]?.status, 'confirmed_conflict');
    assert.deepEqual(list.items[0]?.reasons.map((r) => r.code), ['confirmed_conflict', 'person_model']);
    assert.equal(list.counts['confirmed_conflict'], 1);
    assert.equal(list.newSinceLastVisit, 1);

    const keep = await decide(id, 'keep_masked', fingerprint);
    assert.equal(keep.status, 409);
    assert.deepEqual(await keep.json(), { error: 'action_not_allowed', status: 'confirmed_conflict' });

    const ack = await decide(id, 'confirm', fingerprint);
    assert.equal(ack.status, 200);
    const { item } = (await ack.json()) as {
      item: { status: string; reasons: Array<{ code: string }>; decision: { action: string } };
    };
    assert.equal(item.status, 'confirmed');
    assert.deepEqual(item.reasons.map((r) => r.code), ['person_model'], 'the person reason stays visible');
    assert.equal(item.decision.action, 'confirm');
    assert.equal(npf(), 'odoo_execute:partner_id');
    assert.equal(harness.updates.length, 0, 'acknowledging never writes config');
    assert.equal(harness.audits.length, 1);
    assert.equal((harness.audits[0]!['before'] as Record<string, unknown>)['status'], 'confirmed_conflict');
    assert.equal(await harness.store.countOpen().then((c) => c.confirmedConflict), 0);
  });

  it('revert on confirmed_conflict removes the entry', async () => {
    harness = await makeHarness({ non_personal_fields: 'odoo_execute:partner_id\nodoo_execute:job_id' });
    const { id, fingerprint } = await seed(harness.store, 'partner_id', 'res.partner');
    const res = await decide(id, 'revert', fingerprint);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { item: { status: string } }).item.status, 'personal');
    assert.equal(npf(), 'odoo_execute:job_id');
  });

  it('refuses (409 invalid_field) and hides a field whose path is not one valid entry', async () => {
    harness = await makeHarness();
    for (const path of ['x\n*:partner_id', 'x,partner_id', 'a b', '*']) {
      // The store itself does not validate: a row from before the check.
      await harness.store.upsertObservation(observation(path));
      const row = (await harness.store.list()).find((c) => c.fieldPath === path)!;
      for (const action of ['confirm', 'reject']) {
        const res = await decide(row.id, action, row.fingerprint || 'fp');
        assert.equal(res.status, 409, JSON.stringify(path));
        assert.deepEqual(await res.json(), { error: 'invalid_field' });
      }
    }
    assert.equal(npf(), undefined);
    assert.equal(harness.updates.length, 0);
    assert.equal(harness.audits.length, 0);
    const list = (await (await fetch(harness.baseUrl)).json()) as { items: unknown[] };
    assert.deepEqual(list.items, []);
  });

  it('serves the stored masked preview, and triggers a recompute', async () => {
    harness = await makeHarness();
    const { id } = await seed(harness.store, 'department_id', 'hr.department');
    const preview = await fetch(`${harness.baseUrl}/${id}/preview`);
    assert.deepEqual(await preview.json(), { samples: ['•••••••• & •••••••••••'] });
    const recompute = await fetch(`${harness.baseUrl}/recompute`, { method: 'POST' });
    assert.equal(recompute.status, 202);
    assert.deepEqual(await recompute.json(), { computedAt: '2026-10-30T11:00:00.000Z' });
  });
});
