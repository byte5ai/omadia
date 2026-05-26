import type { ConfigStore } from './configStore.js';

/**
 * First-boot onboarding seed (US7 / T029, C2 / FR-021).
 *
 * If the operator has not yet created any Agents, seed a minimal-privilege
 * `fallback` Agent (zero plugins, `strict` privacy profile) and set it as
 * the platform's `fallback_agent_id`. This means unmatched channel keys
 * have somewhere to land on day-1 — operators see "we routed your message
 * to the safe default Agent" instead of a hard-reject they cannot debug.
 *
 * Idempotent: safe to call on every boot.
 *
 *  - If any agents exist, the function is a no-op (the operator owns the
 *    config; we do not silently create more).
 *  - If no agents exist, it creates the fallback Agent + sets
 *    `platform_settings.fallback_agent_id`.
 *  - If an agent exists with the seeded slug but no fallback is set, the
 *    function points `fallback_agent_id` at the existing row instead of
 *    creating a duplicate.
 *
 * Returns the slug of the fallback Agent (or `undefined` if seeding was
 * skipped because non-fallback agents already exist).
 */

export const FALLBACK_AGENT_SLUG = 'fallback';

export interface OnboardingOptions {
  readonly slug?: string;
  readonly name?: string;
  readonly description?: string;
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
}

export async function ensureFallbackAgent(
  store: ConfigStore,
  options: OnboardingOptions = {},
): Promise<string | undefined> {
  const slug = options.slug ?? FALLBACK_AGENT_SLUG;
  const log = options.log ?? (() => undefined);

  const agents = await store.listAgents();
  const settings = await store.getPlatformSettings();

  // The operator has at least one Agent and a fallback set — nothing to do.
  if (agents.length > 0 && settings.fallbackAgentId) return undefined;

  // The operator has Agents but no fallback. Refuse to invent one — they
  // may have intentionally left fallback unset (hard-reject policy). Log
  // a hint and exit.
  if (agents.length > 0 && !settings.fallbackAgentId) {
    log(
      `onboarding: agents present but no fallback_agent_id — skipping seed (operator policy)`,
      { agentCount: agents.length },
    );
    return undefined;
  }

  // Zero Agents — seed the fallback. If a row with the seed slug already
  // exists (e.g. operator pre-created an empty one), reuse it.
  let fallback = await store.getAgentBySlug(slug);
  if (!fallback) {
    fallback = await store.createAgent({
      slug,
      name: options.name ?? 'Fallback Agent',
      description:
        options.description ??
        'Auto-seeded on first boot. Receives unbound channel traffic until the operator configures explicit bindings.',
      privacyProfile: 'strict',
      status: 'enabled',
    });
    log(`onboarding: seeded fallback agent`, {
      slug: fallback.slug,
      agentId: fallback.id,
    });
  }

  await store.setFallbackAgentId(fallback.id);
  log(`onboarding: platform_settings.fallback_agent_id set`, {
    slug: fallback.slug,
    agentId: fallback.id,
  });
  return fallback.slug;
}
