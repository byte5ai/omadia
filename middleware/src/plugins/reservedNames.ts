/**
 * Reserved tool-name registry.
 *
 * Built-in capabilities (memory, knowledge-graph, integrations) expose tools
 * whose IDs must not be claimed by uploaded or builder-generated agents —
 * otherwise an agent's `query_memory` would silently shadow the real one.
 *
 * Two layers:
 *   - exact reservations  (e.g. `query_memory`)
 *   - prefix reservations (e.g. `query_odoo_*` — matched via String.startsWith)
 *
 * Plugins extend the registry from their `activate()` via
 * `registerReservedExact` / `registerReservedPrefix`. The MVP set below
 * covers what ships today; further entries grow with the platform.
 */

const exactReserved = new Set<string>([
  // Orchestrator native tools
  'query_knowledge_graph',
  'query_memory',
  'query_calendar',
  // Bundle-capability + service names
  'chat_agent',
  'verifier',
  'memory',
  // Orchestrator-extras tools
  'extract_facts',
  'detect_topic',
  'retrieve_context',
]);

const reservedPrefixes = new Set<string>([
  'query_odoo_',
  'query_confluence_',
  'query_microsoft365_',
]);

export type ReservedCheckResult =
  | { reserved: true; reason: string }
  | { reserved: false };

export function isReservedToolId(toolId: string): ReservedCheckResult {
  if (exactReserved.has(toolId)) {
    return {
      reserved: true,
      reason: `Tool ID '${toolId}' is reserved by a built-in capability`,
    };
  }
  for (const prefix of reservedPrefixes) {
    if (toolId.startsWith(prefix)) {
      return {
        reserved: true,
        reason: `Tool ID '${toolId}' uses reserved prefix '${prefix}'`,
      };
    }
  }
  return { reserved: false };
}

export function registerReservedExact(name: string): void {
  if (!name) {
    throw new Error('reservedNames: name must be non-empty');
  }
  exactReserved.add(name);
}

export function registerReservedPrefix(prefix: string): void {
  if (!prefix.endsWith('_')) {
    throw new Error(
      `reservedNames: prefix '${prefix}' must end with '_' to avoid greedy matches`,
    );
  }
  reservedPrefixes.add(prefix);
}

export function getReservedSnapshot(): {
  exact: readonly string[];
  prefixes: readonly string[];
} {
  return {
    exact: [...exactReserved].sort(),
    prefixes: [...reservedPrefixes].sort(),
  };
}
