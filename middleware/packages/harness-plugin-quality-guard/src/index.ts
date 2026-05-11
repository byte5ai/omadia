/**
 * Public surface of `@omadia/plugin-quality-guard`.
 *
 * Plugin entry-point lives in `./plugin.js` (`activate`) — that one is
 * loaded by the kernel via `manifest.lifecycle.entry`. Re-exports here are
 * for programmatic consumers (tests, Builder-side `set_quality_config`,
 * future persona plugin) that want strong types and helpers for the
 * `responseGuard@1` shape.
 */

export {
  activate,
  createResponseGuardService,
  formatRulesBlock,
  parseProfileQualityConfig,
  type QualityGuardPluginHandle,
} from './plugin.js';

export {
  rulesForSycophancy,
  SYCOPHANCY_SECTION_HEADING,
} from './sycophancyGuard.js';

export {
  expandPresets,
  knownBoundaryPresetIds,
  BOUNDARY_SECTION_HEADING,
} from './boundaryPresets.js';

export {
  AgentOverridesMapSchema,
  BoundariesSchema,
  ProfileQualityConfigSchema,
  SycophancyLevelSchema,
  type AgentOverridesMap,
  type ProfileQualityConfigParsed,
} from './configSchema.js';
