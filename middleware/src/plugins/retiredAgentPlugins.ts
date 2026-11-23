import type { PluginCatalog } from './manifestLoader.js';
import type { InstalledRegistry } from './installedRegistry.js';

/**
 * Spec 2042 §5.10, ADR-0014 — the kernel has no runtime for plugins of the
 * retired kind `agent`. A new one is refused at upload and install
 * (`pluginBoundary.ts`, `install.retired_kind`); this covers a package that
 * was installed before the kind was retired and is still in the registry.
 *
 * Such a plugin starts no code. It is left `errored` with the code
 * `kind_retired` and a message that says what to do, so the store shows it
 * like any other plugin that did not start and the operator can update or
 * uninstall it. Its stored config, secrets and grants stay untouched: a
 * version of a capability or template kind under the same id takes them over.
 */
export class RetiredPluginKindError extends Error {
  constructor(readonly pluginId: string) {
    super(
      `'${pluginId}' is of the retired kind 'agent'. The kernel runs no agent plugins: ` +
        `update it to a version of a capability or template kind, or uninstall it.`,
    );
    this.name = 'RetiredPluginKindError';
  }
}

/**
 * Why a plugin the kernel has no runtime for (`pluginRuntimeOf` → `none`) did
 * not start: the retired kind `agent`, or no catalog entry at all (a package
 * missing from every store). Only the first is `kind_retired`.
 */
export function noRuntimeError(pluginId: string, kind: string | undefined): Error {
  return kind === 'agent'
    ? new RetiredPluginKindError(pluginId)
    : new Error(`'${pluginId}' is not in the plugin catalog: no package of it was found, so nothing was started`);
}

/**
 * At boot: every installed plugin of the retired kind `agent` is recorded as
 * `errored` with `kind_retired`. Never throws, so a registry write that fails
 * for one entry neither crashes the boot nor stops the others. Returns the ids
 * it recorded.
 */
export async function blockRetiredAgentPlugins(deps: {
  readonly registry: Pick<InstalledRegistry, 'list' | 'markActivationBlocked'>;
  readonly catalog: Pick<PluginCatalog, 'get'>;
  readonly log: (message: string) => void;
}): Promise<string[]> {
  const blocked: string[] = [];
  for (const entry of deps.registry.list()) {
    if (deps.catalog.get(entry.id)?.plugin.kind !== 'agent') continue;
    const error = new RetiredPluginKindError(entry.id);
    try {
      await deps.registry.markActivationBlocked(entry.id, { message: error.message, code: 'kind_retired' });
      blocked.push(entry.id);
      deps.log(`[plugins] ${error.message}`);
    } catch (err) {
      deps.log(
        `[plugins] could not record '${entry.id}' as retired: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return blocked;
}
