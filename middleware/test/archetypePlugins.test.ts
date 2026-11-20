/**
 * #2088 (K2) — archetype plugins.
 *
 * A plugin of manifest kind `archetype` delivers an agent archetype: its
 * manifest carries the descriptor the kernel enforces. This suite covers the
 * path from the manifest to the enforced descriptor: strict reading (an
 * unknown kind or an unknown descriptor entry rejects the manifest),
 * registration of what is installed, the engine found by kind as well as by
 * the archetype it delivers, and the explicit confirmation at install.
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import {
  ARCHETYPE_ADDITIONS,
  ARCHETYPE_OMISSIONS,
  applyArchetypeContract,
  archetypeAdds,
  archetypeOmits,
  archetypeRequires,
  FACILITATOR_NEUTRALITY_BLOCK,
  getArchetype,
  listArchetypes,
  roleContractOf,
} from '@omadia/orchestrator';

import type { Plugin } from '../src/api/admin-v1.js';
import {
  archetypePluginFor,
  createArchetypeRegistrySync,
  installedArchetypePlugins,
} from '../src/platform/archetypeRegistrySync.js';
import {
  assertEngineOnlyForFacilitators,
  declaresFacilitationEngine,
  facilitationEnginePluginIds,
  resolveFacilitationEngine,
} from '../src/platform/facilitatorGuard.js';
import { readArchetypeManifest } from '../src/plugins/archetypeManifest.js';
import { capabilityPluginIds } from '../src/plugins/capabilityPlugins.js';
import { InstallError, InstallService } from '../src/plugins/installService.js';
import { adaptManifestV1 } from '../src/plugins/manifestLoader.js';
import { buildOperatorArchetypes } from '../src/routes/operatorArchetypes.js';

const ENGINE = '@omadia/agent-facilitator';
const CONTRACT = '## Neutrality contract (plugin)\nYou moderate. You hold no opinion on the content.';

const FACILITATOR_BLOCK = {
  id: 'facilitator',
  label: { en: 'Facilitator', de: 'Facilitator' },
  label_plural: { en: 'Facilitators', de: 'Facilitatoren' },
  description: { en: 'Moderates group processes.', de: 'Moderiert Gruppenprozesse.' },
  noun: 'a facilitator',
  omits: [...ARCHETYPE_OMISSIONS],
  omission_reasons: { memory: 'a facilitator keeps no general memory (plugin wording)' },
  adds: [...ARCHETYPE_ADDITIONS],
  requires: ['own_channel_identity'],
  role_contract: CONTRACT,
};

function manifest(over: { kind?: unknown; id?: string; archetype?: unknown; provides?: string[] } = {}): Record<string, unknown> {
  return {
    schema_version: '1',
    identity: {
      id: over.id ?? ENGINE,
      ...('kind' in over ? (over.kind === undefined ? {} : { kind: over.kind }) : { kind: 'archetype' }),
      domain: 'facilitation',
      name: 'Archetype Facilitator',
      version: '1.1.0',
    },
    ...(over.provides ? { provides: over.provides } : {}),
    ...('archetype' in over ? (over.archetype === undefined ? {} : { archetype: over.archetype }) : { archetype: FACILITATOR_BLOCK }),
  };
}

/** `adaptManifestV1` with its rejection reasons captured instead of printed. */
function load(doc: Record<string, unknown>): { plugin: Plugin | null; warnings: string } {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    return { plugin: adaptManifestV1(doc), warnings: lines.join('\n') };
  } finally {
    console.warn = original;
  }
}

function sources(installed: { id: string; status?: string; doc: Record<string, unknown> }[]) {
  const plugins = new Map(installed.map((p) => [p.id, load(p.doc).plugin]));
  return {
    installedRegistry: { list: () => installed.map((p) => ({ id: p.id, status: p.status ?? 'active' })) } as never,
    catalog: { get: (id: string) => (plugins.get(id) ? { plugin: plugins.get(id)! } : undefined) } as never,
  };
}

