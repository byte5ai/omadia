# 0288 — Satellites are outbound-only capability bridges; agents stay on the hub

## Status

Accepted

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers. Design record for epic #746 (wave 6, W36). Accepted by the owner on 2026-11-27; implementation is not planned yet.

## Context and Problem Statement

Epic #746 proposes Satellites: a small omadia runtime (`omadia-satellite`, Raspberry Pi
class) that pairs with a hub by URL and one-time device code, holds one outbound TLS
connection, and bridges systems that are reachable only inside a customer network.

The owner limited v1 on 2026-08-19 to W0–W2: pairing, the outbound tunnel, and the
tool/MCP bridge; the agent loop stays on the hub. W3 (data bridge), W4 (remote agent
execution), W5 (fleet operations beyond revoke, rotate and update) and W6 (blind relay) are
"on demand". Third-party mesh networks (Tailscale, Headscale, ZeroTier) were rejected. The
epic refers to "ADR 0010" for that rejection; that number belongs to an unrelated record,
so this ADR takes its place.

Since then epic #2042 redefined agents. W4 as written — "run selected agents on the
satellite", with an edge plugin runtime and a `placement` block — conflicts with that model:

- Agents are kernel-managed identities, routed deterministically, with no orchestrator
  agent ([ADR-0012](0012-agents-are-virtual-employees.md)).
- Model calls run only through the kernel's model gateway in an execution context
  ([ADR-0017](0017-model-gateway-and-execution-contexts.md)).
- Plugins deliver capabilities, granted per agent
  ([ADR-0014](0014-plugins-are-only-the-delivery-form.md),
  [ADR-0016](0016-least-privilege-and-the-agent-envelope.md)).

## Decision Drivers

- No inbound port at the customer site; no third-party control plane.
- Every satellite tool passes the same grants, guards and audit as any other tool.
- No agent identity, routing or model credentials outside the hub's kernel.
- A revoked satellite loses all access at once; the device key is not the security line
  (no TPM on a Pi).

## Considered Options

- **A — Capability bridge only.** The satellite offers tools to the hub as an MCP server of
  kind `satellite`; the hub side is a system-module (pairing, tunnel, registry, admin UI).
  W4 is dropped. W3 is re-specified as a capability (data arrives as tool results or
  dataset imports under a grant) when a deployment asks for it.
- **B — The epic as written,** including W4 with an edge plugin runtime and placement.
- **C — VPN or mesh** as the connectivity path.

## Decision Outcome

Chosen option: **A** (owner decision 2026-11-27).

- **Outbound only.** The satellite dials `wss://<hub>/api/v1/satellites/ws` with a
  long-poll fallback; the hub never connects to the satellite. Versioned protocol in a
  dependency-free package, mismatch aborts loudly. No relay in v1.
- **Pairing.** A device code (short TTL, single use) issued in `/admin/satellites` mints a
  scoped API key `satellite:<id>` ([ADR-0101](0101-api-keys-as-second-authentication-method.md))
  plus a device-key signature. The tunnel authenticates before the WebSocket handshake
  ([ADR-0136](0136-channel-websockets-authenticate-before-the-handshake.md)).
- **Tools through the MCP choke point.** Satellite tools appear as an MCP server of kind
  `satellite`. Agents reach them only through a per-agent grant; calls run in the calling
  agent's envelope, are audited, and follow MCP outcome rules
  ([ADR-0205](0205-mcp-calls-are-resent-only-when-safe-and-failures-end-only-their-request.md),
  [ADR-0206](0206-unattended-mcp-callers-get-typed-outcomes-and-start-no-interaction.md)).
- **Kernel stays on the hub.** No agent runtime, no routing, no model credentials on the
  satellite. A satellite never calls a model. Internal-system credentials are delivered over
  the tunnel into a satellite-local vault and are revoked with the satellite.
- **The satellite enforces its own boundary, fail-closed.** An internal-host allow-list and,
  for shell-shaped tools, a command policy with no policy meaning "deny".
- **Hub side is a system-module** that needs explicit install confirmation (ADR-0014).
- **W4 is out.** Running an agent elsewhere would need its own spec that keeps ADR-0012 and
  ADR-0017; this record does not allow it.
- **Mesh and VPN are rejected** as connectivity paths.

### Consequences

- 🟢 **Good:** v1 adds no new trust model: grants, audit and envelope are the existing ones.
- 🟢 **Good:** Customer IT opens no port and installs no VPN.
- 🔴 **Bad:** Every tool call pays the hub↔site round trip twice; raw API data transits the
  hub process before the shield's hub→model boundary.
- 🔴 **Bad:** An own tunnel protocol is several engineer-weeks before the first usable
  milestone.
- ⚪ **Neutral:** Satellites stay on the roadmap (owner, 2026-11-27). Follow-ups when planned: `specs/746-satellites/spec.md`, then issues
  for W0–W2 only.

## Pros and Cons of the Options

### A — Capability bridge only

- 🟢 Fits ADR-0012/0014/0016/0017 unchanged.
- 🔴 No on-edge masking in v1; "data never leaves the building" is not a v1 property.

### B — Epic as written

- 🟢 Covers edge compute and on-edge masking.
- 🔴 Places agents and model access outside the kernel, against ADR-0012 and ADR-0017.

### C — VPN or mesh

- 🟢 No own protocol.
- 🔴 Needs customer IT changes or an external control plane; owner rejected it.

## More Information

- Epic: [#746](https://github.com/byte5ai/omadia/issues/746) (technical design v1 in its first
  comment).
- Related: ADR-0012, ADR-0014, ADR-0016, ADR-0017, ADR-0101, ADR-0136, ADR-0205, ADR-0206.
