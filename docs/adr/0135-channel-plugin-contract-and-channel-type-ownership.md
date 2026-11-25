# 0135 — Channels are plugins behind one kernel contract; a channel type belongs to the plugin that claimed it first

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); per-plugin
  `CoreApi` view from #2092, extended in #2142
- **Supersedes:** —

## Context and Problem Statement

Teams, Telegram, Slack, Discord, WhatsApp, the public HTTP API and the canvas UI all bring
messages in and answers out. Each of them is an independently versioned plugin (most live in
their own repositories), yet the kernel has to route their turns, mount their HTTP routes, take
them down without a restart, and trust what they report about who wrote what. This record is
retroactive: it states the contract the code on main already implements. What does a channel
plugin get from the kernel, and what stops one channel plugin from acting for another?

## Decision Drivers

- Agents stay channel-agnostic: no Teams, Slack or Telegram shape leaks into the core.
- A channel can be installed, upgraded and deactivated at runtime without an Express restart.
- An inbound message event is the kernel's authoritative record of authorship; a second plugin
  must not be able to state it for a channel type it does not serve.
- Old channel plugins keep loading against a newer kernel, and new ones against an older kernel.

## Considered Options

- **A — One `ChannelPlugin.activate(ctx, core)` contract; the kernel owns routing, mounts and
  ownership; capabilities are optional and feature-detected.**
- **B — Channel adapters compiled into the kernel** (one module per platform).
- **C — Channels mount their own Express routes and call the orchestrator directly.**

## Decision Outcome

Chosen option: **A**.

- **The contract.** A channel package exports `ChannelPlugin.activate(ctx, core)` and returns a
  `ChannelHandle` whose `close()` releases everything
  (`middleware/packages/harness-channel-sdk/src/plugin.ts`). `CoreApi` is all it calls:
  `handleTurnStream(turn)`, `registerRoute`, `registerRouter`, `resolveIdentity`, `log`, and
  optional capabilities such as `registerWebSocket` and `registerRosterProvider`.
- **Semantic contracts both ways.** A turn goes in as `IncomingTurn` and comes back as
  `ChatStreamEvent`s or a folded `SemanticAnswer`; the plugin translates to Adaptive Cards,
  Block Kit or inline keyboards. Outgoing types change additively within a major
  (`outgoing.ts`: "additive changes only within a major").
- **Optional means feature-detected.** Every capability added after the first contract is an
  optional method; a channel checks `typeof core.registerWebSocket === 'function'` before use
  (`coreApi.ts`). The kernel never assumes a plugin implements a newer provider either.
- **Mount once, switch off by flag.** Express cannot unregister a route, so
  `ExpressRouteRegistry` mounts each channel route once and reads the handler from a mutable
  record plus a per-channel `active` flag. Deactivation answers `503`; re-registration by the
  same channel rebinds in place; a route another channel owns throws
  (`middleware/src/channels/routeRegistry.ts`).
- **First claim owns a channel type.** Every provider registry is owner-tracked: one provider
  per `channelType`, a foreign re-registration throws, deactivation drops exactly that plugin's
  contributions (`targetedSendRegistry.ts`: "delivery redirection is security-relevant"). The
  owner is not derived from the plugin id (`@omadia/channel-teams` serves `teams`).
- **Each plugin gets its own view.** The channel registry hands a plugin a `CoreApi` bound to
  it: its id is stamped on what it emits and registers; an event for a channel type another
  plugin holds is dropped, a provider for it refused (`ChannelTypeClaims`, `scopedCoreApi.ts`).
  The scope is deliberately narrow: the facilitator surfaces and the membership event.
- **Loading.** `DynamicChannelPluginResolver` resolves the package (uploaded, then built-in),
  checks that `lifecycle.entry` stays inside the package root, and imports it with a
  cache-bust token so an upgrade loads fresh code (`dynamicChannelResolver.ts`).

### Consequences

- 🟢 **Good:** A new channel is a plugin; the kernel and the agents do not change.
- 🟢 **Good:** One plugin cannot redirect another channel's deliveries or state its authorship.
- 🔴 **Bad:** Ownership is first-come: if two installed plugins serve the same channel type, the
  one that activates first holds it until it deactivates.
- 🔴 **Bad:** `registerRouter` applies no authentication of its own; a channel router behind
  the session gate that needs public paths must claim them (`permissions.public_paths`) or
  authenticate itself.
- 🔴 **Bad:** Turn handling, routes and the older provider registries keep their own ownership
  rules; only the surfaces listed in `scopedCoreApi.ts` are stamped per plugin.
- ⚪ **Neutral:** A deactivated channel's routes stay mounted and answer `503` for the life of
  the process.

## Pros and Cons of the Options

### A — One plugin contract, kernel-owned mounts and ownership

- 🟢 Independent release cycles for kernel and channels; optional capabilities bridge versions.
- 🔴 A wide contract surface (`CoreApi` plus provider interfaces) that must stay additive.

### B — Adapters in the kernel

- 🟢 No version skew.
- 🔴 Every platform SDK and credential handling lands in the core; contradicts ADR-0014.

### C — Channels mount routes and call the orchestrator themselves

- 🟢 Least kernel code.
- 🔴 No clean deactivation, no ownership check, platform shapes leak toward agents.

## More Information

- Related: ADR-0003, ADR-0013, ADR-0014, ADR-0022, ADR-0027, ADR-0037; [ADR-0134](0134-agents-own-bots-on-channels.md),
  [ADR-0136](0136-channel-websockets-authenticate-before-the-handshake.md), [ADR-0145](0145-turn-origin-states-where-a-turn-came-from.md).
- Code: `middleware/packages/harness-channel-sdk/src/{plugin,coreApi,outgoing,incoming}.ts`,
  `middleware/src/channels/{channelRegistry,coreApi,scopedCoreApi,routeRegistry,dynamicChannelResolver,targetedSendRegistry}.ts`.
- Tests: `middleware/test/scopedCoreApi.test.ts`, `middleware/test/coreApiOptionalCapabilities.test.ts`,
  `middleware/test/channelRouteRebind.test.ts`, `middleware/test/dynamicChannelResolverCache.test.ts`.