describe('manifest kind', () => {
  it('rejects a kind the kernel does not know instead of loading it as an agent plugin', () => {
    // `provider` and `ui` were never kernel kinds (spec 2042 §5.10 retires
    // them in the Hub's vocabulary); a typo stays a typo.
    for (const kind of ['archetyp', 'systemmodule', 'provider', 'ui', 'Agent', 42, '']) {
      const { plugin, warnings } = load(manifest({ kind, archetype: undefined }));
      assert.equal(plugin, null, `kind ${JSON.stringify(kind)} must be rejected`);
      assert.match(warnings, /manifest rejected: plugin '@omadia\/agent-facilitator' has identity\.kind .* which this kernel does not know \(it knows: integration, tool, skill, channel, model, archetype, system-module, agent-template, agent, extension\)/);
    }
  });

  it('keeps every known kind, and a manifest without the field stays an agent plugin', () => {
    for (const kind of ['agent', 'integration', 'channel', 'tool', 'extension', 'skill', 'model', 'system-module', 'agent-template']) {
      assert.equal(load(manifest({ kind, archetype: undefined })).plugin?.kind, kind);
    }
    assert.equal(load(manifest({ kind: undefined, archetype: undefined })).plugin?.kind, 'agent');
  });

  it("an `archetype:` block on another kind is ignored and says so", () => {
    const { plugin, warnings } = load(manifest({ kind: 'extension' }));
    assert.equal(plugin?.kind, 'extension');
    assert.equal(plugin?.archetype, undefined);
    assert.match(warnings, /only read for identity\.kind 'archetype'/);
  });
});

describe('the archetype descriptor of a manifest', () => {
  it('is read in full and travels on the plugin', () => {
    const { plugin } = load(manifest());
    assert.equal(plugin?.kind, 'archetype');
    assert.deepEqual(plugin?.archetype, {
      id: 'facilitator',
      omits: [...ARCHETYPE_OMISSIONS],
      adds: [...ARCHETYPE_ADDITIONS],
      requires: ['own_channel_identity'],
      noun: 'a facilitator',
      label: { en: 'Facilitator', de: 'Facilitator' },
      labelPlural: { en: 'Facilitators', de: 'Facilitatoren' },
      description: { en: 'Moderates group processes.', de: 'Moderiert Gruppenprozesse.' },
      omissionReasons: { memory: 'a facilitator keeps no general memory (plugin wording)' },
      roleContract: CONTRACT,
    });
  });

  it('a minimal descriptor: an id and an explicit, possibly empty, list of omissions', () => {
    const read = readArchetypeManifest({ id: 'coach', omits: [] });
    assert.deepEqual(read, {
      descriptor: { id: 'coach', omits: [], adds: [], requires: [], noun: "an agent of the archetype 'coach'" },
    });
  });

  it('rejects what the kernel could not enforce, with the reason', () => {
    const error = (block: unknown): string => {
      const read = readArchetypeManifest(block);
      return 'error' in read ? read.error : 'accepted';
    };
    assert.match(error(undefined), /needs an `archetype:` block/);
    assert.match(error({ id: 'Facilitator', omits: [] }), /archetype\.id must be/);
    assert.match(error({ id: 'standard', omits: [] }), /built-in archetype/);
    assert.match(error({ id: 'coach' }), /archetype\.omits is required/);
    assert.match(error({ id: 'coach', omits: 'memory' }), /archetype\.omits must be a list/);
    // The point of strictness: an omission the kernel does not know cannot be skipped.
    assert.match(error({ id: 'coach', omits: ['memory', 'web_access'] }), /archetype\.omits names "web_access", which this kernel cannot enforce/);
    assert.match(error({ id: 'coach', omits: [], adds: ['root_shell'] }), /archetype\.adds names "root_shell"/);
    assert.match(error({ id: 'coach', omits: [], requires: ['a_pony'] }), /archetype\.requires names "a_pony"/);
    assert.match(error({ id: 'coach', omits: [], omission_reasons: { memory: 'x' } }), /names 'memory', which is not in archetype\.omits/);
    assert.match(error({ id: 'coach', omits: [], label: { fr: 'Coach' } }), /archetype\.label must be/);
    assert.match(error({ id: 'coach', omits: [], role_contract: 'x'.repeat(8_001) }), /archetype\.role_contract/);
    // And the manifest as a whole is rejected for it.
    const { plugin, warnings } = load(manifest({ archetype: { id: 'coach', omits: ['web_access'] } }));
    assert.equal(plugin, null);
    assert.match(warnings, /manifest rejected: plugin '@omadia\/agent-facilitator': archetype\.omits names "web_access"/);
    assert.equal(load(manifest({ archetype: undefined })).plugin, null, 'kind archetype without a descriptor');
  });
});

