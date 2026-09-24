/**
 * The runner installs into the KIND it was asked for — team or chat.
 *
 * THE FIELD TEST BEHIND THIS SUITE. An operator pasted
 * `abc8af8ec7fc471785d3b83c4d84b667` into a field labelled "Team-ID". The
 * chain answered `400 teamId needs to be a valid GUID`; once the id was
 * hyphenated, Graph answered `404 No team found with Group Id`. Every team and
 * channel in the tenant was searched by hand afterwards — it was neither. It
 * was, with high probability, the stem of a GROUP CHAT id.
 *
 * `team_id` was the only target the stack could name, so a group chat could
 * not be asked for, could not be validated, and could only fail at step five
 * of a chain that had already created an Entra app, an Azure bot and a catalog
 * entry. This suite pins the vocabulary that fixes it:
 *
 *   * a team target still goes through `installToTeam` (unchanged);
 *   * a chat target goes through `installToChat`, with the id VERBATIM;
 *   * a connector too old for chats fails with a sentence naming the version;
 *   * the binding records which endpoint actually performed the install.
 *
 * Self-contained on purpose: it drives its own minimal store/provisioner
 * rather than the big shared fixture, so the shape of the chat contract is
 * readable in one file.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { TimerSeam } from '../src/plugins/jobScheduler.js';
import {
  TeamsProvisioningJobRunner,
  type ProvisionTeamsIdentityRequest,
  type TeamsAppPackageAssets,
  type TeamsIdentityJobRecord,
  type TeamsIdentityJobStore,
  type TeamsIdentityJobUpdate,
  type TeamsProvisionerPort,
} from '../src/services/teamsProvisioningJob.js';

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function immediateTimers(): TimerSeam {
  return {
    setTimeout(cb) {
      cb();
      return 1;
    },
    clearTimeout() {},
    setInterval() {
      throw new Error('runner must not use setInterval');
    },
    clearInterval() {},
  };
}

interface MemoryStore extends TeamsIdentityJobStore {
  row: TeamsIdentityJobRecord;
  readonly updates: TeamsIdentityJobUpdate[];
}

function makeStore(): MemoryStore {
  const updates: TeamsIdentityJobUpdate[] = [];
  const store: MemoryStore = {
    // Starts at `catalog_uploaded` so every run in this suite reaches the
    // install step in one hop — the earlier steps have their own suite and
    // repeating them here would only make the chat contract harder to read.
    row: {
      agentId: 'agent-1',
      botSlug: 'hr-bot',
      displayName: 'HR Bot',
      state: 'catalog_uploaded',
      appId: 'app-123',
      tenantId: 'tenant-9',
      teamsAppId: 'catalog-77',
      teamsAppExternalId: 'external-abc',
      lastError: null,
    },
    async getByAgentId(agentId) {
      return store.row.agentId === agentId ? store.row : undefined;
    },
    async update(agentId, patch) {
      assert.equal(store.row.agentId, agentId);
      updates.push(patch);
      store.row = {
        ...store.row,
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.teamsAppId !== undefined ? { teamsAppId: patch.teamsAppId } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
      };
      return store.row;
    },
    updates,
  };
  return store;
}

interface InstallRow {
  readonly teamId: string;
  readonly targetKind?: string;
  readonly teamDisplayName?: string | null;
}

class MemoryInstallStore {
  readonly rows: InstallRow[] = [];

  get(_agentId: string, teamId: string): Promise<{ teamId: string } | undefined> {
    const row = this.rows.find((entry) => entry.teamId === teamId);
    return Promise.resolve(row ? { teamId: row.teamId } : undefined);
  }

  record(input: {
    readonly agentId: string;
    readonly teamId: string;
    readonly teamsAppId?: string | null;
    readonly teamDisplayName?: string | null;
    readonly targetKind?: string;
  }): Promise<unknown> {
    this.rows.push({
      teamId: input.teamId,
      ...(input.targetKind !== undefined ? { targetKind: input.targetKind } : {}),
      teamDisplayName: input.teamDisplayName ?? null,
    });
    return Promise.resolve(undefined);
  }
}

interface StubProvisioner extends TeamsProvisionerPort {
  readonly calls: string[];
}

/**
 * `chatInstall: 'absent'` models a connector < 0.7.0 by OMITTING the key
 * entirely — a present-but-undefined property would still be a key, and
 * feature detection has to see a missing method.
 */
