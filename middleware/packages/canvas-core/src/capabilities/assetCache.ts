/**
 * omadia-canvas-protocol/1.1 — content-addressed asset transport (lumens-spec.md §6.1).
 *
 * Binaries (images, audio, tiles, voice) travel as DataRefs that are
 * content-addressed: `id = "<kind>-<sha256(content)[:16]>"`. Same bytes → same
 * id; different bytes → different id. ALWAYS. This is cache-busting BY
 * CONSTRUCTION — the id IS the content hash, so changed content is a different
 * id and old content can never be addressed by a new reference. No time-based
 * "maybe stale" guesswork; invalidation is explicit only.
 */
import { createHash } from 'node:crypto';

/** Compute the content-addressed id for a blob. `kind` ∈ {pixel,vector,audio,
 *  video,struct,…} (lowercase letters — matches the DataRef id pattern). */
export function contentId(kind: string, content: string | Uint8Array): string {
  if (!/^[a-z]+$/.test(kind)) throw new Error(`invalid asset kind '${kind}' (lowercase letters only)`);
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return `${kind}-${hash}`;
}

export interface CachedAsset {
  id: string;
  kind: string;
  content: string | Uint8Array;
  /** ISO 8601; undefined = no expiry. */
  expiresAt?: string;
}

/** A local content-addressed store keyed by id: instant hits across
 *  turns/Lumens/canvases, automatic dedup, explicit-only invalidation. */
export class ContentAddressedStore {
  private readonly entries = new Map<string, CachedAsset>();
  private readonly refs = new Map<string, number>();

  /** Store a blob, returning its content-addressed id. Idempotent: identical
   *  bytes reuse the same entry (dedup), never a second copy. */
  put(kind: string, content: string | Uint8Array, expiresAt?: string): string {
    const id = contentId(kind, content);
    if (!this.entries.has(id)) this.entries.set(id, { id, kind, content, expiresAt });
    return id;
  }

  get(id: string): CachedAsset | undefined {
    return this.entries.get(id);
  }
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Track a live reference (a Lumen/scene using this asset). */
  retain(id: string): void {
    this.refs.set(id, (this.refs.get(id) ?? 0) + 1);
  }
  release(id: string): void {
    const n = (this.refs.get(id) ?? 0) - 1;
    if (n <= 0) this.refs.delete(id);
    else this.refs.set(id, n);
  }

  /** Explicit invalidation (expiresAt passed or surface_data_ref_invalidated). */
  invalidate(id: string): void {
    this.entries.delete(id);
    this.refs.delete(id);
  }

  /** GC entries that are BOTH expired and unreferenced (never time-guesswork on
   *  live or unexpired assets). `now` is an ISO timestamp (injected, testable). */
  gc(now: string): string[] {
    const removed: string[] = [];
    for (const [id, asset] of this.entries) {
      const expired = asset.expiresAt !== undefined && asset.expiresAt <= now;
      const referenced = (this.refs.get(id) ?? 0) > 0;
      if (expired && !referenced) {
        this.entries.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }
}
