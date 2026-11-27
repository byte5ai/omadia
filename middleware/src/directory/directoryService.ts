// ADR-0300 — the kernel's directory of people: sources contributed by channel
// plugins (one per tenant, first registrant owns it), the sync schedule, and
// deprovisioning. The store is Postgres-only; without a database there is no
// directory and channel users keep the behaviour they had before.

import type { DirectorySource, DirectorySourceKind } from '@omadia/channel-sdk';
import type { TurnIdentityDirectory } from '@omadia/orchestrator';

import { systemAuditActor, type AuditEntryInput } from '../auth/adminAuditLog.js';
import type { DirectoryPerson, DirectoryStore } from './directoryStore.js';
import { runDirectorySync, type DeprovisionReason, type DirectorySyncOutcome } from './directorySync.js';

/** How often each source is read again after its first run. */
export const DIRECTORY_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

const SYNC_ACTOR = systemAuditActor('system:directory-sync');

export interface DirectoryServiceDeps {
  readonly store: () => DirectoryStore | undefined;
  readonly audit: () => { record(entry: AuditEntryInput): Promise<void> } | undefined;
  /**
   * Revoke and delete every per-person MCP token stored under `personKey`,
   * each server on its own: `failed` counts servers whose token is still there.
   */
  readonly revokePersonConnections: (personKey: string) => Promise<{ revoked: number; failed: number }>;
  /** Unlink every channel identity an operator linked to the person; resolves the count. */
  readonly unlinkPersonIdentities: (person: DirectoryPerson) => Promise<number>;
  /** `users.status` of an account; `undefined` = unknown account. */
  readonly accountStatus: (userId: string) => Promise<'active' | 'disabled' | undefined>;
  /**
   * Whether `channelId` may contribute a source of this kind (Entra: only the
   * plugin that holds the `teams` channel type). Absent: every kind allowed (tests).
   */
  readonly mayRegister?: (channelId: string, source: DirectorySourceKind) => boolean;
  readonly log?: (message: string) => void;
  readonly intervalMs?: number;
}

export interface RegisteredDirectorySource {
  readonly source: DirectorySourceKind;
  readonly tenantId: string;
  readonly channelId: string;
}