function makeProvisioner(
  opts: { chatInstall?: 'absent'; installError?: Error } = {},
): StubProvisioner {
  const calls: string[] = [];
  return {
    calls,
    async createAppRegistration() {
      return {
        outcome: 'created',
        value: { appId: 'app-123', registration: { tenantId: 'tenant-9' } },
      };
    },
    async createBot(input) {
      return {
        kind: 'provisioned',
        bot: { outcome: 'created', value: { botName: input.botName } },
      };
    },
    buildAppPackage() {
      return new Uint8Array([80, 75]);
    },
    async uploadToCatalog() {
      return { outcome: 'created', value: { teamsAppId: 'catalog-77' } };
    },
    async getCatalogApp() {
      return { found: true, teamsAppId: 'catalog-77' };
    },
    async installToTeam(input) {
      calls.push(`installToTeam:${input.teamId}`);
      if (opts.installError) throw opts.installError;
      return {
        outcome: 'created',
        value: { teamId: input.teamId, teamsAppId: input.teamsAppId },
      };
    },
    ...(opts.chatInstall === 'absent'
      ? {}
      : {
          async installToChat(input: {
            readonly chatId: string;
            readonly teamsAppId: string;
          }) {
            calls.push(`installToChat:${input.chatId}`);
            if (opts.installError) throw opts.installError;
            return {
              outcome: 'created' as const,
              value: { chatId: input.chatId, teamsAppId: input.teamsAppId },
            };
          },
        }),
  };
}

const ASSETS: TeamsAppPackageAssets = {
  manifestTemplate: '{"id":"{{APP_ID}}"}',
  params: { APP_ID: 'app-123' },
  icons: { color: new Uint8Array([1]), outline: new Uint8Array([2]) },
  externalId: 'external-abc',
};

function makeRunner(opts: {
  provisioner?: StubProvisioner;
  installs?: MemoryInstallStore;
  resolveTeamName?: (teamId: string) => Promise<string | null>;
} = {}): {
  runner: TeamsProvisioningJobRunner;
  store: MemoryStore;
  provisioner: StubProvisioner;
} {
  const store = makeStore();
  const provisioner = opts.provisioner ?? makeProvisioner();
  const runner = new TeamsProvisioningJobRunner({
    store,
    getProvisioner: () => provisioner,
    buildMessagingEndpoint: (botSlug) =>
      `https://mw.example.com/api/teams/${botSlug}/messages`,
    loadPackageAssets: async () => ASSETS,
    timers: immediateTimers(),
    maxAttempts: 1,
    baseRetryDelayMs: 1,
    ...(opts.installs ? { installs: opts.installs } : {}),
    ...(opts.resolveTeamName ? { resolveTeamName: opts.resolveTeamName } : {}),
    log: () => {},
  });
  return { runner, store, provisioner };
}

const TEAM_REQUEST: ProvisionTeamsIdentityRequest = {
  agentId: 'agent-1',
  teamId: '2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c',
};

function lastErrorOf(store: MemoryStore): string {
  const recorded = store.updates
    .map((update) => update.lastError)
    .filter((value): value is string => typeof value === 'string');
  return recorded.at(-1) ?? '';
}

// ---------------------------------------------------------------------------

