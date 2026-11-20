/**
 * #2066 — per-agent settings of an archetype (spec 2043 §7): a facilitator's
 * default methods and reminder policy.
 *
 *   1. THE MANIFEST DECLARES THE FIELDS (`archetype.agent_settings`), read
 *      strictly: the facilitator plugin's block (fixture copy) parses, an
 *      unknown type or a duplicate key rejects the manifest.
 *   2. VALUES ARE VALIDATED against the fields; `null` clears a field so the
 *      plugin's instance setting applies again; stale values are not passed on.
 *   3. THE ROUTE reads and writes them, refuses invalid values with 422 and
 *      without a write, audits a change.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import express from 'express';
import { parse as parseYaml } from 'yaml';

import {
  effectiveArchetypeAgentSettings,
  getArchetype,
  registerArchetype,
  validateArchetypeAgentSettings,
  type ArchetypeAgentSetting,
  type ArchetypeAgentSettingValue,
} from '../packages/harness-orchestrator/src/registry/archetype.js';
import type { AuditEntryInput } from '../src/auth/adminAuditLog.js';
import type { AgentArchetypeSettingsStore } from '../src/platform/agentArchetypeSettingsStore.js';
import { readArchetypeManifest } from '../src/plugins/archetypeManifest.js';
import { createOperatorAgentArchetypeSettingsRouter } from '../src/routes/operatorAgentArchetypeSettings.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

async function fixtureBlock(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(new URL('./fixtures/archetype-plugin.manifest.yaml', import.meta.url), 'utf-8');
  return (parseYaml(raw) as { archetype: Record<string, unknown> }).archetype;
}

const FIELDS: readonly ArchetypeAgentSetting[] = [
  {
    key: 'default_decision_method',
    type: 'enum',
    label: { en: 'Default decision method', de: 'Standard-Entscheidungsmethode' },
    options: [
      { value: 'ranked', label: 'Ranked' },
      { value: 'consent', label: 'Consent' },
    ],
  },
  { key: 'reminder_offsets_hours', type: 'number_list', label: 'Reminders', maxItems: 3 },
];

describe('archetype agent settings: manifest (#2066)', () => {
  it("reads the facilitator plugin's agent_settings", async () => {
    const read = readArchetypeManifest(await fixtureBlock());
    assert.ok('descriptor' in read, JSON.stringify(read));
    const settings = read.descriptor.agentSettings ?? [];
    assert.deepEqual(
      settings.map((s) => `${s.key}:${s.type}`),
      [
        'default_decision_method:enum',
        'default_prioritisation_method:enum',
        'ranked_points:number_list',
        'reminder_offsets_hours:number_list',
      ],
    );
    const method = settings[0]!;
    assert.equal(method.type, 'enum');
    assert.deepEqual(
      method.type === 'enum' ? method.options.map((o) => o.value) : [],
      ['ranked', 'single', 'approval', 'consent'],
    );
    assert.equal(read.descriptor.omits.includes('persona_skill'), false, 'working modes are allowed');
  });

  it('a block without agent_settings has none', () => {
    const read = readArchetypeManifest({ id: 'coach', omits: [] });
    assert.ok('descriptor' in read);
    assert.equal(read.descriptor.agentSettings, undefined);
  });

  it('rejects a type the kernel cannot validate, a duplicate key and an enum without options', () => {
    const base = { id: 'coach', omits: [] };
    const field = { key: 'tone', label: 'Tone' };
    const cases: [unknown, RegExp][] = [
      [[{ ...field, type: 'free_text' }], /not a setting type this kernel can validate/],
      [[{ ...field, type: 'enum', options: [{ value: 'a', label: 'A' }] }, { ...field, type: 'enum', options: [{ value: 'a', label: 'A' }] }], /declared twice/],
      [[{ ...field, type: 'enum', options: [] }], /options must be a list/],
      [[{ ...field, key: 'Bad Key', type: 'number_list' }], /key must be lowercase/],
      [[{ ...field, type: 'number_list', max_items: 0 }], /max_items/],
      ['not a list', /must be a list/],
    ];
    for (const [agentSettings, error] of cases) {
      const read = readArchetypeManifest({ ...base, agent_settings: agentSettings });
      assert.ok('error' in read, JSON.stringify(agentSettings));
      assert.match(read.error, error);
    }
  });
});

describe('archetype agent settings: validation (#2066)', () => {
  const descriptor = { agentSettings: FIELDS };

  it('accepts declared values and null as "use the instance setting"', () => {
    assert.deepEqual(
      validateArchetypeAgentSettings(descriptor, {
        default_decision_method: 'consent',
        reminder_offsets_hours: [48, 4],
      }),
      { settings: { default_decision_method: 'consent', reminder_offsets_hours: [48, 4] } },
    );
    assert.deepEqual(
      validateArchetypeAgentSettings(descriptor, { default_decision_method: null, reminder_offsets_hours: [] }),
      { settings: { default_decision_method: null, reminder_offsets_hours: null } },
    );
  });

  it('refuses an undeclared key, an unknown option and a bad list', () => {
    const checked = validateArchetypeAgentSettings(descriptor, {
      tone: 'loud',
      default_decision_method: 'dictator',
      reminder_offsets_hours: [24, -1],
    });
    assert.ok('issues' in checked);
    assert.deepEqual(
      checked.issues.map((i) => i.key),
      ['tone', 'default_decision_method', 'reminder_offsets_hours'],
    );
    const tooMany = validateArchetypeAgentSettings(descriptor, { reminder_offsets_hours: [1, 2, 3, 4] });
    assert.ok('issues' in tooMany);
    assert.ok('issues' in validateArchetypeAgentSettings(descriptor, ['x']));
    assert.ok('issues' in validateArchetypeAgentSettings(undefined, { default_decision_method: 'consent' }));
  });

  it('passes on only stored values that still fit the fields', () => {
    assert.deepEqual(
      effectiveArchetypeAgentSettings(descriptor, {
        default_decision_method: 'single',
        reminder_offsets_hours: [12],
        dropped: true,
      }),
      { reminder_offsets_hours: [12] },
    );
    assert.deepEqual(effectiveArchetypeAgentSettings(descriptor, null), {});
  });
});

describe('archetype agent settings: route (#2066)', () => {
  const stored = new Map<string, Record<string, unknown>>();
  const audits: AuditEntryInput[] = [];
  let writes = 0;
  let server: Server;
  let base = '';
  let dispose: () => void = () => {};

  const store: AgentArchetypeSettingsStore = {
    get: (agentId) => Promise.resolve(stored.get(agentId) ?? {}),
    merge: (agentId, changes: Readonly<Record<string, ArchetypeAgentSettingValue | null>>) => {
      writes += 1;
      const next: Record<string, unknown> = { ...(stored.get(agentId) ?? {}) };
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      stored.set(agentId, next);
      return Promise.resolve(next);
    },
  };

  const agents: Record<string, { id: string; archetype: string }> = {
    mara: { id: 'id-mara', archetype: 'facilitator' },
    hr: { id: 'id-hr', archetype: 'standard' },
  };

  before(async () => {
    dispose = registerArchetype({ ...getArchetype('facilitator')!, source: '@omadia/agent-facilitator', agentSettings: FIELDS });
    const app = express();
    app.use(express.json());
    app.use(
      '/agents',
      createOperatorAgentArchetypeSettingsRouter({
        getAgent: (slug) => Promise.resolve(agents[slug]),
        getStore: () => store,
        recordAudit: (entry) => {
          audits.push(entry);
          return Promise.resolve();
        },
      }),
    );
    server = await listenLoopback(app);
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(async () => {
    dispose();
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    stored.clear();
    audits.length = 0;
    writes = 0;
  });

  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it('answers the fields of the archetype and only the set values', async () => {
    stored.set('id-mara', { reminder_offsets_hours: [24] });
    const res = await call('GET', '/agents/mara/archetype-settings');
    assert.equal(res.status, 200);
    assert.equal(res.json['archetype'], 'facilitator');
    assert.deepEqual(
      (res.json['fields'] as { key: string; max_items: number | null }[]).map((f) => [f.key, f.max_items]),
      [
        ['default_decision_method', null],
        ['reminder_offsets_hours', 3],
      ],
    );
    assert.deepEqual(res.json['values'], { reminder_offsets_hours: [24] });
  });

  it('stores a facilitator default, clears another and audits the change', async () => {
    stored.set('id-mara', { reminder_offsets_hours: [24] });
    const res = await call('PUT', '/agents/mara/archetype-settings', {
      settings: { default_decision_method: 'consent', reminder_offsets_hours: null },
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.deepEqual(res.json['values'], { default_decision_method: 'consent' });
    assert.deepEqual(stored.get('id-mara'), { default_decision_method: 'consent' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.action, 'agent.archetype_settings_change');
    assert.equal(audits[0]!.target, 'agent:id-mara');
    assert.deepEqual(audits[0]!.before, { reminder_offsets_hours: [24] });
  });

  it('refuses invalid values with 422 and writes nothing', async () => {
    const res = await call('PUT', '/agents/mara/archetype-settings', {
      settings: { default_decision_method: 'dictator' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.json['error'], 'invalid_archetype_settings');
    assert.equal(writes, 0);
    assert.equal(audits.length, 0);
  });

  it('a standard agent has no fields, and every value is refused', async () => {
    const read = await call('GET', '/agents/hr/archetype-settings');
    assert.deepEqual(read.json['fields'], []);
    const write = await call('PUT', '/agents/hr/archetype-settings', { settings: { default_decision_method: 'consent' } });
    assert.equal(write.status, 422);
    assert.equal(writes, 0);
  });

  it('answers 404 for an unknown agent', async () => {
    assert.equal((await call('GET', '/agents/ghost/archetype-settings')).status, 404);
  });
});
