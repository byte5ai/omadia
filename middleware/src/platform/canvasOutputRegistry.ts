/**
 * Canvas-output capability registry (declare → resolve → derive).
 *
 * Replaces the operator-maintained `canvas_output_tools` string on the
 * ui-orchestrator as the PRIMARY authorisation source for canvas sentinels
 * (`_pendingCanvasTree` / `_pendingStructuredPayload`): a plugin DECLARES
 * `canvas_output: true` on a manifest capability entry, the kernel RESOLVES
 * those declarations into this registry as plugins (de)activate, and the
 * ui-orchestrator DERIVES its allow-set lazily per check — so a plugin
 * installed after the orchestrator activated is authorised without any
 * re-activation. The config field stays as an operator override.
 *
 * Deny-by-default is preserved: emitting canvas output remains an explicit,
 * manifest-visible declaration the operator sees at install time — it is the
 * REGISTRATION that is automatic now, not the permission.
 */

export interface CanvasOutputLookup {
  has(toolName: string): boolean;
}

export class CanvasOutputRegistry implements CanvasOutputLookup {
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
 * Extracts the capability ids that declare `canvas_output: true` from a raw
 * manifest document. Tolerant by design (mirrors the loader's permissive
 * capability handling): anything that is not an object with a string `id`
 * and a literal `canvas_output: true` is ignored.
 */
export function canvasOutputToolIds(manifest: unknown): string[] {
  if (typeof manifest !== 'object' || manifest === null) return [];
  const caps = (manifest as Record<string, unknown>)['capabilities'];
  if (!Array.isArray(caps)) return [];
  const ids: string[] = [];
  for (const cap of caps) {
    if (typeof cap !== 'object' || cap === null) continue;
    const rec = cap as Record<string, unknown>;
    if (rec['canvas_output'] === true && typeof rec['id'] === 'string' && rec['id'].length > 0) {
      ids.push(rec['id']);
    }
  }
  return ids;
}
