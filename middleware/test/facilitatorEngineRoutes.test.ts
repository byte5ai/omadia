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

  it('an engine installed without its grant is errored, and is still reported as waiting for the grant', async () => {
    const status = async (): Promise<Record<string, unknown>> => (await h.call('GET', '/agents/facilitation-engine')).json;
    // What a real install without the SQL grant leaves behind: the install job
    // ends `installed_missing_permissions` and the registry entry is errored.
    h.installed = [{ id: ENGINE, status: 'errored' }];
    h.sqlGranted = false;
    assert.deepEqual(
      [(await status())['state'], (await status())['plugin_id'], (await status())['reason_code']],
      ['ungranted', ENGINE, 'ungranted'],
      'not "none": the operator has to be told to grant it',
    );
    // Granted, but still errored for another reason: bound, and not usable.
    h.sqlGranted = true;
    assert.deepEqual(
      [(await status())['state'], (await status())['available'], (await status())['reason_code']],
      ['bound', false, 'inactive'],
    );
    // A healthy engine beside an errored leftover is not ambiguous.
    h.installed = [
      { id: ENGINE, status: 'active' },
      { id: '@acme/second-engine', status: 'errored' },
    ];
    h.engineState = { pluginId: ENGINE, version: '1.0.0', available: true };
    assert.deepEqual([(await status())['state'], (await status())['plugin_id']], ['bound', ENGINE]);
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

    // #2088 — `archetype` is the name; both are returned while `kind` exists.
    assert.equal(created.json['archetype'], 'facilitator');
    assert.equal(plain.json['archetype'], 'standard');
    const byArchetype = await h.call('POST', '/agents', { slug: 'ida', name: 'Ida', archetype: 'facilitator' });
    assert.deepEqual([byArchetype.status, byArchetype.json['archetype'], byArchetype.json['kind']], [201, 'facilitator', 'facilitator']);
    const unregistered = await h.call('POST', '/agents', { slug: 'y', name: 'Y', archetype: 'coach' });
    assert.equal(unregistered.status >= 400 && unregistered.status < 500, true);
    assert.match(String(unregistered.json['message']), /archetype "coach" is not registered/);
    const disagree = await h.call('POST', '/agents', { slug: 'z', name: 'Z', archetype: 'standard', kind: 'facilitator' });
    assert.equal(disagree.status >= 400 && disagree.status < 500, true);
    assert.match(String(disagree.json['message']), /disagree/);

    const list = await h.call('GET', '/agents');
    const kinds = Object.fromEntries(
      (list.json['agents'] as { slug: string; kind: string }[]).map((a) => [a.slug, a.kind]),
    );
    assert.deepEqual(kinds, { mara: 'facilitator', hr: 'standard', nora: 'facilitator', sales: 'standard', ida: 'facilitator' });
    assert.equal(
      (list.json['agents'] as { kind: string; archetype: string }[]).every((a) => a.archetype === a.kind),
      true,
    );
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

describe('#2088 an agent is not created or enabled while its archetype plugin did not start', () => {
  const h = routesHarness();
  const erroredEngine = (): void => {
    h.archetypePlugins = { [ENGINE]: 'facilitator' };
    h.installed = h.installed.map((entry) =>
      entry.id === ENGINE ? ({ ...entry, status: 'errored', last_activation_error: 'database not available (not_isolated)' } as never) : entry,
    );
  };

  it('refuses the creation with the plugin and its reason, and writes nothing', async () => {
    erroredEngine();
    const res = await h.call('POST', '/agents', { slug: 'nora', name: 'Nora', archetype: 'facilitator' });
    assert.equal(res.status, 409);
    assert.equal(res.json['error'], 'archetype_plugin_not_running');
    assert.equal(res.json['plugin_id'], ENGINE);
    assert.equal(res.json['archetype'], 'facilitator');
    assert.equal(res.json['detail'], 'database not available (not_isolated)');
    assert.ok(!h.agents.some((a) => a.slug === 'nora'));
    assert.deepEqual(h.writes, []);
  });

  it('refuses to enable a disabled agent of that archetype, and still lets it be disabled', async () => {
    erroredEngine();
    const mara = h.agents.find((a) => a.slug === 'mara')!;
    (mara as { status: string }).status = 'disabled';
    const enable = await h.call('PATCH', '/agents/mara', { status: 'enabled' });
    assert.equal(enable.status, 409);
    assert.equal(enable.json['error'], 'archetype_plugin_not_running');
    assert.deepEqual(h.writes, []);

    (mara as { status: string }).status = 'enabled';
    const disable = await h.call('PATCH', '/agents/mara', { status: 'disabled' });
    assert.notEqual(disable.json['error'], 'archetype_plugin_not_running');
  });

  it('does not touch agents of other archetypes, nor a plugin that runs', async () => {
    erroredEngine();
    const standard = await h.call('POST', '/agents', { slug: 'ops', name: 'Ops' });
    assert.equal(standard.status, 201);

    h.installed = h.installed.map((entry) => (entry.id === ENGINE ? ({ ...entry, status: 'active' } as never) : entry));
    const running = await h.call('POST', '/agents', { slug: 'nora', name: 'Nora', archetype: 'facilitator' });
    assert.equal(running.status, 201);
  });
});
