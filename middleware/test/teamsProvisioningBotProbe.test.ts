/**
 * #2043 rollout (D10) — a bot the Bot Connector rejects is not "installed".
 *
 * After a reset and a new run every step was green and the web-ui said
 * "ready", while Teams called the bot invalid: the Bot Connector answered 401
 * to the bot's own token (the app registration had been restored from the
 * recycle bin and the bot re-created under a used app id). Azure reported the
 * resource as healthy.
 *
 * The run now asks the connector to probe the bot before the identity
 * becomes `installed`, and on a re-run of an installed identity.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  botRejectedFailure,
  classifyTeamsProvisioningError,
  TeamsProvisioningJobRunner,
  type TeamsBotProbeResult,
  type TeamsIdentityJobRecord,
  type TeamsProvisionerPort,
} from '../src/services/teamsProvisioningJob.js';

function setup(opts: {
  readonly probe?: (() => Promise<TeamsBotProbeResult>) | null;
  readonly row?: Partial<TeamsIdentityJobRecord>;
  readonly attempts?: number;
}) {
  let row = {
    agentId: 'agent-1',
    botSlug: 'mara-test',
    displayName: 'Mara (Test)',
    state: 'pending',
    teamId: 'team-42',
    appId: null,
    tenantId: null,
    teamsAppId: null,
    teamsAppExternalId: null,
    lastError: null,
    ...opts.row,
  } as TeamsIdentityJobRecord;
  const calls: string[] = [];
  const logs: string[] = [];
  const events: string[] = [];
  const waits: number[] = [];
  const synced: string[] = [];
  let catalog: string | undefined = row.teamsAppId ?? undefined;
  const provisioner = {
    async createAppRegistration() {
      return { outcome: 'created', value: { appId: 'app-123', registration: { tenantId: 'tenant-9' } } };
    },
    async createBot(input: { botName: string }) {
      return { kind: 'provisioned', bot: { outcome: 'created', value: { botName: input.botName } } };
    },
    buildAppPackage: () => new Uint8Array([80, 75]),
    async uploadToCatalog() {
      catalog = 'catalog-77';
      return { outcome: 'created', value: { teamsAppId: catalog } };
    },
    async getCatalogApp() {
      return catalog ? { found: true, teamsAppId: catalog } : { found: false };
    },
    async installToTeam(input: { teamId: string; teamsAppId: string }) {
      calls.push('install');
      return { outcome: 'created', value: input };
    },
    ...(opts.probe === null
      ? {}
      : {
          probeBot: async (input: { appId: string }) => {
            calls.push(`probe:${input.appId}`);
            return (opts.probe ?? (async () => ({ status: 'known' as const })))();
          },
        }),
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
      manifestTemplate: '{"id":"{{APP_ID}}"}',
      params: { APP_ID: 'app-123', VERSION: '1.3.1' },
      icons: { color: new Uint8Array([1]), outline: new Uint8Array([2]) },
      externalId: 'external-abc',
    }),
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        waits.push(ms);
        fn();
        return 0 as never;
      },
      clearTimeout: () => undefined,
    } as never,
    botProbeDelayMs: 25,
    ...(opts.attempts !== undefined ? { botProbeAttempts: opts.attempts } : {}),
    syncBotConfig: async (identity: TeamsIdentityJobRecord) => {
      synced.push(identity.state);
      return { status: 'synced' as const };
    },
    events: {
      clearForAgent: async () => undefined,
      record: async (e: { step: string; status: string; detail?: string | null }) => {
        events.push(`${e.step}/${e.status}${e.detail ? `/${e.detail}` : ''}`);
      },
    } as never,
    log: (m: string) => logs.push(m),
  } as never);
  const run = () => runner.enqueue({ agentId: 'agent-1', teamId: 'team-42' });
  return { run, calls, logs, events, waits, synced, row: () => row };
}

const REJECTED: TeamsBotProbeResult = {
  status: 'rejected',
  httpStatus: 401,
  detail: 'Authorization has been denied for this request.',
};

describe('the bot is probed before an identity becomes installed (#2043 D10)', () => {
  it('a known bot: installed, probed once, after the install', async () => {
    const h = setup({});
    const result = await h.run();
    assert.equal(result.status, 'installed');
    assert.deepEqual(h.calls, ['install', 'probe:app-123']);
    assert.ok(h.events.includes('installed/progress/verifying_bot'));
    assert.equal(h.row().state, 'installed');
  });

  it('the rollout case: the Bot Connector rejects the bot, so the run FAILS with its own code and never says installed', async () => {
    const h = setup({ probe: async () => REJECTED, attempts: 3 });
    const result = await h.run();
    assert.equal(result.status, 'failed');
    assert.equal((result as { reason?: string }).reason, 'bot_rejected');
    assert.equal(h.row().state, 'failed');
    assert.equal(h.row().errorCode, 'bot_rejected');
    assert.match(h.row().lastError ?? '', /^bot_rejected: the Bot Connector does not accept this bot/);
    assert.match(h.row().lastError ?? '', /Delete this Teams identity completely and provision it again/);
    assert.match(h.row().lastError ?? '', /Reported: Authorization has been denied for this request\.$/);
    assert.equal(h.calls.filter((c) => c.startsWith('probe')).length, 3, 'asked again within the bound');
    assert.deepEqual(h.waits.filter((ms) => ms === 25), [25, 25]);
    assert.ok(!h.events.some((e) => e === 'installed/succeeded/team'), 'the install step is not reported as done');
    // The bot's config entry was written before the install (D6) and is not
    // written again as "finished".
    assert.deepEqual(h.synced, ['catalog_uploaded']);
  });

  it('a bot that needs a moment: rejected first, known on the second probe, installed', async () => {
    let n = 0;
    const h = setup({ probe: async () => (++n === 1 ? REJECTED : { status: 'known' }) });
    const result = await h.run();
    assert.equal(result.status, 'installed');
    assert.equal(n, 2);
  });

  it('a question that could not be asked does not block: unverified, or a throwing probe', async () => {
    const unverified = setup({ probe: async () => ({ status: 'unverified', detail: 'token endpoint unreachable' }) });
    assert.equal((await unverified.run()).status, 'installed');
    assert.match(unverified.logs.join('\n'), /could not be verified against the Bot Connector \(token endpoint unreachable\)/);
    const throwing = setup({
      probe: async () => {
        throw new Error('socket hang up');
      },
    });
    assert.equal((await throwing.run()).status, 'installed');
  });

  it('an older connector without probeBot: installed as before, and the log says the bot was not verified', async () => {
    const h = setup({ probe: null });
    const result = await h.run();
    assert.equal(result.status, 'installed');
    assert.match(h.logs.join('\n'), /bot not verified against the Bot Connector: the installed connector publishes no probeBot/);
  });

  it('"run provisioning again" on an installed identity finds a dead bot (Mara, 26 minutes later)', async () => {
    const h = setup({
      probe: async () => REJECTED,
      attempts: 1,
      row: {
        state: 'installed',
        appId: 'app-123',
        tenantId: 'tenant-9',
        teamsAppId: 'catalog-77',
        teamsAppExternalId: 'external-abc',
      },
    });
    const result = await h.run();
    assert.equal(result.status, 'failed');
    assert.equal(h.row().state, 'failed');
    assert.equal(h.row().errorCode, 'bot_rejected');
    assert.deepEqual(h.calls, ['probe:app-123'], 'nothing else was repeated');
  });

  it('the sentence round-trips through the classifier for rows without the code column', () => {
    const failure = botRejectedFailure('401');
    assert.equal(failure.errorCode, 'bot_rejected');
    assert.equal(classifyTeamsProvisioningError(failure.lastError).code, 'bot_rejected');
  });
});
