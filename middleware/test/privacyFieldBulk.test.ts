/**
 * Field classification — bulk accept (preview / confirm / latest / undo),
 * the admin actions on auto-approved and auto-revoked fields, and the
 * auto-approval dry run, against an in-memory store and installed registry
 * (express on 127.0.0.1 + fetch, like the other admin-route suites).
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';

import type { FieldObservation } from '@omadia/plugin-api';

import { InMemoryInstalledRegistry } from '../src/plugins/installedRegistry.js';
import type { PluginCatalog } from '../src/plugins/manifestLoader.js';
import { candidateFingerprint } from '../src/privacy/fieldClassification/engine.js';
import { createFieldClassificationRoutes } from '../src/privacy/fieldClassification/routes.js';
import { InMemoryFieldClassificationStore } from '../src/privacy/fieldClassification/store.js';

const GUARD_ID = '@omadia/plugin-privacy-guard';
const USER_ID = '7b1f4a52-1111-4222-8333-444455556666';
const CLEAN = { sampleCount: 4, identityHit: false, c1: 'clean', hitTypes: [] } as const;

interface Harness {
  readonly base: string;
  readonly registry: InMemoryInstalledRegistry;
  readonly store: InMemoryFieldClassificationStore;
  readonly audits: Array<Record<string, unknown>>;
  readonly writes: number[];
  recomputes: number;
  close(): Promise<void>;
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function makeHarness(config: Record<string, unknown> = {}): Promise<Harness> {
  const registry = new InMemoryInstalledRegistry();
  await registry.register({
    id: GUARD_ID,
    installed_version: '0.16.0',
    installed_at: '2026-10-30T08:00:00.000Z',
    status: 'active',
    config,
  });
  const writes: number[] = [];
  const original = registry.updateConfig.bind(registry);
  registry.updateConfig = async (id, next) => {
    writes.push(1);
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
  const harness = {
    recomputes: 0,
  } as { recomputes: number };
  app.use(
    '/fc',
    createFieldClassificationRoutes({
      store,
      installedRegistry: registry,
      catalog,
      serviceRegistry: { get: () => undefined },
      audit: {
        record: async (entry) => {
          audits.push(entry as unknown as Record<string, unknown>);
        },
      },
      recompute: async () => {
        harness.recomputes += 1;
        return { computedAt: '2026-10-31T00:00:00.000Z', candidates: 0, observations: 0 };
      },
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return Object.assign(harness, {
    base: `http://127.0.0.1:${String(port)}/fc`,
    registry,
    store,
    audits,
    writes,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

function observation(fieldPath: string, scope: string, toolName: string): FieldObservation {
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

async function seed(
  fieldPath: string,
  relation: string | undefined,
  opts: { scope?: string; tool?: string; sample?: typeof CLEAN | Record<string, unknown> } = {},
): Promise<{ id: string; fingerprint: string }> {
  assert.ok(h);
  const scope = opts.scope ?? 'sale.order';
  const toolName = opts.tool ?? 'odoo_execute';
  await h.store.upsertObservation(observation(fieldPath, scope, toolName));
  const row = (await h.store.list()).find(
    (c) => c.fieldPath === fieldPath && c.scope === scope && c.toolName === toolName,
  )!;
  const relationModels = relation !== undefined ? [relation] : [];
  const fingerprint = candidateFingerprint({ scope, relationModels, valueShape: 'm2o' });
  await h.store.saveClassification(row.id, {
    relationModels,
    status: 'suggested',
    reasons: [],
    fingerprint,
    sampleVerdict: (opts.sample ?? CLEAN) as never,
    computedAt: '2026-10-30T10:00:00.000Z',
  });
  return { id: row.id, fingerprint };
}

async function post(path: string, body?: unknown): Promise<Response> {
  assert.ok(h);
  return fetch(`${h.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const npf = (): unknown => h?.registry.get(GUARD_ID)?.config['non_personal_fields'];

async function saveRegionVerdict(confidence = 0.95): Promise<void> {
  assert.ok(h);
  await h.store.saveModelVerdicts([
    { model: 'x_custom.region', verdict: 'non-personal', source: 'haiku', confidence, reason: '', fieldsHash: '' },
  ]);
}

describe('bulk accept', () => {
  it('preview lists exactly the open suggestions with reason and tool breakdown', async () => {
    h = await makeHarness();
    await saveRegionVerdict();
    const team = await seed('team_id', 'crm.team');
    const region = await seed('region_id', 'x_custom.region');
    await seed('partner_id', 'res.partner');
    await seed('stage_id', 'crm.stage', { tool: 'other_tool' });
    await seed('near_id', 'crm.team', { sample: { ...CLEAN, c1: 'near-miss' } });

    const res = await fetch(`${h.base}/bulk/preview?status=suggested`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await json<{
      count: number;
      byReason: Record<string, number>;
      byTool: Record<string, number>;
      items: Array<Record<string, unknown>>;
    }>(res);
    assert.equal(body.count, 3);
    assert.deepEqual(body.byReason, { known_non_personal: 2, haiku: 1 });
    assert.deepEqual(body.byTool, { odoo_execute: 2, other_tool: 1 });
    const regionItem = body.items.find((i) => i['id'] === region.id);
    assert.deepEqual(regionItem, {
      id: region.id,
      toolName: 'odoo_execute',
      scope: 'sale.order',
      fieldPath: 'region_id',
      entry: 'odoo_execute:sale.order/region_id',
      reasonCode: 'haiku',
    });

    const filtered = await json<{ count: number; items: Array<{ id: string }> }>(
      await fetch(`${h.base}/bulk/preview?tool=odoo_execute&scope=sale.order`),
    );
    assert.equal(filtered.count, 2);
    assert.ok(filtered.items.some((i) => i.id === team.id));
    assert.equal((await fetch(`${h.base}/bulk/preview?ids=nope`)).status, 400);
  });

  it('confirm re-validates every id, writes config once, audits per field with the admin and records a batch', async () => {
    h = await makeHarness({ non_personal_fields: 'odoo_execute:sale.order/covered_id' });
    const team = await seed('team_id', 'crm.team');
    const stage = await seed('stage_id', 'crm.stage');
    const partner = await seed('partner_id', 'res.partner');
    const hit = await seed('hit_id', 'crm.team', { sample: { ...CLEAN, identityHit: true, hitTypes: ['email'] } });
    const covered = await seed('covered_id', 'crm.team');
    const conflict = await seed('mix_id', undefined);
    const noScope = await seed('free_id', 'crm.team', { scope: '-' });
    const unknown = '0f5c1c3a-1111-4222-8333-444455556666';

    const res = await post('/bulk/confirm', {
      ids: [team.id, stage.id, partner.id, hit.id, covered.id, conflict.id, noScope.id, unknown],
    });
    assert.equal(res.status, 200);
    const body = await json<{
      batchId: string;
      applied: Array<Record<string, unknown>>;
      skipped: Array<{ id: string; reason: string }>;
      remaining: number;
    }>(res);
    assert.deepEqual(
      body.applied.map((a) => a['entry']),
      ['odoo_execute:sale.order/team_id', 'odoo_execute:sale.order/stage_id'],
      'in the order of the ids',
    );
    assert.deepEqual(body.applied[0], {
      id: team.id,
      toolName: 'odoo_execute',
      scope: 'sale.order',
      fieldPath: 'team_id',
      entry: 'odoo_execute:sale.order/team_id',
    });
    const reasons = Object.fromEntries(body.skipped.map((s) => [s.id, s.reason]));
    assert.deepEqual(reasons, {
      [unknown]: 'stale',
      [partner.id]: 'person_model',
      [hit.id]: 'detector_hit',
      [covered.id]: 'already_covered',
      [conflict.id]: 'not_suggested',
      [noScope.id]: 'no_scope',
    });
    assert.equal(body.remaining, 0);
    assert.equal(h.writes.length, 1, 'one config write');
    assert.equal(
      npf(),
      'odoo_execute:sale.order/covered_id\nodoo_execute:sale.order/team_id\nodoo_execute:sale.order/stage_id',
    );
    const stored = await h.store.get(team.id);
    assert.equal(stored?.status, 'confirmed');
    assert.equal(stored?.decision?.action, 'confirm');
    assert.equal(stored?.decision?.batchId, body.batchId);
    assert.equal(stored?.decision?.byId, USER_ID);
    assert.equal(h.audits.length, 2);
    assert.deepEqual(h.audits[0], {
      actor: { id: USER_ID, email: 'admin@example.com' },
      action: 'privacy.field_classification',
      target: 'privacy-field:odoo_execute:sale.order/team_id',
      before: { status: 'suggested' },
      after: {
        decision: 'confirm',
        status: 'confirmed',
        batchId: body.batchId,
        entry: 'odoo_execute:sale.order/team_id',
        plugin: GUARD_ID,
      },
    });
    const latest = await json<{ batch: Record<string, unknown> | null }>(await fetch(`${h.base}/bulk/latest`));
    assert.deepEqual(latest.batch, {
      id: body.batchId,
      createdAt: (latest.batch as { createdAt: string }).createdAt,
      actorEmail: 'admin@example.com',
      count: 2,
    });
  });

  it('a filter (or nothing) takes every open suggestion of the selection; ids and filter together are refused', async () => {
    h = await makeHarness();
    await seed('team_id', 'crm.team');
    await seed('stage_id', 'crm.stage', { tool: 'other_tool' });
    await seed('partner_id', 'res.partner');
    assert.equal((await post('/bulk/confirm', { ids: [], filter: {} })).status, 400);
    assert.equal(
      (await post('/bulk/confirm', { ids: ['0f5c1c3a-1111-4222-8333-444455556666'], filter: {} })).status,
      400,
    );
    const byTool = await json<{ applied: unknown[]; skipped: unknown[] }>(
      await post('/bulk/confirm', { filter: { status: 'suggested', tool: 'other_tool' } }),
    );
    assert.equal(byTool.applied.length, 1);
    assert.deepEqual(byTool.skipped, []);
    const all = await json<{ applied: unknown[] }>(await post('/bulk/confirm', {}));
    assert.equal(all.applied.length, 1);
    assert.equal(npf(), 'other_tool:sale.order/stage_id\nodoo_execute:sale.order/team_id');
    // Nothing left: no batch, no write.
    const writes = h.writes.length;
    const none = await json<{ batchId: string | null; applied: unknown[] }>(await post('/bulk/confirm', {}));
    assert.equal(none.batchId, null);
    assert.equal(h.writes.length, writes);
  });

  it('caps a call at 500 fields and reports the rest as remaining', async () => {
    h = await makeHarness();
    for (let i = 0; i < 501; i += 1) await seed(`f${String(i).padStart(3, '0')}_id`, 'crm.team');
    const body = await json<{ applied: unknown[]; remaining: number }>(await post('/bulk/confirm', {}));
    assert.equal(body.applied.length, 500);
    assert.equal(body.remaining, 1);
    assert.equal(h.writes.length, 1);
  });

  it('undo removes exactly the entries the latest batch still owns', async () => {
    h = await makeHarness({ non_personal_fields: 'keep_me' });
    const team = await seed('team_id', 'crm.team');
    const stage = await seed('stage_id', 'crm.stage');
    const tag = await seed('tag_id', 'crm.tag');
    const first = await json<{ batchId: string }>(await post('/bulk/confirm', { ids: [team.id] }));
    const second = await json<{ batchId: string }>(await post('/bulk/confirm', { ids: [stage.id, tag.id] }));

    // Only the latest batch can be undone.
    const older = await post(`/bulk/${first.batchId}/undo`);
    assert.equal(older.status, 409);
    assert.deepEqual(await older.json(), { error: 'not_latest_batch' });

    // tag_id: the admin reverted it on its own meanwhile → not this batch's.
    const tagRow = (await h.store.get(tag.id))!;
    const reverted = await post(`/${tag.id}/decision`, { action: 'revert', fingerprint: tagRow.fingerprint });
    assert.equal(reverted.status, 200);

    const auditsBefore = h.audits.length;
    const res = await post(`/bulk/${second.batchId}/undo`);
    assert.equal(res.status, 200);
    const body = await json<{ batchId: string; reverted: unknown[]; skipped: unknown[] }>(res);
    assert.deepEqual(body, {
      batchId: second.batchId,
      reverted: [{ id: stage.id, entry: 'odoo_execute:sale.order/stage_id' }],
      skipped: [{ id: tag.id, reason: 'not_owned' }],
    });
    assert.equal(npf(), 'keep_me\nodoo_execute:sale.order/team_id');
    const stageRow = await h.store.get(stage.id);
    assert.equal(stageRow?.decision?.action, 'revert');
    assert.equal(stageRow?.status, 'suggested');
    assert.equal(h.audits.length, auditsBefore + 1);
    assert.deepEqual((h.audits.at(-1) as { after: Record<string, unknown> }).after['batchId'], second.batchId);

    const again = await post(`/bulk/${second.batchId}/undo`);
    assert.equal(again.status, 409);
    assert.deepEqual(await again.json(), { error: 'already_undone' });

    // The first batch is the latest open one now; its entry was removed by hand.
    await h.registry.updateConfig(GUARD_ID, { non_personal_fields: 'keep_me' });
    const latest = await json<{ batch: { id: string } | null }>(await fetch(`${h.base}/bulk/latest`));
    assert.equal(latest.batch?.id, first.batchId);
    const firstUndo = await json<{ skipped: unknown[] }>(await post(`/bulk/${first.batchId}/undo`));
    assert.deepEqual(firstUndo.skipped, [{ id: team.id, reason: 'not_present' }]);
    assert.deepEqual(await json(await fetch(`${h.base}/bulk/latest`)), { batch: null });
    assert.equal((await post('/bulk/0f5c1c3a-1111-4222-8333-444455556666/undo')).status, 404);
  });
});

describe('admin actions on auto-approved and auto-revoked fields', () => {
  async function autoApproved(): Promise<{ id: string; fingerprint: string }> {
    assert.ok(h);
    const field = await seed('team_id', 'crm.team');
    await h.registry.updateConfig(GUARD_ID, { non_personal_fields: 'odoo_execute:sale.order/team_id' });
    await h.store.saveDecision(
      field.id,
      {
        action: 'auto_approve',
        fingerprint: field.fingerprint,
        byId: null,
        byEmail: 'system:auto-classifier',
        at: '2026-10-31T00:00:00.000Z',
      },
      'auto_approved',
    );
    return field;
  }

  it('lists an auto-approved field with its basis and the system actor', async () => {
    h = await makeHarness();
    await autoApproved();
    const body = await json<{ items: Array<Record<string, unknown>>; counts: Record<string, number> }>(
      await fetch(`${h.base}/?status=auto_approved`),
    );
    assert.equal(body.counts['auto_approved'], 1);
    const item = body.items[0]!;
    assert.equal(item['status'], 'auto_approved');
    assert.deepEqual((item['reasons'] as unknown[])[0], { code: 'auto_approved', basis: 'known_non_personal' });
    assert.deepEqual(item['decision'], {
      action: 'auto_approve',
      by: 'system:auto-classifier',
      at: '2026-10-31T00:00:00.000Z',
      batchId: null,
    });
  });

  it('revert removes the entry and records revert', async () => {
    h = await makeHarness();
    const field = await autoApproved();
    const res = await post(`/${field.id}/decision`, { action: 'revert', fingerprint: field.fingerprint });
    assert.equal(res.status, 200);
    assert.equal(npf(), undefined);
    const row = await h.store.get(field.id);
    assert.equal(row?.decision?.action, 'revert');
    assert.equal(row?.status, 'suggested');
    assert.equal(h.audits.length, 1);
  });

  it('confirm takes ownership without a write', async () => {
    h = await makeHarness();
    const field = await autoApproved();
    const writes = h.writes.length;
    const res = await post(`/${field.id}/decision`, { action: 'confirm', fingerprint: field.fingerprint });
    assert.equal(res.status, 200);
    assert.equal((await json<{ item: { status: string } }>(res)).item.status, 'confirmed');
    assert.equal(h.writes.length, writes);
    assert.equal(npf(), 'odoo_execute:sale.order/team_id');
  });

  it('an auto-revoked field takes confirm unless it is personal now; keep_masked always', async () => {
    h = await makeHarness();
    const team = await seed('team_id', 'crm.team');
    const partner = await seed('partner_id', 'res.partner');
    for (const f of [team, partner]) {
      await h.store.saveDecision(
        f.id,
        { action: 'auto_revoke', fingerprint: f.fingerprint, byId: null, byEmail: 'system:auto-classifier', at: '2026-10-31T00:00:00.000Z' },
        'auto_revoked',
      );
    }
    const refused = await post(`/${partner.id}/decision`, { action: 'confirm', fingerprint: partner.fingerprint });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: 'action_not_allowed', status: 'auto_revoked' });
    assert.equal(
      (await post(`/${partner.id}/decision`, { action: 'keep_masked', fingerprint: partner.fingerprint })).status,
      200,
    );
    const ok = await post(`/${team.id}/decision`, { action: 'confirm', fingerprint: team.fingerprint });
    assert.equal(ok.status, 200);
    assert.equal(npf(), 'odoo_execute:sale.order/team_id');
  });
});

describe('POST /recompute?dryRun=1', () => {
  it('reports what would be auto-approved, without running or writing anything', async () => {
    h = await makeHarness({ auto_approve_non_personal: false, auto_approve_confidence: '0,9' });
    await saveRegionVerdict(0.95);
    await seed('team_id', 'crm.team');
    await seed('region_id', 'x_custom.region');
    await seed('partner_id', 'res.partner');
    await seed('department_id', 'hr.department', { scope: 'hr.employee' });
    const res = await post('/recompute?dryRun=1');
    assert.equal(res.status, 200);
    const body = await json<Record<string, unknown>>(res);
    assert.equal(body['dryRun'], true);
    assert.equal(body['enabled'], false);
    assert.equal(body['threshold'], 0.9);
    assert.equal(body['candidates'], 4);
    // An employee's department (a person scope pointing to a known
    // non-personal model) is eligible; only the field pointing to a person
    // model is blocked.
    assert.equal(body['eligible'], 3);
    assert.deepEqual(body['byBasis'], { known_non_personal: 2, haiku: 1 });
    assert.deepEqual(body['byTool'], { odoo_execute: 3 });
    assert.deepEqual(body['byScope'], { 'odoo_execute:sale.order': 2, 'odoo_execute:hr.employee': 1 });
    assert.deepEqual(body['blocked'], { person_model: 1 });
    const sample = body['sample'] as Array<Record<string, unknown>>;
    assert.deepEqual(
      sample.find((s) => s['fieldPath'] === 'region_id'),
      {
        id: sample.find((s) => s['fieldPath'] === 'region_id')!['id'],
        toolName: 'odoo_execute',
        scope: 'sale.order',
        fieldPath: 'region_id',
        relationModels: ['x_custom.region'],
        basis: 'haiku',
        confidence: 0.95,
        entry: 'odoo_execute:sale.order/region_id',
      },
    );
    assert.equal(h.recomputes, 0);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.audits, []);
  });
});
