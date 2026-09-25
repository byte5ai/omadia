/**
 * #1080 — write notifications for the concrete secret vaults.
 *
 * The kernel caches things that are DERIVED from vault credentials: the LLM
 * provider pool memoises a built provider (or a negative "no key" answer) per
 * provider id, and the shared host `anthropicClient` holds the key it was
 * built with. Neither saw a key change, so saving a key after a keyless boot
 * never armed the orchestrator and removing one revoked nothing.
 *
 * Several paths write credentials without passing a common helper (the admin
 * settings save, the runtime-secrets PATCH, install-time `setMany`, uninstall
 * `purge`, the OAuth token-store persist binding, the Spec-005 OAuth broker),
 * so the vault itself is the one place every write crosses. The observer is
 * deliberately NOT part of the `SecretVault` interface: plugins and route
 * handlers keep the narrow read/write contract, only the kernel subscribes on
 * the concrete instance it owns.
 */

/** One completed vault mutation. Values are never carried — only key names. */
export type SecretVaultWriteEvent =
  | {
      /** The vault namespace (agent / plugin id) that changed. */
      readonly scope: string;
      /** The keys that were set or deleted. Never empty. */
      readonly keys: readonly string[];
    }
  | {
      readonly scope: string;
      /** The whole namespace was dropped (uninstall). */
      readonly purged: true;
    };

export type SecretVaultWriteListener = (event: SecretVaultWriteEvent) => void;

/**
 * Tiny synchronous fan-out. A listener runs inside the write call, before the
 * write's promise settles, so a caller that awaits the write and THEN
 * reactivates a plugin is guaranteed to see the derived caches already
 * dropped. A throwing listener is logged and skipped: an observer must never
 * be able to fail a credential write.
 */
export class VaultWriteEmitter {
  private readonly listeners = new Set<SecretVaultWriteListener>();

  on(listener: SecretVaultWriteListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: SecretVaultWriteEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.warn(
          `[vault] write listener failed for scope ${event.scope}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}
