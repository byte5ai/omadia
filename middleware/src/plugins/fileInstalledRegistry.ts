import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AgentId } from '../api/admin-v1.js';
import {
  blockActivation,
  bumpFailure,
  type InstalledAgent,
  type InstalledRegistry,
} from './installedRegistry.js';
import type { ActivationErrorReason } from './activationErrorReason.js';

/**
 * File-backed installed-agents registry. No encryption — entries are
 * non-secret metadata (id, version, timestamps, non-secret config values).
 * Atomic write via tmp + rename.
 */

interface RegistryFile {
  version: 1;
  agents: Record<AgentId, InstalledAgent>;
}

export class FileInstalledRegistry implements InstalledRegistry {
  private agents = new Map<AgentId, InstalledAgent>();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as RegistryFile;
      if (parsed.version !== 1) {
        throw new Error(`unknown registry version: ${parsed.version}`);
      }
      this.agents = new Map(Object.entries(parsed.agents ?? {}));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw err;
      this.agents = new Map();
    }
    this.loaded = true;
  }

  list(): InstalledAgent[] {
    this.ensureLoaded();
    return Array.from(this.agents.values()).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }

  get(id: AgentId): InstalledAgent | undefined {
    this.ensureLoaded();
    return this.agents.get(id);
  }

  has(id: AgentId): boolean {
    this.ensureLoaded();
    return this.agents.has(id);
  }

  async register(entry: InstalledAgent): Promise<void> {
    this.ensureLoaded();
    this.agents.set(entry.id, entry);
    await this.persist();
  }

  async remove(id: AgentId): Promise<void> {
    this.ensureLoaded();
    this.agents.delete(id);
    await this.persist();
  }

  async markActivationFailed(
    id: AgentId,
    error: string,
    unresolvedRequires?: readonly string[],
    reason?: ActivationErrorReason,
  ): Promise<void> {
    this.ensureLoaded();
    const current = this.agents.get(id);
    if (!current) return;
    // #1456 — shared with the in-memory registry. This used to be a private
    // copy of the same writes, which is how a new field reaches one backend
    // and not the other: the operator then sees the reason until the next
    // boot reads the entry back off disk without it.
    this.agents.set(
      id,
      bumpFailure(
        current,
        error,
        new Date().toISOString(),
        unresolvedRequires,
        reason,
      ),
    );
    await this.persist();
  }

  async markActivationBlocked(
    id: AgentId,
    error: string,
    reason?: ActivationErrorReason,
  ): Promise<void> {
    this.ensureLoaded();
    const current = this.agents.get(id);
    if (!current) return;
    this.agents.set(
      id,
      blockActivation(current, error, new Date().toISOString(), reason),
    );
    await this.persist();
  }

  async markActivationSucceeded(id: AgentId): Promise<void> {
    this.ensureLoaded();
    const current = this.agents.get(id);
    if (!current) return;
    // OM-16 — `last_activated_at` is stamped on EVERY success, so the previous
    // "nothing to clear → skip the write" short-circuit no longer applies:
    // `readiness.verified_at` is derived from this timestamp and a stale one
    // would misreport when the plugin was last proven to work.
    const next: InstalledAgent = {
      ...current,
      last_activated_at: new Date().toISOString(),
    };
    delete next.activation_failure_count;
    delete next.last_activation_error;
    delete next.last_activation_error_at;
    delete next.unresolved_requires;
    delete next.last_activation_error_reason;
    this.agents.set(id, next);
    await this.persist();
  }

  async clearActivationError(id: AgentId): Promise<void> {
    this.ensureLoaded();
    const current = this.agents.get(id);
    if (!current) return;
    const wasErrored = current.status === 'errored';
    const hadAnyErrorField =
      current.activation_failure_count !== undefined ||
      current.last_activation_error !== undefined ||
      current.last_activation_error_at !== undefined ||
      current.unresolved_requires !== undefined ||
      current.last_activation_error_reason !== undefined;
    if (!wasErrored && !hadAnyErrorField) return;
    const next: InstalledAgent = { ...current };
    delete next.activation_failure_count;
    delete next.last_activation_error;
    delete next.last_activation_error_at;
    delete next.unresolved_requires;
    delete next.last_activation_error_reason;
    if (wasErrored) next.status = 'active';
    this.agents.set(id, next);
    await this.persist();
  }

  async updateConfig(
    id: AgentId,
    config: Record<string, unknown>,
  ): Promise<void> {
    this.ensureLoaded();
    const current = this.agents.get(id);
    if (!current) {
      throw new Error(`FileInstalledRegistry: no agent with id '${id}'`);
    }
    this.agents.set(id, { ...current, config });
    await this.persist();
  }

  async updateVersion(
    id: AgentId,
    newVersion: string,
    newConfig: Record<string, unknown>,
  ): Promise<void> {
    this.ensureLoaded();
    const current = this.agents.get(id);
    if (!current) {
      throw new Error(`FileInstalledRegistry: no agent with id '${id}'`);
    }
    this.agents.set(id, {
      ...current,
      installed_version: newVersion,
      config: newConfig,
    });
    await this.persist();
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      throw new Error(
        'FileInstalledRegistry: call load() before any other operation',
      );
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const file: RegistryFile = {
      version: 1,
      agents: Object.fromEntries(this.agents),
    };
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), {
      mode: 0o600,
      encoding: 'utf8',
    });
    await fs.rename(tmp, this.filePath);
  }
}
