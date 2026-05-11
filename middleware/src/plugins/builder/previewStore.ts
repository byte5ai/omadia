import type { PreviewHandle } from './previewRuntime.js';

/**
 * PreviewStore — in-memory registry of active preview handles, keyed by
 * draftId. Strictly separate from the `installedRegistry`: previews are
 * ephemeral, never serialised to disk, never reach the orchestrator's
 * domain-tool list.
 *
 * Cap-enforcement and LRU eviction live in `previewCache.ts` (B.3-2);
 * this store is the raw key-value layer.
 */

export class PreviewStore {
  private readonly handles = new Map<string, PreviewHandle>();

  set(draftId: string, handle: PreviewHandle): void {
    this.handles.set(draftId, handle);
  }

  get(draftId: string): PreviewHandle | undefined {
    return this.handles.get(draftId);
  }

  has(draftId: string): boolean {
    return this.handles.has(draftId);
  }

  /** Remove the entry without closing the handle (caller is responsible). */
  delete(draftId: string): boolean {
    return this.handles.delete(draftId);
  }

  /** Close ALL handles and clear the store. Used at SIGTERM/drain time. */
  async closeAll(): Promise<void> {
    const handles = Array.from(this.handles.values());
    this.handles.clear();
    await Promise.allSettled(handles.map((h) => h.close()));
  }

  get size(): number {
    return this.handles.size;
  }

  draftIds(): string[] {
    return Array.from(this.handles.keys());
  }
}
