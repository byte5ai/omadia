/**
 * #1569 — an agent's own response-quality settings (`agent_identities.quality`,
 * the agent editor's "Boundaries" tab / AGENT.md `quality:` frontmatter) and
 * how they reach the `responseGuard@1` provider (the Quality Guard plugin).
 *
 * The orchestrator used to call the guard with neither the agent id nor these
 * settings, so the plugin's `agent_overrides` and the agent's own level were
 * ignored and every agent got the plugin default.
 */
import type { ProfileQualityConfig, SycophancyLevel } from '@omadia/plugin-api';

const SYCOPHANCY_LEVELS: ReadonlySet<string> = new Set(['off', 'low', 'medium', 'high']);

function stringList(raw: unknown): string[] | undefined {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : undefined;
}

/**
 * Narrow the persisted JSONB to the contract shape. Anything unrecognised is
 * dropped field by field, never cast: a hand-edited or newer row must not turn
 * into a level the guard does not know. `undefined` when nothing usable is set.
 */
export function parseAgentQuality(raw: unknown): ProfileQualityConfig | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const sycophancy =
    typeof record.sycophancy === 'string' && SYCOPHANCY_LEVELS.has(record.sycophancy)
      ? (record.sycophancy as SycophancyLevel)
      : undefined;
  const rawBoundaries =
    record.boundaries !== null && typeof record.boundaries === 'object'
      ? (record.boundaries as Record<string, unknown>)
      : undefined;
  const presets = stringList(rawBoundaries?.presets);
  const custom = stringList(rawBoundaries?.custom);
  const boundaries =
    presets !== undefined || custom !== undefined
      ? { ...(presets ? { presets } : {}), ...(custom ? { custom } : {}) }
      : undefined;
  if (sycophancy === undefined && boundaries === undefined) return undefined;
  return { ...(sycophancy ? { sycophancy } : {}), ...(boundaries ? { boundaries } : {}) };
}

/**
 * What the orchestrator hands the guard as `profileQuality` for an agent.
 *
 * The precedence the plugin documents is: the agent's own setting, then the
 * plugin's `agent_overrides` entry for the agent, then the plugin default. The
 * agent's own setting is already compiled into its system prompt
 * (`composeAgentIdentityPrompt`: "## Anti-Sycophancy Protocol …", boundaries),
 * so the guard must not add a SECOND block for a field the agent set — that is
 * the two blocks of different strength #1570 showed. For each field the agent
 * set, the guard is told "nothing from you" (`off` / no boundaries); a field
 * the agent left open falls through to `agent_overrides` and the default.
 *
 * `undefined` when the agent set nothing: the guard then resolves from
 * `agent_overrides` and its default alone.
 */
export function responseGuardProfileFor(
  quality: ProfileQualityConfig | undefined,
): ProfileQualityConfig | undefined {
  if (quality === undefined) return undefined;
  const ownSycophancy = quality.sycophancy !== undefined;
  const ownBoundaries =
    (quality.boundaries?.presets?.length ?? 0) > 0 ||
    (quality.boundaries?.custom?.some((line) => line.trim().length > 0) ?? false);
  if (!ownSycophancy && !ownBoundaries) return undefined;
  return {
    ...(ownSycophancy ? { sycophancy: 'off' as const } : {}),
    ...(ownBoundaries ? { boundaries: { presets: [], custom: [] } } : {}),
  };
}
