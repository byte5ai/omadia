import type { TeamsSsoAudience } from '../auth/teamsSsoVerifier.js';
import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import {
  CHANNEL_TEAMS_PLUGIN_ID,
  readTeamsBotsConfig,
  TEAMS_BOTS_CONFIG_KEY,
} from '../services/teamsBotsConfigSync.js';

/**
 * Which Teams SSO audiences the kernel accepts for `auth: 'teams-sso'`
 * routes (#1620): the bots of the INSTALLED, ACTIVE `@omadia/channel-teams`.
 *
 * Mirrors how channel-teams itself assembles its bots in `activate()`:
 *
 *   - every `teams_bots[]` entry with an `appId` and a `tenantId`;
 *   - plus the legacy scalar bot `microsoft_app_id` / `microsoft_tenant_id`,
 *     resolved along channel-teams' config chain (its own config first, then
 *     its `depends_on` ancestors — in practice the Microsoft 365 integration).
 *
 * No active channel-teams → no audiences → every Teams SSO token is refused.
 * That is the fail-closed reading of "audience = an installed bot": a token
 * minted for a bot this deployment no longer runs opens nothing.
 *
 * Read per verification, from in-memory registry state, so a bot that is
 * provisioned or removed at runtime takes effect on the next request.
 */
export interface TeamsSsoAudienceSourceDeps {
  readonly registry: () => InstalledRegistry | undefined;
  /** channel-teams' config resolution chain, own id first. */
  readonly configChain: (pluginId: string) => readonly string[];
  /** Override for tests; defaults to `@omadia/channel-teams`. */
  readonly pluginId?: string;
}

const LEGACY_APP_ID_KEY = 'microsoft_app_id';
const LEGACY_TENANT_ID_KEY = 'microsoft_tenant_id';

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function createTeamsSsoAudienceSource(
  deps: TeamsSsoAudienceSourceDeps,
): () => readonly TeamsSsoAudience[] {
  const pluginId = deps.pluginId ?? CHANNEL_TEAMS_PLUGIN_ID;
  return () => {
    const registry = deps.registry();
    const channel = registry?.get(pluginId);
    if (!registry || !channel || channel.status !== 'active') return [];

    const audiences: TeamsSsoAudience[] = [];
    const add = (appId: unknown, tenantId: unknown): void => {
      const app = trimmedString(appId);
      const tenant = trimmedString(tenantId);
      if (!app || !tenant) return;
      const duplicate = audiences.some(
        (a) =>
          a.appId.toLowerCase() === app.toLowerCase() &&
          a.tenantId.toLowerCase() === tenant.toLowerCase(),
      );
      if (!duplicate) audiences.push({ appId: app, tenantId: tenant });
    };

    try {
      for (const entry of readTeamsBotsConfig(
        channel.config[TEAMS_BOTS_CONFIG_KEY],
      ).entries) {
        add(entry['appId'], entry['tenantId']);
      }
    } catch {
      // An unreadable `teams_bots` value means channel-teams cannot have
      // activated with it either; contribute nothing from it.
    }

    const lookup = (key: string): unknown => {
      for (const id of deps.configChain(pluginId)) {
        const value = registry.get(id)?.config[key];
        if (value !== undefined) return value;
      }
      return undefined;
    };
    add(lookup(LEGACY_APP_ID_KEY), lookup(LEGACY_TENANT_ID_KEY));

    return audiences;
  };
}
