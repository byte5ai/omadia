/**
 * #2043 rollout (D9) — a re-run picks up a corrected package.
 *
 * A run failed at the install with a catalog app already published from an
 * old template. The plugin was updated (new template revision), "run
 * provisioning again" logged "package built: skipped, catalog uploaded:
 * skipped", and the install failed again with the old package. The only way
 * forward was a reset, which deletes the bot and every install users made.
 *
 * The run now reads which version the catalog holds and rebuilds when the
 * one it would build is newer, updating the entry in place.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  isOlderTeamsAppVersion,
  TeamsProvisioningJobRunner,
  type TeamsIdentityJobRecord,
  type TeamsProvisionerPort,
} from '../src/services/teamsProvisioningJob.js';

interface Catalog {
  id: string | undefined;
  version: string | undefined;
}

function setup(opts: {
  readonly row: Partial<TeamsIdentityJobRecord>;
  readonly catalog: Catalog;
  /** The version the current template + identity yield. */
  readonly builds: string;
  readonly catalogReadFails?: boolean;
  readonly installFails?: boolean;
}) {
  let row = {
    agentId: 'agent-1',
    botSlug: 'mara-test',
    displayName: 'Mara (Test)',
    state: 'failed',
    teamId: 'team-42',
    appId: 'app-123',
    tenantId: 'tenant-9',
    teamsAppId: 'catalog-77',
    teamsAppExternalId: 'external-abc',
    lastError: 'earlier failure',
    ...opts.row,
  } as TeamsIdentityJobRecord;
  const catalog = { ...opts.catalog };
  const calls: string[] = [];
  const events: string[] = [];
  const provisioner = {
    async createAppRegistration() {
      calls.push('createAppRegistration');
      return { outcome: 'already-existed', value: { appId: 'app-123', registration: { tenantId: 'tenant-9' } } };
    },
    async createBot(input: { botName: string }) {
      calls.push('createBot');
      return { kind: 'provisioned', bot: { outcome: 'already-existed', value: { botName: input.botName } } };
    },
    buildAppPackage(input: { params: Record<string, unknown> }) {
      calls.push(`build:${String(input.params['VERSION'])}`);
      return new Uint8Array([80, 75]);
    },
    async uploadToCatalog(input: { externalId: string }) {
      calls.push(`upload:${input.externalId}`);
      catalog.id ??= 'catalog-new';
      catalog.version = opts.builds;
      return { outcome: 'created', value: { teamsAppId: catalog.id } };
    },
    async getCatalogApp() {
      calls.push('getCatalogApp');
      if (opts.catalogReadFails) throw new Error('graph 503');
      return catalog.id === undefined
        ? { found: false }
        : { found: true, teamsAppId: catalog.id, ...(catalog.version ? { publishedVersion: catalog.version } : {}) };
    },
    async installToTeam(input: { teamId: string; teamsAppId: string }) {
      calls.push(`install:${input.teamsAppId}`);
      if (opts.installFails) {
        throw Object.assign(new Error('graph teams.installedApps.add 403 Forbidden'), {
          name: 'ProvisioningRequestError',
          status: 403,
          step: 'teams.installedApps.add',
        });
      }
      return { outcome: 'created', value: input };
    },
  } as unknown as TeamsProvisionerPort;
  const runner = new TeamsProvisioningJobRunner({
    store: {
      getByAgentId: async () => row,
      update: async (_id: string, patch: Partial<TeamsIdentityJobRecord>) => {
        row = { ...row, ...patch } as TeamsIdentityJobRecord;
        return row;
      },
    } as never,
    getProvisioner: () => provisioner,
    buildMessagingEndpoint: (slug: string) => `https://mw.example.com/api/teams/${slug}/messages`,
    loadPackageAssets: async () => ({
      manifestTemplate: '{"id":"{{APP_ID}}","version":"{{VERSION}}"}',
      params: { APP_ID: 'app-123', VERSION: opts.builds },
      icons: { color: new Uint8Array([1]), outline: new Uint8Array([2]) },
      externalId: 'external-abc',
    }),
    timers: {
      setTimeout: (fn: () => void) => {
        fn();
        return 0 as never;
      },
      clearTimeout: () => undefined,
    } as never,
    catalogReplicationDelayMs: 1,
    // No install is recorded for the requested team, so an `installed`
    // identity still has the per-team install to do (the additional-team case).
    installs: { get: async () => undefined, record: async () => undefined },
    events: {
      clearForAgent: async () => undefined,
      record: async (e: { step: string; status: string; detail?: string | null }) => {
        events.push(`${e.step}/${e.status}${e.detail ? `/${e.detail}` : ''}`);
      },
    } as never,
    log: () => undefined,
  } as never);
  const run = () => runner.enqueue({ agentId: 'agent-1', teamId: 'team-42' });
  return { run, calls, events, row: () => row, catalog };
}

