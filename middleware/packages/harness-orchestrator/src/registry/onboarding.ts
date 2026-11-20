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
 * Phase B (B1) — attach every supplied plugin id to the given Agent via
 * `upsertAgentPlugin`. Used by the B3d "Reset to all plugins" operator action.
 *
 * Idempotent: an already-attached plugin id is re-upserted with the same
 * shape so the row is rewritten but the state is identical. Per-plugin
 * failures are logged and the loop continues — one broken manifest
 * cannot block the rest of the catalog from landing on the Agent.
 *
 * Returns the count of plugins attached (successful upserts).
 */
export async function attachAllPlugins(
  store: Pick<ConfigStore, 'upsertAgentPlugin'>,
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

/** Outcome of {@link attachNewPluginsToFallbackAgent}. */
export interface FallbackAttachResult {
  /** The fallback Agent's id, or `undefined` when none is set. */
  readonly agentId: string | undefined;
  /** Ids that got a new `agent_plugins` row. */
  readonly attached: readonly string[];
}

/**
 * #1491 / #1498 — the runtime half of the "the fallback Agent has every
 * installed plugin" rule that first boot establishes via `attachAllPlugins`.
 * The host calls it for plugins the KERNEL just installed: a Hub install or
 * upload, or a built-in the boot seeded on an existing instance.
 *
 * Only ids WITHOUT a row on the fallback Agent are attached. An existing row
 * is the operator's (or an earlier attach's) decision, so a disabled row stays
 * disabled and a configured row keeps its config — `upsertAgentPlugin`
 * would overwrite both. A freshly installed plugin never has a row (uninstall
 * purges them), so for it this is the same as `attachAllPlugins`.
 *
 * No fallback Agent set → nothing to attach to (operator policy, see
 * `ensureFallbackAgent`); returns `agentId: undefined`.
 */
export async function attachNewPluginsToFallbackAgent(
  store: Pick<ConfigStore, 'routing' | 'listAgentPlugins' | 'upsertAgentPlugin'>,
  pluginIds: readonly string[],
  log: (msg: string, fields?: Record<string, unknown>) => void = () =>
    undefined,
): Promise<FallbackAttachResult> {
  // #2055 — the former fallback agent is the instance entry of the
  // default-agent table (S2 removes this auto-attach altogether, #2054).
  const fallbackAgentId =
    (await store.routing.listDefaultEntries()).find(
      (e) => e.principal === null && e.channelType === null,
    )?.agentId ?? null;
  if (!fallbackAgentId) return { agentId: undefined, attached: [] };
  const existing = new Set(
    (await store.listAgentPlugins(fallbackAgentId)).map((row) => row.pluginId),
  );
  const missing = [...new Set(pluginIds)].filter(
    (id) => id !== ORCHESTRATOR_PLUGIN_ID && !existing.has(id),
  );
  const attached: string[] = [];
  for (const pluginId of missing) {
    // One id per call so the result names exactly what landed; the per-id
    // failure handling is `attachAllPlugins`' own.
    const count = await attachAllPlugins(
      store,
      fallbackAgentId,
      [pluginId],
      log,
    );
    if (count > 0) attached.push(pluginId);
  }
  return { agentId: fallbackAgentId, attached };
}

