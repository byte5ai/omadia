/**
 * #914 — re-publishing the Teams app package of an ALREADY INSTALLED
 * identity.
 *
 * The chain short-circuits at `installed` (#910): there is nothing left to
 * provision, so a re-run only re-asserts the plugin config. That is exactly
 * right until the agent's IDENTITY changes — then the tenant is serving a
 * package built from the old name, description, colour and icon, and a
 * silent no-op is the worst possible answer.
 *
 * So this suite pins both halves of the contract:
 *  - without `republish`, an installed identity still touches no provisioner
 *    at all (the #910 behaviour, unchanged);
 *  - with it, the package is rebuilt from freshly loaded assets, re-uploaded
 *    under the same externalId, re-installed, and the state stays `installed`
 *    — a re-publish never walks the identity backwards.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  TeamsProvisioningJobRunner,
  type TeamsAppPackageAssets,
  type TeamsIdentityJobRecord,
  type TeamsIdentityJobStore,
  type TeamsIdentityJobUpdate,
  type TeamsProvisionerPort,
} from '../src/services/teamsProvisioningJob.js';

const ASSETS: TeamsAppPackageAssets = {
  manifestTemplate: '{"id":"{{APP_ID}}","version":"{{VERSION}}"}',
  params: { APP_ID: 'external-abc', VERSION: '1.0.7' },
  icons: { color: new Uint8Array([1]), outline: new Uint8Array([2]) },
  externalId: 'external-abc',
};

function installedRow(): TeamsIdentityJobRecord {
  return {
    agentId: 'agent-1',
    botSlug: 'hr-bot',
    displayName: 'HR Bot',
    state: 'installed',
    appId: 'app-123',
    tenantId: 'tenant-9',
    teamsAppId: 'catalog-77',
    teamsAppExternalId: 'external-abc',
    lastError: null,
  };
}

interface MemoryStore extends TeamsIdentityJobStore {
  row: TeamsIdentityJobRecord;
  readonly updates: TeamsIdentityJobUpdate[];
}

function makeStore(): MemoryStore {
  const updates: TeamsIdentityJobUpdate[] = [];
  const store: MemoryStore = {
    row: installedRow(),
    updates,
    getByAgentId(agentId) {
      return Promise.resolve(store.row.agentId === agentId ? store.row : undefined);
    },
    update(agentId, patch) {
      assert.equal(agentId, store.row.agentId);
      updates.push(patch);
      store.row = {
        ...store.row,
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.teamsAppId !== undefined ? { teamsAppId: patch.teamsAppId } : {}),
        ...(patch.teamsAppExternalId !== undefined
          ? { teamsAppExternalId: patch.teamsAppExternalId }
          : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
      };
      return Promise.resolve(store.row);
    },
  };
  return store;
}

interface StubProvisioner extends TeamsProvisionerPort {
  readonly calls: string[];
}

function makeProvisioner(): StubProvisioner {
  const calls: string[] = [];
  return {
    calls,
    createAppRegistration() {
      calls.push('createAppRegistration');
      throw new Error('an installed identity must not re-register its app');
    },
    createBot() {
      calls.push('createBot');
      throw new Error('an installed identity must not re-create its bot');
    },
    buildAppPackage(input) {
      calls.push(`buildAppPackage:${String(input.params['VERSION'])}`);
      return new Uint8Array([80, 75]);
    },
    uploadToCatalog(input) {
      calls.push(`uploadToCatalog:${input.externalId}`);
      return Promise.resolve({
        outcome: 'already-existed' as const,
        value: { teamsAppId: 'catalog-77' },
      });
    },
    getCatalogApp(input) {
      calls.push(`getCatalogApp:${input.teamsAppExternalId}`);
      return Promise.resolve({ found: true as const, teamsAppId: 'catalog-77' });
    },
    installToTeam(input) {
      calls.push(`installToTeam:${input.teamId}:${input.teamsAppId}`);
      return Promise.resolve({
        outcome: 'already-existed' as const,
        value: { teamId: input.teamId, teamsAppId: input.teamsAppId },
      });
    },
  };
}

interface Fixture {
  readonly runner: TeamsProvisioningJobRunner;
  readonly store: MemoryStore;
  readonly provisioner: StubProvisioner;
  readonly assetLoads: string[];
}

function makeRunner(): Fixture {
  const store = makeStore();
  const provisioner = makeProvisioner();
  const assetLoads: string[] = [];
  const runner = new TeamsProvisioningJobRunner({
    store,
    getProvisioner: () => provisioner,
    buildMessagingEndpoint: (slug) =>
      `https://mw.example.com/api/teams/${slug}/messages`,
    loadPackageAssets: (identity) => {
      assetLoads.push(identity.agentId);
      return Promise.resolve(ASSETS);
    },
    timers: {
      setTimeout: (cb: () => void) => {
        cb();
        return 1;
      },
      clearTimeout: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
    },
    log: () => {},
  });
  return { runner, store, provisioner, assetLoads };
}

describe('teams provisioning — republish of an installed identity (#914)', () => {
  it('rebuilds, re-uploads and re-installs, and keeps the state installed', async () => {
    const { runner, store, provisioner, assetLoads } = makeRunner();

    const result = await runner.enqueue({
      agentId: 'agent-1',
      teamId: 'team-42',
      republish: true,
    });

    assert.deepEqual(result, { status: 'installed', agentId: 'agent-1' });
    // Fresh assets — a cached package would republish the OLD identity.
    assert.deepEqual(assetLoads, ['agent-1']);
    assert.deepEqual(provisioner.calls, [
      // The version comes from the identity's revision; the stub records it
      // so a params regression cannot pass unnoticed.
      'buildAppPackage:1.0.7',
      'uploadToCatalog:external-abc',
      'installToTeam:team-42:catalog-77',
    ]);
    assert.equal(store.row.state, 'installed');
    // Nothing in the run demotes the identity: the only state write is step
    // 5 re-asserting the terminal one it already had.
    assert.deepEqual(
      store.updates.flatMap((u) => (u.state === undefined ? [] : [u.state])),
      ['installed'],
    );
  });

  it('leaves the #910 behaviour alone when republish is not asked for', async () => {
    const { runner, store, provisioner, assetLoads } = makeRunner();

    const result = await runner.enqueue({ agentId: 'agent-1', teamId: 'team-42' });

    assert.deepEqual(result, { status: 'installed', agentId: 'agent-1' });
    assert.deepEqual(provisioner.calls, []);
    assert.deepEqual(assetLoads, []);
    assert.equal(store.row.state, 'installed');
  });
});