describe('a re-run rebuilds a stale catalog package (#2043 D9)', () => {
  it('the failed run of the rollout: a new template revision is built and updates the catalog app in place', async () => {
    const h = setup({ row: {}, catalog: { id: 'catalog-77', version: '1.2.1' }, builds: '1.3.1' });
    const result = await h.run();
    assert.equal(result.status, 'installed');
    assert.deepEqual(
      h.calls.filter((c) => !c.startsWith('create')),
      ['getCatalogApp', 'build:1.3.1', 'upload:external-abc', 'install:catalog-77'],
    );
    assert.equal(h.catalog.version, '1.3.1');
    assert.equal(h.row().teamsAppId, 'catalog-77', 'the same catalog app, so installs users made keep working');
    assert.ok(h.events.includes('package_built/succeeded'), 'reported as built, not as skipped');
    assert.ok(h.events.includes('catalog_uploaded/succeeded'));
  });

  it('a changed identity (higher identity revision) is rebuilt the same way', async () => {
    const h = setup({ row: { state: 'catalog_uploaded' }, catalog: { id: 'catalog-77', version: '1.3.1' }, builds: '1.3.2' });
    await h.run();
    assert.ok(h.calls.includes('build:1.3.2'));
  });

  it('a current package is left alone: one read, both steps logged as skipped', async () => {
    const h = setup({ row: { state: 'catalog_uploaded' }, catalog: { id: 'catalog-77', version: '1.3.1' }, builds: '1.3.1' });
    const result = await h.run();
    assert.equal(result.status, 'installed');
    assert.deepEqual(h.calls, ['getCatalogApp', 'install:catalog-77']);
    assert.ok(h.events.includes('package_built/succeeded/skipped'));
    assert.ok(h.events.includes('catalog_uploaded/succeeded/skipped'));
  });

  it('never downgrades: a catalog that is NEWER than what this run would build is kept', async () => {
    const h = setup({ row: { state: 'catalog_uploaded' }, catalog: { id: 'catalog-77', version: '1.4.0' }, builds: '1.3.9' });
    await h.run();
    assert.deepEqual(h.calls, ['getCatalogApp', 'install:catalog-77']);
  });

  it('an installed identity on its way into another team is refreshed and stays installed', async () => {
    const h = setup({
      row: { state: 'installed', lastError: null },
      catalog: { id: 'catalog-77', version: '1.2.5' },
      builds: '1.3.5',
    });
    const result = await h.run();
    assert.equal(result.status, 'installed');
    assert.ok(h.calls.includes('upload:external-abc'));
    assert.equal(h.row().state, 'installed');
  });

  it('a catalog app that was deleted behind our back is uploaded again', async () => {
    const h = setup({ row: { state: 'catalog_uploaded' }, catalog: { id: undefined, version: undefined }, builds: '1.3.1' });
    const result = await h.run();
    assert.equal(result.status, 'installed');
    assert.deepEqual(h.calls, ['getCatalogApp', 'build:1.3.1', 'upload:external-abc', 'install:catalog-new']);
    assert.equal(h.row().teamsAppId, 'catalog-new');
  });

  it('a connector that reports no version, or a failing catalog read, keeps the published package', async () => {
    const noVersion = setup({ row: { state: 'catalog_uploaded' }, catalog: { id: 'catalog-77', version: undefined }, builds: '1.3.1' });
    await noVersion.run();
    assert.deepEqual(noVersion.calls, ['getCatalogApp', 'install:catalog-77']);
    const readFails = setup({
      row: { state: 'catalog_uploaded' },
      catalog: { id: 'catalog-77', version: '1.0.0' },
      builds: '1.3.1',
      catalogReadFails: true,
    });
    const result = await readFails.run();
    assert.equal(result.status, 'installed', 'a failed comparison does not fail a run that had nothing else to do there');
    assert.deepEqual(readFails.calls, ['getCatalogApp', 'install:catalog-77']);
  });

  it('a fresh run that finds an OLDER entry under its external id updates it instead of adopting it', async () => {
    const h = setup({
      row: { state: 'bot_created', teamsAppId: null, teamsAppExternalId: null },
      catalog: { id: 'catalog-old', version: '1.2.1' },
      builds: '1.3.1',
    });
    await h.run();
    assert.deepEqual(h.calls, ['getCatalogApp', 'build:1.3.1', 'upload:external-abc', 'install:catalog-old']);
  });

  it('compares versions position by position, and refuses to guess', () => {
    assert.equal(isOlderTeamsAppVersion('1.2.37', '1.3.1'), true, 'template revision outranks identity revision');
    assert.equal(isOlderTeamsAppVersion('1.3.1', '1.3.1'), false);
    assert.equal(isOlderTeamsAppVersion('1.3.10', '1.3.9'), false, 'numeric, not lexical');
    assert.equal(isOlderTeamsAppVersion('1.3', '1.3.1'), true);
    for (const unknown of [undefined, '', 'latest', '1.x.0', 7]) {
      assert.equal(isOlderTeamsAppVersion(unknown, '1.3.1'), false);
      assert.equal(isOlderTeamsAppVersion('1.0.0', unknown), false);
    }
  });
});
