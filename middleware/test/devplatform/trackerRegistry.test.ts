import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  TrackerRegistry,
  makeGithubTrackerBuilder,
  type PluginTrackerFactory,
} from '../../src/devplatform/triggers/trackerRegistry.js';
import type { IssuesFetch } from '../../src/devplatform/githubIssuesTracker.js';
import type { DevPlatformTracker } from '../../src/routes/devPlatformShared.js';
import type { DevRepo } from '../../src/devplatform/types.js';

/**
 * Epic #470 W3 — the tracker capability seam. Pure unit (no pg): the seam resolves
 * the built-in GitHub Issues tracker for a `github_app` repo and a plugin-
 * contributed tracker where one is bound, and returns null otherwise.
 */

function makeRepo(overrides: Partial<DevRepo> = {}): DevRepo {
  return {
    id: 'repo-1',
    forgeKind: 'github',
    owner: 'byte5ai',
    name: 'omadia',
    cloneUrl: 'https://example.com/x/y.git',
    defaultBranch: 'main',
    credentialKind: 'pat',
    credentialRef: 'repo/repo-1',
    trackerKind: null,
    trackerConfig: {},
    allowedTriggers: ['admin', 'tracker'],
    allowedLaunchers: [],
    egressAllowlist: [],
    runsTests: false,
    branchProtectionOk: null,
    branchProtectionCheckedAt: null,
    approverRoleKey: null,
    gateDeadlineIso: 'P7D',
    bootstrapCommand: null,
    testCommand: null,
    policyOverrides: {} as DevRepo['policyOverrides'],
    triggerLabel: 'omadia-dev',
    webhookEnabled: true,
    webhookSenders: [],
    createdBy: 'op',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A fetch double returning one open issue, so the built-in tracker parses it. */
const githubFetch: IssuesFetch = (_url, _init) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve([
        {
          number: 5,
          title: 'A bug',
          body: 'broken',
          labels: [{ name: 'omadia-dev' }],
          html_url: 'https://github.com/byte5ai/omadia/issues/5',
          user: { login: 'alice' },
          updated_at: '2026-05-01T00:00:00Z',
        },
      ]),
  });

function githubBuilder(): (repo: DevRepo) => Promise<DevPlatformTracker | null> {
  return makeGithubTrackerBuilder({
    resolveToken: async () => 'gha-token',
    fetchImpl: githubFetch,
  });
}

describe('devplatform/trackerRegistry (W3 seam)', () => {
  it('resolves the built-in GitHub Issues tracker for a github_app repo', async () => {
    // FAIL-IF-REVERTED: drop the github_app branch and this returns null instead of
    // a working tracker whose listOpenTickets parses the GitHub issues payload.
    const registry = new TrackerRegistry({ makeGithubTracker: githubBuilder() });
    const repo = makeRepo({ credentialKind: 'github_app', trackerKind: null });

    const tracker = await registry.resolveTrackerForRepo(repo);
    assert.ok(tracker, 'expected a tracker for a github_app repo');

    const tickets = await tracker.listOpenTickets({ limit: 10, label: 'omadia-dev' });
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0]!.number, 5);
    assert.equal(tickets[0]!.updatedAt, '2026-05-01T00:00:00Z');
  });

  it('resolves a plugin-contributed tracker where one is bound', async () => {
    // FAIL-IF-REVERTED: without the plugin-precedence branch the repo's trackerKind
    // is ignored and the jira tracker is never returned.
    const registry = new TrackerRegistry({ makeGithubTracker: githubBuilder() });
    const jira: DevPlatformTracker = {
      getTicket: async () => {
        throw new Error('unused');
      },
      listOpenTickets: async () => [
        {
          number: 42,
          title: 'JIRA-42',
          body: 'from jira',
          labels: ['omadia-dev'],
          htmlUrl: '',
          authorLogin: 'bob',
          updatedAt: '2026-06-01T00:00:00Z',
        },
      ],
    };
    const factory: PluginTrackerFactory = () => jira;
    registry.registerTracker('jira', factory);

    const repo = makeRepo({ credentialKind: 'pat', trackerKind: 'jira' });
    const resolved = await registry.resolveTrackerForRepo(repo);
    assert.equal(resolved, jira, 'expected the exact plugin tracker instance');
  });

  it('lets a plugin binding win over the built-in for a github_app repo', async () => {
    const registry = new TrackerRegistry({ makeGithubTracker: githubBuilder() });
    const jira: DevPlatformTracker = {
      getTicket: async () => {
        throw new Error('unused');
      },
      listOpenTickets: async () => [],
    };
    registry.registerTracker('jira', () => jira);

    // github_app AND an explicit jira binding: the operator configured jira, so jira wins.
    const repo = makeRepo({ credentialKind: 'github_app', trackerKind: 'jira' });
    assert.equal(await registry.resolveTrackerForRepo(repo), jira);
  });

  it('returns null when no tracker is bound', async () => {
    const registry = new TrackerRegistry({ makeGithubTracker: githubBuilder() });
    // device_flow, no trackerKind: neither the built-in nor a plugin applies.
    const repo = makeRepo({ credentialKind: 'device_flow', trackerKind: null });
    assert.equal(await registry.resolveTrackerForRepo(repo), null);
  });

  it('unregister thunk withdraws the plugin tracker', async () => {
    const registry = new TrackerRegistry({ makeGithubTracker: githubBuilder() });
    const jira: DevPlatformTracker = {
      getTicket: async () => {
        throw new Error('unused');
      },
      listOpenTickets: async () => [],
    };
    const off = registry.registerTracker('jira', () => jira);
    const repo = makeRepo({ credentialKind: 'pat', trackerKind: 'jira' });
    assert.equal(await registry.resolveTrackerForRepo(repo), jira);

    off();
    assert.equal(registry.hasPluginTracker('jira'), false);
    // pat repo with an unregistered kind now has no tracker at all.
    assert.equal(await registry.resolveTrackerForRepo(repo), null);
  });
});
