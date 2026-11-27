/**
 * ADR-0256 — the top-level `/memories` trees and who may use them through
 * `memoryStore@1`. Shared by the manifest loader (which drops undeclarable
 * names from `permissions.memory.trees`) and the bounded store
 * (`boundedGraphServices.ts`).
 */

/**
 * ADR-0256 — where the kernel records which plugin owns a declared top-level
 * tree: one file per tree, `/memories/_plugin-trees/<tree>.json`, written by
 * the first plugin that touches the tree. Private to the kernel: no plugin
 * reads or changes it through the service.
 */
export const PLUGIN_TREE_OWNERS_TREE = '_plugin-trees';

/**
 * First segments under `/memories` a plugin never reaches through the
 * service: each agent's private root (and every plugin's `ctx.memory` inside
 * it), every plugin's plugin-wide and legacy tree (`agents`,
 * `ctx.memory.pluginWide`), the per-context trees, the session transcripts,
 * the web chat copies, the per-user UI preferences and the tree-owner
 * records. A plugin reads its own notes through `ctx.memory`.
 */
export const PRIVATE_TREES: ReadonlySet<string> = new Set([
  'orchestrators',
  'agents',
  'contexts',
  'sessions',
  'chat-sessions',
  'ui-prefs',
  PLUGIN_TREE_OWNERS_TREE,
]);

/** The shared tree every plugin reads and none changes (ADR-0256, ADR-0033). */
export const CORE_TREE = 'core';

/** A tree name a manifest may declare under `permissions.memory.trees`. */
const DECLARABLE_TREE_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Whether `tree` may be declared as a plugin's own top-level tree: a plain
 *  lower-case name, not private, not `core`, not an operator `_*` tree. */
export function isDeclarableMemoryTree(tree: string): boolean {
  return DECLARABLE_TREE_RE.test(tree) && !PRIVATE_TREES.has(tree) && tree !== CORE_TREE;
}

/**
 * ADR-0256 — trees that belonged to one Hub plugin before the field existed.
 * The plugin keeps its tree without declaring it, and no other plugin can
 * claim it. Keyed by id, which is not a credential (#789). A row retires when
 * the plugin's released manifest declares the tree.
 */
export const LEGACY_MEMORY_TREE_OWNERS_2026_11_26: Readonly<Record<string, string>> = Object.freeze({
  pairings: '@omadia/channel-telegram',
});

/** The trees `pluginId` may use: its declaration plus its legacy rows. */
export function memoryTreesFor(pluginId: string, declared: readonly string[]): ReadonlySet<string> {
  const trees = new Set(declared.filter(isDeclarableMemoryTree));
  for (const [tree, owner] of Object.entries(LEGACY_MEMORY_TREE_OWNERS_2026_11_26)) {
    if (owner === pluginId) trees.add(tree);
  }
  return trees;
}

