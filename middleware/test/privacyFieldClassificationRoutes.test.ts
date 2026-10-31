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

import {
  PRIVACY_FIELD_SAMPLES_SERVICE_NAME,
  PRIVACY_REDACT_SERVICE_NAME,
  type FieldObservation,
} from '@omadia/plugin-api';

import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { createFieldClassificationRoutes } from '../src/privacy/fieldClassification/routes.js';
import { InMemoryFieldClassificationStore } from '../src/privacy/fieldClassification/store.js';
import { candidateFingerprint } from '../src/privacy/fieldClassification/engine.js';

const GUARD_ID = '@omadia/plugin-privacy-guard';
const DATASET = '0f5c1c3a-1111-4222-8333-444455556666';
const USER_ID = '7b1f4a52-1111-4222-8333-444455556666';

interface Harness {
  readonly baseUrl: string;
  readonly registry: InMemoryInstalledRegistry;
  readonly store: InMemoryFieldClassificationStore;
  readonly audits: Array<Record<string, unknown>>;
  readonly updates: number[];
  readonly sampleCalls: unknown[];
  close(): Promise<void>;
}

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function observation(
  fieldPath: string,
  scope = 'hr.employee',
  toolName = 'odoo_execute',
): FieldObservation {
  return {
    toolName,
    scope,
    fieldPath,
    valueShape: 'm2o',
    seenCount: 2,
    firstSeenAt: '2026-10-30T08:00:00.000Z',
    lastSeenAt: '2026-10-30T09:00:00.000Z',
  };
}

/** Seed one classified candidate; returns its id and fingerprint. */
async function seed(
  store: InMemoryFieldClassificationStore,
  fieldPath: string,
  relation: string | undefined,
  scope = 'hr.employee',
  toolName = 'odoo_execute',
): Promise<{ id: string; fingerprint: string }> {
  await store.upsertObservation(observation(fieldPath, scope, toolName));
  const row = (await store.list()).find(
    (c) => c.fieldPath === fieldPath && c.scope === scope && c.toolName === toolName,
  )!;
  const relationModels = relation !== undefined ? [relation] : [];
  const fingerprint = candidateFingerprint({
    scope,
    relationModels,
    valueShape: 'm2o',
  });
  await store.saveClassification(row.id, {
    relationModels,
    relationInfoKnown: true,
    status: 'suggested',
    reasons: [],
    fingerprint,
    sampleVerdict: { sampleCount: 4, identityHit: false, c1: 'clean', hitTypes: [] },
    maskedPreview: ['•••••••• & •••••••••••'],
    computedAt: '2026-10-30T10:00:00.000Z',
  });
  return { id: row.id, fingerprint };
}

