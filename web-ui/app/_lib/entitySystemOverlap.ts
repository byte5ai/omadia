import type { Plugin } from './storeTypes';

/**
 * #2245 / ADR-0167 — one entity system this plugin declares that an installed
 * plugin already declares too, with the names of those plugins.
 */
export interface EntitySystemOverlap {
  system: string;
  pluginNames: string[];
}

type OverlapSubject = Pick<Plugin, 'id' | 'permissions_summary'>;
type OverlapCandidate = Pick<
  Plugin,
  'id' | 'name' | 'install_state' | 'permissions_summary'
>;

function isInstalled(plugin: OverlapCandidate): boolean {
  return (
    plugin.install_state === 'installed' ||
    plugin.install_state === 'update-available'
  );
}

/**
 * The declared entity systems (`permissions.graph.entity_systems`) of
 * `subject` that another installed plugin already declares.
 *
 * ADR-0167 does not tie a system to one plugin: any plugin may declare `odoo`
 * and then write Odoo master-data nodes. The operator is the bound, so the
 * store shows the overlap before install. The kernel decides nothing here;
 * this only reads the catalog the store already lists.
 *
 * Order follows the subject's declaration; plugin names are sorted.
 */
export function entitySystemOverlaps(
  subject: OverlapSubject,
  catalog: readonly OverlapCandidate[],
): EntitySystemOverlap[] {
  const declared = subject.permissions_summary.graph_entity_systems ?? [];
  if (declared.length === 0) return [];
  const others = catalog.filter((p) => p.id !== subject.id && isInstalled(p));
  return [...new Set(declared)].flatMap((system) => {
    const pluginNames = others
      .filter((p) =>
        (p.permissions_summary.graph_entity_systems ?? []).includes(system),
      )
      .map((p) => p.name)
      .sort((a, b) => a.localeCompare(b));
    return pluginNames.length > 0 ? [{ system, pluginNames }] : [];
  });
}
