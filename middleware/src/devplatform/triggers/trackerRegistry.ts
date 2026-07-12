/**
 * Epic #470 W3 — the tracker capability seam (spec §4 tracker note).
 *
 * A repo's issue tracker is resolved through ONE narrow seam so a future plugin
 * (Jira, Linear, …) can contribute a `DevPlatformTracker` for the repos it is
 * bound to, exactly like the #459 `serviceRegistry.provide` capability pattern:
 * the plugin PROVIDES a tracker factory keyed on a `tracker_kind`; the host
 * CONSUMES it here without knowing the concrete client.
 *
 * Resolution order (`resolveTrackerForRepo`):
 *   1. A plugin-contributed tracker whose `tracker_kind` matches `repo.trackerKind`.
 *   2. Otherwise the built-in GitHub Issues tracker, for `github_app` repos only.
 *   3. Otherwise `null` — the repo has no tracker binding (the poller skips it).
 *
 * This unit builds ONLY the seam and the built-in wiring. No Jira client lives
 * here — that ships as a separate plugin that calls `registerTracker(...)`. Until
 * such a plugin is installed, `registerTracker` is the documented binding point
 * and the map is simply empty (built-in GitHub resolution still works).
 */

import { GithubIssuesTracker, type IssuesFetch } from '../githubIssuesTracker.js';
import type { DevPlatformTracker } from '../../routes/devPlatformShared.js';
import type { DevRepo } from '../types.js';

/** A plugin's tracker factory: given a bound repo, hand back a `DevPlatformTracker`.
 *  The plugin resolves its OWN credentials (via its plugin context), so the host
 *  passes only the repo. */
export type PluginTrackerFactory = (repo: DevRepo) => DevPlatformTracker;

export interface TrackerRegistryDeps {
  /** Build the built-in GitHub Issues tracker for a `github_app` repo, resolving
   *  its token. Returns `null` when the credential cannot be resolved (so the
   *  poller treats the repo as having no tracker rather than crashing). */
  makeGithubTracker: (repo: DevRepo) => Promise<DevPlatformTracker | null>;
}

/**
 * The kernel-wide registry of repo trackers. One instance is wired at boot and
 * handed to the tracker poller; plugins call `registerTracker` during their own
 * boot to contribute a tracker for a `tracker_kind`.
 */
export class TrackerRegistry {
  private readonly plugins = new Map<string, PluginTrackerFactory>();

  constructor(private readonly deps: TrackerRegistryDeps) {}

  /**
   * Bind a plugin tracker to a `tracker_kind`. Returns an unregister thunk (so a
   * plugin can withdraw its provider cleanly on unload), mirroring
   * `serviceRegistry.provide`'s disposer contract.
   */
  registerTracker(trackerKind: string, factory: PluginTrackerFactory): () => void {
    this.plugins.set(trackerKind, factory);
    return () => {
      if (this.plugins.get(trackerKind) === factory) this.plugins.delete(trackerKind);
    };
  }

  /** True iff a plugin tracker is bound to `trackerKind`. */
  hasPluginTracker(trackerKind: string): boolean {
    return this.plugins.has(trackerKind);
  }

  /**
   * Resolve the tracker for a repo. A plugin binding wins over the built-in (a
   * repo that explicitly configured `tracker_kind='jira'` wants Jira, even on a
   * `github_app` clone credential). `null` = no tracker bound.
   */
  async resolveTrackerForRepo(repo: DevRepo): Promise<DevPlatformTracker | null> {
    const kind = repo.trackerKind;
    if (kind) {
      const plugin = this.plugins.get(kind);
      if (plugin) return plugin(repo);
    }
    if (repo.credentialKind === 'github_app') return this.deps.makeGithubTracker(repo);
    return null;
  }
}

/**
 * Default `makeGithubTracker` builder: adapt the repo-bound `GithubIssuesTracker`
 * to the `DevPlatformTracker` seam (binding `{owner, name}` so callers pass only
 * an issue number / list opts). Mirrors `wireDevPlatform.makeIssuesTrackerFactory`
 * but is repo-keyed and resolves the token lazily (Vault). The boot wiring passes
 * this into `TrackerRegistry`.
 */
export function makeGithubTrackerBuilder(opts: {
  resolveToken: (repo: DevRepo) => Promise<string | undefined>;
  apiBaseUrl?: string;
  fetchImpl?: IssuesFetch;
}): (repo: DevRepo) => Promise<DevPlatformTracker | null> {
  return async (repo) => {
    const token = await opts.resolveToken(repo);
    if (!token) return null;
    const tracker = new GithubIssuesTracker({
      token,
      apiBaseUrl: opts.apiBaseUrl,
      fetchImpl: opts.fetchImpl,
    });
    const bound = { owner: repo.owner, name: repo.name };
    return {
      getTicket: (issueNumber) => tracker.getTicket(bound, issueNumber),
      listOpenTickets: (listOpts) => tracker.listOpenTickets(bound, listOpts),
    };
  };
}
