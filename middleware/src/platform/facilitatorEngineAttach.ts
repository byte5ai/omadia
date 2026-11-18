// #2043 — a facilitator gets the facilitation engine without an operator
// clicking "grant".
//
// The engine is the one thing a facilitator may be granted (and the one thing
// it cannot work without), so the grant is not a decision anyone has to take.
// It is attached in both orders: when a facilitator is created and an engine
// is bound, and when an engine is installed or replaced while facilitators
// exist. Nothing else is ever attached here.
//
// Insert-if-absent, like every kernel attach: an existing row is the
// operator's (a disabled engine grant stays disabled). No engine, or more
// than one, attaches nothing.

import type { ConfigStore } from '@omadia/orchestrator';
import { isFacilitatorKind } from '@omadia/orchestrator';

import { resolveFacilitationEngine, type FacilitationEngineSources } from './facilitatorGuard.js';

type AttachStore = Pick<ConfigStore, 'listAgents' | 'listAgentPlugins' | 'upsertAgentPlugin'>;

/** Attach the bound engine to one facilitator. Returns the plugin id that was
 *  attached, or `undefined` when nothing changed. */
export async function attachEngineToFacilitator(
  store: Pick<ConfigStore, 'listAgentPlugins' | 'upsertAgentPlugin'>,
  agent: { readonly id: string; readonly slug: string; readonly kind?: 'standard' | 'facilitator' },
  sources: FacilitationEngineSources,
): Promise<string | undefined> {
  if (!isFacilitatorKind(agent)) return undefined;
  const engine = resolveFacilitationEngine(sources);
  if (engine.state !== 'bound') return undefined;
  const rows = await store.listAgentPlugins(agent.id);
  if (rows.some((row) => row.pluginId === engine.pluginId)) return undefined;
  await store.upsertAgentPlugin(agent.id, { pluginId: engine.pluginId, enabled: true });
  return engine.pluginId;
}

/** Attach the bound engine to every facilitator that has no row for it.
 *  Returns the slugs that changed. */
export async function attachEngineToFacilitators(
  store: AttachStore,
  sources: FacilitationEngineSources,
  log: (message: string) => void = () => undefined,
): Promise<string[]> {
  if (resolveFacilitationEngine(sources).state !== 'bound') return [];
  const changed: string[] = [];
  for (const agent of await store.listAgents()) {
    try {
      if (await attachEngineToFacilitator(store, agent, sources)) changed.push(agent.slug);
    } catch (err) {
      log(
        `[facilitator] attaching the facilitation engine to '${agent.slug}' failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (changed.length > 0) {
    log(`[facilitator] facilitation engine attached to: ${changed.join(', ')}`);
  }
  return changed;
}
