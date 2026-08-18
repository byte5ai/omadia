import { floorPermits, type AudienceFloor, type Capability } from '@omadia/channel-sdk';

import { turnContext } from './turnContext.js';

/**
 * #575 — the egress guard: the first of the audience floor's three call sites.
 *
 * `audienceFloor.ts` in the channel SDK computes *what this room may do*. This
 * is where that answer is enforced for outbound effects, and it is deliberately
 * the ONLY thing in the orchestrator that knows about the floor — the other two
 * guards (context retrieval, handle resolution) share the same intersection
 * function rather than re-deriving one.
 *
 * ## Why per call, and not once per turn
 *
 * Spec §5.2: a turn-start snapshot is a TOCTOU hole. Somebody can join the
 * conversation between the model deciding to call a tool and the call actually
 * firing, and the floor must have narrowed by then. So the provider is invoked
 * **per dispatch**, which is affordable because `audienceFloor` is pure and the
 * expensive part (resolving the roster) is the provider's own business to cache
 * within a turn.
 *
 * This is also the half of decision **D4** that re-evaluates. Rendered context
 * cannot be un-sent so the context guard snapshots; an outbound call that has
 * not fired yet can still be refused, so this one recomputes.
 *
 * ## Absent provider means the feature is OFF, not that the floor is CLOSED
 *
 * This distinction is the whole reason introducing the guard does not break
 * every existing deployment, and getting it wrong would be spectacular: a
 * `closed` floor denies everything, so treating "nobody configured an audience
 * source" as `closed` would silently disable every tool in every turn.
 *
 * The precedent is right next door. `turnContext.privacyHandle` is documented as
 * "undefined when no provider is installed (then tool results flow through
 * unmodified)" — the same shape, for the same reason. So:
 *
 *  - **no provider** → not enforced. There is no floor, because nobody asked
 *    for one.
 *  - **provider present, floor `closed`** → refuse. The deployment opted in and
 *    the audience could not be established, which §5.1 says must fail closed.
 *
 * "Unknown audience" only means "deny" once somebody has said they want the
 * room bounded at all.
 *
 * ## A refusal is a tool result, not an exception
 *
 * It reads back to the model the way the dispatch deadline does — a plain
 * `Error: …` string in the tool's result slot. Throwing would abort the turn,
 * which turns a policy decision into an outage and denies the model the chance
 * to explain the refusal or take another route.
 */

/**
 * Resolves the floor for the current turn. Installed by whatever knows how to
 * enumerate the audience; absent in every deployment that has not opted in.
 */
export type AudienceFloorProvider = () => Promise<AudienceFloor>;

/**
 * The capability a tool dispatch requires.
 *
 * `tool:<name>` — a flat namespace on purpose. Capabilities are opaque tokens
 * (see `audienceFloor.ts`), and the grant store is what decides which of them a
 * role confers; encoding structure here would put policy in the wrong layer.
 */
export function toolCapability(name: string): Capability {
  return `tool:${name}`;
}

/**
 * Check whether the current audience permits dispatching `name`.
 *
 * Returns `undefined` when the call may proceed — including when no provider is
 * installed — or the refusal string to hand back as the tool's result.
 *
 * A provider that throws is treated as a closed floor rather than an open one:
 * the deployment asked for the room to be bounded, and an audience source that
 * blew up has not bounded it. That is the same reasoning as `partial` in #333
 * and `unresolved` in the floor itself, and it is the opposite of the
 * `privacyHandle` precedent for a reason — privacy degrades to "unmodified"
 * because its failure mode is over-sharing detail, while this one's failure
 * mode is performing an effect nobody authorized.
 */
export async function guardToolEgress(name: string): Promise<string | undefined> {
  const provider = turnContext.current()?.audienceFloor;
  if (!provider) return undefined;

  let floor: AudienceFloor;
  try {
    floor = await provider();
  } catch (err) {
    return audienceRefusal(
      name,
      `the audience could not be resolved (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (floorPermits(floor, toolCapability(name))) return undefined;

  return audienceRefusal(
    name,
    floor.outcome === 'closed'
      ? floor.reason
      : 'not every participant in this conversation is permitted to use it',
  );
}

/**
 * The refusal text. Names the tool and the reason, and tells the model what to
 * do next — an unexplained denial produces a retry loop against a wall.
 */
function audienceRefusal(name: string, reason: string): string {
  return `Error: tool \`${name}\` was refused for this conversation — ${reason}. This is a permission boundary, not a transient failure: retrying will not help. Continue without it, or tell the user which participants would need access.`;
}
