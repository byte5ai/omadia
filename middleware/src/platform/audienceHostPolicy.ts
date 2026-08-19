/**
 * #575 — "may the current room reach this host?", for the per-plugin HTTP
 * accessor.
 *
 * The issue asks for egress as "allowlist = intersection of allowed hosts,
 * deny = union of denied hosts". This delivers the **deny half**, and the
 * asymmetry in what is shipped is deliberate rather than partial work — see
 * below.
 *
 * ## Why prohibitions can land now and the intersection cannot
 *
 * Outbound hosts are granted by a plugin's **manifest**, not by the grant
 * store: `permissions.network.outbound` is what an operator approved at install
 * time, and `createHttpAccessor` already enforces it. So the two directions are
 * not symmetric here:
 *
 *  - A **prohibition** composes cleanly with that list. It can only narrow it,
 *    it only applies where an operator explicitly wrote one, and a deployment
 *    that has written none is unaffected.
 *  - An **intersection** would need the floor to carry positive host grants for
 *    every host every plugin may legitimately reach. Applying it before those
 *    grants exist would reduce every room's effective allow-list to the empty
 *    set — every plugin's HTTP calls refused, everywhere, the moment the floor
 *    is switched on. That is the same failure the grant store's boot refusal
 *    exists to prevent, and shipping it "for completeness" would make the
 *    feature unusable rather than more complete.
 *
 * The intersection also needs something the floor does not expose yet: whether
 * host policy was expressed *anywhere in the audience*. `AudienceFloor` carries
 * the already-intersected capability set, so "no `net:` token survived" cannot
 * be told apart from "nobody ever granted one" — the same distinction that made
 * `denied` a separate field on the floor. Stated here so the remaining half is
 * visible rather than assumed.
 *
 * ## Asked per request, never captured
 *
 * `ctx.http` is built once when a plugin activates; the audience changes within
 * a turn. A denial resolved at construction time would be a snapshot of a room
 * that may no longer exist — the same TOCTOU argument that makes the egress
 * guard re-evaluate per tool call (spec §5.2).
 */

import { floorDeniesHost, type AudienceFloor } from '@omadia/channel-sdk';
import { turnContext } from '@omadia/orchestrator';

/**
 * Resolve the current turn's floor and ask whether it forbids `host`.
 *
 * Returns `false` — not enforced — when no audience provider is installed,
 * which is every deployment that has not opted into the floor. "Nobody
 * configured this" must never read as "closed"; that rule is what keeps the
 * whole cluster from disabling itself in deployments that never asked for it.
 *
 * A provider that THROWS is the opposite case and denies: the deployment did
 * opt in, and an unresolvable audience must fail closed.
 */
export async function audienceDeniesHost(host: string): Promise<boolean> {
  const provider = turnContext.current()?.audienceFloor;
  if (!provider) return false;

  let floor: AudienceFloor;
  try {
    floor = await provider();
  } catch (err) {
    console.warn(
      `[platform] outbound host '${host}' refused — audience unresolvable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return true;
  }

  const denied = floorDeniesHost(floor, host);
  if (denied) {
    console.warn(`[platform] outbound host '${host}' refused by the audience floor`);
  }
  return denied;
}
