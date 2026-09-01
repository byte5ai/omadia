import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  InMemoryInstalledRegistry,
  type InstalledRegistry,
} from '../src/plugins/installedRegistry.js';
import {
  CHANNEL_TEAMS_PLUGIN_ID,
  TEAMS_BOTS_CONFIG_KEY,
  TeamsBotsConfigSyncError,
  defaultTeamsBotSecretRef,
  dropTeamsBotConfig,
  projectTeamsBotConfig,
  projectTeamsBotsConfigSyncStatus,
  readTeamsBotsConfig,
  removeTeamsBotEntry,
  serializeTeamsBotsConfig,
  syncTeamsBotConfig,
  teamsBotConfigEntry,
  upsertTeamsBotEntry,
  type TeamsBotIdentitySource,
} from '../src/services/teamsBotsConfigSync.js';

/**
 * #910 — the automatic `teams_bots` write.
 *
 * The happy path is the least interesting property here. What these tests
 * exist for is the two guarantees an operator's production deployment depends
 * on: a re-run must not duplicate its own entry, and NOTHING this sync writes
 * may disturb an entry it does not own — above all `teams_bots[0]`, the legacy
 * scalar-shimmed bot that owns the `/api/messages` aliases and is answering
 * live traffic while this code runs.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IDENTITY: TeamsBotIdentitySource = {
  botSlug: 'hr-bot',
  displayName: 'HR Bot',
  appId: 'app-hr-0001',
  tenantId: 'tenant-0001',
};

/** The production bot of a legacy single-bot deployment, shimmed onto entry 0
 *  by channel-teams. Hand-written on purpose: the operator typed this. */
const LEGACY_ENTRY = {
  botSlug: 'default',
  appId: 'app-legacy-9999',
  tenantId: 'tenant-0001',
  appPasswordSecretRef: 'microsoft_app_password',
  appType: 'MultiTenant',
  displayName: 'Microsoft Teams Bot',
};

/** Another agent's entry, hand-tuned by an operator (note the non-default
 *  secret ref and the extra key the parser ignores). */
const FOREIGN_ENTRY = {
  botSlug: 'sales-bot',
  displayName: 'Sales Bot — do not touch',
  appId: 'app-sales-4242',
  appType: 'SingleTenant',
  tenantId: 'tenant-0001',
  appPasswordSecretRef: 'custom_vault:sales',
  note: 'managed by hand, see runbook',
};

function registryWith(config: Record<string, unknown>): InstalledRegistry {
  const registry = new InMemoryInstalledRegistry();
  void registry.register({
    id: CHANNEL_TEAMS_PLUGIN_ID,
    installed_version: '0.21.0',
    installed_at: new Date(0).toISOString(),
    status: 'active',
    config,
  });
  return registry;
}

function storedEntries(registry: InstalledRegistry): Record<string, unknown>[] {
  const value = registry.get(CHANNEL_TEAMS_PLUGIN_ID)?.config[TEAMS_BOTS_CONFIG_KEY];
  return [...readTeamsBotsConfig(value).entries];
}

// ---------------------------------------------------------------------------
// The projection (moved here from routes/operatorAgents.ts)
// ---------------------------------------------------------------------------

describe('teams_bots projection', () => {
  it('emits a parseTeamsBotsConfig-shaped entry with the derived secret REF', () => {
    const projection = projectTeamsBotConfig(IDENTITY);
    assert.deepEqual(projection, {
      botSlug: 'hr-bot',
      displayName: 'HR Bot',
      appId: 'app-hr-0001',
      appType: 'SingleTenant',
      tenantId: 'tenant-0001',
      appPasswordSecretRef: 'teams_bot_password:app-hr-0001',
    });
  });

  it('is null until BOTH app and tenant are known', () => {
    assert.equal(projectTeamsBotConfig({ ...IDENTITY, appId: null }), null);
    assert.equal(projectTeamsBotConfig({ ...IDENTITY, tenantId: null }), null);
  });

  it('derives the secret ref from appId, never from the slug', () => {
    assert.equal(
      defaultTeamsBotSecretRef({ appId: 'app-hr-0001' }),
      'teams_bot_password:app-hr-0001',
    );
    assert.throws(() => defaultTeamsBotSecretRef({ appId: null }), /requires a provisioned appId/);
  });

  it('honours an injected clientSecretRef', () => {
    const projection = projectTeamsBotConfig(IDENTITY, () => 'vault:custom');
    assert.equal(projection?.appPasswordSecretRef, 'vault:custom');
  });
});

