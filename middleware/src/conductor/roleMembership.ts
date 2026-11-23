/**
 * Spec 2042 §5.3 (availability) — "does this person hold this group?" for the
 * management layer's availability check, answered synchronously from a
 * snapshot of the Conductor's roles.
 *
 * The router decides before every turn and cannot await a directory, so the
 * holders of every role are read into memory: every 30 s, and at once after a
 * role or assignment write of this process (`ConductorRoleStore.onChange`).
 * Holders come from the Conductor's `RoleHolderRegistry`: the local
 * assignment table plus every holder source the operator activated.
 *
 * Fail closed:
 *  - a role whose lookup was partial (one source did not answer) has NO
 *    members in the snapshot: an availability entry `role:<key>` then admits
 *    nobody, never a guessed set;
 *  - a failed refresh keeps the last snapshot (a role that was complete stays
 *    as it was) — the alternative, dropping every role at once, would lock
 *    everyone out on one database hiccup;
 *  - before the first refresh nobody holds any role.
 *
 * Principals are compared in their canonical form (`user:<id>`, trim +
 * lowercase); a role key is matched as written (trim only), as the Conductor
 * stores it.
 */

import { canonicalizePrincipalRef, parsePrincipal, type AggregateHolderLookup } from '@omadia/channel-sdk';

export const ROLE_MEMBERSHIP_REFRESH_MS = 30_000;

export interface RoleMembershipDeps {
  /** Every role key the Conductor knows. */
  readonly listRoleKeys: () => Promise<readonly string[]>;
  /** The Conductor's holder resolution (`RoleHolderRegistry.resolveHolders`). */
  readonly resolveHolders: (roleKey: string) => Promise<AggregateHolderLookup>;
  readonly intervalMs?: number;
  readonly log?: (message: string) => void;
}

export class RoleMembershipSnapshot {
  private members: ReadonlyMap<string, ReadonlySet<string>> = new Map();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private again = false;

  constructor(private readonly deps: RoleMembershipDeps) {}

  /** The router's `RoleMembership`: does `principal` (`user:<id>`) hold `roleKey`? */
  readonly hasRole = (principal: string, roleKey: string): boolean => {
    const parsed = parsePrincipal(principal);
    if (parsed?.kind !== 'user') return false;
    return this.members.get(roleKey.trim())?.has(parsed.userId) === true;
  };

  /**
   * Re-read every role. Calls while one runs coalesce into one more run after
   * it, so the last change is never missed and a burst costs two reads.
   */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.load().finally(() => {
      this.running = undefined;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.running;
  }

  /** Start the periodic refresh (unref'd: it never keeps the process alive). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), this.deps.intervalMs ?? ROLE_MEMBERSHIP_REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async load(): Promise<void> {
    let keys: readonly string[];
    try {
      keys = await this.deps.listRoleKeys();
    } catch (err) {
      this.deps.log?.(`[roles] membership refresh failed, keeping the last snapshot: ${String(err)}`);
      return;
    }
    const next = new Map<string, ReadonlySet<string>>();
    for (const key of keys) {
      try {
        const lookup = await this.deps.resolveHolders(key);
        // Partial = not every source answered: nobody is a member.
        if (lookup.partial) continue;
        next.set(key.trim(), new Set(lookup.holders.map((h) => canonicalizePrincipalRef('user', h))));
      } catch (err) {
        this.deps.log?.(`[roles] holders of '${key}' could not be resolved; nobody holds it for now: ${String(err)}`);
      }
    }
    this.members = next;
  }
}
