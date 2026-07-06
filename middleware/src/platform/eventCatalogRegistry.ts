/**
 * Event-catalog capability registry (declare → resolve → emit). The Conductor Surface's
 * connector half (US4): a plugin declares the domain events it emits, and at runtime it may
 * emit one — which the {@link ../conductor/eventRouter.ts ConductorEventRouter} routes to every
 * subscribed workflow.
 *
 * The sibling of {@link ./canvasOutputRegistry.ts} / {@link ./deterministicActionRegistry.ts}:
 * a manifest capability entry `{ id, event_emit: true }` declares an emittable event id, and the
 * registry collects those per plugin from BOTH activation runtimes (dynamic + tool). It is the
 * authoritative catalog the Designer's event-trigger picker reads, and it backs deny-by-default
 * at emit time — a plugin may only emit an id it declared (`allows`).
 */

export interface EventCatalogLookup {
  has(eventId: string): boolean;
}

export class EventCatalogRegistry implements EventCatalogLookup {
  private readonly byPlugin = new Map<string, ReadonlySet<string>>();

  register(pluginId: string, eventIds: readonly string[]): void {
    if (eventIds.length === 0) {
      this.byPlugin.delete(pluginId);
      return;
    }
    this.byPlugin.set(pluginId, new Set(eventIds));
  }

  unregister(pluginId: string): void {
    this.byPlugin.delete(pluginId);
  }

  /** Any plugin declares this event id. */
  has(eventId: string): boolean {
    for (const ids of this.byPlugin.values()) {
      if (ids.has(eventId)) return true;
    }
    return false;
  }

  /** This specific plugin declared this event id (deny-by-default for ctx.events.emit). */
  allows(pluginId: string, eventId: string): boolean {
    return this.byPlugin.get(pluginId)?.has(eventId) ?? false;
  }

  /** The full catalog — sorted union of all declared event ids (for the Designer picker). */
  list(): string[] {
    const out = new Set<string>();
    for (const ids of this.byPlugin.values()) {
      for (const id of ids) out.add(id);
    }
    return [...out].sort();
  }

  /** The catalog grouped by source plugin (for an operator/Designer view). */
  byPluginId(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [pluginId, ids] of this.byPlugin) out[pluginId] = [...ids].sort();
    return out;
  }
}

/**
 * Extracts the event ids a manifest declares it emits — capability entries with a string `id`
 * and a literal `event_emit: true`. Tolerant by design (mirrors the loader's permissive
 * capability handling): anything else is ignored.
 */
export function eventEmitIds(manifest: unknown): string[] {
  if (typeof manifest !== 'object' || manifest === null) return [];
  const caps = (manifest as Record<string, unknown>)['capabilities'];
  if (!Array.isArray(caps)) return [];
  const ids: string[] = [];
  for (const cap of caps) {
    if (typeof cap !== 'object' || cap === null) continue;
    const rec = cap as Record<string, unknown>;
    if (rec['event_emit'] === true && typeof rec['id'] === 'string' && rec['id'].length > 0) {
      ids.push(rec['id']);
    }
  }
  return ids;
}
