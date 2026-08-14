import type { ConfigStore } from './configStore.js';

/**
 * The orchestrator plugin's own id. It activates as part of the kernel's
 * tool runtime, but it is not a tool plugin that an Agent attaches to — it
 * IS the Agent runtime. Excluding it from the auto-attach catalog prevents
 * the operator UI from showing an unactionable "orchestrator on agent"
 * row on every Agent card.
 */
const ORCHESTRATOR_PLUGIN_ID = '@omadia/orchestrator';

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

/**
 * #679 / I5 — the prose this seed writes on first boot, exported so the UI can
 * recognise it.
 *
 * ## The decision
 *
 * A German operator saw an English sentence in their agent list, and the
 * obvious reading is "a translation is missing". It is not: this string is
 * written by the SERVER into the database, once, at first boot, before any
 * locale exists to write it in. There is no request, no `Accept-Language`, no
 * operator preference — the row is created by the boot sequence.
 *
 * Three options were on the table:
 *
 *  1. **Localise the seed at write time.** Rejected: the value is *persisted*.
 *     Whatever locale the boot happens to pick is frozen into the row, so an
 *     operator who later switches the UI to English still reads German — the
 *     same bug, pointing the other way, and now baked into data.
 *  2. **Seed no description at all** and let the UI fill the blank. Rejected:
 *     the column is part of the store's contract and is read by consumers that
 *     have no message catalogue (the API, exports, the CLI). An empty
 *     description would degrade those to say nothing at all.
 *  3. **Keep the seed as a provenance record and localise at the boundary** —
 *     chosen. The stored sentence describes *why the row exists*, which is a
 *     fact about the system, not UI copy. The UI is where a locale exists, so
 *     the UI renders its own catalogue text — the same split
 *     `fetchNavEntries(locale)` already uses for plugin nav labels.
 *
 * Recognition is by exact match against these constants AND the seed slug, so
 * the moment an operator edits the description their words are shown verbatim.
 * A row the operator has touched is operator content and is never overridden.
 */
export const FALLBACK_AGENT_SEED_NAME = 'Standard Orchestrator';

/** @see FALLBACK_AGENT_SEED_NAME for why this stays English in the store. */
export const FALLBACK_AGENT_SEED_DESCRIPTION =
  'Auto-seeded on first boot. Receives unbound channel traffic until the operator configures explicit bindings.';

export interface OnboardingOptions {
  readonly slug?: string;
  readonly name?: string;
  readonly description?: string;
  readonly log?: (msg: string, fields?: Record<string, unknown>) => void;
  /**
   * Phase B (B1) — plugin IDs to attach to the fallback Agent on creation.
   * Each ID is upserted into `agent_plugins` with `enabled: true` and
   * empty config (operator can later edit via the dashboard, B3c).
   *
   * Filtered to skip the orchestrator's own id — it is the runtime, not a
   * pluggable contribution. Passing `undefined` or `[]` reverts to the
   * pre-B1 behaviour (zero plugins; useful in tests).
   */
  readonly pluginIds?: readonly string[];
}

/**
 * Phase B (B1) — attach every supplied plugin id to the given Agent via
 * `upsertAgentPlugin`. Used by `ensureFallbackAgent` on first-boot seed
 * and by the B3d "Reset fallback to all plugins" operator action.
 *
 * Idempotent: an already-attached plugin id is re-upserted with the same
 * shape so the row is rewritten but the state is identical. Per-plugin
 * failures are logged and the loop continues — one broken manifest
 * cannot block the rest of the catalog from landing on the Agent.
 *
 * Returns the count of plugins attached (successful upserts).
 */
export async function attachAllPlugins(
  store: ConfigStore,
  agentId: string,
  pluginIds: readonly string[],
  log: (msg: string, fields?: Record<string, unknown>) => void = () =>
    undefined,
): Promise<number> {
  let attached = 0;
  for (const pluginId of pluginIds) {
    if (pluginId === ORCHESTRATOR_PLUGIN_ID) continue;
    try {
      await store.upsertAgentPlugin(agentId, {
        pluginId,
        config: {},
        enabled: true,
      });
      attached += 1;
    } catch (err) {
      log(`onboarding: upsertAgentPlugin FAILED — skipping`, {
        agentId,
        pluginId,
        error: (err as Error).message,
      });
    }
  }
  return attached;
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
  const created = !fallback;
  if (!fallback) {
    fallback = await store.createAgent({
      slug,
      name: options.name ?? FALLBACK_AGENT_SEED_NAME,
      description: options.description ?? FALLBACK_AGENT_SEED_DESCRIPTION,
      privacyProfile: 'strict',
      status: 'enabled',
    });
    log(`onboarding: seeded fallback agent`, {
      slug: fallback.slug,
      agentId: fallback.id,
    });
  }

  // Phase B (B1) — on FRESH creation only, attach every installed plugin.
  // Existing fallback rows are left untouched (operator may have already
  // pruned them; rehydrating without consent would silently re-grant
  // capabilities the operator removed on purpose). The B3d operator action
  // is the consent-bearing path for an existing Agent.
  if (created && options.pluginIds && options.pluginIds.length > 0) {
    const attached = await attachAllPlugins(
      store,
      fallback.id,
      options.pluginIds,
      log,
    );
    log(`onboarding: fallback agent hydrated with installed plugins`, {
      slug: fallback.slug,
      agentId: fallback.id,
      attached,
      requested: options.pluginIds.length,
    });
  }

  await store.setFallbackAgentId(fallback.id);
  log(`onboarding: platform_settings.fallback_agent_id set`, {
    slug: fallback.slug,
    agentId: fallback.id,
  });
  return fallback.slug;
}
