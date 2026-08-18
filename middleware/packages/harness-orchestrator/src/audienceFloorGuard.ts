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
 * The capability recalling prior context into the prompt requires.
 *
 * One flat token rather than a per-item permission, and that is a measured
 * limitation rather than a shortcut — see {@link guardContextRecall}.
 */
export const MEMORY_RECALL_CAPABILITY: Capability = 'memory:recall';

/**
 * The capability resolving a stored attachment handle requires.
 *
 * Separate from `tool:read_attachment` on purpose. That one asks "may this room
 * invoke the read tool"; this one asks "may this room redeem a storage handle",
 * and the handle is redeemable from paths that are not tool calls at all — see
 * {@link guardAttachmentRead}.
 */
export const ATTACHMENT_READ_CAPABILITY: Capability = 'attachment:read';

/**
 * #575 — the third guard: file / credential handle resolution.
 *
 * ## Why this is not already covered by the egress guard
 *
 * `read_attachment` is a tool, so it passes `dispatchTool` and Guard 1 does
 * bound it. But that is not the only way a handle gets redeemed: the
 * orchestrator's own `ingestAttachments` resolves storage keys straight off the
 * inbound turn, with no tool call in sight. Guarding only the tool would leave
 * the path a caller actually controls wide open.
 *
 * ## Why the check rides with the handle rather than sitting at call sites
 *
 * Spec §5.2 says the check "must ride with" the handle, because a handle
 * outlives the turn that minted it. A storage key issued in a private chat is
 * just a string, and a string can be pasted into a group chat. Adding a call to
 * every resolution site would work exactly until somebody adds the next site
 * and forgets — so the enforcement lives in a wrapper around `AttachmentReader`
 * itself (`attachmentReaderFactory.ts`). Every consumer, present and future, is
 * covered by construction.
 *
 * ## What this function does NOT do — and what now does it
 *
 * It checks the floor **at redemption**: may this room redeem a handle at all.
 * That leaves a handle minted in a narrow room redeemable by any room that
 * happens to hold the capability, because a storage key is just a string.
 *
 * That second half is no longer open, but it is deliberately NOT here:
 * `attachmentBinding.ts` pins each key to the `ScopeId` it was first resolved
 * in, and the reader wrapper enforces both checks in order. Two separate
 * questions — *may this room read attachments* and *was this handle minted
 * here* — kept in two places, because collapsing them would make a capability
 * answer look like an identity answer.
 *
 * The residual gap, stated rather than assumed closed: a handle first resolved
 * from a **non-addressable** scope (`'http-default'`, `teams-unknown`, a system
 * scope) is not bound at all, because those strings identify no room. See
 * `attachmentBinding.ts` for why approximating there would be worse than
 * standing down.
 */
export async function guardAttachmentRead(): Promise<string | undefined> {
  const provider = turnContext.current()?.audienceFloor;
  if (!provider) return undefined;

  let floor: AudienceFloor;
  try {
    floor = await provider();
  } catch (err) {
    return `audience unresolvable (${err instanceof Error ? err.message : String(err)})`;
  }

  if (floorPermits(floor, ATTACHMENT_READ_CAPABILITY)) return undefined;

  return floor.outcome === 'closed'
    ? floor.reason
    : 'not every participant in this conversation may read stored attachments';
}

/**
 * #575 — the second guard: context / memory recall.
 *
 * ## Why this one SNAPSHOTS while egress re-computes
 *
 * Decision **D4** splits by reversibility. Once recalled context has been
 * rendered into the prompt it cannot be un-sent, so re-filtering it later in
 * the turn is theatre. This guard therefore evaluates the floor **once**, at
 * the moment of recall, and that answer stands for the assembled context. The
 * egress guard does the opposite because an unfired tool call can still be
 * refused.
 *
 * ## Why it is one gate and not a per-item, per-recipient filter
 *
 * Spec §5.2 asks for "per retrieval, per recipient", and that is the right
 * target. It is not what this wires, because two of its preconditions do not
 * exist in the tree today, and pretending otherwise would ship a filter that
 * only looks like one:
 *
 *  1. **There is no per-recipient render.** Context is assembled once per turn
 *     into a single prompt string; every participant sees the same model reply
 *     derived from it. Until output is rendered per person, "the context for
 *     Alice" has nowhere to go.
 *  2. **Recalled items carry no capability labels.** The retriever returns
 *     turns and memories from the knowledge graph with scores and scopes, not
 *     entitlements. There is nothing per item to check against, so a per-item
 *     filter would have to invent a labelling scheme — policy, and not this
 *     layer's to invent.
 *
 * What IS enforceable today is the honest reduction of the same rule: in a
 * shared room the recalled context reaches everyone present, so the room may
 * only recall what **everyone** present may read. That is exactly the
 * intersection, applied to one capability.
 *
 * ## A denial here is a skip, not an error
 *
 * Unlike a refused tool call, a refused recall has a natural degraded mode: the
 * turn proceeds without prior context, which is precisely what already happens
 * when no retriever is configured. So this returns a *reason to log*, and the
 * caller takes its existing "skip recall" path rather than surfacing anything
 * to the model. Turning a missing memory into an error would make a policy
 * decision look like a fault.
 *
 * Returns `undefined` when recall may proceed — including when no audience
 * provider is installed, for the same "not enforced ≠ closed" reason spelled
 * out at the top of this file.
 */
export async function guardContextRecall(): Promise<string | undefined> {
  const provider = turnContext.current()?.audienceFloor;
  if (!provider) return undefined;

  let floor: AudienceFloor;
  try {
    floor = await provider();
  } catch (err) {
    return `audience unresolvable (${err instanceof Error ? err.message : String(err)})`;
  }

  if (floorPermits(floor, MEMORY_RECALL_CAPABILITY)) return undefined;

  return floor.outcome === 'closed'
    ? floor.reason
    : 'not every participant in this conversation may read recalled context';
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
