import type { SecretVault } from '../../secrets/vault.js';

/**
 * PreviewSecretBuffer — secret-field values per (user, draft) for the
 * Builder's Preview-Agent.
 *
 * Two operating modes:
 *
 *   - **In-memory only** (default): values live in heap, gone on restart.
 *     This is what tests use and what the original B.3-4a contract
 *     specified. `dropAll(user)` on logout wipes everything.
 *
 *   - **Vault-backed** (production wiring): a `SecretVault` is passed in;
 *     values are persisted to its encrypted store in addition to the
 *     in-memory cache, so they survive a middleware restart. Each
 *     (user, draft) gets its own vault namespace
 *     `<vaultPrefix>:<userEmail>:<draftId>` and is purged together when
 *     the user calls "Alle löschen" in the workspace drawer or the draft
 *     is deleted. The drawer makes it explicit that values stay across
 *     restarts but are still test-only — production plugins read their
 *     credentials from their own per-agent vault namespace via the
 *     RequiresWizard flow, never from this buffer.
 *
 * Lazy-load contract: the in-memory cache is authoritative once `warm()`
 * has been called for a (user, draft). Routes call `warm()` at the top of
 * their handler so the sync readers (`get`, `keys`, `has`) can stay sync —
 * if they had been turned async, the build callback inside PreviewCache
 * (`secretValues: buffer.get(...)`) would need to thread an await through
 * a synchronous "build closure" contract owned by the runtime.
 */

export interface PreviewSecretBufferDeps {
  /** When provided, set/drop also persist to the encrypted vault so
   *  values survive a middleware restart. */
  vault?: SecretVault;
  /** Vault-namespace prefix. Composed with userEmail + draftId to form
   *  one isolated namespace per (user, draft). Default 'core.builder-preview'. */
  vaultPrefix?: string;
}

const DEFAULT_VAULT_PREFIX = 'core.builder-preview';

export class PreviewSecretBuffer {
  private readonly byKey = new Map<string, Record<string, string>>();
  private readonly userIndex = new Map<string, Set<string>>();
  private readonly loaded = new Set<string>();
  private readonly vault: SecretVault | undefined;
  private readonly vaultPrefix: string;

  constructor(deps: PreviewSecretBufferDeps = {}) {
    this.vault = deps.vault;
    this.vaultPrefix = deps.vaultPrefix ?? DEFAULT_VAULT_PREFIX;
  }

  /**
   * Ensure the in-memory cache for one (user, draft) reflects the vault.
   * No-op when vault-less. Idempotent — second call for the same pair
   * returns immediately.
   */
  async warm(userEmail: string, draftId: string): Promise<void> {
    const key = makeKey(userEmail, draftId);
    if (this.loaded.has(key)) return;
    this.loaded.add(key);
    if (!this.vault) return;
    const ns = this.namespaceFor(userEmail, draftId);
    const keys = await this.vault.listKeys(ns);
    if (keys.length === 0) return;
    const values: Record<string, string> = {};
    for (const k of keys) {
      const v = await this.vault.get(ns, k);
      if (v !== undefined) values[k] = v;
    }
    this.byKey.set(key, values);
    this.indexUser(userEmail, draftId);
  }

  /** Replace the secret-values for one (user, draft). Empty object clears. */
  async set(
    userEmail: string,
    draftId: string,
    values: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.warm(userEmail, draftId);
    const key = makeKey(userEmail, draftId);
    const copy = { ...values };
    this.byKey.set(key, copy);
    this.indexUser(userEmail, draftId);
    if (this.vault) {
      const ns = this.namespaceFor(userEmail, draftId);
      // Replace semantics: purge the namespace, then write the new keys.
      // setMany is additive otherwise — leftover keys would survive a
      // user-driven removal.
      await this.vault.purge(ns);
      if (Object.keys(copy).length > 0) {
        await this.vault.setMany(ns, copy);
      }
    }
  }

  /** Returns a snapshot copy. Never returns null (always at least an empty object).
   *  Caller must have invoked `warm()` first when running in vault-backed mode. */
  get(userEmail: string, draftId: string): Readonly<Record<string, string>> {
    const stored = this.byKey.get(makeKey(userEmail, draftId));
    return stored ? { ...stored } : {};
  }

  /**
   * Buffered key set without leaking values. Caller must have invoked
   * `warm()` first when running in vault-backed mode — used by the
   * GET /preview/secrets status route.
   */
  keys(userEmail: string, draftId: string): readonly string[] {
    const stored = this.byKey.get(makeKey(userEmail, draftId));
    if (!stored) return [];
    return Object.keys(stored);
  }

  has(userEmail: string, draftId: string): boolean {
    return this.byKey.has(makeKey(userEmail, draftId));
  }

  /** Clear secrets for one draft. Returns whether anything was removed
   *  in-memory. The vault namespace is purged unconditionally. */
  async drop(userEmail: string, draftId: string): Promise<boolean> {
    await this.warm(userEmail, draftId);
    const key = makeKey(userEmail, draftId);
    const removed = this.byKey.delete(key);
    if (removed) {
      const drafts = this.userIndex.get(userEmail);
      drafts?.delete(draftId);
      if (drafts && drafts.size === 0) {
        this.userIndex.delete(userEmail);
      }
    }
    if (this.vault) {
      await this.vault.purge(this.namespaceFor(userEmail, draftId));
    }
    return removed;
  }

  /**
   * Wipe ALL drafts for one user (logout / session-end). Returns count
   * cleared in-memory. In vault-backed mode this only purges the drafts
   * the user touched in this process — drafts persisted in a previous
   * session and not re-opened stay in the vault until the user comes
   * back to them and clears explicitly. That's intentional: persistence
   * is the whole point.
   */
  async dropAll(userEmail: string): Promise<number> {
    const drafts = this.userIndex.get(userEmail);
    if (!drafts) return 0;
    let n = 0;
    for (const draftId of drafts) {
      if (this.byKey.delete(makeKey(userEmail, draftId))) n += 1;
      if (this.vault) {
        await this.vault.purge(this.namespaceFor(userEmail, draftId));
      }
    }
    this.userIndex.delete(userEmail);
    return n;
  }

  /** Wipe the in-memory cache. Vault is NOT touched — used at process
   *  shutdown / SIGTERM where heap is going away anyway. */
  clear(): void {
    this.byKey.clear();
    this.userIndex.clear();
    this.loaded.clear();
  }

  size(): number {
    return this.byKey.size;
  }

  sizeForUser(userEmail: string): number {
    return this.userIndex.get(userEmail)?.size ?? 0;
  }

  /** True iff the buffer is wired to a vault. Lets routes & UI describe
   *  the persistence story honestly to the user. */
  get persistent(): boolean {
    return this.vault !== undefined;
  }

  // -------------------------------------------------------------------------

  private namespaceFor(userEmail: string, draftId: string): string {
    return `${this.vaultPrefix}:${userEmail}:${draftId}`;
  }

  private indexUser(userEmail: string, draftId: string): void {
    let drafts = this.userIndex.get(userEmail);
    if (!drafts) {
      drafts = new Set<string>();
      this.userIndex.set(userEmail, drafts);
    }
    drafts.add(draftId);
  }
}

function makeKey(userEmail: string, draftId: string): string {
  return `${userEmail}::${draftId}`;
}