describe('registration: what is installed is what is enforced', () => {
  const disposers: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const dispose of disposers.splice(0)) await dispose();
    assert.equal(getArchetype('facilitator')?.source, 'kernel', 'the suite leaves the registry as it found it');
    assert.equal(getArchetype('coach'), undefined);
  });

  function syncWith(installed: () => Parameters<typeof sources>[0]) {
    const logs: string[] = [];
    /** `(id, source)` of every upsert of a row. */
    const writes: unknown[][] = [];
    /** The archetype ids of every "the kernel delivers these again" reset. */
    const resets: unknown[] = [];
    const sync = createArchetypeRegistrySync({
      sources: () => sources(installed()),
      rows: () => ({
        query: (text: string, values?: readonly unknown[]) => {
          if (/^\s*INSERT/i.test(text)) writes.push([...(values ?? [])]);
          else resets.push(values?.[0]);
          return Promise.resolve();
        },
      }),
      log: (m) => logs.push(m),
    });
    return { sync, logs, writes, resets };
  }

  it('an installed archetype plugin replaces the kernel seed, and an uninstall brings the seed back', async () => {
    let installed = [{ id: ENGINE, doc: manifest() }];
    const h = syncWith(() => installed);
    disposers.push(async () => {
      installed = [];
      await h.sync.sync();
    });

    assert.deepEqual(await h.sync.sync(), { registered: ['facilitator'], removed: [], conflicts: [] });
    assert.equal(getArchetype('facilitator')?.source, ENGINE);
    assert.deepEqual(h.writes, [['facilitator', ENGINE]], 'agent_archetypes.source names the plugin');
    // The plugin's descriptor is the one enforced.
    assert.equal(roleContractOf('facilitator'), CONTRACT);
    assert.match(getArchetype('facilitator')?.omissionReasons?.memory ?? '', /plugin wording/);
    assert.equal(archetypeOmits({ archetype: 'facilitator' }, 'memory'), true);
    assert.equal(archetypeAdds({ archetype: 'facilitator' }, 'agent_turn'), true);
    assert.equal(archetypeRequires({ archetype: 'facilitator' }, 'own_channel_identity'), true);

    // Unchanged installed set: nothing is done twice.
    assert.deepEqual(await h.sync.sync(), { registered: [], removed: [], conflicts: [] });
    assert.equal(h.writes.length, 1);

    installed = [];
    assert.deepEqual(await h.sync.sync(), { registered: [], removed: ['facilitator'], conflicts: [] });
    assert.equal(getArchetype('facilitator')?.source, 'kernel');
    assert.equal(roleContractOf('facilitator'), FACILITATOR_NEUTRALITY_BLOCK);
    assert.deepEqual(h.writes.at(-1), ['facilitator', 'kernel']);
    assert.match(h.logs.join('\n'), /the kernel's own descriptor applies again/);
    // A plugin uninstalled while the process was down left its id in the row:
    // every sync resets the rows of what the kernel itself delivers.
    assert.deepEqual(h.resets.at(-1), ['standard', 'facilitator']);
    assert.deepEqual(h.resets[0], ['standard'], 'while the plugin delivered facilitator, only standard was the kernel\'s');
  });

  it('a stopped or broken plugin still registers: its omissions hold while it is down', async () => {
    let installed = [{ id: ENGINE, status: 'errored', doc: manifest() }];
    const h = syncWith(() => installed);
    disposers.push(async () => {
      installed = [];
      await h.sync.sync();
    });
    await h.sync.sync();
    assert.equal(getArchetype('facilitator')?.source, ENGINE);
  });

  it('a third archetype exists while its plugin is installed and omits everything once it is gone', async () => {
    const coach = { id: '@acme/archetype-coach', doc: manifest({ id: '@acme/archetype-coach', archetype: { id: 'coach', omits: ['memory'], adds: [] } }) };
    let installed = [coach];
    const h = syncWith(() => installed);
    disposers.push(async () => {
      installed = [];
      await h.sync.sync();
    });
    await h.sync.sync();
    assert.deepEqual(listArchetypes().map((d) => d.id).sort(), ['coach', 'facilitator', 'standard']);
    assert.equal(archetypeOmits({ archetype: 'coach' }, 'memory'), true);
    assert.equal(archetypeOmits({ archetype: 'coach' }, 'plugin_grant'), false);
    assert.equal(archetypeAdds({ archetype: 'coach' }, 'agent_turn'), false, 'not listed, not given');
    assert.equal(applyArchetypeContract('coach', 'You coach.'), 'You coach.', 'no role contract, nothing appended');

    installed = [];
    await h.sync.sync();
    assert.equal(getArchetype('coach'), undefined);
    assert.equal(archetypeOmits({ archetype: 'coach' }, 'plugin_grant'), true, 'deny all without a descriptor');
    assert.match(h.logs.join('\n'), /its agents omit everything until a plugin delivers it again/);
  });

  it('two plugins for one archetype: neither is registered', async () => {
    let installed = [
      { id: ENGINE, doc: manifest() },
      { id: '@acme/other-facilitator', doc: manifest({ id: '@acme/other-facilitator' }) },
    ];
    const h = syncWith(() => installed);
    disposers.push(async () => {
      installed = [];
      await h.sync.sync();
    });
    assert.deepEqual(await h.sync.sync(), { registered: [], removed: [], conflicts: ['facilitator'] });
    assert.equal(getArchetype('facilitator')?.source, 'kernel', 'the previous state stays');
    assert.equal(archetypePluginFor(sources(installed), 'facilitator'), undefined);
    assert.match(h.logs.join('\n'), /more than one installed plugin delivers the archetype 'facilitator'/);
  });

  it('a database that refuses the row does not undo the descriptor', async () => {
    let installed = [{ id: ENGINE, doc: manifest() }];
    const logs: string[] = [];
    const sync = createArchetypeRegistrySync({
      sources: () => sources(installed),
      rows: () => ({ query: () => Promise.reject(new Error('relation "agent_archetypes" does not exist')) }),
      log: (m) => logs.push(m),
    });
    disposers.push(async () => {
      installed = [];
      await sync.sync();
    });
    await sync.sync();
    assert.equal(getArchetype('facilitator')?.source, ENGINE);
    assert.match(logs.join('\n'), /could not record 'facilitator'/);
  });
});

