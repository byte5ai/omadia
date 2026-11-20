/**
 * Spec 2042 §5.11 — notes of the memory tool keep the labels of the turn that
 * wrote them, and reading a note adds them to the reading turn (criterion 27:
 * "the turn is summarised into memory; weeks later a consultation or a CRM
 * write that would carry that summary is refused").
 *
 * Wraps the ROOT memory store, below the binder's scoping and namespacing, so
 * a note is keyed by its physical path: every tier and every turn that reads
 * the same file finds the same labels. The egress check (may this turn write
 * into that tier at all?) runs before the tool call, in the orchestrator,
 * where the tier's readers are known; this layer only records and restores.
 *
 * Outside a labelled turn (background jobs, durable-rule hooks) it is a pass
 * through. A failed label lookup on read fails closed: the turn gets a label
 * nobody is known to be allowed to read.
 */

import type { MemoryEntry, MemoryStore } from '@omadia/plugin-api';

import { UNKNOWN_READERS } from './labels.js';
import type { DiscretionPort } from './port.js';
import { addTurnLabels, currentDiscretion, resolvedTurnLabels } from './turnLabels.js';

const SUBJECT = 'memory_file' as const;

export class LabelledMemoryStore implements MemoryStore {
  constructor(
    private readonly inner: MemoryStore,
    private readonly port: DiscretionPort,
    private readonly agentSlug: string,
  ) {}

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
    if (currentDiscretion()) {
      try {
        const found = await this.port.labelsOf(SUBJECT, [virtualPath]);
        const labels = found.get(virtualPath);
        if (labels) addTurnLabels(labels);
      } catch (err) {
        console.error('[discretion] memory note label lookup failed — labelling the turn unreadable:', err);
        addTurnLabels([{ kind: 'context', key: 'unreadable', readers: UNKNOWN_READERS }]);
      }
    }
    return content;
  }

  async createFile(virtualPath: string, content: string): Promise<void> {
    await this.inner.createFile(virtualPath, content);
    await this.record(virtualPath);
  }

  async writeFile(virtualPath: string, content: string): Promise<void> {
    await this.inner.writeFile(virtualPath, content);
    await this.record(virtualPath);
  }

  async delete(virtualPath: string): Promise<void> {
    await this.inner.delete(virtualPath);
    await this.port.dropLabels?.(SUBJECT, virtualPath).catch((err: unknown) => {
      console.error('[discretion] dropping the labels of a deleted note failed:', err);
    });
  }

  async rename(fromVirtualPath: string, toVirtualPath: string): Promise<void> {
    await this.inner.rename(fromVirtualPath, toVirtualPath);
    // The labels move with the note (a renamed directory keeps its files'
    // labels under their old paths: a documented gap).
    try {
      const found = await this.port.labelsOf(SUBJECT, [fromVirtualPath]);
      const labels = found.get(fromVirtualPath);
      if (!labels) return;
      await this.port.persistLabels(SUBJECT, toVirtualPath, this.agentSlug, labels);
      await this.port.dropLabels?.(SUBJECT, fromVirtualPath);
    } catch (err) {
      console.error('[discretion] moving the labels of a renamed note failed:', err);
    }
  }

  /** The written note keeps everything the turn had read when it wrote it. */
  private async record(virtualPath: string): Promise<void> {
    const state = currentDiscretion();
    if (!state) return;
    const labels = await resolvedTurnLabels(state);
    if (labels.labels.length === 0) return;
    await this.port.persistLabels(SUBJECT, virtualPath, this.agentSlug, labels).catch((err: unknown) => {
      console.error('[discretion] persisting the labels of a memory note failed:', err);
    });
  }
}
