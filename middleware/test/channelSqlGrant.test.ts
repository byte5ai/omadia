import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DefaultChannelRegistry } from '../src/channels/channelRegistry.js';

// omadia#838 / ADR-0050 — a CHANNEL plugin that declares `permissions.sql`
// gets the same grant check and kernel-run migrations as a tool plugin. Before,
// `DefaultChannelRegistry.activate` never passed `sqlGranted`, so a channel was
// ungranted forever and its migrations never ran: Teams could only reach the
// pool through the dated grandfather row. Drives the real activate().

const TEAMS_ID = '@omadia/channel-teams';
const LEDGER = 'plg_omadia_channel_teams_migrations';

function packageWithMigrations(): string {
  const root = mkdtempSync(join(tmpdir(), 'channel-sql-'));
  mkdirSync(join(root, 'migrations'));
  writeFileSync(join(root, 'migrations', '0001_t.sql'), 'CREATE TABLE IF NOT EXISTS t (id int);\n');
  return root;
}

interface Rig {
  registry: DefaultChannelRegistry;
  seen: { sql: unknown; activated: boolean };
  connects: { count: number };
}

function makeRegistry(opts: {
  grantLedger?: string;
  withGrantStore?: boolean;
  declared?: boolean;
}): Rig {
  const noop = (): void => undefined;
  const unsub = (): (() => void) => () => undefined;
  const seen = { sql: undefined as unknown, activated: false };
  const connects = { count: 0 };
  const pool = {
    connect: async () => {
      connects.count += 1;
      throw new Error('sentinel: migration runner reached the pool');
    },
    query: async () => ({ rows: [] }),
  };
  const entry = {
    plugin: {
      id: TEAMS_ID,
      kind: 'channel',
      domain: 'channel.teams',
      depends_on: [],
      permissions_summary: opts.declared === false ? {} : { sql: { ledger: LEDGER, migrations: 'migrations' } },
      setup_fields: [],
      integrations_summary: [],
      provides: [],
      requires: [],
      jobs: [],
    },
    manifest: { schema_version: '1', identity: { id: TEAMS_ID, kind: 'channel' } },
  };
  const root = packageWithMigrations();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps: any = {
    catalog: { get: () => entry, has: () => true, list: () => [entry], isBundledId: () => false },
    installedRegistry: { list: () => [], get: () => entry },
    vault: { get: noop, set: noop, list: () => [] },
    serviceRegistry: {
      get: (name: string) => (name === 'graphPool' ? pool : undefined),
      has: () => false,
      provide: unsub,
      replace: unsub,
    },
    nativeToolRegistry: { register: noop, unregister: noop, list: () => [] },
    pluginRouteRegistry: { disposeBySource: noop },
    notificationRouter: { registerChannel: unsub },
    uiRouteCatalog: { disposeBySource: noop },
    jobScheduler: { stopForPlugin: noop },
    pluginStatusRegistry: { clear: noop },
    ...(opts.withGrantStore === false
      ? {}
      : {
          sqlGrantStore: {
            get: async () => (opts.grantLedger ? { pluginId: TEAMS_ID, ledger: opts.grantLedger } : undefined),
          },
        }),
    packagePathOf: () => root,
    resolver: {
      resolve: async () => ({
        activate: async (ctx: { sql?: unknown }) => {
          seen.sql = ctx.sql;
          seen.activated = true;
          return { close: async () => undefined };
        },
      }),
      invalidate: noop,
    },
    coreApi: { log: noop, registerRoute: noop, registerRouter: noop },
    routes: { setActive: noop, deactivateChannel: noop },
    webSockets: { setActive: noop, deactivateChannel: noop },
  };
  return { registry: new DefaultChannelRegistry(deps), seen, connects };
}

describe('channel plugins and permissions.sql (omadia#838, ADR-0050)', () => {
  it('a granted channel runs its migrations BEFORE activate()', async () => {
    const { registry, seen, connects } = makeRegistry({ grantLedger: LEDGER });
    await assert.rejects(registry.activate(TEAMS_ID), /sentinel: migration runner reached the pool/);
    assert.equal(connects.count, 1);
    assert.equal(seen.activated, false, 'activate() must not run when the migrations failed');
  });

  it('an ungranted channel gets no ctx.sql and no migration runs', async () => {
    const { registry, seen, connects } = makeRegistry({});
    await registry.activate(TEAMS_ID);
    assert.equal(seen.activated, true);
    assert.equal(seen.sql, undefined);
    assert.equal(connects.count, 0);
  });

  it('a grant for another ledger counts as ungranted', async () => {
    const { registry, seen, connects } = makeRegistry({ grantLedger: 'plg_omadia_channel_teams_other' });
    await registry.activate(TEAMS_ID);
    assert.equal(seen.sql, undefined);
    assert.equal(connects.count, 0);
  });

  it('without a grant store (no database) every channel is ungranted', async () => {
    const { registry, seen } = makeRegistry({ withGrantStore: false });
    await registry.activate(TEAMS_ID);
    assert.equal(seen.sql, undefined);
  });

  it('a channel that declares no permissions.sql is untouched', async () => {
    const { registry, seen, connects } = makeRegistry({ grantLedger: LEDGER, declared: false });
    await registry.activate(TEAMS_ID);
    assert.equal(seen.activated, true);
    assert.equal(seen.sql, undefined);
    assert.equal(connects.count, 0);
  });
});
