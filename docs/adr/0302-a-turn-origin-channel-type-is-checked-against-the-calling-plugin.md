# 0302 — A turn origin's channel type is checked against the calling plugin; a link to a disabled account is not applied

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers (wave 7, W40; issue #2324). Closes the two risks [ADR-0280](0280-channel-account-link-is-an-operator-offer-redeemed-by-the-channel.md) accepted on purpose; decided after the wave 7 recommendation and can be reversed.
- **Supersedes:** —

## Context and Problem Statement

A plugin channel turn names its sender only through `origin.channelType` and `userId`.
[ADR-0280](0280-channel-account-link-is-an-operator-offer-redeemed-by-the-channel.md) runs a
linked sender as the linked account, with its `per_user` MCP key, and
[ADR-0300](0300-entra-directory-people-anchor-channel-identities-and-per-person-tokens.md) gives a
Teams sender the person key of a directory person. Both trust the stated channel type. The kernel
did not check that the calling plugin serves that type: any installed plugin could state
`teams` and a known object id, or `telegram` and a linked id, and run as that person. The
plugin-supplied `IncomingTurn.channelId` was not checked either, so the reserved `api` origin
of [ADR-0182](0182-web-and-api-turns-carry-an-account-or-key-origin.md) could be claimed by
naming the API channel's id. Separately, disabling an account left its channel links working.

## Decision Drivers

- The channel-type ownership of [ADR-0135](0135-channel-plugin-contract-and-channel-type-ownership.md)
  (first claim wins, `ChannelTypeClaims`) is the one statement of which plugin serves which type.
- The kernel knows the calling plugin of every service and CoreApi call; the plugin must not
  name itself.
- A disabled account names nobody ([ADR-0113](0113-sign-in-providers-behind-one-contract-and-a-single-admin-role.md));
  re-enabling should restore what it had.

## Considered Options

- **A — Wrap the entry points per calling plugin; check account status in the turn path.**
- **B — Stamp the origin in every plugin** (plugin-side change, no kernel check).
- **C — Unlink on account disable.**

## Decision Outcome

Chosen option: **A**.

- **Per-caller entry points.** `chatAgent@1` and `channelResolver@1` are handed out per
  calling plugin (`decorateOnProvide` + `perCallerService`). Their `chat` / `chatStream`, and
  the `chatAgent` of every resolver answer, drop an `origin` whose channel type the caller does
  not hold, and likewise a `channelIdentity` of a channel kind it does not hold, before the turn
  runs (`turnOriginGuard.ts`). A plugin gets only the guarded `agent` of the bundle (the part
  `ChatAgentBundle` types); the raw orchestrator and the stores stay the kernel's. "Holds" is what the plugin claimed, else
  what its manifest derives (`channelTypesOfPlugin`). `http` is never allowed, `api` only for
  `@omadia/channel-api`. The kernel's own reads are not wrapped; the dispatcher already checks.
  A dropped origin is a `[security-audit]` log line; the turn runs context-free.
- **`CoreApi.handleTurnStream`.** The plugin's scoped CoreApi stamps `channelId` with the
  plugin's own id, drops an origin of another plugin's channel type, and refuses a turn whose
  `userRef.kind` attests another plugin's channel (`teams-aad` → `teams`, …).
- **Disabled accounts.** `resolveTurnOwnerIdentity` asks the kernel's
  `turnIdentityDirectory@1` (handed out to the orchestrator only) whether a linked account is
  active. A disabled or deleted account, or a failed lookup, is not applied: an origin-stated
  turn runs as the raw channel id, as an unlinked one; a turn with a dispatcher-minted
  `channelIdentity` (already in the account's cluster) gets no identity at all. The link itself
  stays and works again when the account is enabled. Without a users table (no database) there
  are no links to apply.

### Consequences

- 🟢 **Good:** An installed plugin can no longer run turns as a linked account or a directory
  person of a channel it does not serve.
- 🟢 **Good:** Disabling an account stops its channel accounts at once, and re-enabling restores
  them without an operator re-linking.
- 🔴 **Bad:** A plugin that is not a channel but stated an origin (none known) loses it; its
  turns run context-free.
- 🔴 **Bad:** The first plugin to claim a channel type still owns it (ADR-0135): a malicious
  plugin activated before the real channel plugin can claim `teams`. Plugins remain
  operator-installed code.
- ⚪ **Neutral:** One account-status read per linked turn.

## Pros and Cons of the Options

### A — Per-caller wrapping and a status check

- 🟢 Uses facts the kernel already has; no plugin change.
- 🔴 Two proxies on hot entry points.

### B — Plugin-side stamping

- 🔴 Trusts the plugin it is meant to check.

### C — Unlink on disable

- 🟢 No read per turn.
- 🔴 Re-enabling loses the links; every other path to a disabled account (a direct database
  change) is missed.

## More Information

- Code: `middleware/src/channels/turnOriginGuard.ts`, `middleware/src/channels/scopedCoreApi.ts`,
  `middleware/packages/harness-orchestrator/src/resolveTurnOwnerIdentity.ts`
  (`TurnIdentityDirectory`), `middleware/src/directory/directoryService.ts`.
- Related: [ADR-0145](0145-turn-origin-states-where-a-turn-came-from.md), [ADR-0053](0053-service-access-by-declaration-one-provider-per-capability.md), [ADR-0225](0225-channel-account-links-to-an-omadia-user-only-through-the-kernel.md).
- Border: channels / identity.
