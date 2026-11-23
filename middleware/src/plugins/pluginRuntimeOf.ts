import { effectiveKind, type PluginKind } from '../api/admin-v1.js';

/**
 * Which runtime runs a plugin of a manifest kind.
 *
 * A `Record` over every kind, on purpose: the dispatch sites used to be
 * `switch` statements whose `default` was the agent runtime, so a kind added
 * to the manifest but not to one of them (#2088: `archetype` in the update
 * and the deactivation path) was started a second time as an agent plugin, or
 * never stopped. A new kind without an entry here does not compile.
 *
 * `none` — spec 2042 §5.10: the kernel has no runtime for the retired kind
 * `agent`. A package of that kind still installed is left `errored` with the
 * code `kind_retired` (`retiredAgentPlugins.ts`) and starts no code.
 */
export type PluginRuntime = 'channel' | 'tool' | 'none';

const RUNTIME_OF_KIND: Readonly<Record<PluginKind, PluginRuntime>> = {
  channel: 'channel',
  tool: 'tool',
  integration: 'tool',
  skill: 'tool',
  model: 'tool',
  // #2088 — an archetype plugin runs like a system module.
  archetype: 'tool',
  'system-module': 'tool',
  // Data-only packages run in the tool runtime, which starts no code for
  // them (`isDataOnlyPlugin`).
  'agent-template': 'tool',
  // Retired, but a system module: packages installed before the kind was
  // retired run as one until their `system-module` version is installed.
  extension: 'tool',
  // Retired, no runtime.
  agent: 'none',
};

/** `undefined` — a plugin the catalog does not know — has no runtime. */
export function pluginRuntimeOf(kind: PluginKind | undefined): PluginRuntime {
  return kind === undefined ? 'none' : RUNTIME_OF_KIND[kind];
}

/**
 * Spec 2042 §5.10 — a package that delivers only data: an `agent-template`
 * (inactive presets) always, a `skill` package when it ships no code. The
 * tool runtime marks such a package active without importing anything, and
 * the upload accepts it without an entry file.
 */
export function isDataOnlyPlugin(kind: PluginKind, manifest: unknown): boolean {
  const k = effectiveKind(kind);
  if (k === 'agent-template') return true;
  if (k !== 'skill') return false;
  const lifecycle = (manifest as { lifecycle?: { entry?: unknown } } | undefined)?.lifecycle;
  return typeof lifecycle?.entry !== 'string' || lifecycle.entry.length === 0;
}