describe('the role contract of an archetype', () => {
  it('closes the identity once, and swaps out the kernel block a stored prompt still carries', async () => {
    assert.equal(applyArchetypeContract('standard', 'You are HR.'), 'You are HR.');
    assert.equal(applyArchetypeContract('facilitator', 'You are Mara.'), `You are Mara.\n\n${FACILITATOR_NEUTRALITY_BLOCK}`);
    assert.equal(applyArchetypeContract('facilitator', null), FACILITATOR_NEUTRALITY_BLOCK);

    const installed = [{ id: ENGINE, doc: manifest() }];
    let current = installed;
    const sync = createArchetypeRegistrySync({ sources: () => sources(current) });
    await sync.sync();
    try {
      const stored = `You are Mara.\n\n${FACILITATOR_NEUTRALITY_BLOCK}`;
      const once = applyArchetypeContract('facilitator', stored);
      assert.equal(once, `You are Mara.\n\n${CONTRACT}`, 'one contract, the plugin\'s, at the end');
      assert.equal(applyArchetypeContract('facilitator', once), once, 'idempotent');
    } finally {
      current = [];
      await sync.sync();
    }
  });
});

describe('the facilitation engine: found by the archetype it delivers', () => {
  const legacy = { id: ENGINE, doc: manifest({ kind: 'extension', archetype: undefined, provides: ['facilitationEngine@1'] }) };
  const byKind = { id: ENGINE, doc: manifest() };

  it('an archetype plugin that delivers `facilitator` is the engine; a `provides: facilitationEngine@1` line alone is not', () => {
    assert.equal(declaresFacilitationEngine(load(byKind.doc).plugin ?? undefined), true);
    assert.deepEqual(resolveFacilitationEngine(sources([byKind])), { state: 'bound', pluginId: ENGINE });
    // #2088 (K6): the form of engine plugins 1.0.x.
    assert.equal(declaresFacilitationEngine(load(legacy.doc).plugin ?? undefined), false);
    assert.deepEqual(facilitationEnginePluginIds(sources([legacy])), []);
    assert.deepEqual(resolveFacilitationEngine(sources([legacy])), { state: 'none' });
  });

  it('an archetype plugin for another archetype, or any other plugin, is not the engine', () => {
    const coach = { id: '@acme/archetype-coach', doc: manifest({ id: '@acme/archetype-coach', archetype: { id: 'coach', omits: [] } }) };
    const odoo = { id: '@omadia/integration-odoo', doc: manifest({ id: '@omadia/integration-odoo', kind: 'integration', archetype: undefined }) };
    assert.deepEqual(facilitationEnginePluginIds(sources([coach, odoo])), []);
    assert.deepEqual(resolveFacilitationEngine(sources([coach, odoo])), { state: 'none' });
    assert.deepEqual(installedArchetypePlugins(sources([coach, odoo])).map((p) => p.pluginId), ['@acme/archetype-coach']);
  });

  it('two archetype plugins that deliver `facilitator` are ambiguous; the old form next to one changes nothing', () => {
    const second = { id: '@acme/second-engine', doc: manifest({ id: '@acme/second-engine' }) };
    assert.deepEqual(resolveFacilitationEngine(sources([byKind, second])), {
      state: 'ambiguous',
      pluginIds: ['@acme/second-engine', ENGINE],
    });
    const old = { id: '@acme/legacy-engine', doc: manifest({ id: '@acme/legacy-engine', kind: 'extension', archetype: undefined, provides: ['facilitationEngine@1'] }) };
    assert.deepEqual(resolveFacilitationEngine(sources([byKind, old])), { state: 'bound', pluginId: ENGINE });
  });
});

