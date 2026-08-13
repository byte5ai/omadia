/**
 * Issue #439 — the storage surface this package needs, expressed structurally.
 *
 * The stores originally typed their dependency as `SecretsAccessor` from
 * `@omadia/plugin-api`. That would make this package depend on the plugin
 * contract package purely to name four methods, and would drag every kernel
 * consumer of `requireApiKey` into that dependency too. A structural subset
 * keeps the package dependency-free; `SecretsAccessor` (and the kernel's own
 * vault accessors) satisfy it without any adapter, because TypeScript
 * structural typing already accepts the wider interface.
 */
export interface ApiKeySecretStorage {
  /** Returns the stored value, or undefined if absent. */
  get(key: string): Promise<string | undefined>;
  /** Keys present in this namespace. Never returns values. */
  keys(): Promise<string[]>;
  /** Present only on a write-capable accessor — guard before use. */
  set?(key: string, value: string): Promise<void>;
  /** Present only on a write-capable accessor — guard before use. */
  delete?(key: string): Promise<void>;
}
