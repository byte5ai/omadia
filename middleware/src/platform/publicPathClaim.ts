import type { PluginRouteRegistry } from './pluginRouteRegistry.js';
import type { PublicPathGrantRegistry } from './publicPathGrants.js';
import type { PublicPathGrantStore } from './publicPathGrantStore.js';

/** What every plugin runtime needs to claim a plugin's declared public paths. */
export interface PublicPathClaimDeps {
  readonly publicPathGrants?: PublicPathGrantRegistry;
  readonly publicPathGrantStore?: PublicPathGrantStore;
  readonly corePublicPaths?: readonly RegExp[];
  readonly pluginRouteRegistry: Pick<PluginRouteRegistry, 'list'>;
}

/**
 * Epic #470 C4 / H1 — claim the `permissions.public_paths` a plugin declared,
 * AFTER its `activate()` ran (the routers it registered are the ones a claim
 * may cover). Shared by every runtime that activates plugins: the tool
 * runtime, the channel registry and the agent runtime.
 *
 * #1596 follow-up — only the tool runtime used to claim. A channel or agent
 * plugin's `auth: 'custom'` route was therefore never served, granted or not:
 * the public-path mount found no owner and the route is never mounted
 * ambiently. The static `/p/` exemption hid that for channel-teams' Teams tab
 * pages until #1596 removed it.
 *
 * Throws `PublicPathClaimError` on a conflicting declaration; the caller rolls
 * the activation back. An ungranted prefix is NOT a failure: the claim holds
 * and the route stays unserved until the operator consents.
 */
export async function claimDeclaredPublicPaths(
  agentId: string,
  declared: readonly unknown[],
  deps: PublicPathClaimDeps,
  log: (msg: string) => void,
  tag: string,
): Promise<void> {
  if (!deps.publicPathGrants || declared.length === 0) return;
  const granted =
    (await deps.publicPathGrantStore?.listForPlugin(agentId)) ?? new Set<string>();
  const { unserved } = deps.publicPathGrants.claim(agentId, declared, {
    corePublicPaths: deps.corePublicPaths ?? [],
    ownRoutePrefixes: [
      ...new Set(
        deps.pluginRouteRegistry
          .list()
          .filter((r) => r.source === agentId && !r.disposed)
          .map((r) => r.prefix),
      ),
    ],
    grantedPrefixes: granted,
  });
  const ungranted = declared.filter((p) => typeof p !== 'string' || !granted.has(p));
  // Epic #470 C16 (#817) — name the remedy, not just the state.
  log(
    `[${tag}] public paths for ${agentId}: ${String(granted.size)} granted, ` +
      `${String(ungranted.length)} declared-but-awaiting-consent` +
      (ungranted.length > 0
        ? ` (${ungranted.join(', ')}) — these prefixes stay behind requireAuth until an operator consents ` +
          `in the admin UI under Plugins → ${agentId} → Permissions, or with ` +
          `PUT /api/v1/admin/runtime/installed/${encodeURIComponent(agentId)}/grants`
        : ''),
  );
  // #1465 — declared, ungranted, and no router registered under it.
  if (unserved.length > 0) {
    log(
      `[${tag}] ${agentId} registered no router under ${unserved.join(', ')} — ` +
        'the declared prefix serves nothing in this configuration and stays behind requireAuth; a grant for it is only valid once the plugin serves it',
    );
  }
}
