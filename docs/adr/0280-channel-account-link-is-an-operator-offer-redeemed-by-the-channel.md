# 0280 — A channel-account link is an operator offer the channel redeems; the fact lives on the identity node

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers. Implements [ADR-0225](0225-channel-account-links-to-an-omadia-user-only-through-the-kernel.md) for #1995; decided after the wave 6 recommendation and can be reversed.

## Context and Problem Statement

ADR-0225 decided that the kernel owns the link from a channel account (Telegram, …) to an
omadia account, that an operator issues it from a user picker, and that turns of a linked
account run as that account. It left the contract open:

- How does a plugin ask for a link without being able to name the user or the operator itself?
- Where is the link recorded, so that both graph backends and the turn path read it?
- Which turns change, and which keep their current identity?

## Decision Drivers

- The plugin must not be able to say "this channel user is account X" on its own
  ([ADR-0110](0110-principal-is-a-typed-user-or-role.md), [ADR-0016](0016-least-privilege-and-the-agent-envelope.md)).
- The operator act is the decision; who made it must be traceable ([ADR-0100](0100-admin-audit-trail-one-actor-rule.md)).
- The person must prove control of the channel account (the operator cannot type a Telegram id).
- No change for every unlinked channel user: their datasets and keys sit under today's ids.
- Both graph backends, in-memory and Neon, behave the same.

## Considered Options

- **A — Offer and redeem through a per-plugin `CoreApi` capability; the link is a fact on the `ChannelIdentity` node.**
- **B — A kernel table `channel_identity_links` plus the same `CoreApi` capability.**
- **C — A plugin-facing service in the registry (`channelIdentityLinks@1`), with the channel kind passed by the plugin.**

## Decision Outcome

Chosen option: **A**.

- **Contract.** `CoreApi.channelIdentityLinks` (channel-sdk 0.3.19, optional,
  feature-detected): `listLinkableAccounts(cookie)`, `offerLink(cookie, { channelType, userId })`,
  `redeemLink({ channelType, channelUserId, offerId })`, `linkOf(...)`, `unlink(cookie, ...)`.
  `scopeCoreApiToChannel` binds it to the plugin: a channel type another plugin holds is
  refused (`unsupported_channel`). `web` and `api` cannot be linked; they are accounts or keys.
- **The operator is resolved by the kernel.** Operator acts take the raw `Cookie` header of
  the plugin's admin request; the kernel resolves the session through the same path as
  `ctx.operatorAuth` (ADR-0106). No valid session → `no_session`. The plugin never names the
  actor.
- **Offer, then redeem.** An offer names one active account (`users.status = 'active'`),
  lives at most 15 minutes in kernel memory, and is single-use (a failed redeem uses it up
  too). The channel redeems it with the sender the platform attested (Telegram: the sender
  of `/start <token>`). `channelUserId` is the id the channel's turns carry as
  `ChatTurnInput.userId` (`telegram:<id>`), because that id keys the sender's identity.
- **The fact lives on the identity node.** `KnowledgeGraph.linkChannelIdentity`
  (plugin-api 1.107.0, kernel-only, both backends) moves the `ChannelIdentity` to the
  account's User-Cluster (the cluster of `web:<users.id>`, created like a login would,
  without an IdP subject, with the AAD object id for an Entra account) and stores `linkedUserId`, `linkedBy`, `linkedAt` on it.
  `resolveOrCreateChannelIdentity` returns `linkedUserId`. Unlink gives the identity a fresh
  1:1 cluster and removes the props. Nothing the identity wrote is moved either way.
- **Audit first.** Redeem writes `channel_identity.link` (actor: the offering operator),
  unlink `channel_identity.unlink` (actor: the session), before the graph changes. Without an
  audit store (no Postgres) the kernel refuses to offer (`unavailable`).
- **Only linked turns change.** `resolveTurnOwnerIdentity` resolves a plugin channel turn's
  sender (stated through `origin`) once. Linked: `omadiaUserId`, `principal` and
  `authSubjectKey` come from the account's cluster, and `channelTurnMcpUserKey` keys
  `per_user` MCP tokens on it. Unlinked, joined by e-mail or AAD, or on a graph failure: the
  turn keeps its raw id, as before. The same resolution is reused as the run-trace owner.
  Memory tiers and the tool caller (`user:<channel user id>`, ADR-0032) stay per channel.

### Consequences

- 🟢 **Good:** A plugin cannot link, unlink or choose an actor without an operator session, and cannot offer, redeem or unlink links of another channel's accounts.
- 🟢 **Good:** No migration; the in-memory backend links like Neon. The user purge (ADR-0186) removes linked identities with the cluster.
- 🔴 **Bad:** Offers do not survive a restart; the operator issues a new pairing (the Telegram pairing token does not survive one either).
- 🔴 **Bad (accepted):** The turn path trusts the channel plugin's attestation, as it already does for a Teams `userRef`. The kernel does not check that the calling plugin holds `origin.channelType`, so an installed channel plugin that forges `origin.channelType` and `userId` of a linked account runs as that account, with its `per_user` MCP key. Channel plugins are operator-installed code; closing this needs the kernel to stamp the origin channel type per plugin (#2324).
- 🔴 **Bad (accepted):** Disabling an account does not unlink it. `linkOf` then reports no link, but turns of the channel account still run as the account's cluster until an operator unlinks it. Deleting the account with the user purge removes the link.
- ⚪ **Neutral:** Telegram is the first adopter (omadia-channel-telegram 0.9.0). Slack, Discord and WhatsApp can use the same capability.

## Pros and Cons of the Options

### A — Offer/redeem on `CoreApi`, fact on the identity node

- 🟢 The channel-type binding already exists (`ChannelTypeClaims`, ADR-0135).
- 🟢 The turn path already resolves the identity node; reading the link costs nothing extra.
- 🔴 The link is only as durable as the graph backend.

### B — Separate kernel table

- 🟢 Survives a graph-backend switch.
- 🔴 Two records of one fact that can disagree; the turn path in `@omadia/orchestrator` has no database access.

### C — Registry service with a plugin-stated channel kind

- 🟢 Familiar `ctx.services` shape.
- 🔴 The registry does not know the caller, so any plugin could link accounts of any channel.

## More Information

- Code: `middleware/src/channels/channelIdentityLinks.ts`, `scopedCoreApi.ts`,
  `packages/harness-channel-sdk/src/channelIdentityLinks.ts`,
  `packages/harness-orchestrator/src/resolveTurnOwnerIdentity.ts`,
  `linkChannelIdentity` in `harness-knowledge-graph-{inmemory,neon}`.
- Tests: `test/channelIdentityLinks.test.ts`, `test/channelIdentityLink{,.pg}.test.ts`,
  `test/resolveTurnOwnerLinkedIdentity.test.ts`.
- Related: [ADR-0225](0225-channel-account-links-to-an-omadia-user-only-through-the-kernel.md), [ADR-0032](0032-tool-caller-principal-is-the-conversation-form.md), [ADR-0135](0135-channel-plugin-contract-and-channel-type-ownership.md), [ADR-0182](0182-web-and-api-turns-carry-an-account-or-key-origin.md), [ADR-0186](0186-user-purge-erases-one-person.md).
- Border: channels / identity.
