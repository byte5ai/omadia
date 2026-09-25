/**
 * OB-61 / #1080 — keep the shared host `anthropicClient` + `llm` providers in
 * step with the orchestrator's vault key.
 *
 * The shared providers are built once at boot from `ANTHROPIC_API_KEY` (or ''
 * when the operator boots without it). OB-61 re-sourced them from the vault
 * after a key was entered, but its early return (`if (!key) return`) meant a
 * REMOVED key was never revoked: host-LLM consumers (plan-runner's gate,
 * LocalSubAgent inner calls, Teams, the builder) kept billing the deleted key
 * until a restart.
 *
 * The target key is: the vault key if one is stored, else the env key, else
 * ''. The env key stays a standing fallback credential for host consumers (the
 * builder already treats it that way); '' is exactly the unauthenticated
 * client a keyless boot builds. Nothing is rebuilt while the target equals the
 * key already applied, so a boot with the env key and an empty vault — or with
 * neither — is still a no-op.
 *
 * Calls are serialized: the admin reactivate path and the vault write listener
 * can both fire for one save, and a stale read must never be applied after a
 * newer one.
 */

export interface SharedAnthropicClientRefresherOptions {
  /** Current Anthropic key in the host-key vault scope, or undefined. */
  readonly readVaultKey: () => Promise<string | undefined>;
  /** Boot-time env key (`ANTHROPIC_API_KEY`), if any. */
  readonly envKey?: string;
  /** Build a client for `apiKey` ('' = unauthenticated) and swap it in. */
  readonly apply: (apiKey: string) => void;
  readonly log?: (message: string) => void;
  readonly logError?: (message: string, err: unknown) => void;
}

export interface SharedAnthropicClientRefresher {
  /** Re-read the vault and swap the shared client if its key changed. Never rejects. */
  refresh(): Promise<void>;
}

export function createSharedAnthropicClientRefresher(
  opts: SharedAnthropicClientRefresherOptions,
): SharedAnthropicClientRefresher {
  const envKey = opts.envKey?.trim() ?? '';
  const log = opts.log ?? ((m: string) => console.log(m));
  const logError =
    opts.logError ??
    ((m: string, err: unknown) =>
      console.error(m, err instanceof Error ? err.message : err));
  // The key currently baked into the shared providers — the boot client was
  // built from the env key (or '').
  let applied = envKey;
  let queue: Promise<void> = Promise.resolve();

  const runOnce = async (): Promise<void> => {
    try {
      const vaultKey = (await opts.readVaultKey())?.trim() ?? '';
      const target = vaultKey.length > 0 ? vaultKey : envKey;
      if (target === applied) return;
      opts.apply(target);
      applied = target;
      if (vaultKey.length > 0) {
        log(
          '[middleware] shared llm/anthropicClient sourced from the orchestrator vault key — host-LLM plugins (plan-runner gate, LocalSubAgent inner calls, Teams) now armed',
        );
      } else if (target.length > 0) {
        log(
          '[middleware] shared llm/anthropicClient revoked (no anthropic key in vault) — fell back to the ANTHROPIC_API_KEY env key',
        );
      } else {
        log(
          '[middleware] shared llm/anthropicClient revoked (no anthropic key in vault) — host-LLM calls are unauthenticated until a key is saved',
        );
      }
    } catch (err) {
      logError('[middleware] failed to refresh shared anthropic client from vault:', err);
    }
  };

  return {
    refresh() {
      const next = queue.then(runOnce);
      queue = next;
      return next;
    },
  };
}
