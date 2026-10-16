/**
 * #1359 — rebuild the LLM plugins whose class-ref model moved under them.
 *
 * The orchestrator, verifier and extras resolve their configured model ref
 * ONCE, in `activate()` (`resolveConfiguredModel`). A class ref
 * (`class:frontier`, the orchestrator's default) resolves to whatever the
 * catalog names as that class's default at that moment. At boot the plugins
 * activate on the built-in seed, and the fire-and-forget discovery run lands a
 * fraction of a second later with the vendor's real defaults — so after every
 * restart the orchestrator ran on the seed's frontier model (`claude-opus-5`)
 * instead of the discovered one (`claude-opus-5-5`), until some admin save
 * happened to reactivate it.
 *
 * The rebuilder closes that gap without making boot wait on a vendor: every
 * activation of an LLM plugin is stamped with the catalog generation it saw,
 * and a discovery run that changes a provider's class defaults bumps the
 * generation and rebuilds every installed LLM plugin that (a) last activated
 * on an older generation, (b) runs on that provider and (c) follows a class
 * ref. A plugin that activated AFTER the discovery run (the run finished
 * first) carries the current generation and is left alone. The rebuild order
 * is the capture order (`rebuildOrder`): extras and verifier before the
 * orchestrator that captures them.
 *
 * #1083 shipped and then withdrew an automatic reactivation like this one,
 * for four reasons that no longer hold: a reactivated orchestrator lost its
 * domain tools (re-bound on every activation since #1406, key-less boot
 * included); a late boot run could race the kernel's hydration (`ready`
 * gates every rebuild); a failed activation was logged as success (the status
 * is read after each rebuild); and rebuilding the verifier or extras alone
 * changed nothing for the orchestrator holding them (`rebuildOrder`).
 */
import { isClassRef } from '@omadia/llm-provider';
import { DEFAULT_ORCHESTRATOR_MODEL } from '@omadia/orchestrator';

import type { InstalledRegistry } from '../plugins/installedRegistry.js';
import {
  DEFAULT_PROVIDER,
  LLM_PLUGINS,
  readStringConfig,
  type LlmPluginDesc,
} from './pluginLlmReadiness.js';
import { rebuildOrder } from './providerDependents.js';

/** A plugin's own model default when its model keys are unset. Only class refs
 *  matter here; the verifier and extras default to concrete vendor ids. */
const CLASS_REF_DEFAULTS: Readonly<Record<string, string>> = {
  '@omadia/orchestrator': DEFAULT_ORCHESTRATOR_MODEL,
};

export interface ClassDefaultRebuildDeps {
  readonly installedRegistry: Pick<InstalledRegistry, 'has' | 'get'>;
  readonly reactivate: (pluginId: string) => Promise<void>;
  /** Resolves once the kernel's boot wiring is done (the domain-tool re-bind
   *  is installed). A rebuild never runs before it. */
  readonly ready: Promise<void>;
  readonly log?: (message: string) => void;
}

export interface ClassDefaultRebuilder {
  /** Record that `pluginId` STARTS (re)activating against the current catalog
   *  (stamped before its `activate()` reads the catalog, so a discovery run
   *  that lands mid-activation still counts as newer). */
  noteActivated(pluginId: string): void;
  /** A discovery run changed `providerId`'s class defaults. Resolves with the
   *  ids it rebuilt, in order. Never rejects. */
  onDefaultsChanged(providerId: string): Promise<string[]>;
}

/** The provider `id` runs on: its own `llm_provider`, else the one it
 *  inherits (`inheritsProviderFrom`), else the platform default. */
function effectiveProviderOf(
  id: string,
  installedRegistry: ClassDefaultRebuildDeps['installedRegistry'],
): string {
  const own = readStringConfig(installedRegistry.get(id)?.config ?? {}, 'llm_provider')?.trim();
  if (own) return own;
  const parent = LLM_PLUGINS.find((p) => p.id === id)?.inheritsProviderFrom;
  return parent !== undefined ? effectiveProviderOf(parent, installedRegistry) : DEFAULT_PROVIDER;
}

/** True when any of the plugin's model keys resolves through a class ref. */
function followsClassRef(desc: LlmPluginDesc, cfg: Record<string, unknown>): boolean {
  return desc.modelKeys.some((key) => {
    const ref = readStringConfig(cfg, key)?.trim() || CLASS_REF_DEFAULTS[desc.id];
    return ref !== undefined && isClassRef(ref);
  });
}

export function createClassDefaultRebuilder(
  deps: ClassDefaultRebuildDeps,
): ClassDefaultRebuilder {
  const log = deps.log ?? ((m: string) => console.log(`[middleware] ${m}`));
  let generation = 0;
  const activatedAt = new Map<string, number>();
  const isLlmPlugin = (id: string): boolean => LLM_PLUGINS.some((p) => p.id === id);
  let queue: Promise<unknown> = Promise.resolve();

  const rebuildStale = async (providerId: string, changedAt: number): Promise<string[]> => {
    const stale = LLM_PLUGINS.filter((desc) => {
      const seen = activatedAt.get(desc.id);
      if (seen === undefined || seen >= changedAt) return false;
      const entry = deps.installedRegistry.get(desc.id);
      if (entry === undefined) return false;
      return (
        effectiveProviderOf(desc.id, deps.installedRegistry) === providerId &&
        followsClassRef(desc, entry.config ?? {})
      );
    }).map((desc) => desc.id);
    if (stale.length === 0) return [];
    const order = rebuildOrder(stale, (id) => deps.installedRegistry.has(id));
    log(
      `model discovery moved ${providerId}'s class defaults — rebuilding ${order.join(', ')} so class-ref models resolve against the discovered catalog`,
    );
    const rebuilt: string[] = [];
    for (const id of order) {
      try {
        await deps.reactivate(id);
      } catch (err) {
        log(
          `rebuild of ${id} after the class-default change FAILED: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      // The production `reactivate` never throws on an activation failure;
      // it leaves the plugin `errored`. Read that instead of assuming success.
      const after = deps.installedRegistry.get(id);
      if (after?.status === 'errored') {
        log(
          `rebuild of ${id} after the class-default change left it errored: ${after.last_activation_error ?? 'no error recorded'}`,
        );
        continue;
      }
      rebuilt.push(id);
    }
    return rebuilt;
  };

  return {
    noteActivated(pluginId) {
      if (isLlmPlugin(pluginId)) activatedAt.set(pluginId, generation);
    },
    onDefaultsChanged(providerId) {
      generation += 1;
      const changedAt = generation;
      // Serialized: two runs (two providers in one boot `refreshAll`, or a key
      // verification during a periodic run) never reactivate concurrently, and
      // each decides what is stale only when its turn comes, so a plugin a
      // previous run (or an admin save) already rebuilt after the change is
      // skipped instead of rebuilt twice.
      const run = queue.then(async () => {
        await deps.ready;
        return rebuildStale(providerId, changedAt);
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}