const sourceKey = (source: DirectorySourceKind, tenantId: string): string => `${source}:${tenantId.toLowerCase()}`;

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class DirectoryService {
  private readonly sources = new Map<string, { source: DirectorySource; channelId: string }>();
  private readonly running = new Map<string, Promise<DirectorySyncOutcome>>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly log: (message: string) => void;

  constructor(private readonly deps: DirectoryServiceDeps) {
    this.log = deps.log ?? ((m) => console.warn(m));
  }

  /** `CoreApi.registerDirectorySource`. Throws for a tenant another plugin holds. */
  register(channelId: string, source: DirectorySource): void {
    if (source === null || typeof source !== 'object' || typeof source.delta !== 'function') {
      throw new Error(`directory source of '${channelId}' is malformed`);
    }
    if (source.source !== 'entra' || !GUID_RE.test(source.tenantId)) {
      throw new Error(`directory source of '${channelId}' names an unknown kind or tenant`);
    }
    if (this.deps.mayRegister && !this.deps.mayRegister(channelId, source.source)) {
      throw new Error(`channel '${channelId}' may not contribute a ${source.source} directory: it does not serve that channel`);
    }
    const key = sourceKey(source.source, source.tenantId);
    const owner = this.sources.get(key)?.channelId;
    if (owner !== undefined && owner !== channelId) {
      throw new Error(`directory of ${key} already belongs to channel '${owner}' (attempted: '${channelId}')`);
    }
    this.sources.set(key, { source, channelId });
    this.schedule(key);
    this.log(`[directory] ${channelId} registered the ${key} directory`);
  }

  /** Deactivation of a channel plugin: its sources and schedules go. Stored people stay. */
  unregisterChannel(channelId: string): void {
    for (const [key, entry] of this.sources) {
      if (entry.channelId !== channelId) continue;
      this.sources.delete(key);
      const timer = this.timers.get(key);
      if (timer) clearInterval(timer);
      this.timers.delete(key);
    }
  }

  registeredSources(): RegisteredDirectorySource[] {
    return [...this.sources.values()].map(({ source, channelId }) => ({
      source: source.source,
      tenantId: source.tenantId,
      channelId,
    }));
  }

  /** Run one source now (or join its running run). `undefined` = no such source or no database. */
  sync(source: DirectorySourceKind, tenantId: string): Promise<DirectorySyncOutcome> | undefined {
    const key = sourceKey(source, tenantId);
    const entry = this.sources.get(key);
    const store = this.deps.store();
    if (!entry || !store) return undefined;
    const current = this.running.get(key);
    if (current) return current;
    const run = this.retryPendingRevocations(source, tenantId)
      .catch((err: unknown) =>
        this.log(`[directory] ${key} revocation retry failed — ${err instanceof Error ? err.message : String(err)}`),
      )
      .then(() =>
        runDirectorySync(entry.source, {
          store,
          deprovision: (person, reason) => this.deprovision(person, reason),
          log: this.log,
        }),
      )
      .catch((err: unknown): DirectorySyncOutcome => {
        const error = err instanceof Error ? err.message : String(err);
        this.log(`[directory] ${key} sync crashed — ${error}`);
        return { outcome: 'failed', error };
      })
      .finally(() => this.running.delete(key));
    this.running.set(key, run);
    return run;
  }

  isRunning(source: DirectorySourceKind, tenantId: string): boolean {
    return this.running.has(sourceKey(source, tenantId));
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  /**
   * A leaver: audit first (a failed audit is logged, never a reason to keep a
   * leaver's tokens), then tokens, then links, then the status.
   */
  async deprovision(person: DirectoryPerson, reason: DeprovisionReason): Promise<void> {
    const store = this.deps.store();
    if (!store) return;
    try {
      const audit = this.deps.audit();
      if (!audit) throw new Error('no audit store');
      await audit.record({
        actor: SYNC_ACTOR,
        action: 'directory_person.deprovision',
        target: `directory_person:${person.id}`,
        before: { status: person.status },
        after: { status: 'deprovisioned', reason, tenantId: person.tenantId },
      });
    } catch (err) {
      this.log(
        `[directory] audit of deprovisioning ${person.id} failed — ${err instanceof Error ? err.message : String(err)} (continuing)`,
      );
    }
    const { revoked, failed } = await this.revoke(person);
    const unlinked = await this.deps.unlinkPersonIdentities(person).catch((err: unknown) => {
      this.log(`[directory] unlinking identities of ${person.id} failed — ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    });
    // Turns stop keying on the person now; a failed revocation is retried by the next run.
    await store.markDeprovisioned(person.id, failed > 0);
    this.log(
      `[directory] deprovisioned ${person.id} (${reason}): ${String(revoked)} connection(s) revoked${
        failed > 0 ? `, ${String(failed)} failed (retried next sync)` : ''
      }, ${String(unlinked)} identity link(s) removed`,
    );
  }

  private async revoke(person: DirectoryPerson): Promise<{ revoked: number; failed: number }> {
    try {
      return await this.deps.revokePersonConnections(person.externalId);
    } catch (err) {
      this.log(`[directory] revoking connections of ${person.id} failed — ${err instanceof Error ? err.message : String(err)}`);
      return { revoked: 0, failed: 1 };
    }
  }

  /** Revocations a deprovisioning could not finish, retried before each run. */
  private async retryPendingRevocations(source: DirectorySourceKind, tenantId: string): Promise<void> {
    const store = this.deps.store();
    if (!store) return;
    for (const person of await store.listRevokePending(source, tenantId)) {
      const { failed } = await this.revoke(person);
      if (failed === 0) await store.clearRevokePending(person.id);
    }
  }

  /** `turnIdentityDirectory@1` — what the orchestrator asks per turn. */
  turnIdentityDirectory(): TurnIdentityDirectory {
    return {
      isAccountActive: async (userId) => (await this.deps.accountStatus(userId)) === 'active',
      activePersonKeyByObjectId: async (aadObjectId) => {
        const store = this.deps.store();
        if (!store || !GUID_RE.test(aadObjectId)) return undefined;
        return (await store.findActiveByObjectId(aadObjectId.toLowerCase()))?.externalId;
      },
      activePersonKeyById: async (personId) => {
        const person = await this.deps.store()?.findById(personId);
        return person?.status === 'active' ? person.externalId : undefined;
      },
    };
  }

  private schedule(key: string): void {
    if (!this.sources.has(key) || this.timers.has(key)) return;
    // Reads the CURRENT source: a reactivated plugin re-registers a new object.
    const runOnce = (): void => {
      const entry = this.sources.get(key);
      if (entry) void this.sync(entry.source.source, entry.source.tenantId);
    };
    // First run right after registration, off the activation path.
    setTimeout(runOnce, 0).unref?.();
    const timer = setInterval(runOnce, this.deps.intervalMs ?? DIRECTORY_SYNC_INTERVAL_MS);
    timer.unref?.();
    this.timers.set(key, timer);
  }
}