describe('TeamsProvisioningJobRunner: team vs chat install targets', () => {
  it('installs into a TEAM through installToTeam when no kind is given', async () => {
    // Every caller before the chat targets meant a team and none of them
    // passes `targetKind` — the default must keep them working verbatim.
    const { runner, provisioner } = makeRunner();
    const result = await runner.enqueue(TEAM_REQUEST);

    assert.equal(result.status, 'installed');
    assert.deepEqual(provisioner.calls, [
      'installToTeam:2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c',
    ]);
  });

  it('installs into a GROUP CHAT through installToChat', async () => {
    const { runner, provisioner } = makeRunner();
    const result = await runner.enqueue({
      agentId: 'agent-1',
      teamId: '19:abc123@thread.v2',
      targetKind: 'group-chat',
    });

    assert.equal(result.status, 'installed');
    assert.deepEqual(provisioner.calls, ['installToChat:19:abc123@thread.v2']);
  });

  it('installs into a 1:1 CHAT through the same chat endpoint', async () => {
    const { runner, provisioner } = makeRunner();
    const result = await runner.enqueue({
      agentId: 'agent-1',
      teamId: '19:a_b@unq.gbl.spaces',
      targetKind: 'one-on-one-chat',
    });

    assert.equal(result.status, 'installed');
    assert.deepEqual(provisioner.calls, ['installToChat:19:a_b@unq.gbl.spaces']);
  });

  it('does NOT reshape a chat id on its way to the connector', async () => {
    // `normalizeTeamsTeamId` turns 32 hex digits into a team GUID. Doing that
    // to a chat id is precisely how the field test produced its 404, so the
    // chat direction must hand Graph the id byte for byte.
    const chatId = '19:abc8af8ec7fc471785d3b83c4d84b667@thread.v2';
    const { runner, provisioner } = makeRunner();
    await runner.enqueue({
      agentId: 'agent-1',
      teamId: chatId,
      targetKind: 'group-chat',
    });

    assert.deepEqual(provisioner.calls, [`installToChat:${chatId}`]);
  });

  it('fails with an ACTIONABLE sentence against a connector without installToChat', async () => {
    const { runner, store } = makeRunner({
      provisioner: makeProvisioner({ chatInstall: 'absent' }),
    });
    const result = await runner.enqueue({
      agentId: 'agent-1',
      teamId: '19:abc@thread.v2',
      targetKind: 'group-chat',
    });

    // A refusal, not a crash: no `TypeError: installToChat is not a function`,
    // and no run that calls itself installed without installing anything.
    assert.equal(result.status, 'failed');
    const detail = lastErrorOf(store);
    assert.match(detail, /installToChat/);
    // Names the version to upgrade to, so the operator can act on it.
    assert.match(detail, /0\.7\.0/);
  });

  it('records the binding with the kind that performed the install', async () => {
    const installs = new MemoryInstallStore();
    const { runner } = makeRunner({ installs });
    await runner.enqueue({
      agentId: 'agent-1',
      teamId: '19:abc@thread.v2',
      targetKind: 'group-chat',
    });

    assert.deepEqual(
      installs.rows.map((row) => [row.teamId, row.targetKind]),
      [['19:abc@thread.v2', 'group-chat']],
    );
  });

  it('does not spend a team-name lookup on a chat binding', async () => {
    // `resolveTeamName` is `teamsProvisioner@1.getTeam`, which answers about
    // TEAMS. Asking it about a chat id buys a `found: false` and a misleading
    // log line.
    const installs = new MemoryInstallStore();
    const lookups: string[] = [];
    const { runner } = makeRunner({
      installs,
      resolveTeamName: async (teamId) => {
        lookups.push(teamId);
        return 'Should Not Be Used';
      },
    });
    await runner.enqueue({
      agentId: 'agent-1',
      teamId: '19:abc@thread.v2',
      targetKind: 'group-chat',
    });

    assert.deepEqual(lookups, []);
    assert.equal(installs.rows[0]?.teamDisplayName, null);
  });

  it('still resolves the name for a TEAM binding', async () => {
    // The counterpart of the test above: the skip is scoped to chats and is
    // not a quiet regression of the team name resolution.
    const installs = new MemoryInstallStore();
    const lookups: string[] = [];
    const { runner } = makeRunner({
      installs,
      resolveTeamName: async (teamId) => {
        lookups.push(teamId);
        return 'Marketing';
      },
    });
    await runner.enqueue(TEAM_REQUEST);

    assert.deepEqual(lookups, ['2f1a9c44-1f0e-4f2c-8f1a-9c441f0e4f2c']);
    assert.equal(installs.rows[0]?.teamDisplayName, 'Marketing');
  });
});

describe('TeamsProvisioningJobRunner: ResourceSpecificPermissionsMismatch', () => {
  /**
   * Graph's `400 ResourceSpecificPermissionsMismatch` is NOT a generic bad
   * request. The id is right and the call is well-formed; the app package's
   * seven RSC permissions exceed what the installing identity may consent to.
   * Reported as a plain 400 it sends the operator hunting for a wrong id that
   * does not exist.
   */
  function rscError(): Error {
    const err = new Error(
      'Request failed: 400 ResourceSpecificPermissionsMismatch — the app requires resource-specific permissions',
    );
    err.name = 'GraphRequestError';
    return err;
  }

  it('names the tenant role to grant for a TEAM target', async () => {
    const { runner, store } = makeRunner({
      provisioner: makeProvisioner({ installError: rscError() }),
    });
    const result = await runner.enqueue(TEAM_REQUEST);

    assert.equal(result.status, 'failed');
    const detail = lastErrorOf(store);
    assert.match(detail, /^rsc_permissions_mismatch:/);
    assert.match(detail, /ReadWriteAndConsentForTeam\.All/);
    // Says the id is fine, so nobody re-checks a correct id.
    assert.match(detail, /target id is correct/i);
  });

  it('names the CHAT role for a chat target', async () => {
    const { runner, store } = makeRunner({
      provisioner: makeProvisioner({ installError: rscError() }),
    });
    const result = await runner.enqueue({
      agentId: 'agent-1',
      teamId: '19:abc@thread.v2',
      targetKind: 'group-chat',
    });

    assert.equal(result.status, 'failed');
    assert.match(lastErrorOf(store), /ReadWriteAndConsentForChat\.All/);
  });

  it('leaves an unrelated install failure classified as before', async () => {
    // The RSC branch must not swallow every 400 — a different failure keeps
    // travelling the ordinary retry/classification path.
    const other = new Error('Request failed: 500 InternalServerError');
    const { runner, store } = makeRunner({
      provisioner: makeProvisioner({ installError: other }),
    });
    const result = await runner.enqueue(TEAM_REQUEST);

    assert.notEqual(result.status, 'installed');
    assert.ok(
      !lastErrorOf(store).startsWith('rsc_permissions_mismatch:'),
      'an unrelated failure must not be reported as an RSC mismatch',
    );
  });
});
