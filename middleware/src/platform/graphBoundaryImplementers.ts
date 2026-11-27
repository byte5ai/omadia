/**
 * ADR-0044 — who holds the raw graph services. Its own module so the service
 * grant gate (`pluginServiceGrants.ts`, ADR-0257) can ask without loading the
 * bounded forms.
 */
import type { PluginCatalog } from '../plugins/manifestLoader.js';

/**
 * The bundled modules that hold the raw graph services, because they provide
 * them or implement the boundary itself (recall, tenant review jobs). CLOSED
 * SET, keyed by id and honoured only for `origin === 'bundled'`: an upload or
 * a local-dev package claiming one of these ids gets the bounded form, as it
 * inherits no legacy grant either (#789).
 *
 * Not on the list, by decision (ADR-0044): `@omadia/verifier` (reads master
 * data through `findEntities` only), `@omadia/plugin-plan-runner` (its own
 * plans; processes like the process tools), `@omadia/diagrams` (`_brand`).
 */
export const GRAPH_BOUNDARY_IMPLEMENTERS: ReadonlySet<string> = new Set([
  '@omadia/orchestrator',
  '@omadia/orchestrator-extras',
  '@omadia/knowledge-graph-neon',
  '@omadia/knowledge-graph-inmemory',
  '@omadia/memory',
  '@omadia/memory-postgres',
]);

/** Whether this plugin resolves the raw graph services. */
export function holdsRawGraphServices(agentId: string, catalog: PluginCatalog): boolean {
  return GRAPH_BOUNDARY_IMPLEMENTERS.has(agentId) && catalog.get(agentId)?.origin === 'bundled';
}
