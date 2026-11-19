import type { PluginKind } from '../api/admin-v1.js';

/**
 * Which of the three runtimes runs a plugin of a manifest kind.
 *
 * A `Record` over every kind, on purpose: the dispatch sites used to be
 * `switch` statements whose `default` was the agent runtime, so a kind added
 * to the manifest but not to one of them (#2088: `archetype` in the update
 * and the deactivation path) was started a second time as an agent plugin, or
 * never stopped. A new kind without an entry here does not compile.
 */
export type PluginRuntime = 'channel' | 'tool' | 'agent';

const RUNTIME_OF_KIND: Readonly<Record<PluginKind, PluginRuntime>> = {
  channel: 'channel',
  tool: 'tool',
  extension: 'tool',
  integration: 'tool',
  // #2088 — an archetype plugin runs like an extension.
  archetype: 'tool',
  agent: 'agent',
};

/** `undefined` (a plugin the catalog does not know) is an agent plugin, as it
 *  always was. */
export function pluginRuntimeOf(kind: PluginKind | undefined): PluginRuntime {
  return kind === undefined ? 'agent' : RUNTIME_OF_KIND[kind];
}
