import {
  purgePluginAgentBindings,
  type AgentPluginBindingStore,
} from './installService.js';

/**
 * #1070 (OM-95 follow-up) — deferred `agent_plugins` purge for plugins the
 * boot-time bootstrap removed on its own (`BootstrapDeps.onPluginRemoved`).
 *
 * Bootstrap runs before `toolPluginRuntime.activateAllInstalled()`, and the
 * binding store (`configStore`) is only provided by `@omadia/orchestrator`
 * inside its `activate()`. So at every bootstrap removal the store is absent:
 * the id is queued here and purged at the host's flush points (after the tool
 * runtime has activated, and again whenever the orchestrator is (re)activated,
 * e.g. after the LLM key is entered on a fresh host).
 *
 * The queue is in memory only. Ids still pending when the process exits are
 * lost, because the removal itself does not repeat on the next boot.
 */
export interface PendingBindingPurge {
  /** Queue a removed plugin id. Synchronous, never purges, never throws. */
  enqueue(pluginId: string): void;
  /** Purge every queued id if the store exists; otherwise keep them and log.
   *  Never rejects: a failed DELETE is logged with the plugin id by
   *  `purgePluginAgentBindings`. */
  flush(): Promise<void>;
  /** Snapshot of the ids still waiting for a store. */
  pending(): readonly string[];
}

export interface PendingBindingPurgeDeps {
  getStore: () => AgentPluginBindingStore | undefined;
  /** Whether the host runs on Postgres (`DATABASE_URL`). Only picks the log
   *  level for a missing store: warn on a DB host, info without one. */
  hasDatabase: boolean;
}

export function createPendingBindingPurge(
  deps: PendingBindingPurgeDeps,
): PendingBindingPurge {
  const queue = new Set<string>();

  const flush = async (): Promise<void> => {
    if (queue.size === 0) return;
    const store = deps.getStore();
    if (!store) {
      reportMissingStore([...queue], deps.hasDatabase);
      return;
    }
    // Snapshot + clear BEFORE awaiting, so a concurrent flush (boot flush vs.
    // an orchestrator reactivation) never purges the same id twice.
    const ids = [...queue];
    queue.clear();
    for (const id of ids) {
      await purgePluginAgentBindings(id, () => store);
    }
  };

  return {
    enqueue: (pluginId) => {
      queue.add(pluginId);
    },
    flush,
    pending: () => [...queue],
  };
}

function reportMissingStore(ids: readonly string[], hasDatabase: boolean): void {
  const list = ids.join(', ');
  if (hasDatabase) {
    // Expected before /setup: the orchestrator skips providing `configStore`
    // without an LLM key. Not an error, but the ids must stay visible.
    console.warn(
      `[bootstrap] agent-plugin binding purge DEFERRED for ${list} — no configStore yet; retries when @omadia/orchestrator activates`,
    );
    return;
  }
  // No DATABASE_URL: normally no `agent_plugins` table at all. The ids are
  // still kept, because the KG can publish a graphPool from a vault-stored
  // DSN, in which case the orchestrator store appears later on this host.
  console.log(
    `[bootstrap] agent-plugin binding purge pending for ${list} — no configStore (no DATABASE_URL); retries if @omadia/orchestrator provides one`,
  );
}
