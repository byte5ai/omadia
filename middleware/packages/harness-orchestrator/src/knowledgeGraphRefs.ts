/**
 * The source ids a `query_knowledge_graph` result shows the model — what a
 * `[ref:…]` citation marker in the answer may name.
 *
 * The tool answers in JSON. Entities carry their node `id`
 * (`odoo:res.partner:42`), turn hits and session-summary turns their
 * `turnId` (`turn:<scope>:<ISO time>`). Those two keys are the citable ones;
 * everything else (scopes, display names, counts) is content, not a source.
 * Read from the text the model received, so an id the Privacy Shield masked
 * is not citable — the model never saw it.
 *
 * Pure. A result that is not JSON (an `Error:` line, a kernel notice) holds
 * no source.
 */

/** Keys whose string value names a citable knowledge-graph node. */
const CITABLE_KEYS: ReadonlySet<string> = new Set(['id', 'turnId']);

/** Nesting a tool result never reaches; a bound on a hostile structure. */
const MAX_DEPTH = 8;

export function knowledgeGraphRefsIn(output: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  const refs = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (CITABLE_KEYS.has(key) && typeof child === 'string' && child.trim() !== '') {
        refs.add(child);
      } else {
        walk(child, depth + 1);
      }
    }
  };
  walk(parsed, 0);
  return [...refs];
}
