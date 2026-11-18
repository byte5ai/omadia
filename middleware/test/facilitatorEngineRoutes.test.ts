/**
 * #2043 — the facilitation engine as the operator routes see it: its state
 * (codes, never sentences), the SQL grant as the trust step, the automatic
 * attach at create, and that the kind is fixed. The refusals for everything a
 * facilitator must not have are in `facilitatorOmissionsRoutes.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ENGINE, ODOO, routesHarness } from './_helpers/facilitatorRoutesHarness.js';

describe('facilitation engine: operator routes', () => {
  const h = routesHarness();

  it('reports the facilitation engine state as codes, never as sentences', async () => {
    const status = async (): Promise<Record<string, unknown>> => (await h.call('GET', '/agents/facilitation-engine')).json;
    h.engineState = undefined;
    assert.deepEqual(await status(), {
      state: 'bound',
      capability: 'facilitationEngine@1',
      plugin_id: ENGINE,
      plugin_ids: [ENGINE],
      version: null,
      available: false,
      reason_code: 'not_reported',
      engine_reason: null,
    });
    h.engineState = { pluginId: ENGINE, version: '1.0.0', available: false, unavailableReason: 'Migrations have not run.' };
    assert.deepEqual(
      [(await status())['reason_code'], (await status())['engine_reason'], (await status())['version']],
      ['engine_reported', 'Migrations have not run.', '1.0.0'],
    );
    h.engineState = { pluginId: ENGINE, version: '1.0.0', available: true };
    assert.deepEqual(
      [(await status())['state'], (await status())['available'], (await status())['reason_code']],
      ['bound', true, null],
    );
    // A report from a plugin that is not the bound engine does not count.
    h.engineState = { pluginId: '@acme/other', version: '9', available: true };
    assert.equal((await status())['reason_code'], 'not_reported');

    // Declared, but the operator has not granted it SQL: a candidate, named.
    h.sqlGranted = false;
    assert.deepEqual(
      [(await status())['state'], (await status())['plugin_id'], (await status())['available'], (await status())['reason_code']],
      ['ungranted', ENGINE, false, 'ungranted'],
    );
    h.sqlGranted = true;
    h.installed = [{ id: ENGINE, status: 'inactive' }];
    assert.equal((await status())['reason_code'], 'inactive');
    h.installed = [{ id: ODOO, status: 'active' }];
    assert.deepEqual(
      [(await status())['state'], (await status())['plugin_id'], (await status())['reason_code']],
      ['none', null, 'none'],
    );
    h.installed = [
      { id: ENGINE, status: 'active' },
      { id: '@acme/second-engine', status: 'active' },
    ];
    const two = await status();
    assert.deepEqual([two['state'], two['reason_code']], ['ambiguous', 'ambiguous']);
    assert.deepEqual(two['plugin_ids'], ['@acme/second-engine', ENGINE]);
    assert.equal(JSON.stringify(two).includes('installed'), false, 'no English sentence in the answer');
  });

  it('a plugin that only declares the capability is not the engine until the operator grants it SQL', async () => {
    h.sqlGranted = false;
    // Nothing is attached at create…
    await h.call('POST', '/agents', { slug: 'nora', name: 'Nora', kind: 'facilitator' });
    assert.deepEqual(h.writes, []);
    // …and it cannot be granted by hand either; the refusal says what to do.
    const res = await h.call('PATCH', '/agents/mara/plugins', { id: ENGINE, enabled: true });
    h.assertRefused(res, 'plugin_grant', /declares the facilitation engine but has no database grant yet/);
    h.sqlGranted = true;
    assert.equal((await h.call('PATCH', '/agents/mara/plugins', { id: ENGINE, enabled: true })).status, 200);
  });

  it('the slug of a static route is reserved', async () => {
    const res = await h.call('POST', '/agents', { slug: 'facilitation-engine', name: 'x' });
    assert.equal(res.status, 409);
    assert.match(String(res.json['message']), /is reserved/);
    assert.deepEqual(h.writes, []);
  });

  it('creates a facilitator and reports the kind in create, list and picker', async () => {
    const created = await h.call('POST', '/agents', { slug: 'nora', name: 'Nora', kind: 'facilitator' });
    assert.equal(created.status, 201);
    assert.equal(created.json['kind'], 'facilitator');
    const plain = await h.call('POST', '/agents', { slug: 'sales', name: 'Sales' });
    assert.equal(plain.json['kind'], 'standard');
    const bogus = await h.call('POST', '/agents', { slug: 'x', name: 'X', kind: 'moderator' });
    assert.equal(bogus.status, 400);

    const list = await h.call('GET', '/agents');
    const kinds = Object.fromEntries(
      (list.json['agents'] as { slug: string; kind: string }[]).map((a) => [a.slug, a.kind]),
    );
    assert.deepEqual(kinds, { mara: 'facilitator', hr: 'standard', nora: 'facilitator', sales: 'standard' });
    const enabled = await h.call('GET', '/agents/enabled');
    assert.equal((enabled.json['agents'] as { slug: string; kind: string }[])[0]!.kind, 'facilitator');
  });

  it('create attaches the engine to a facilitator, and only to a facilitator', async () => {
    await h.call('POST', '/agents', { slug: 'nora', name: 'Nora', kind: 'facilitator' });
    assert.equal(h.writes.length, 1);
    assert.match(h.writes[0]!, /^upsertAgentPlugin\(\["id-nora",\{"pluginId":"@omadia\/agent-facilitator","enabled":true\}/);
    h.writes = [];
    await h.call('POST', '/agents', { slug: 'sales', name: 'Sales' });
    assert.deepEqual(h.writes, []);
    // No engine installed: the facilitator is created, the engine follows on install.
    h.installed = [{ id: ODOO, status: 'active' }];
    assert.equal((await h.call('POST', '/agents', { slug: 'ida', name: 'Ida', kind: 'facilitator' })).status, 201);
    assert.deepEqual(h.writes, []);
  });

  it('the engine cannot be granted to a standard agent', async () => {
    const res = await h.call('PATCH', '/agents/hr/plugins', { id: ENGINE, enabled: true });
    assert.equal(res.status, 409);
    assert.equal(res.json['error'], 'config_validation');
    assert.match(String(res.json['message']), /can only be granted to a facilitator/);
    assert.deepEqual(h.writes, []);
  });

  it('the kind cannot be patched', async () => {
    const res = await h.call('PATCH', '/agents/hr', { kind: 'facilitator', name: 'HR' });
    assert.equal(res.status, 200);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0]!.includes('kind'), false, 'kind is not part of any update');
  });

  it('plugin grant: the engine plugin is granted, found by capability', async () => {
    const res = await h.call('PATCH', '/agents/mara/plugins', { id: ENGINE, enabled: true });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(h.writes.length, 1);
    assert.match(h.writes[0]!, /^upsertAgentPlugin/);
    h.writes = [];
    // A disabled row grants nothing, so switching a stale grant off stays possible.
    const off = await h.call('PUT', '/agents/mara/plugins', { plugins: [{ id: ODOO, enabled: false }] });
    assert.equal(off.status, 200, JSON.stringify(off.json));
  });

  it('plugin grant: refused without an engine, and with two', async () => {
    h.installed = [{ id: ODOO, status: 'active' }];
    h.assertRefused(
      await h.call('PATCH', '/agents/mara/plugins', { id: ENGINE, enabled: true }),
      'plugin_grant',
      /no facilitation engine plugin is installed/,
    );
    h.installed = [
      { id: ENGINE, status: 'active' },
      { id: '@acme/second-engine', status: 'inactive' },
    ];
    h.assertRefused(
      await h.call('PATCH', '/agents/mara/plugins', { id: ENGINE, enabled: true }),
      'plugin_grant',
      /more than one facilitation engine is installed/,
    );
    // An errored provider does not count.
    h.installed = [
      { id: ENGINE, status: 'active' },
      { id: '@acme/second-engine', status: 'errored' },
    ];
    assert.equal((await h.call('PATCH', '/agents/mara/plugins', { id: ENGINE, enabled: true })).status, 200);
  });
});
