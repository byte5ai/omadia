import { z } from 'zod';

/**
 * Zod schemas for `quality:` blocks landed via:
 *   1. Plugin manifest setup form (operator-facing global defaults)
 *   2. AGENT.md frontmatter (Phase 2.1, per-profile override)
 *   3. AgentSpec.quality (Builder-side, Phase 1 forward-compat)
 *
 * The schema accepts a permissive shape that mirrors the
 * `ProfileQualityConfig` type from plugin-api and is reused by
 * `parseProfileQualityConfig` in plugin.ts.
 *
 * Strictness rules:
 *   - sycophancy: must be one of the four enum values; rejects typos
 *     so a profile can never silently fall through to a wrong level.
 *   - boundaries.presets: array of strings; the plugin drops unknown ids
 *     at runtime (forward-compat), but the SHAPE must be valid.
 *   - boundaries.custom: array of non-empty strings.
 *   - .strict() on the outer object catches typos in the field names.
 */

export const SycophancyLevelSchema = z.enum(['off', 'low', 'medium', 'high']);

export const BoundariesSchema = z
  .object({
    presets: z.array(z.string().min(1)).optional(),
    custom: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const ProfileQualityConfigSchema = z
  .object({
    sycophancy: SycophancyLevelSchema.optional(),
    boundaries: BoundariesSchema.optional(),
  })
  .strict();

export type ProfileQualityConfigParsed = z.infer<
  typeof ProfileQualityConfigSchema
>;

/** Schema for the plugin's own `agent_overrides` setup field. Accepts a
 *  JSON-string of agentId → SycophancyLevel. Empty string parses to {}. */
export const AgentOverridesMapSchema = z.record(
  z.string().min(1),
  SycophancyLevelSchema,
);

export type AgentOverridesMap = z.infer<typeof AgentOverridesMapSchema>;
