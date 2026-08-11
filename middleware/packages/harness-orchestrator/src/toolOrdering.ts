/**
 * Deterministic tool ordering (W0-3).
 *
 * Anthropic prompt caching keys on a byte-exact prefix: `buildToolsList()`
 * stamps `cache_control: { type: 'ephemeral' }` on the LAST tool spec, which
 * makes the whole tool block one cacheable chunk. That only pays off if the
 * block serializes identically every time.
 *
 * Several of the segments feeding that block are iterated straight out of a
 * `Map`, so their order is insertion order: plugin load order for the native
 * tool registry, `created_at` row order for domain tools. Both are stable
 * *within* one process but diverge across Fly machines and across deploys —
 * silently dropping the cache for the entire tool block and everything after
 * it, with no error and no signal other than the cache-read token counter.
 *
 * Sorting the dynamic segments by name makes the serialized block a pure
 * function of the tool SET rather than of registration timing.
 *
 * Ordering is advertisement-only. Collision resolution (native tools win over
 * domain tools on a duplicate name) is decided by `Map` insertion in
 * `ToolDispatchService`, never by array position, so sorting the resulting
 * array cannot change which handler a name resolves to.
 */

/**
 * Locale-pinned name comparison. The explicit `'en'` locale keeps the result
 * independent of the host's `LANG`/`LC_COLLATE`, which is the whole point —
 * two Fly machines with different environments must produce the same bytes.
 */
export function compareToolNames(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

/** Returns a new array sorted by `name`; never mutates the input. */
export function sortByToolName<T extends { readonly name: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort((a, b) => compareToolNames(a.name, b.name));
}

/**
 * Same ordering for tool shapes that carry their name on a nested `spec`
 * (`LocalSubAgentTool` has no top-level `name`).
 */
export function sortBySpecName<
  T extends { readonly spec: { readonly name: string } },
>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => compareToolNames(a.spec.name, b.spec.name));
}

/**
 * Normalizes the order of an MCP server's discovered-tool list before it is
 * persisted to `mcp_servers.discovered_tools`.
 *
 * A server is free to return `tools/list` in any order it likes, and some
 * return a different order per call. Without normalization each rediscovery
 * rewrites the JSONB column with semantically identical content, which churns
 * the row and any grant-epoch diff computed from it.
 *
 * Entries without a usable string `name` keep their relative order and are
 * placed after named entries, so a malformed payload degrades rather than
 * throws.
 */
export function normalizeDiscoveredToolOrder(
  tools: readonly unknown[],
): unknown[] {
  const named: Array<{ name: string; value: unknown }> = [];
  const unnamed: unknown[] = [];

  for (const tool of tools) {
    const name =
      typeof tool === 'object' && tool !== null && 'name' in tool
        ? (tool as { name: unknown }).name
        : undefined;
    if (typeof name === 'string') named.push({ name, value: tool });
    else unnamed.push(tool);
  }

  named.sort((a, b) => compareToolNames(a.name, b.name));
  return [...named.map((entry) => entry.value), ...unnamed];
}