// ---------------------------------------------------------------------------
// Reading + rewriting the stored value
// ---------------------------------------------------------------------------

describe('readTeamsBotsConfig', () => {
  it('treats every "nothing configured" spelling as an empty string field', () => {
    for (const raw of [undefined, null, '', '   ']) {
      assert.deepEqual(readTeamsBotsConfig(raw), { entries: [], form: 'string' });
    }
  });

  it('reads the setup wizard string form and the install-registry array form', () => {
    assert.deepEqual(readTeamsBotsConfig(JSON.stringify([LEGACY_ENTRY])), {
      entries: [LEGACY_ENTRY],
      form: 'string',
    });
    assert.deepEqual(readTeamsBotsConfig([LEGACY_ENTRY]), {
      entries: [LEGACY_ENTRY],
      form: 'array',
    });
  });

  it('refuses a value it cannot read rather than resetting it', () => {
    assert.throws(() => readTeamsBotsConfig('{ not json'), TeamsBotsConfigSyncError);
    assert.throws(() => readTeamsBotsConfig('{"a":1}'), TeamsBotsConfigSyncError);
    assert.throws(() => readTeamsBotsConfig(42), TeamsBotsConfigSyncError);
    assert.throws(() => readTeamsBotsConfig(['nope']), TeamsBotsConfigSyncError);
  });

  it('does NOT validate foreign entries — a neighbour is none of its business', () => {
    // No botSlug, no appId: `parseTeamsBotsConfig` would reject this at
    // activate() time. This sync must still be able to read past it, or one
    // operator's mistake would break an unrelated agent's provisioning.
    const doc = readTeamsBotsConfig([{ displayName: 'half-typed' }]);
    assert.equal(doc.entries.length, 1);
  });

  it('round-trips the container form it was given', () => {
    const asString = readTeamsBotsConfig(JSON.stringify([LEGACY_ENTRY]));
    assert.equal(typeof serializeTeamsBotsConfig(asString), 'string');
    assert.deepEqual(
      JSON.parse(serializeTeamsBotsConfig(asString) as string),
      [LEGACY_ENTRY],
    );
    const asArray = readTeamsBotsConfig([LEGACY_ENTRY]);
    assert.deepEqual(serializeTeamsBotsConfig(asArray), [LEGACY_ENTRY]);
  });
});

describe('upsertTeamsBotEntry', () => {
  const projection = projectTeamsBotConfig(IDENTITY);
  assert.ok(projection);

  it('appends when the list holds no entry for this slug', () => {
    const doc = readTeamsBotsConfig([LEGACY_ENTRY, FOREIGN_ENTRY]);
    const { document, changed } = upsertTeamsBotEntry(doc, projection);
    assert.equal(changed, true);
    assert.deepEqual(document.entries, [
      LEGACY_ENTRY,
      FOREIGN_ENTRY,
      teamsBotConfigEntry(projection),
    ]);
  });

  it('replaces its own entry IN PLACE — position 0 never changes owner', () => {
    const mine = { ...teamsBotConfigEntry(projection), displayName: 'stale name' };
    const doc = readTeamsBotsConfig([mine, LEGACY_ENTRY]);
    const { document, changed } = upsertTeamsBotEntry(doc, projection);
    assert.equal(changed, true);
    assert.equal(document.entries.length, 2);
    assert.deepEqual(document.entries[0], teamsBotConfigEntry(projection));
    assert.equal(document.entries[1], LEGACY_ENTRY);
  });

  it('reports no change when the stored entry already equals the projection', () => {
    const doc = readTeamsBotsConfig([LEGACY_ENTRY, teamsBotConfigEntry(projection)]);
    const { document, changed } = upsertTeamsBotEntry(doc, projection);
    assert.equal(changed, false);
    assert.equal(document, doc);
  });

  it('never matches an entry whose botSlug is absent or not a string', () => {
    const doc = readTeamsBotsConfig([{ appId: 'x' }, { botSlug: 42 }, { botSlug: '  ' }]);
    const { document } = upsertTeamsBotEntry(doc, projection);
    assert.equal(document.entries.length, 4);
    assert.deepEqual(document.entries[3], teamsBotConfigEntry(projection));
  });
});

