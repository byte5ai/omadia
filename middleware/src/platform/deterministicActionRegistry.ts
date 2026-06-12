/**
 * Deterministic-action capability registry (declare → resolve → derive).
 *
 * The sibling of {@link ./canvasOutputRegistry.ts}. Where `canvas_output: true`
 * authorises a tool to EMIT a canvas surface, `deterministic_action: true`
 * declares that a tool's result is FULLY determined by the plugin — there is
 * nothing for a model to decide. When a structured canvas action names such a
 * tool, the ui-orchestrator dispatches it DIRECTLY (no skeleton, no sub-agent
 * LLM turn) and synthesises its sentinel straight into surface events.
 *
 * This is the generic contract behind "an agent can ship its own deterministic
 * UI": a saved-page recall, a status flip, a stored list view all declare
 * `deterministic_action: true` and become instant. Data-driven agents simply
 * don't declare it and keep using the compose/skeleton path ("the real magic"
 * of Omadia UI — the model decides the shape from the data).
 *
 * Deny-by-default is preserved: a tool reaches the fast-path ONLY when it both
 * declares `deterministic_action: true` here AND remains canvas-output
 * authorised for its sentinel to resolve. Registration is automatic per
 * manifest; the orchestrator's `deterministic_action_tools` config field stays
 * as an operator override on top.
 */

export interface DeterministicActionLookup {
  has(toolName: string): boolean;
}

export class DeterministicActionRegistry implements DeterministicActionLookup {
  private readonly byPlugin = new Map<string, ReadonlySet<string>>();

  register(pluginId: string, toolIds: readonly string[]): void {
    if (toolIds.length === 0) {
      this.byPlugin.delete(pluginId);
      return;
    }
    this.byPlugin.set(pluginId, new Set(toolIds));
  }

  unregister(pluginId: string): void {
    this.byPlugin.delete(pluginId);
  }

  has(toolName: string): boolean {
    for (const ids of this.byPlugin.values()) {
      if (ids.has(toolName)) return true;
    }
    return false;
  }

  list(): string[] {
    const out = new Set<string>();
    for (const ids of this.byPlugin.values()) {
      for (const id of ids) out.add(id);
    }
    return [...out].sort();
  }
}

/**
 * Extracts the capability ids that declare `deterministic_action: true` from a
 * raw manifest document. Tolerant by design (mirrors the loader's permissive
 * capability handling): anything that is not an object with a string `id` and a
 * literal `deterministic_action: true` is ignored.
 */
export function deterministicActionToolIds(manifest: unknown): string[] {
  if (typeof manifest !== 'object' || manifest === null) return [];
  const caps = (manifest as Record<string, unknown>)['capabilities'];
  if (!Array.isArray(caps)) return [];
  const ids: string[] = [];
  for (const cap of caps) {
    if (typeof cap !== 'object' || cap === null) continue;
    const rec = cap as Record<string, unknown>;
    if (
      rec['deterministic_action'] === true &&
      typeof rec['id'] === 'string' &&
      rec['id'].length > 0
    ) {
      ids.push(rec['id']);
    }
  }
  return ids;
}
