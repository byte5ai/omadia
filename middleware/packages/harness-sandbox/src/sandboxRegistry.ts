import type { AgentComputerProfile } from './agentComputerProfile.js';

/**
 * Issue #576 P3 — the durable bookkeeping a `SandboxBackend` does not give
 * for free: which scope owns which backend-specific sandbox reference, when
 * it was last used (for the reaper), and the RO-layer content hash last
 * synced into it. `DockerSandboxBackend`'s deterministic container naming
 * (`omadia-sbx-<sha256(scopeKey)>`) already makes a SINGLE backend instance
 * durable across process restarts without this — a registry is what turns
 * that into something operable at fleet scale: idle-scope reaping, RO-layer
 * re-sync decisions, and (once a second backend exists) scope→backend
 * routing.
 */
export interface SandboxRegistryEntry {
  readonly scopeKey: string;
  readonly backend: string;
  /** Backend-specific reference — e.g. `DockerSandboxBackend`'s container
   *  name. Opaque to the registry itself. */
  readonly sandboxRef: string;
  readonly profile: AgentComputerProfile;
  /** Content hash of the RO layer last synced into this sandbox (see
   *  `contentHash.ts`), or undefined when nothing has been synced yet. */
  readonly roLayerHash?: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
}

export interface SandboxRegistryUpsertInput {
  readonly scopeKey: string;
  readonly backend: string;
  readonly sandboxRef: string;
  readonly profile: AgentComputerProfile;
  readonly roLayerHash?: string;
  readonly now: Date;
}

export interface SandboxRegistry {
  get(scopeKey: string): Promise<SandboxRegistryEntry | undefined>;
  /** Insert-or-update. `createdAt` is preserved on an update (only set on
   *  first insert); `lastUsedAt` is always set to `input.now`. */
  upsert(input: SandboxRegistryUpsertInput): Promise<SandboxRegistryEntry>;
  /** Bump `lastUsedAt` without touching anything else. No-ops (does not
   *  throw) when the scope is not registered. */
  touch(scopeKey: string, now: Date): Promise<void>;
  delete(scopeKey: string): Promise<void>;
  /** Every registered entry. Used by the reaper — expected to be called
   *  infrequently (a periodic sweep), not per tool dispatch. */
  listAll(): Promise<readonly SandboxRegistryEntry[]>;
}

/**
 * In-memory `SandboxRegistry` — used by tests and by any deployment that
 * has not wired a durable store. Durability then reduces to whatever the
 * backend itself provides (for `DockerSandboxBackend`, its deterministic
 * naming) — a strictly weaker but still-correct posture, same trade-off
 * `InMemoryDirectLineStickyStore` documents elsewhere in this codebase.
 */
export class InMemorySandboxRegistry implements SandboxRegistry {
  private readonly entries = new Map<string, SandboxRegistryEntry>();

  async get(scopeKey: string): Promise<SandboxRegistryEntry | undefined> {
    return this.entries.get(scopeKey);
  }

  async upsert(input: SandboxRegistryUpsertInput): Promise<SandboxRegistryEntry> {
    const existing = this.entries.get(input.scopeKey);
    const entry: SandboxRegistryEntry = {
      scopeKey: input.scopeKey,
      backend: input.backend,
      sandboxRef: input.sandboxRef,
      profile: input.profile,
      ...(input.roLayerHash !== undefined ? { roLayerHash: input.roLayerHash } : {}),
      createdAt: existing?.createdAt ?? input.now,
      lastUsedAt: input.now,
    };
    this.entries.set(input.scopeKey, entry);
    return entry;
  }

  async touch(scopeKey: string, now: Date): Promise<void> {
    const existing = this.entries.get(scopeKey);
    if (!existing) return;
    this.entries.set(scopeKey, { ...existing, lastUsedAt: now });
  }

  async delete(scopeKey: string): Promise<void> {
    this.entries.delete(scopeKey);
  }

  async listAll(): Promise<readonly SandboxRegistryEntry[]> {
    return Array.from(this.entries.values());
  }
}