// ---------------------------------------------------------------------------
// The sync
// ---------------------------------------------------------------------------

describe('syncTeamsBotConfig', () => {
  it('writes the entry into an empty config and reloads the plugin', async () => {
    const registry = registryWith({ teams_directory_label: 'byte5' });
    const reloaded: string[] = [];
    const outcome = await syncTeamsBotConfig(
      {
        getInstalledRegistry: () => registry,
        reactivate: async (id) => {
          reloaded.push(id);
        },
      },
      IDENTITY,
    );
    assert.deepEqual(outcome, { status: 'synced', botSlug: 'hr-bot' });
    assert.deepEqual(reloaded, [CHANNEL_TEAMS_PLUGIN_ID]);
    assert.deepEqual(storedEntries(registry), [
      {
        botSlug: 'hr-bot',
        displayName: 'HR Bot',
        appId: 'app-hr-0001',
        appType: 'SingleTenant',
        tenantId: 'tenant-0001',
        appPasswordSecretRef: 'teams_bot_password:app-hr-0001',
      },
    ]);
    // Every other setup value survives the write.
    assert.equal(
      registry.get(CHANNEL_TEAMS_PLUGIN_ID)?.config['teams_directory_label'],
      'byte5',
    );
  });

  it('writes a JSON STRING, the form the setup field holds', async () => {
    const registry = registryWith({});
    await syncTeamsBotConfig({ getInstalledRegistry: () => registry }, IDENTITY);
    const value = registry.get(CHANNEL_TEAMS_PLUGIN_ID)?.config[TEAMS_BOTS_CONFIG_KEY];
    assert.equal(typeof value, 'string');
    // And it round-trips through the plugin's own accepted container shapes.
    assert.equal(readTeamsBotsConfig(value).entries.length, 1);
  });

  it('is idempotent by botSlug: two runs leave exactly one entry', async () => {
    const registry = registryWith({});
    const deps = { getInstalledRegistry: () => registry };
    const first = await syncTeamsBotConfig(deps, IDENTITY);
    const second = await syncTeamsBotConfig(deps, IDENTITY);
    assert.equal(first.status, 'synced');
    assert.equal(second.status, 'unchanged');
    const entries = storedEntries(registry);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.['botSlug'], 'hr-bot');
  });

  it('does not reload the plugin on a no-op re-run', async () => {
    const registry = registryWith({});
    const reloaded: string[] = [];
    const deps = {
      getInstalledRegistry: () => registry,
      reactivate: async (id: string) => {
        reloaded.push(id);
      },
    };
    await syncTeamsBotConfig(deps, IDENTITY);
    await syncTeamsBotConfig(deps, IDENTITY);
    // A live channel plugin is serving traffic; bouncing it for a write that
    // changed nothing would be a self-inflicted outage.
    assert.deepEqual(reloaded, [CHANNEL_TEAMS_PLUGIN_ID]);
  });

  it('leaves the legacy entry 0 and a hand-tuned foreign entry byte-identical', async () => {
    const before = JSON.stringify([LEGACY_ENTRY, FOREIGN_ENTRY], null, 2);
    const registry = registryWith({ [TEAMS_BOTS_CONFIG_KEY]: before });
    await syncTeamsBotConfig({ getInstalledRegistry: () => registry }, IDENTITY);
    await syncTeamsBotConfig({ getInstalledRegistry: () => registry }, IDENTITY);
    const entries = storedEntries(registry);
    assert.equal(entries.length, 3);
    // Byte-identical, not merely equivalent: no re-ordering, no re-defaulting,
    // and the extra `note` key an operator added survives.
    assert.equal(JSON.stringify(entries[0]), JSON.stringify(LEGACY_ENTRY));
    assert.equal(JSON.stringify(entries[1]), JSON.stringify(FOREIGN_ENTRY));
    assert.equal(entries[2]?.['botSlug'], 'hr-bot');
  });

  it('updates its own entry when an identity field changed (new display name)', async () => {
    const registry = registryWith({
      [TEAMS_BOTS_CONFIG_KEY]: JSON.stringify([LEGACY_ENTRY]),
    });
    const deps = { getInstalledRegistry: () => registry };
    await syncTeamsBotConfig(deps, IDENTITY);
    const outcome = await syncTeamsBotConfig(deps, {
      ...IDENTITY,
      displayName: 'HR Bot (Renamed)',
    });
    assert.equal(outcome.status, 'synced');
    const entries = storedEntries(registry);
    assert.equal(entries.length, 2);
    assert.equal(entries[1]?.['displayName'], 'HR Bot (Renamed)');
  });

  it('skips cleanly when channel-teams is not installed', async () => {
    const registry = new InMemoryInstalledRegistry();
    const outcome = await syncTeamsBotConfig(
      { getInstalledRegistry: () => registry },
      IDENTITY,
    );
    assert.deepEqual(outcome, { status: 'skipped', reason: 'plugin_not_installed' });
  });

  it('skips cleanly when no installed registry is bound', async () => {
    const outcome = await syncTeamsBotConfig(
      { getInstalledRegistry: () => undefined },
      IDENTITY,
    );
    assert.deepEqual(outcome, { status: 'skipped', reason: 'registry_unavailable' });
  });

  it('skips an identity that has no app registration yet', async () => {
    const registry = registryWith({});
    const outcome = await syncTeamsBotConfig(
      { getInstalledRegistry: () => registry },
      { ...IDENTITY, appId: null },
    );
    assert.deepEqual(outcome, { status: 'skipped', reason: 'identity_incomplete' });
  });

  it('throws instead of overwriting a config value it cannot read', async () => {
    const registry = registryWith({ [TEAMS_BOTS_CONFIG_KEY]: '{ not json' });
    await assert.rejects(
      syncTeamsBotConfig({ getInstalledRegistry: () => registry }, IDENTITY),
      TeamsBotsConfigSyncError,
    );
    // The operator's (broken, but theirs) value is still there.
    assert.equal(
      registry.get(CHANNEL_TEAMS_PLUGIN_ID)?.config[TEAMS_BOTS_CONFIG_KEY],
      '{ not json',
    );
  });

  it('propagates a reactivation failure AFTER the config was written', async () => {
    const registry = registryWith({});
    await assert.rejects(
      syncTeamsBotConfig(
        {
          getInstalledRegistry: () => registry,
          reactivate: async () => {
            throw new Error('activate() blew up');
          },
        },
        IDENTITY,
      ),
      /activate\(\) blew up/,
    );
    // The write landed; only the hot reload did not. A restart picks it up,
    // and the caller surfaces the warning.
    assert.equal(storedEntries(registry).length, 1);
  });

  it('serializes concurrent writes so neither agent loses its entry', async () => {
    // Two agents finishing provisioning at once is normal (the boot-time
    // resume scan re-enqueues every interrupted row). Unserialized, the second
    // read-modify-write would read a config the first had not written yet and
    // silently drop that entry.
    const registry = registryWith({
      [TEAMS_BOTS_CONFIG_KEY]: JSON.stringify([LEGACY_ENTRY]),
    });
    // A registry whose write does not land until the next macrotask — the
    // widest interleaving window a real, async registry could open.
    const slow: InstalledRegistry = {
      ...registry,
      get: (id) => registry.get(id),
      updateConfig: async (id, config) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await registry.updateConfig(id, config);
      },
    } as InstalledRegistry;
    const deps = { getInstalledRegistry: () => slow };
    await Promise.all([
      syncTeamsBotConfig(deps, IDENTITY),
      syncTeamsBotConfig(deps, {
        botSlug: 'sales-bot-2',
        displayName: 'Sales Bot 2',
        appId: 'app-sales-2',
        tenantId: 'tenant-0001',
      }),
      syncTeamsBotConfig(deps, {
        botSlug: 'ops-bot',
        displayName: 'Ops Bot',
        appId: 'app-ops-3',
        tenantId: 'tenant-0001',
      }),
    ]);
    const slugs = storedEntries(registry).map((entry) => entry['botSlug']);
    assert.deepEqual(slugs, ['default', 'hr-bot', 'sales-bot-2', 'ops-bot']);
  });

  it('a failed write does not poison the queue for the next caller', async () => {
    const broken = registryWith({ [TEAMS_BOTS_CONFIG_KEY]: '{ not json' });
    const good = registryWith({});
    await assert.rejects(
      syncTeamsBotConfig({ getInstalledRegistry: () => broken }, IDENTITY),
      TeamsBotsConfigSyncError,
    );
    const outcome = await syncTeamsBotConfig(
      { getInstalledRegistry: () => good },
      IDENTITY,
    );
    assert.equal(outcome.status, 'synced');
  });

  it('never writes secret material — only the opaque vault REF', async () => {
    const registry = registryWith({});
    await syncTeamsBotConfig({ getInstalledRegistry: () => registry }, IDENTITY);
    const serialized = JSON.stringify(registry.get(CHANNEL_TEAMS_PLUGIN_ID)?.config);
    assert.ok(serialized.includes('teams_bot_password:app-hr-0001'));
    assert.ok(!serialized.includes('appPassword"'));
  });
});

