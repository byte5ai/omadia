# 0225 — A channel account is linked to an omadia user only through the kernel, on an operator-issued pairing

## Status

Accepted

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers. The decision follows the recommendation of the wave 5 recheck for issue #1995 and can be reversed.

## Context and Problem Statement

The Telegram channel's pairing confirms "connected as <name>". In fact it binds the chat to
no one (#1995):

- The operator types a free-text "identity ID".
- The plugin stores the ID in its own store and never passes it to the kernel.
- Every turn runs as `telegram:<id>`.

Other channels have the same gap. An identity without a verified e-mail or an AAD object id
(Telegram, WhatsApp, iMessage) always gets its own 1:1 user cluster in the knowledge graph.
Nothing can join it to the omadia user who signs in to the web UI. `docs/cross-channel-memory.md`
(Proposed, not built) sketches a `mergeIdentities` capability for this.

The question has two parts. Should a pairing link a channel account to an existing omadia
user, or only allow the account to chat? If it links, who owns the link?

## Decision Drivers

- An operator who pairs a person means that person. The texts must be true, either way.
- Identity is the kernel's ([ADR-0110](0110-principal-is-a-typed-user-or-role.md)): a plugin must not be able to say "this turn is user X" on its own.
- A link widens what a channel account reaches: memory, datasets, `per_user` MCP tokens. It has to be a recorded operator decision.
- Plugins must not read the kernel's user table ([ADR-0016](0016-least-privilege-and-the-agent-envelope.md)).

## Considered Options

- **A — The kernel owns the link.** A plugin asks the kernel to link the channel identity it attests to a user. The operator picks that user from the kernel's user list. The kernel validates the user, records who linked whom, and joins the channel identity to that user's cluster.
- **B — The plugin owns the link** and states the omadia user on every turn.
- **C — No link: the pairing is a DM allow-list.** The texts are reworded to "allowed to chat".

## Decision Outcome

Chosen option: **A**.

- **The link lives in the kernel.** One recorded fact: `(channel kind, channel user id) → users.id`, with who linked it and when. The plugin keeps only its pairing token and its DM allow-list.
- **The operator issues it.** The pairing deep link carries a kernel-validated user id chosen from a user picker. It never carries free text. The plugin asks the kernel to link when the person opens the link. A user id the kernel does not know is refused.
- **The channel attests, the kernel decides.** The plugin states only the channel identity it received from the platform, as today. A linked identity resolves to the user's cluster in the knowledge graph. The kernel derives the turn's `omadiaUserId`, its principal and its MCP user key from that cluster. No plugin field names the omadia user.
- **Unlinking is a kernel operation too.** An unlinked identity gets its own 1:1 cluster again, and nothing it wrote while linked is moved.
- **Until the link exists, no channel claims one.** A plugin that has no kernel link says "allowed to chat", never "connected as".

### Consequences

- 🟢 **Good:** "Connected as Anna" becomes true. Anna's datasets and `per_user` MCP tokens are hers in Telegram too.
- 🟢 **Good:** One mechanism for every channel without a verified e-mail. The operator decision is recorded.
- 🔴 **Bad:** This needs a new knowledge-graph operation. Re-pointing an identity to another cluster does not exist in either backend today.
- 🔴 **Bad:** It needs a new kernel service for plugins: link, unlink, and a list of linkable users to back the picker.
- 🔴 **Bad:** It touches the turn identity derivation in the orchestrator.
- 🔴 **Bad:** Memory tiers stay keyed per channel (`telegram|<id>`). A linked account does not see the web user's memory until the cross-channel memory work decides that. This ADR does not.
- ⚪ **Neutral:** It is not implemented with this record. Telegram 0.8 still has the allow-list pairing; its texts are corrected in the plugin until the kernel seam ships.

## Pros and Cons of the Options

### A — Kernel owns the link

- 🟢 Identity stays in one place, and the link is an audited operator act.
- 🔴 It is the largest change of the three.

### B — Plugin owns the link

- 🟢 Small.
- 🔴 Any plugin could make its turns run as any user. That breaks ADR-0110 and the envelope.

### C — Allow-list only

- 🟢 Plugin-only, S-size.
- 🔴 The person and the operator never get what "pairing" promises. Every channel keeps a second, unlinked identity per person.

## More Information

- Issue: #1995. Plugin: byte5ai/omadia-channel-telegram (`src/adminRouter.ts`, `src/pairingStore.ts`, `handleStartWithToken`).
- Code that a link changes: `middleware/packages/harness-orchestrator/src/resolveTurnOwnerIdentity.ts`, and `resolveOrCreateChannelIdentity` in `harness-knowledge-graph-{neon,inmemory}`.
- Related: [ADR-0110](0110-principal-is-a-typed-user-or-role.md), [ADR-0032](0032-tool-caller-principal-is-the-conversation-form.md), [ADR-0145](0145-turn-origin-states-where-a-turn-came-from.md), [ADR-0162](0162-scope-id-typed-session-scope.md), [ADR-0113](0113-sign-in-providers-behind-one-contract-and-a-single-admin-role.md) (no account linking between sign-in providers), `docs/cross-channel-memory.md`.
- Border: channels / identity.
