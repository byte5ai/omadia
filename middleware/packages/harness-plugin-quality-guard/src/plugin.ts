import {
  RESPONSE_GUARD_SERVICE_NAME,
  type PluginContext,
  type ProfileQualityConfig,
  type ResponseGuardRequest,
  type ResponseGuardResult,
  type ResponseGuardService,
  type SycophancyLevel,
} from '@omadia/plugin-api';

import {
  BOUNDARY_SECTION_HEADING,
  expandPresets,
} from './boundaryPresets.js';
import {
  AgentOverridesMapSchema,
  ProfileQualityConfigSchema,
  SycophancyLevelSchema,
  type AgentOverridesMap,
} from './configSchema.js';
import {
  SYCOPHANCY_SECTION_HEADING,
  rulesForSycophancy,
} from './sycophancyGuard.js';

/**
 * @omadia/plugin-quality-guard — plugin entry point.
 *
 * Activation wiring:
 *   1. Read default sycophancy + boundaries from `ctx.config`.
 *   2. Read the optional per-agent sycophancy override map (JSON string).
 *   3. Build the {@link ResponseGuardService} and publish it as
 *      `responseGuard@1` for the orchestrator hook to consume.
 *
 * The plugin holds no state across turns: every `getRules` call resolves
 * its inputs, formats a string block, returns. That keeps the surface
 * trivially testable and side-effect-free.
 */

export interface QualityGuardPluginHandle {
  close(): Promise<void>;
}

export async function activate(
  ctx: PluginContext,
): Promise<QualityGuardPluginHandle> {
  ctx.log('[quality-guard] activating');

  const defaults = readDefaultsFromConfig(ctx);
  const agentOverrides = readAgentOverridesFromConfig(ctx);

  const service = createResponseGuardService({
    defaults,
    agentOverrides,
  });

  const disposeService = ctx.services.provide<ResponseGuardService>(
    RESPONSE_GUARD_SERVICE_NAME,
    service,
  );

  ctx.log(
    `[quality-guard] ready (default sycophancy=${defaults.sycophancy}, ` +
      `default presets=${defaults.boundaries.presets.length}, ` +
      `default customs=${defaults.boundaries.custom.length}, ` +
      `agent overrides=${Object.keys(agentOverrides).length})`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('[quality-guard] deactivating');
      disposeService();
    },
  };
}

// ---------------------------------------------------------------------------
// Service factory — pure function so tests can construct without ctx.
// ---------------------------------------------------------------------------

interface ResolvedDefaults {
  sycophancy: SycophancyLevel;
  boundaries: {
    presets: readonly string[];
    custom: readonly string[];
  };
}

interface ServiceDeps {
  defaults: ResolvedDefaults;
  agentOverrides: AgentOverridesMap;
}

export function createResponseGuardService(
  deps: ServiceDeps,
): ResponseGuardService {
  return {
    getRules(
      input: ResponseGuardRequest,
    ): Promise<ResponseGuardResult> {
      const resolved = resolveProfileQuality(input, deps);
      const prependRules = formatRulesBlock(resolved);
      return Promise.resolve({ prependRules });
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution — profile-quality (per turn) overrides agent_overrides
// (per agentId) overrides plugin defaults (per install).
// ---------------------------------------------------------------------------

function resolveProfileQuality(
  input: ResponseGuardRequest,
  deps: ServiceDeps,
): ResolvedDefaults {
  const profile = input.profileQuality;
  const agentOverride =
    input.agentId !== undefined
      ? deps.agentOverrides[input.agentId]
      : undefined;

  const sycophancy: SycophancyLevel =
    profile?.sycophancy ?? agentOverride ?? deps.defaults.sycophancy;

  const presets =
    profile?.boundaries?.presets ?? deps.defaults.boundaries.presets;
  const custom =
    profile?.boundaries?.custom ?? deps.defaults.boundaries.custom;

  return {
    sycophancy,
    boundaries: { presets, custom },
  };
}

/**
 * Format the rules into a single string block. Empty when no rules apply
 * (sycophancy=off + no boundaries). The orchestrator hook checks for the
 * empty-string case and skips the splice so the cache shape stays stable
 * for guard-free turns.
 */
export function formatRulesBlock(resolved: ResolvedDefaults): string {
  const sycophancyRules = rulesForSycophancy(resolved.sycophancy);
  const boundaryRules = expandPresets(resolved.boundaries.presets);
  const customRules = resolved.boundaries.custom.filter(
    (s) => s.trim().length > 0,
  );

  const sections: string[] = [];
  if (sycophancyRules.length > 0) {
    sections.push(
      SYCOPHANCY_SECTION_HEADING +
        '\n' +
        sycophancyRules.map((r) => `- ${r}`).join('\n'),
    );
  }
  const allBoundaries = [...boundaryRules, ...customRules];
  if (allBoundaries.length > 0) {
    sections.push(
      BOUNDARY_SECTION_HEADING +
        '\n' +
        allBoundaries.map((r) => `- ${r}`).join('\n'),
    );
  }
  return sections.join('\n\n');
}

// ---------------------------------------------------------------------------
// Config readers — tolerate missing/malformed inputs gracefully so a
// half-configured plugin still boots with sane defaults rather than
// blocking activate.
// ---------------------------------------------------------------------------

const DEFAULT_SYCOPHANCY: SycophancyLevel = 'medium';

function readDefaultsFromConfig(ctx: PluginContext): ResolvedDefaults {
  const rawSyc = ctx.config.get<unknown>('default_sycophancy');
  const sycophancy = parseSycophancyOrDefault(rawSyc, DEFAULT_SYCOPHANCY);

  const rawPresets = ctx.config.get<unknown>('default_boundary_presets');
  const presets = parseCsvList(rawPresets);

  const rawCustom = ctx.config.get<unknown>('default_boundary_custom');
  const custom = parseLineList(rawCustom);

  return {
    sycophancy,
    boundaries: { presets, custom },
  };
}

function readAgentOverridesFromConfig(ctx: PluginContext): AgentOverridesMap {
  const raw = ctx.config.get<unknown>('agent_overrides');
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') return {};
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    ctx.log(
      '[quality-guard] config.agent_overrides is not valid JSON — ignoring',
    );
    return {};
  }
  const result = AgentOverridesMapSchema.safeParse(parsed);
  if (!result.success) {
    ctx.log(
      `[quality-guard] config.agent_overrides failed schema validation: ${result.error.message} — ignoring`,
    );
    return {};
  }
  return result.data;
}

function parseSycophancyOrDefault(
  raw: unknown,
  fallback: SycophancyLevel,
): SycophancyLevel {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return fallback;
  const result = SycophancyLevelSchema.safeParse(trimmed);
  return result.success ? result.data : fallback;
}

function parseCsvList(raw: unknown): readonly string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseLineList(raw: unknown): readonly string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Public helper: validate an arbitrary input against the
 * `ProfileQualityConfig` shape. Used by the Builder-side `set_quality_config`
 * tool (Phase 1 Aufgabe 5) to reject malformed payloads BEFORE they touch
 * the draft. Re-exported through the plugin's public surface.
 */
export function parseProfileQualityConfig(
  raw: unknown,
): ProfileQualityConfig {
  return ProfileQualityConfigSchema.parse(raw) as ProfileQualityConfig;
}