// ---------------------------------------------------------------------------
// The status projection the operator UI renders from
// ---------------------------------------------------------------------------

describe('projectTeamsBotsConfigSyncStatus', () => {
  it('reports synced after a sync and out_of_sync after a hand edit', async () => {
    const registry = registryWith({});
    const deps = { getInstalledRegistry: () => registry };
    assert.equal(projectTeamsBotsConfigSyncStatus(deps, IDENTITY).state, 'missing');
    await syncTeamsBotConfig(deps, IDENTITY);
    assert.equal(projectTeamsBotsConfigSyncStatus(deps, IDENTITY).state, 'synced');

    const edited = storedEntries(registry);
    edited[0] = { ...(edited[0] ?? {}), displayName: 'hand edited' };
    await registry.updateConfig(CHANNEL_TEAMS_PLUGIN_ID, {
      [TEAMS_BOTS_CONFIG_KEY]: JSON.stringify(edited),
    });
    assert.equal(projectTeamsBotsConfigSyncStatus(deps, IDENTITY).state, 'out_of_sync');
  });

  it('names each reason the entry cannot be there', () => {
    assert.equal(
      projectTeamsBotsConfigSyncStatus({ getInstalledRegistry: () => undefined }, IDENTITY)
        .state,
      'unknown',
    );
    assert.equal(
      projectTeamsBotsConfigSyncStatus(
        { getInstalledRegistry: () => new InMemoryInstalledRegistry() },
        IDENTITY,
      ).state,
      'plugin_not_installed',
    );
    assert.equal(
      projectTeamsBotsConfigSyncStatus(
        { getInstalledRegistry: () => registryWith({}) },
        { ...IDENTITY, appId: null },
      ).state,
      'not_applicable',
    );
    assert.equal(
      projectTeamsBotsConfigSyncStatus(
        {
          getInstalledRegistry: () =>
            registryWith({ [TEAMS_BOTS_CONFIG_KEY]: '{ not json' }),
        },
        IDENTITY,
      ).state,
      'unreadable',
    );
  });

  it('carries the plugin id and config key the UI names in its copy', () => {
    const status = projectTeamsBotsConfigSyncStatus(
      { getInstalledRegistry: () => registryWith({}) },
      IDENTITY,
    );
    assert.equal(status.plugin_id, CHANNEL_TEAMS_PLUGIN_ID);
    assert.equal(status.config_key, 'teams_bots');
  });
});

