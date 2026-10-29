import type { PluginRouteRegistry } from './pluginRouteRegistry.js';
import type { PublicPathGrantRegistry } from './publicPathGrants.js';
import type { PublicPathGrantStore } from './publicPathGrantStore.js';

/**
 * Epic #470 C4 / H1 — claim a plugin's manifest-declared public-path prefixes,
 * AFTER its `activate()` ran.
 *
 * Shared by every runtime that activates plugins: the tool runtime, the
 * dynamic-agent runtime (Builder-generated agents) and the channel registry
 * (Teams, …). Until S3-G only the tool runtime claimed, so a channel or agent
 * plugin's `auth:'custom'` route behind a GRANTED declaration was never served:
 * the public-path mount only dispatches to claimed prefixes, the request fell
 * through and answered 404. That stayed invisible while `/p/` was a static
 * public path; #1596 removed it and Teams tabs broke.
 *
 * AFTER activate(), deliberately: "a plugin may only make public something it
 * actually serves" needs the prefixes the plugin registered, and those only
 * exist once activate() has run.
 *
 * Throws `PublicPathClaimError` on a rejected claim (conflict, invalid
 * declaration). The caller owns the rollback — it alone knows what it set up —
 * and must call `grants.releaseBySource(agentId)` on deactivate.
 */
export interface PublicPathClaimDeps {
  readonly grants: PublicPathGrantRegistry;
  readonly store?: PublicPathGrantStore;
  readonly corePublicPaths?: readonly RegExp[];
  readonly routeRegistry: PluginRouteRegistry;
  readonly log: (message: string) => void;
  /** Log tag, e.g. `tool-runtime` or `channels`. */
  readonly tag: string;
}

export async function claimDeclaredPublicPaths(
  agentId: string,
  declared: readonly string[],
  deps: PublicPathClaimDeps,
): Promise<void> {
  if (declared.length === 0) return;
  const granted =
    (await deps.store?.listForPlugin(agentId)) ?? new Set<string>();
  const { unserved } = deps.grants.claim(agentId, declared, {
    corePublicPaths: deps.corePublicPaths ?? [],
    ownRoutePrefixes: [
      ...new Set(
        deps.routeRegistry
          .list()
          .filter((r) => r.source === agentId && !r.disposed)
          .map((r) => r.prefix),
      ),
    ],
    grantedPrefixes: granted,
  });
  const ungranted = declared.filter((p) => !granted.has(p));
  // Epic #470 C16 (#817) — name the remedy, not just the state. An ungranted
  // prefix is NOT an activation failure: the claim holds (nobody else can take
  // the prefix) and the route stays behind the session gate.
  deps.log(
    `[${deps.tag}] public paths for ${agentId}: ${String(granted.size)} granted, ` +
      `${String(ungranted.length)} declared-but-awaiting-consent` +
      (ungranted.length > 0
        ? ` (${ungranted.join(', ')}) — these prefixes stay behind requireAuth until an operator consents ` +
          `in the admin UI under Plugins → ${agentId} → Permissions, or with ` +
          `PUT /api/v1/admin/runtime/installed/${encodeURIComponent(agentId)}/grants`
        : ''),
  );
  // #1465 — declared, ungranted, and no router registered under it (a feature
  // switched off). Not a failure; granting it would be.
  if (unserved.length > 0) {
    deps.log(
      `[${deps.tag}] ${agentId} registered no router under ${unserved.join(', ')} — ` +
        'the declared prefix serves nothing in this configuration and stays behind requireAuth; a grant for it is only valid once the plugin serves it',
    );
  }
}