async function makeHarness(
  config: Record<string, unknown> = {},
  sampleValues: readonly string[] = ['Research & Development', 'Sales'],
): Promise<Harness> {
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
  const sampleCalls: unknown[] = [];
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
            ? {
                maskedFieldPreview: () => ['live'],
                // The plugin-facing service is never asked for real values.
                fieldSampleForAdmin: () => {
                  sampleCalls.push('privacyRedact');
                  return ['WRONG SERVICE'];
                },
              }
            : name === PRIVACY_FIELD_SAMPLES_SERVICE_NAME
              ? {
                  fieldSampleForAdmin: (field: { limit?: number }) => {
                    sampleCalls.push(field);
                    return sampleValues;
                  },
                }
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
    sampleCalls,
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
    assert.equal(dept['configEntry'], 'odoo_execute:hr.employee/department_id');
    assert.equal(dept['scope'], 'hr.employee');
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

  it('confirm appends exactly the scoped entry and writes an audit row with the actor; revert removes it', async () => {
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
      batchId: null,
    });
    assert.equal(npf(), '*:job_id\nodoo_execute:hr.employee/department_id');
    assert.equal(harness.audits.length, 1);
    const audit = harness.audits[0]!;
    assert.equal(audit['action'], 'privacy.field_classification');
    assert.equal(audit['target'], 'privacy-field:odoo_execute:hr.employee/department_id');
    assert.deepEqual(audit['actor'], { id: USER_ID, email: 'admin@example.com' });
    assert.deepEqual(audit['before'], { status: 'suggested', non_personal_fields: '*:job_id' });
    assert.equal((audit['after'] as Record<string, unknown>)['non_personal_fields'], '*:job_id\nodoo_execute:hr.employee/department_id');
    assert.equal(await harness.store.countOpen().then((c) => c.suggested), 0);

    const revert = await decide(id, 'revert', fingerprint);
    assert.equal(revert.status, 200);
    assert.equal(((await revert.json()) as { item: { status: string } }).item.status, 'suggested');
    assert.equal(npf(), '*:job_id');
    assert.equal(harness.audits.length, 2);
    assert.equal((harness.audits[1]!['after'] as Record<string, unknown>)['decision'], 'revert');
  });

  it('a legacy entry confirms with legacy_entry; revert refuses (409 covered_by_legacy)', async () => {
    for (const entry of ['*:department_id', 'department_id', 'odoo_execute:department_id']) {
      harness = await makeHarness({ non_personal_fields: entry });
      const { id, fingerprint } = await seed(harness.store, 'department_id', 'hr.department');
      const list = (await (await fetch(harness.baseUrl)).json()) as {
        items: Array<{ status: string; reasons: Array<Record<string, unknown>> }>;
      };
      assert.equal(list.items[0]?.status, 'confirmed', entry);
      assert.deepEqual(list.items[0]?.reasons.at(-1), { code: 'legacy_entry', entry });
      const res = await decide(id, 'revert', fingerprint);
      assert.equal(res.status, 409);
      assert.deepEqual(await res.json(), { error: 'covered_by_legacy', entry });
      assert.equal(npf(), entry);
      assert.equal(harness.updates.length, 0);
      await harness.close();
      harness = undefined;
    }
  });

  it('confirm on a dataset column and an MCP source writes their scoped forms', async () => {
    harness = await makeHarness();
    const dataset = await seed(harness.store, 'Abteilung Name', undefined, DATASET, 'query_dataset');
    const mcp = await seed(harness.store, 'category', undefined, '-', 'mcp_shop');
    // A clean vet + a confident source verdict make both suggested.
    await harness.store.saveModelVerdicts([
      { model: `query_dataset:${DATASET}`, verdict: 'non-personal', source: 'haiku', confidence: 0.9, reason: '', fieldsHash: 'h' },
      { model: 'mcp_shop:-', verdict: 'non-personal', source: 'haiku', confidence: 0.9, reason: '', fieldsHash: 'h' },
    ]);
    const a = await decide(dataset.id, 'confirm', dataset.fingerprint);
    assert.equal(a.status, 200);
    const b = await decide(mcp.id, 'confirm', mcp.fingerprint);
    assert.equal(b.status, 200);
    assert.equal(npf(), `dataset:${DATASET}/Abteilung Name\nmcp_shop:-/category`);
    assert.equal(harness.audits[0]!['target'], `privacy-field:query_dataset:${DATASET}/Abteilung Name`);
  });

  it('lists legacy entries with the fields they cover, and converts one (audit, decisions)', async () => {
    harness = await makeHarness({ non_personal_fields: 'odoo_execute:department_id\n*:job_id' });
    const emp = await seed(harness.store, 'department_id', 'hr.department');
    const sale = await seed(harness.store, 'department_id', 'hr.department', 'sale.order');
    const person = await seed(harness.store, 'department_id', 'res.partner', 'crm.lead');

    const legacy = (await (await fetch(`${harness.baseUrl}/legacy`)).json()) as {
      entries: Array<{ entry: string; covers: Array<{ id: string; configEntry: string }> }>;
    };
    assert.deepEqual(
      legacy.entries.map((e) => [e.entry, e.covers.map((c) => c.configEntry)]),
      [
        [
          'odoo_execute:department_id',
          [
            'odoo_execute:crm.lead/department_id',
            'odoo_execute:hr.employee/department_id',
            'odoo_execute:sale.order/department_id',
          ],
        ],
        ['*:job_id', []],
      ],
    );
    assert.deepEqual(
      legacy.entries[0]!.covers.map((c) => [c.configEntry, (c as { personal?: boolean }).personal]),
      [
        ['odoo_execute:crm.lead/department_id', true],
        ['odoo_execute:hr.employee/department_id', false],
        ['odoo_execute:sale.order/department_id', false],
      ],
    );

    const res = await fetch(`${harness.baseUrl}/legacy/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry: 'odoo_execute:department_id' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      added: string[];
      skipped: unknown[];
      skippedPersonal: Array<{ id: string; configEntry: string; personal: boolean }>;
      conflicts: string[];
    };
    assert.deepEqual(body.added, [
      'odoo_execute:hr.employee/department_id',
      'odoo_execute:sale.order/department_id',
    ]);
    assert.deepEqual(body.skipped, []);
    // A field whose base status is personal is NOT converted: it is masked
    // afterwards and listed for the admin to decide.
    assert.deepEqual(
      body.skippedPersonal.map((f) => [f.id, f.configEntry, f.personal]),
      [[person.id, 'odoo_execute:crm.lead/department_id', true]],
    );
    assert.deepEqual(body.conflicts, []);
    assert.equal(
      npf(),
      'odoo_execute:hr.employee/department_id\nodoo_execute:sale.order/department_id\n*:job_id',
    );
    assert.equal(harness.updates.length, 1);
    assert.equal(harness.audits.length, 1);
    const audit = harness.audits[0]!;
    assert.equal(audit['action'], 'privacy.field_classification');
    assert.deepEqual(audit['before'], { non_personal_fields: 'odoo_execute:department_id\n*:job_id' });
    assert.equal((audit['after'] as Record<string, unknown>)['non_personal_fields'], npf());

    assert.equal((await harness.store.get(emp.id))?.decision?.action, 'confirm');
    assert.equal((await harness.store.get(sale.id))?.decision?.action, 'confirm');
    assert.equal((await harness.store.get(person.id))?.decision, null, 'a skipped field gets no decision');
    const list = (await (await fetch(harness.baseUrl)).json()) as {
      items: Array<{ id: string; status: string; reasons: Array<{ code: string }> }>;
    };
    const empItem = list.items.find((i) => i.id === emp.id)!;
    assert.equal(empItem.status, 'confirmed');
    assert.equal(empItem.reasons.some((r) => r.code === 'legacy_entry'), false);
    assert.equal(list.items.find((i) => i.id === person.id)?.status, 'personal', 'masked now');
    assert.deepEqual((audit['after'] as Record<string, unknown>)['skippedPersonal'], [
      'odoo_execute:crm.lead/department_id',
    ]);

    const again = await fetch(`${harness.baseUrl}/legacy/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry: 'odoo_execute:department_id' }),
    });
    assert.equal(again.status, 409);
    assert.deepEqual(await again.json(), { error: 'legacy_entry_not_found', entry: 'odoo_execute:department_id' });
    assert.equal(harness.updates.length, 1);
  });

  it('a field seeded from the Odoo schema lists as not_seen_yet, and can be confirmed', async () => {
    harness = await makeHarness();
    await harness.store.seedField({ ...observation('job_id', 'hr.employee', 'odoo_execute'), seenCount: 0 });
    const row = (await harness.store.list()).find((c) => c.fieldPath === 'job_id')!;
    const fingerprint = candidateFingerprint({ scope: 'hr.employee', relationModels: ['hr.job'], valueShape: 'm2o' });
    await harness.store.saveClassification(row.id, {
      relationModels: ['hr.job'],
      relationInfoKnown: true,
      status: 'needs_clarification',
      reasons: [],
      fingerprint,
      computedAt: '2026-10-30T10:00:00.000Z',
    });
    const body = (await (await fetch(harness.baseUrl)).json()) as {
      items: Array<{ fieldPath: string; status: string; reasons: Array<{ code: string }> }>;
    };
    const job = body.items.find((i) => i.fieldPath === 'job_id')!;
    assert.equal(job.status, 'needs_clarification');
    assert.deepEqual(
      job.reasons.map((r) => r.code),
      ['known_non_personal', 'not_seen_yet'],
    );
    assert.equal((await decide(row.id, 'confirm', fingerprint)).status, 200);
    assert.equal(npf(), 'odoo_execute:hr.employee/job_id');
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
    harness = await makeHarness({ non_personal_fields: 'odoo_execute:hr.employee/other_id' });
    const a = await seed(harness.store, 'department_id', 'hr.department');
    const b = await seed(harness.store, 'partner_id', 'res.partner');

    const rejected = await decide(a.id, 'reject', a.fingerprint);
    assert.equal(rejected.status, 200);
    assert.equal(((await rejected.json()) as { item: { status: string } }).item.status, 'rejected');
    const kept = await decide(b.id, 'keep_masked', b.fingerprint);
    assert.equal(kept.status, 200);
    assert.equal(((await kept.json()) as { item: { status: string } }).item.status, 'kept_masked');
    assert.equal(npf(), 'odoo_execute:hr.employee/other_id');
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
    harness = await makeHarness({ non_personal_fields: 'odoo_execute:hr.employee/partner_id' });
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
    assert.equal(npf(), 'odoo_execute:hr.employee/partner_id');
    assert.equal(harness.updates.length, 0, 'acknowledging never writes config');
    assert.equal(harness.audits.length, 1);
    assert.equal((harness.audits[0]!['before'] as Record<string, unknown>)['status'], 'confirmed_conflict');
    assert.equal(await harness.store.countOpen().then((c) => c.confirmedConflict), 0);
  });

  it('revert on confirmed_conflict removes the entry', async () => {
    harness = await makeHarness({
      non_personal_fields: 'odoo_execute:hr.employee/partner_id\nodoo_execute:hr.employee/job_id',
    });
    const { id, fingerprint } = await seed(harness.store, 'partner_id', 'res.partner');
    const res = await decide(id, 'revert', fingerprint);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { item: { status: string } }).item.status, 'personal');
    assert.equal(npf(), 'odoo_execute:hr.employee/job_id');
  });

  it('refuses (409 invalid_field) and hides a field whose path is not one valid entry', async () => {
    harness = await makeHarness();
    for (const path of ['x\n*:partner_id', 'x,partner_id', 'a:b', 'a/b', ' a']) {
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

  it('the preview returns real samples plus the stored masked ones, and audits the view without values', async () => {
    harness = await makeHarness();
    const { id } = await seed(harness.store, 'department_id', 'hr.department');
    const preview = await fetch(`${harness.baseUrl}/${id}/preview`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await preview.json(), {
      samples: ['Research & Development', 'Sales'],
      maskedSamples: ['•••••••• & •••••••••••'],
      samplesWithheld: null,
    });
    assert.deepEqual(harness.sampleCalls, [
      { toolName: 'odoo_execute', scope: 'hr.employee', fieldPath: 'department_id', limit: 10 },
    ]);
    assert.equal(harness.audits.length, 1);
    const audit = harness.audits[0]!;
    assert.equal(audit['action'], 'privacy.field_preview');
    assert.equal(audit['target'], 'privacy-field:odoo_execute:hr.employee/department_id');
    assert.deepEqual(audit['after'], { count: 2 });
    const serialized = JSON.stringify(audit);
    assert.equal(serialized.includes('Research'), false, 'never a value in the audit row');
    assert.equal(serialized.includes('Sales'), false);

    assert.equal((await fetch(`${harness.baseUrl}/not-a-uuid/preview`)).status, 400);
    assert.equal((await fetch(`${harness.baseUrl}/${DATASET}/preview`)).status, 404);
  });

  it('an uploaded dataset shows masked samples only — no real value, no audit row', async () => {
    harness = await makeHarness();
    const { id } = await seed(harness.store, 'Abteilung', undefined, DATASET, 'query_dataset');
    const preview = await fetch(`${harness.baseUrl}/${id}/preview`);
    assert.equal(preview.status, 200);
    assert.deepEqual(await preview.json(), {
      samples: [],
      maskedSamples: ['•••••••• & •••••••••••'],
      samplesWithheld: 'owner_scoped_dataset',
    });
    assert.deepEqual(harness.sampleCalls, [], 'the sample service is not even asked');
    assert.deepEqual(harness.audits, []);
  });

  it('no real values returned → no audit row', async () => {
    harness = await makeHarness({}, []);
    const { id } = await seed(harness.store, 'department_id', 'hr.department');
    const body = (await (await fetch(`${harness.baseUrl}/${id}/preview`)).json()) as { samples: string[] };
    assert.deepEqual(body.samples, []);
    assert.equal(harness.sampleCalls.length, 1);
    assert.deepEqual(harness.audits, []);
  });

  it('every response is Cache-Control: no-store, errors included', async () => {
    harness = await makeHarness();
    const { id, fingerprint } = await seed(harness.store, 'department_id', 'hr.department');
    const responses = [
      await fetch(harness.baseUrl),
      await fetch(`${harness.baseUrl}?status=bogus`),
      await fetch(`${harness.baseUrl}/legacy`),
      await fetch(`${harness.baseUrl}/${id}/preview`),
      await fetch(`${harness.baseUrl}/not-a-uuid/preview`),
      await decide(id, 'reject', fingerprint),
      await fetch(`${harness.baseUrl}/recompute`, { method: 'POST' }),
      await fetch(`${harness.baseUrl}/legacy/convert`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entry: 'nope' }),
      }),
    ];
    for (const res of responses) {
      assert.equal(res.headers.get('cache-control'), 'no-store', `${res.url} ${String(res.status)}`);
    }
  });

  it('triggers a recompute', async () => {
    harness = await makeHarness();
    const recompute = await fetch(`${harness.baseUrl}/recompute`, { method: 'POST' });
    assert.equal(recompute.status, 202);
    assert.deepEqual(await recompute.json(), { computedAt: '2026-10-30T11:00:00.000Z' });
  });
});