// ---------------------------------------------------------------------------
// The teardown half — taking back out what the chain wrote
// ---------------------------------------------------------------------------

/**
 * A reset that leaves the entry behind is not a reset. The registration it
 * names has just been deleted AND purged, so what stays behind is a bot that
 * fails authentication on every inbound activity — and the next run appends a
 * second entry under the same slug beside it.
 *
 * The properties that matter are the mirror image of the sync's: remove
 * exactly one entry, disturb nothing else, and never fail for "already gone".
 */

/** The entry the chain would have written for {@link IDENTITY}. */
const hrEntry = (): Record<string, unknown> => {
  const projection = projectTeamsBotConfig(IDENTITY);
  assert.ok(projection, 'fixture must project');
  return teamsBotConfigEntry(projection) as Record<string, unknown>;
};

function docWith(
  entries: readonly Record<string, unknown>[],
): ReturnType<typeof readTeamsBotsConfig> {
  return readTeamsBotsConfig(
    serializeTeamsBotsConfig({ entries: [...entries], form: 'string' }),
  );
}

describe('removeTeamsBotEntry', () => {
  it('drops the named slug and carries every other entry over untouched', () => {
    const doc = docWith([LEGACY_ENTRY, hrEntry(), FOREIGN_ENTRY]);
    const { document, changed } = removeTeamsBotEntry(doc, 'hr-bot');
    assert.equal(changed, true);
    assert.deepEqual(
      document.entries.map((e) => (e as Record<string, unknown>)['botSlug']),
      ['default', 'sales-bot'],
    );
    // Entry 0 is the legacy scalar-shimmed bot answering live traffic, and
    // the foreign entry is somebody's hand-tuned row. Byte-equal, not merely
    // still present.
    assert.deepEqual(document.entries[0], LEGACY_ENTRY);
    assert.deepEqual(document.entries[1], FOREIGN_ENTRY);
  });

  it('reports unchanged, and returns the SAME document, when nothing matched', () => {
    const doc = docWith([LEGACY_ENTRY]);
    const { document, changed } = removeTeamsBotEntry(doc, 'hr-bot');
    assert.equal(changed, false);
    assert.equal(document, doc);
  });

  it('matches on the SLUG, not on the app id', () => {
    // The teardown runs AFTER the registration is purged, so the entry that
    // most needs removing is precisely the one whose app id no longer
    // resolves. Matching on the id would leave exactly that one behind.
    const doc = docWith([{ ...hrEntry(), appId: 'app-already-purged' }]);
    const { document, changed } = removeTeamsBotEntry(doc, 'hr-bot');
    assert.equal(changed, true);
    assert.deepEqual(document.entries, []);
  });
});

