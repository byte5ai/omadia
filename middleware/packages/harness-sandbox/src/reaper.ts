import type { SandboxRegistry } from './sandboxRegistry.js';

/**
 * Issue #576 P3 — reaper for orphaned (idle, non-persistent) sandboxes.
 *
 * ## The #709/#710 clock-race lesson, applied here
 *
 * `ipv6-bind-ipv4-dial-test-flake-pr703` / the #709 reaper-test race taught
 * this codebase that an idle-timeout check must anchor "now" to a clock
 * INDEPENDENT of the row being checked — never derive "now" from the same
 * field (or a sibling row's copy of it) you are comparing against, because
 * that makes the comparison self-referential and racy (a row updated
 * between "compute now" and "compare" moves the goalposts).
 *
 * `reapOrphanedSandboxes` therefore takes `now` as a REQUIRED, externally
 * supplied parameter (a plain `Date`, never `new Date()` computed inside
 * this function, never derived from `entries`). The caller's own clock is
 * the anchor; the entries are the thing being checked. Tests assert this
 * directly: an entry catalog and an independently-chosen `now` are passed
 * in, never the other way around.
 *
 * ## What counts as orphaned
 *
 * `profile.persistent === true` sandboxes are NEVER reaped by idle time —
 * that is the entire point of `persistent`. Only non-persistent entries
 * whose `lastUsedAt` is older than `now - idleThresholdMs` are candidates.
 */
export interface ReapOrphanedSandboxesOptions {
  readonly registry: SandboxRegistry;
  /** Tears down the backend-specific sandbox for a given `sandboxRef`. */
  readonly teardown: (sandboxRef: string) => Promise<void>;
  /** The clock anchor — see the module doc. Required, never defaulted to
   *  `new Date()` internally. */
  readonly now: Date;
  readonly idleThresholdMs: number;
}

export interface ReapOrphanedSandboxesResult {
  readonly reapedScopeKeys: readonly string[];
  /** Scope keys whose teardown call threw — left in the registry so a
   *  retry can find them again rather than losing track of a sandbox that
   *  may still be running. */
  readonly failedScopeKeys: readonly string[];
}

export async function reapOrphanedSandboxes(
  options: ReapOrphanedSandboxesOptions,
): Promise<ReapOrphanedSandboxesResult> {
  const entries = await options.registry.listAll();
  const cutoff = options.now.getTime() - options.idleThresholdMs;

  const reapedScopeKeys: string[] = [];
  const failedScopeKeys: string[] = [];

  for (const entry of entries) {
    if (entry.profile.persistent) continue;
    if (entry.lastUsedAt.getTime() >= cutoff) continue;

    try {
      await options.teardown(entry.sandboxRef);
      await options.registry.delete(entry.scopeKey);
      reapedScopeKeys.push(entry.scopeKey);
    } catch {
      // Best-effort: a teardown failure must not abort the sweep for the
      // remaining entries, and the registry row is deliberately LEFT so the
      // next sweep retries it rather than the sandbox becoming untracked.
      failedScopeKeys.push(entry.scopeKey);
    }
  }

  return { reapedScopeKeys, failedScopeKeys };
}
