/**
 * Keep class-ref LLM plugins on the model their class resolves to NOW (#1083).
 *
 * The orchestrator, verifier and orchestrator-extras resolve a configured
 * class ref (`class:frontier`) to a concrete vendor id ONCE, at activation.
 * Live model discovery (`modelCatalogSync`: the boot run racing plugin
 * activation, the periodic refresh, "Refresh models", a key verification) can
 * move what that class resolves to — the plugin would keep running the old
 * model while the providers page labels the class with the new one.
 *
 * `createClassRefReactivator` hooks the catalog swap: it snapshots what every
 * installed, active LLM plugin's class refs resolve to right before the swap,
 * compares right after, and reactivates exactly the plugins whose resolution
 * changed. Concrete model ids never move with the catalog and are ignored.
 *
 * Boot ordering: a swap before plugin activation has started changes nothing
 * that is running (activation reads the new catalog). A swap WHILE the boot
 * activation runs may land after a plugin already resolved its model, so those
 * plugins are queued and reactivated once activation has finished — never
 * concurrently with the boot loop.
 */
import { isClassRef, resolveConfiguredModel } from '@omadia/llm-provider';

import type { InstalledAgent } from '../plugins/installedRegistry.js';
import { DEFAULT_PROVIDER, LLM_PLUGINS, readStringConfig } from './pluginLlmReadiness.js';

export interface ClassRefReactivatorDeps {
  readonly installedRegistry: {
    get(id: string): Pick<InstalledAgent, 'status' | 'config'> | undefined;
  };
  readonly reactivate: (pluginId: string) => Promise<void>;
  readonly log?: (message: string) => void;
  readonly warn?: (message: string) => void;
}

export interface ClassRefReactivator {
  /** For `modelCatalogSync`: called right before a provider's models are
   *  swapped; the returned function is called once the swap succeeded and
   *  resolves when the affected plugins were reactivated. */
  beforeModelsSwap(providerId: string): () => Promise<void>;
  /** Boot: plugin activation is about to start. */
  activationStarting(): void;
  /** Boot: plugin activation finished — flushes swaps that landed meanwhile. */
  activationFinished(): Promise<void>;
}

type Phase = 'before-activation' | 'activating' | 'live';

/** What each active LLM plugin on `providerId` resolves its class refs to,
 *  keyed by plugin id. Plugins without a class ref are left out. */
export function classRefResolutions(
  registry: ClassRefReactivatorDeps['installedRegistry'],
  providerId: string,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const desc of LLM_PLUGINS) {
    const entry = registry.get(desc.id);
    if (entry === undefined || entry.status !== 'active') continue;
    const cfg = entry.config;
    if ((readStringConfig(cfg, 'llm_provider') ?? DEFAULT_PROVIDER) !== providerId) continue;
    const refs = desc.modelKeys
      .map((key) => readStringConfig(cfg, key))
      .filter((ref): ref is string => ref !== undefined && isClassRef(ref));
    if (refs.length === 0) continue;
    out.set(
      desc.id,
      refs.map((ref) => `${ref}=${resolveConfiguredModel(ref, providerId) ?? '∅'}`).join(','),
    );
  }
  return out;
}

export function createClassRefReactivator(deps: ClassRefReactivatorDeps): ClassRefReactivator {
  const log = deps.log ?? ((m: string) => console.log(`[model-discovery] ${m}`));
  const warn = deps.warn ?? ((m: string) => console.warn(`[model-discovery] ${m}`));
  let phase: Phase = 'before-activation';
  const queued = new Set<string>();

  const reactivateAll = async (pluginIds: Iterable<string>): Promise<void> => {
    for (const pluginId of pluginIds) {
      try {
        await deps.reactivate(pluginId);
        log(`${pluginId}: class-ref model moved with the catalog — reactivated`);
      } catch (err) {
        warn(`${pluginId}: reactivation after a catalog change failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  return {
    beforeModelsSwap(providerId) {
      const before = classRefResolutions(deps.installedRegistry, providerId);
      return async () => {
        if (phase === 'before-activation') return;
        const after = classRefResolutions(deps.installedRegistry, providerId);
        const changed = [...after.keys()].filter((id) => before.get(id) !== after.get(id));
        if (changed.length === 0) return;
        if (phase === 'activating') {
          for (const id of changed) queued.add(id);
          return;
        }
        await reactivateAll(changed);
      };
    },
    activationStarting() {
      phase = 'activating';
    },
    async activationFinished() {
      phase = 'live';
      const pending = [...queued];
      queued.clear();
      await reactivateAll(pending);
    },
  };
}
