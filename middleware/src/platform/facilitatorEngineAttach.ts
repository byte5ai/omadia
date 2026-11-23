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
import { FACILITATOR_ARCHETYPE, archetypeOf, isArchetype, type ArchetypeBearer } from '@omadia/orchestrator';

import {
  foreignArchetypeGrants,
  resolveFacilitationEngine,
  type FacilitationEngineSources,
} from './facilitatorGuard.js';

type AttachStore = Pick<ConfigStore, 'listAgents' | 'listAgentPlugins' | 'upsertAgentPlugin'>;

/** Attach the bound engine to one facilitator. Returns the plugin id that was
 *  attached, or `undefined` when nothing changed. */
export async function attachEngineToFacilitator(
  store: Pick<ConfigStore, 'listAgentPlugins' | 'upsertAgentPlugin'>,
  agent: { readonly id: string; readonly slug: string } & ArchetypeBearer,
  sources: FacilitationEngineSources,
): Promise<string | undefined> {
  if (!isArchetype(agent, FACILITATOR_ARCHETYPE)) return undefined;
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

/**
 * What the kernel does at boot and whenever installed plugins change: first
 * register which archetypes are delivered, and by whom; then attach the
 * engine to the facilitators and rebuild them.
 *
 * The archetype sync does not depend on the agent runtime. It runs even when
 * there is no config store yet (an instance without LLM access, where the
 * orchestrator does not publish one): the descriptor in force must be the
 * plugin's from the start, not the kernel's seed until the next restart.
 * Attaching needs the config store and is skipped without one. A failed sync
 * attaches nothing: the attach is decided on the registered descriptors.
 */
export async function syncArchetypesAndAttachEngine<S extends AttachStore>(deps: {
  readonly sync: () => Promise<unknown>;
  readonly getStore: () => S | undefined;
  readonly attach: (store: S) => Promise<unknown>;
  readonly reload: () => Promise<unknown> | undefined;
  readonly log: (message: string) => void;
}): Promise<void> {
  try {
    await deps.sync();
  } catch (err) {
    deps.log(`[middleware] archetype sync FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const store = deps.getStore();
  if (!store) return;
  try {
    await deps.attach(store);
    // Always: the registry rebuilds the facilitators whose effective engine
    // grant changed, with or without a new row (boot, grant, revoke).
    await deps.reload();
  } catch (err) {
    deps.log(`[middleware] facilitation engine attach FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** One grant {@link revokeForeignArchetypeGrants} removed. */
export interface RevokedArchetypeGrant {
  readonly agentSlug: string;
  readonly pluginId: string;
  /** The archetype the plugin delivers (not the agent's own). */
  readonly archetype: string;
}

/**
 * S3c — remove every grant of an archetype plugin from an agent of ANOTHER
 * archetype (for example the facilitation engine on a standard agent). Such a
 * grant is never valid (#2088) and is refused on every write path; rows from
 * before the rule stay behind and block the operator's replace of the
 * agent's grant set. Runs at boot and whenever installed plugins or grants
 * change, before the engine is attached. Logs every removal; a failure on one
 * agent does not stop the others. Returns what it removed.
 */
export async function revokeForeignArchetypeGrants(
  store: Pick<ConfigStore, 'listAgents' | 'listAgentPlugins' | 'removeAgentPlugin'>,
  catalog: FacilitationEngineSources['catalog'],
  log: (message: string) => void = () => undefined,
): Promise<RevokedArchetypeGrant[]> {
  if (!catalog) return [];
  const revoked: RevokedArchetypeGrant[] = [];
  for (const agent of await store.listAgents()) {
    try {
      const foreign = foreignArchetypeGrants(agent, await store.listAgentPlugins(agent.id), catalog);
      for (const grant of foreign) {
        await store.removeAgentPlugin(agent.id, grant.pluginId);
        revoked.push({ agentSlug: agent.slug, pluginId: grant.pluginId, archetype: grant.archetype });
        log(
          `[archetype] removed the grant of '${grant.pluginId}' from agent '${agent.slug}': it delivers the archetype '${grant.archetype}', the agent is '${archetypeOf(agent)}'`,
        );
      }
    } catch (err) {
      log(
        `[archetype] checking the grants of '${agent.slug}' for foreign archetype plugins failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return revoked;
}