describe('an archetype plugin is attached only to agents of its archetype', () => {
  const coach = { id: '@acme/archetype-coach', doc: manifest({ id: '@acme/archetype-coach', archetype: { id: 'coach', omits: [] } }) };
  const facilitation = { id: ENGINE, doc: manifest() };
  const s = sources([coach, facilitation]);
  const grant = (pluginId: string, enabled = true) => [{ pluginId, enabled }];

  it('refuses it for an agent of another archetype, standard included', () => {
    assert.throws(
      () => assertEngineOnlyForFacilitators({ slug: 'hr', archetype: 'standard' }, grant('@acme/archetype-coach'), s),
      /agent "hr" has the archetype 'standard': an archetype plugin can only be granted to agents of its own archetype — refused: @acme\/archetype-coach \(archetype 'coach'\)/,
    );
    assert.throws(
      () => assertEngineOnlyForFacilitators({ slug: 'mara', archetype: 'facilitator' }, grant('@acme/archetype-coach'), s),
      /archetype 'facilitator'.*refused: @acme\/archetype-coach/,
    );
    assert.throws(() => assertEngineOnlyForFacilitators({ slug: 'cora', archetype: 'coach' }, grant(ENGINE), s), /refused: @omadia\/agent-facilitator/);
  });

  it('is no capability plugin: never offered for a grant to agents (#2054)', () => {
    const odoo = { id: '@omadia/integration-odoo', doc: manifest({ id: '@omadia/integration-odoo', kind: 'integration', archetype: undefined }) };
    const all = sources([coach, facilitation, odoo]);
    assert.deepEqual(
      capabilityPluginIds(['@acme/archetype-coach', ENGINE, '@omadia/integration-odoo'], all.catalog),
      ['@omadia/integration-odoo'],
    );
  });

  it('allows it for its own agents, and a switched-off row is no grant', () => {
    assert.doesNotThrow(() => assertEngineOnlyForFacilitators({ slug: 'cora', archetype: 'coach' }, grant('@acme/archetype-coach'), s));
    assert.doesNotThrow(() => assertEngineOnlyForFacilitators({ slug: 'mara', archetype: 'facilitator' }, grant(ENGINE), s));
    assert.doesNotThrow(() => assertEngineOnlyForFacilitators({ slug: 'hr', archetype: 'standard' }, grant('@acme/archetype-coach', false), s));
  });
});

