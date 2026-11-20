/**
 * Spec 2042 §5.11 — notes of the memory tool keep the labels of the turns that
 * wrote them, and reading a note adds them to the reading turn (criterion 27:
 * "the turn is summarised into memory; weeks later a consultation or a CRM
 * write that would carry that summary is refused").
 *
 * Wraps the ROOT memory store, below the binder's scoping and namespacing, so
 * a note is keyed by its physical path: every tier and every turn that reads
 * the same file finds the same labels. Paths are canonicalised like the stores
 * do (`//` collapsed, trailing `/` dropped), so a spelling variant never
 * reaches a note without its labels. The egress check (may this turn write
 * into that tier at all?) runs before the tool call, in the orchestrator,
 * where the tier's readers are known; this layer records and restores.
 *
 * Fail closed:
 *  - a write first stores the union of the note's labels and the turn's, and
 *    only then the content; when the labels cannot be stored the write is
 *    refused (a note never exists without the labels of what went into it);
 *  - labels only grow per path until the note is deleted (a turn that
 *    rewrites a note read it first, so its labels are in the turn anyway);
 *  - a failed lookup on read labels the turn unreadable;
 *  - a renamed or deleted directory takes its files' labels along.
 *
 * Outside a labelled turn (background jobs, durable-rule hooks) writes record
 * nothing and reads add nothing. Kernel-internal trees that are read across
 * rooms (the members index) must not go through this store: the binder gets
 * the undecorated store for them.
 */

import type { MemoryEntry, MemoryStore } from '@omadia/plugin-api';

import { UNKNOWN_READERS, unionLabels, type LabelSet } from './labels.js';
import type { DiscretionPort } from './port.js';
import { addTurnLabels, currentDiscretion, resolvedTurnLabels } from './turnLabels.js';

const SUBJECT = 'memory_file' as const;

export interface LabelledMemoryStoreOptions {
  /**
   * Whether reading a file adds its labels to the turn (default true). The
   * session logger's store sets false: it re-reads the conversation's own
   * transcript to append to it, which is no new information for the turn.
   */
  readonly labelReads?: boolean;
}

/** The canonical spelling of a memory path (as the stores normalise it). */
export function canonicalMemoryPath(virtualPath: string): string {
  const collapsed = virtualPath.replace(/\/+/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
}

export class LabelledMemoryStore implements MemoryStore {
  private readonly labelReads: boolean;

  constructor(
    private readonly inner: MemoryStore,
    private readonly port: DiscretionPort,
    private readonly agentSlug: string,
    options: LabelledMemoryStoreOptions = {},
  ) {
    this.labelReads = options.labelReads ?? true;
  }

  list(virtualPath: string): Promise<MemoryEntry[]> {
    return this.inner.list(virtualPath);
  }

  fileExists(virtualPath: string): Promise<boolean> {
    return this.inner.fileExists(virtualPath);
  }

  directoryExists(virtualPath: string): Promise<boolean> {
    return this.inner.directoryExists(virtualPath);
  }

  async readFile(virtualPath: string): Promise<string> {
    const content = await this.inner.readFile(virtualPath);
    if (this.labelReads && currentDiscretion()) {
      const path = canonicalMemoryPath(virtualPath);
      try {
        const labels = (await this.port.labelsOf(SUBJECT, [path])).get(path);
        if (labels) addTurnLabels(labels);
      } catch (err) {
        console.error('[discretion] memory note label lookup failed — labelling the turn unreadable:', err);
        addTurnLabels([{ kind: 'context', key: 'unreadable', readers: UNKNOWN_READERS }]);
      }
    }
    return content;
  }

  async createFile(virtualPath: string, content: string): Promise<void> {
    await this.recordBeforeWrite(virtualPath);
    await this.inner.createFile(virtualPath, content);
  }

  async writeFile(virtualPath: string, content: string): Promise<void> {
    await this.recordBeforeWrite(virtualPath);
    await this.inner.writeFile(virtualPath, content);
  }

  async delete(virtualPath: string): Promise<void> {
    const files = await this.filesUnder(virtualPath);
    await this.inner.delete(virtualPath);
    if (!this.port.dropLabels) return;
    for (const file of files) {
      await this.port.dropLabels(SUBJECT, file).catch((err: unknown) => {
        console.error('[discretion] dropping the labels of a deleted note failed:', err);
      });
    }
  }

  async rename(fromVirtualPath: string, toVirtualPath: string): Promise<void> {
    const from = canonicalMemoryPath(fromVirtualPath);
    const to = canonicalMemoryPath(toVirtualPath);
    const files = await this.filesUnder(from);
    const found = files.length > 0 ? await this.port.labelsOf(SUBJECT, files) : new Map<string, LabelSet>();
    // The labels go to the new paths before the move: a moved note is never
    // readable there without them.
    for (const [file, labels] of found) {
      await this.port.persistLabels(SUBJECT, `${to}${file.slice(from.length)}`, this.agentSlug, labels);
    }
    await this.inner.rename(fromVirtualPath, toVirtualPath);
    if (!this.port.dropLabels) return;
    for (const file of found.keys()) {
      await this.port.dropLabels(SUBJECT, file).catch((err: unknown) => {
        console.error('[discretion] dropping the old labels of a renamed note failed:', err);
      });
    }
  }

  /** The note keeps everything the turns that wrote it had read. Throws when it cannot. */
  private async recordBeforeWrite(virtualPath: string): Promise<void> {
    const state = currentDiscretion();
    if (!state) return;
    const turn = await resolvedTurnLabels(state);
    if (turn.labels.length === 0) return;
    const path = canonicalMemoryPath(virtualPath);
    const existing = (await this.port.labelsOf(SUBJECT, [path])).get(path);
    await this.port.persistLabels(SUBJECT, path, this.agentSlug, existing ? unionLabels(existing, turn) : turn);
  }

  /** The canonical paths of a file, or of every file below a directory. */
  private async filesUnder(virtualPath: string): Promise<string[]> {
    const path = canonicalMemoryPath(virtualPath);
    if (!(await this.inner.directoryExists(path).catch(() => false))) return [path];
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await this.inner.list(dir)) {
        const child = canonicalMemoryPath(entry.virtualPath);
        if (child === dir || !child.startsWith(`${dir}/`)) continue;
        if (entry.isDirectory) await walk(child);
        else out.push(child);
      }
    };
    await walk(path);
    return out;
  }
}
