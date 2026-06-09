/**
 * Plugin self-extension — persistent store of operator-approved extensions.
 *
 * For standalone (non-Builder) plugins, an approved self-extension is NOT
 * codegen'd into the package; instead the {@link ApprovedExtension} ({templateId,
 * params}) is persisted here, keyed by pluginId, and replayed into the plugin's
 * own `selfExtend.apply()` on every activation. This keeps the package directory
 * read-only and makes self-extensions survive restarts.
 *
 * File-backed JSON with atomic tmp+rename writes and an in-memory cache, mirror
 * of the `UploadedPackageStore` / `fileInstalledRegistry` idioms.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ApprovedExtension } from '@omadia/plugin-api';

interface ExtensionIndex {
  version: 1;
  byPlugin: Record<string, ApprovedExtension[]>;
}

function emptyIndex(): ExtensionIndex {
  return { version: 1, byPlugin: {} };
}

function key(ext: ApprovedExtension): string {
  // Stable identity for dedupe: same template + same params ⇒ same extension.
  return `${ext.templateId}::${stableStringify(ext.params)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export class ExtensionStore {
  private index: ExtensionIndex = emptyIndex();

  constructor(private readonly indexPath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw) as ExtensionIndex;
      if (parsed && parsed.version === 1 && typeof parsed.byPlugin === 'object') {
        this.index = { version: 1, byPlugin: parsed.byPlugin ?? {} };
      }
    } catch {
      // missing / unreadable / malformed → start empty (write happens on add)
      this.index = emptyIndex();
    }
  }

  /** Approved extensions for a plugin, in insertion order. Never null. */
  list(pluginId: string): ApprovedExtension[] {
    return [...(this.index.byPlugin[pluginId] ?? [])];
  }

  /** Add an approved extension. Idempotent: a duplicate (same template+params)
   *  is a no-op. Returns true iff something new was persisted. */
  async add(pluginId: string, ext: ApprovedExtension): Promise<boolean> {
    const existing = this.index.byPlugin[pluginId] ?? [];
    if (existing.some((e) => key(e) === key(ext))) return false;
    this.index.byPlugin[pluginId] = [...existing, ext];
    await this.save();
    return true;
  }

  /** Remove every approved extension of a given template for a plugin. Returns
   *  the number removed. */
  async removeTemplate(pluginId: string, templateId: string): Promise<number> {
    const existing = this.index.byPlugin[pluginId] ?? [];
    const kept = existing.filter((e) => e.templateId !== templateId);
    const removed = existing.length - kept.length;
    if (removed > 0) {
      this.index.byPlugin[pluginId] = kept;
      await this.save();
    }
    return removed;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.index, null, 2), 'utf8');
    await fs.rename(tmp, this.indexPath);
  }
}
