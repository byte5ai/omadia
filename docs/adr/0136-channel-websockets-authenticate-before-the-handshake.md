# 0136 — One WebSocket upgrade listener; authentication before the handshake; a channel socket lives no longer than its session

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers; WebSocket transport for channel plugins in #205, per-route
  authentication and frame caps in #1201, session-bound sockets in #1262
- **Supersedes:** —

## Context and Problem Statement

The canvas UI channel talks to the kernel over a WebSocket, and kernel features need sockets of
their own. An HTTP request is checked by `requireAuth` on every call; a WebSocket is checked
once and then stays open, so a signed-out, reset or disabled user could keep an authorised
connection for hours. With several replicas, a revocation announced on one does not reach a
socket held by another. This record is retroactive. Who may accept an upgrade, when is it
authenticated, and when does a socket end? (Border: authentication and sessions.)

## Decision Drivers

- The WebSocket gate and the HTTP gate must not drift: one session verdict path.
- An unauthenticated peer should cost no WebSocket allocation.
- An outage of the session lookup is not a verdict on the credential.
- A plugin must not be able to opt out of session authentication.
- Bounded memory: a peer must not make the kernel buffer large or unchecked frames.

## Considered Options

- **A — One registry is the only `upgrade` listener; authenticate before `101`; track every
  channel socket against its session (expiry, revocation, per-frame re-check).**
- **B — Authenticate at upgrade only.**
- **C — Each plugin owns its `WebSocketServer` and its authentication.**

## Decision Outcome

Chosen option: **A** (`middleware/src/channels/webSocketRegistry.ts`,
`channelSessionLifetime.ts`, `channelSessionCheck.ts`, `channelSessionAuth.ts`).

- **Two kinds of route.** *Channel routes* (`CoreApi.registerWebSocket`): session cookie plus
  the Entra whitelist, the `CHANNEL_WS_MAX_PAYLOAD_BYTES` cap (32 MiB), a transport-agnostic
  `ChannelSocket`, and the channel's `active` lifecycle. *Kernel routes* (`registerKernel`,
  never on `CoreApi`): their own authenticator with a deadline (`KERNEL_WS_AUTH_TIMEOUT_MS`,
  10 s), a required `maxPayload`, the raw `ws` socket. Custom authentication is kernel-only.
- **Before the handshake.** A rejected peer gets a raw `401` or `403` and the socket is
  destroyed; no `101` is sent. An authenticator that throws or misses its deadline answers
  `503`; an unregistered path `404`. The status line carries only the standard reason phrase.
- **Same verdict as HTTP.** `authenticateChannelSession` calls `evaluateSessionToken`, the
  evaluation `requireAuth` uses. The handler gets the claims only; the token stays in the
  registry and the cookie is stripped from `socket.request.headers`.
- **Lifetime.** The socket closes with `4401` at the token's `exp`, with `4403` when the session
  is revoked or the identity de-whitelisted: at once on the replica that hears the revocation,
  elsewhere before the next frame is handled (a frame needs a verdict at most
  `WS_SESSION_FRAME_RECHECK_MS`, 5 s, old), and within `WS_SESSION_RECHECK_MS` (60 s) for a
  socket that sends nothing. `1013` when the upgrade's verdict cannot be trusted
  (`RECENT_REVOCATIONS_KEPT` = 256 announcements exceeded during the check).
- **No verdict, no frame.** While a session check fails or times out
  (`WS_SESSION_CHECK_TIMEOUT_MS`, 10 s) the socket stays open but its frames are withheld
  (`onRefusedMessage`); the socket stops reading meanwhile, so the wait cannot grow a buffer.
- **A renewal extends the cookie, not the socket.** The client reconnects.

### Consequences

- 🟢 **Good:** Sign-out, password reset, disable and delete end live sockets; the bound is
  stated in constants and pinned by tests.
- 🟢 **Good:** Plugins cannot weaken socket authentication or re-implement the check.
- 🔴 **Bad:** A session lookup per socket at least every 5 s of traffic and every 60 s when
  idle; frames wait while it runs.
- 🔴 **Bad:** On a replica that did not hear the revocation, an idle socket still receives
  pushes for up to 60 s.
- 🔴 **Bad:** The 32 MiB cap is sized against the canvas channel's largest valid frame in
  ASCII; a maximal list of 3-byte UTF-8 text would exceed it and close with `1009`.
- ⚪ **Neutral:** Kernel routes own their principal and their lifetime; the registry enforces
  none for them.

## Pros and Cons of the Options

### A — One listener, pre-handshake auth, session-bound lifetime

- 🟢 Revocation reaches sockets on every replica with a stated bound.
- 🔴 The most code of the three; timers and a per-socket check queue.

### B — Authenticate at upgrade only

- 🟢 Simple.
- 🔴 A revoked session keeps its socket until the client disconnects.

### C — Plugin-owned servers

- 🟢 Freedom per channel.
- 🔴 Several `upgrade` listeners in one process, and authentication becomes optional.

## More Information

- Related: [ADR-0135](0135-channel-plugin-contract-and-channel-type-ownership.md); `docs/security-architecture.md`
  (§10k server-side session revocation).
- Tests: `middleware/test/webSocketRegistry.test.ts`, `webSocketRegistryHardening.test.ts`,
  `webSocketRegistrySession.test.ts`, `webSocketRegistryFrameGate.test.ts`,
  `channelSessionTracker.test.ts`, `channelSessionFrameGate.test.ts`.