describe('installing an archetype plugin needs an explicit confirmation', () => {
  function service(doc: Record<string, unknown>): InstallService {
    const plugin = load(doc).plugin!;
    return new InstallService({
      catalog: { get: (id: string) => (id === plugin.id ? { plugin, manifest: doc } : undefined) } as never,
      registry: { has: () => false, list: () => [], get: () => undefined } as never,
      vault: { get: () => Promise.resolve(undefined), setMany: () => Promise.resolve(), purge: () => Promise.resolve() } as never,
      onUninstall: () => Promise.resolve(),
      onInstalled: () => Promise.resolve(),
    } as never);
  }

  it('without it the install is refused, and the refusal carries what is being confirmed', () => {
    let caught: unknown;
    try {
      service(manifest()).create(ENGINE);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof InstallError);
    assert.deepEqual([caught.code, caught.status], ['install.archetype_confirmation_required', 409]);
    assert.match(caught.message, /adds the agent archetype 'facilitator' to this instance/);
    const details = caught.details as { archetype: { id: string; omits: string[]; adds: string[] } };
    assert.equal(details.archetype.id, 'facilitator');
    assert.deepEqual(details.archetype.adds, [...ARCHETYPE_ADDITIONS]);
    assert.deepEqual(details.archetype.omits, [...ARCHETYPE_OMISSIONS]);
    assert.throws(() => service(manifest()).create(ENGINE, { confirmedArchetype: false }), InstallError);
  });

  it('with it the install job is created; other kinds never ask', () => {
    assert.equal(service(manifest()).create(ENGINE, { confirmedArchetype: true }).plugin_id, ENGINE);
    const legacy = manifest({ kind: 'extension', archetype: undefined });
    assert.equal(service(legacy).create(ENGINE).plugin_id, ENGINE);
  });
});

describe('GET /operator/archetypes', () => {
  it('lists standard first, the descriptor in force and who delivers it, with agent counts', async () => {
    const before = buildOperatorArchetypes(listArchetypes(), [], ['standard', 'standard', 'facilitator']);
    assert.deepEqual(before.map((a) => [a.id, a.source, a.built_in, a.plugin, a.agent_count]), [
      ['standard', 'kernel', true, null, 2],
      ['facilitator', 'kernel', false, null, 1],
    ]);
    assert.deepEqual(before[1]?.adds, [...ARCHETYPE_ADDITIONS]);

    let current = [{ id: ENGINE, status: 'active', doc: manifest() }];
    const sync = createArchetypeRegistrySync({ sources: () => sources(current) });
    await sync.sync();
    try {
      const list = buildOperatorArchetypes(listArchetypes(), installedArchetypePlugins(sources(current)), undefined);
      const facilitator = list.find((a) => a.id === 'facilitator');
      assert.deepEqual(facilitator?.plugin, { id: ENGINE, status: 'active' });
      assert.deepEqual(facilitator?.label_plural, { en: 'Facilitators', de: 'Facilitatoren' });
      assert.equal(facilitator?.agent_count, null, 'no config store, no count');
    } finally {
      current = [];
      await sync.sync();
    }
  });
});