describe('dropTeamsBotConfig', () => {
  it('writes the shortened list and reactivates the plugin', async () => {
    const registry = registryWith({
      [TEAMS_BOTS_CONFIG_KEY]: serializeTeamsBotsConfig({
        entries: [LEGACY_ENTRY, hrEntry()],
        form: 'string',
      }),
    });
    const reactivated: string[] = [];
    const outcome = await dropTeamsBotConfig(
      {
        getInstalledRegistry: () => registry,
        reactivate: async (id: string) => {
          reactivated.push(id);
        },
      },
      'hr-bot',
    );
    assert.deepEqual(outcome, { status: 'synced', botSlug: 'hr-bot' });
    assert.deepEqual(
      storedEntries(registry).map((e) => e['botSlug']),
      ['default'],
    );
    assert.deepEqual(reactivated, [CHANNEL_TEAMS_PLUGIN_ID]);
  });

  it('does not bounce a live plugin when there was nothing to remove', async () => {
    const registry = registryWith({
      [TEAMS_BOTS_CONFIG_KEY]: serializeTeamsBotsConfig({
        entries: [LEGACY_ENTRY],
        form: 'string',
      }),
    });
    const reactivated: string[] = [];
    const outcome = await dropTeamsBotConfig(
      {
        getInstalledRegistry: () => registry,
        reactivate: async (id: string) => {
          reactivated.push(id);
        },
      },
      'hr-bot',
    );
    assert.deepEqual(outcome, { status: 'unchanged', botSlug: 'hr-bot' });
    assert.deepEqual(reactivated, []);
    assert.deepEqual(storedEntries(registry), [LEGACY_ENTRY]);
  });

  it('skips, never throws, when the registry or the plugin is absent', async () => {
    assert.deepEqual(
      await dropTeamsBotConfig({ getInstalledRegistry: () => undefined }, 'hr-bot'),
      { status: 'skipped', reason: 'registry_unavailable' },
    );
    assert.deepEqual(
      await dropTeamsBotConfig(
        { getInstalledRegistry: () => new InMemoryInstalledRegistry() },
        'hr-bot',
      ),
      { status: 'skipped', reason: 'plugin_not_installed' },
    );
  });

  it('refuses to clobber a stored value it cannot read', async () => {
    // Same posture as the sync: an unparsable value may be an operator's
    // hand-written list, and rewriting it would destroy work this module has
    // no way to reconstruct.
    await assert.rejects(
      dropTeamsBotConfig(
        {
          getInstalledRegistry: () =>
            registryWith({ [TEAMS_BOTS_CONFIG_KEY]: '{ not json' }),
        },
        'hr-bot',
      ),
      TeamsBotsConfigSyncError,
    );
  });
});
