/**
 * Environment variables that seed boot-managed plugin config (ADR-0193, #1858).
 *
 * The rule: an environment variable writes its plugin config key only when it
 * is SET. A value the boot wrote stays boot-owned, so it follows the variable
 * on every later boot (changed, or removed when the variable is unset). Once
 * the operator edits the value in the plugin settings it is theirs: the boot
 * never touches it again, and a set variable it shadows is logged.
 *
 * Ownership is recorded in a hidden config key (`ENV_SEEDED_MARKER_KEY`) that
 * holds the values the boot wrote, JSON-encoded. A key counts as boot-owned
 * while its stored value equals the recorded one. Entries written before the
 * marker existed (the old migration wrote every key, set or not) count as
 * boot-owned when they still hold the built-in default.
 */

export const ENV_SEEDED_MARKER_KEY = '_env_seeded';

export interface EnvSeed {
  /** Environment variable name, e.g. `GRAPH_EMBEDDING_BACKFILL_BATCH_SIZE`. */
  readonly envName: string;
  /** Plugin config key it seeds. */
  readonly configKey: string;
  /** The validated value from `Config`, as the string the plugin reads. */
  readonly value: string;
  /** Built-in default, as written by builds before the marker existed. */
  readonly legacyDefault: string;
}

export interface EnvSeedResult {
  /** The new config, or `null` when nothing changed. */
  readonly config: Record<string, unknown> | null;
  /** Operator values that shadow a set variable (one log line each). */
  readonly shadowed: ReadonlyArray<{
    readonly envName: string;
    readonly configKey: string;
    readonly stored: string;
    readonly envValue: string;
  }>;
}

function readMarker(config: Record<string, unknown>): Record<string, string> | null {
  const raw = config[ENV_SEEDED_MARKER_KEY];
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    // A corrupt marker owns nothing: every stored value is the operator's.
    return {};
  }
}

function isEnvSet(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  return v !== undefined && v.trim() !== '';
}

/**
 * Apply the seeding rule to one plugin's config. Pure: returns the new config
 * (or `null` when unchanged) plus the shadowed variables to log.
 */
export function applyEnvSeeds(
  current: Readonly<Record<string, unknown>>,
  seeds: ReadonlyArray<EnvSeed>,
  env: NodeJS.ProcessEnv,
): EnvSeedResult {
  const config: Record<string, unknown> = { ...current };
  const priorMarker = readMarker(config);
  const marker: Record<string, string> = { ...(priorMarker ?? {}) };
  const shadowed: Array<EnvSeedResult['shadowed'][number]> = [];

  for (const seed of seeds) {
    const storedRaw = config[seed.configKey];
    const stored = storedRaw === undefined ? undefined : String(storedRaw);
    const recorded = marker[seed.configKey];
    const bootOwned =
      stored === undefined ||
      (recorded !== undefined && stored === recorded) ||
      (priorMarker === null && stored === seed.legacyDefault);

    if (isEnvSet(env, seed.envName)) {
      if (bootOwned) {
        config[seed.configKey] = seed.value;
        marker[seed.configKey] = seed.value;
      } else if (stored !== seed.value) {
        shadowed.push({
          envName: seed.envName,
          configKey: seed.configKey,
          stored: stored ?? '',
          envValue: seed.value,
        });
      }
      continue;
    }
    // Variable unset: a boot-owned value goes, so the plugin's own default
    // applies; an operator value stays.
    if (bootOwned) {
      delete config[seed.configKey];
      delete marker[seed.configKey];
    }
  }

  config[ENV_SEEDED_MARKER_KEY] = JSON.stringify(marker);
  const changed = JSON.stringify(sortedEntries(config)) !==
    JSON.stringify(sortedEntries(current));
  return { config: changed ? config : null, shadowed };
}

function sortedEntries(o: Readonly<Record<string, unknown>>): Array<[string, unknown]> {
  return Object.entries(o).sort(([a], [b]) => a.localeCompare(b));
}
