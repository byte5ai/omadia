import type { PluginCatalog } from './manifestLoader.js';

/**
 * Topologically sort plugin ids so that every plugin appears AFTER the
 * plugins it declares in its manifest's `depends_on` AND after any provider
 * it implicitly depends on via a capability `requires`. Used by both the
 * DynamicAgentRuntime and ToolPluginRuntime to guarantee activation order
 * within each runtime.
 *
 * Dependencies that are not part of the input set (e.g. an agent plugin
 * depending on a tool plugin that a different runtime activates) are
 * skipped — cross-runtime ordering is handled at the boot-sequence level
 * in `index.ts` (tool runtime runs before agent runtime).
 *
 * Cycles throw with a `plugin dependency cycle` error that lists the
 * offending chain so the operator can see which manifests reference each
 * other. Missing catalog entries are tolerated — a plugin that isn't in
 * the catalog keeps its input order position and contributes no deps.
 *
 * `extraEdges` folds capability-derived edges into the same DFS so that the
 * existing cycle-detection applies uniformly: if a capability edge
 * completes a cycle (A depends_on B, B requires a cap A provides) it
 * surfaces as the same `plugin dependency cycle` error, not a silent
 * activation-order bug.
 */
export interface TopoEdge {
  /** Plugin that must activate first. */
  from: string;
  /** Plugin that must activate after `from`. */
  to: string;
}

export function topoSortByDependsOn(
  ids: readonly string[],
  catalog: PluginCatalog,
  extraEdges: readonly TopoEdge[] = [],
): string[] {
  const inSet = new Set(ids);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const out: string[] = [];

  // Per-consumer incoming adjacency from `extraEdges`. A DFS visit of `to`
  // must first recurse into every `from` — same shape as the manifest's
  // `depends_on` list, so the existing cycle detection applies uniformly.
  const extraIncoming = new Map<string, string[]>();
  for (const edge of extraEdges) {
    if (!extraIncoming.has(edge.to)) extraIncoming.set(edge.to, []);
    extraIncoming.get(edge.to)!.push(edge.from);
  }

  const visit = (id: string, stack: readonly string[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      const cycle = [...stack.slice(cycleStart), id].join(' → ');
      throw new Error(`plugin dependency cycle detected: ${cycle}`);
    }
    if (!inSet.has(id)) {
      // Cross-runtime dep — the other runtime's ordering handles it.
      return;
    }
    visiting.add(id);
    const entry = catalog.get(id);
    const deps = entry?.plugin.depends_on ?? [];
    for (const dep of deps) {
      visit(dep, [...stack, id]);
    }
    for (const dep of extraIncoming.get(id) ?? []) {
      visit(dep, [...stack, id]);
    }
    visiting.delete(id);
    visited.add(id);
    out.push(id);
  };

  for (const id of ids) visit(id, []);
  return out;
}
