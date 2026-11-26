# 0222 — Channels read outgoing attachment bytes in-process

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** Wave 5 cluster W15-17, under the owner's autonomy grant for wave 5; tracked by
  #1993 (kernel seam; the Telegram upload is the plugin's part).
- **Supersedes:** —
- **Refines:** [ADR-0135](0135-channel-plugin-contract-and-channel-type-ownership.md) (one more
  optional, feature-detected `CoreApi` capability).

## Context and Problem Statement

`OutgoingAttachment.url` "must be reachable by the channel" (`harness-channel-sdk/src/outgoing.ts`).
Channels such as Telegram hand that URL to the platform, whose servers fetch it. Diagram and
document URLs are built from a base URL that defaults to `http://localhost:3979`, and many
installations sit on a private network. The platform cannot fetch them: generated Excel/Word files
never arrive, diagrams go missing, and the answer still says "here is your file". The plugin only
logged the failure.

How does a channel get the bytes of an attachment the kernel produced?

## Decision Drivers

- Works without a public base URL (desktop, private networks, the default configuration).
- No new way around the attachment routes' own checks (signed, expiring URLs) and no new
  unauthenticated surface.
- No channel-specific code in the kernel; additive within the channel SDK major (ADR-0135).
- A failed delivery must be visible to the user
  ([ADR-0021](0021-deterministic-first-side-channels-and-uncluttered-answers.md): honest answers).

## Considered Options

- **A — `CoreApi.readAttachment(url)` as a loopback read of granted public paths.** The kernel
  GETs the URL's path and query from itself, only when the path lies under an operator-granted
  public prefix (`PublicPathGrantRegistry`), without credentials or redirects, with a deadline and
  a size cap; the owning plugin's router still verifies the signature.
- **B — A storage-level API.** Channels read from the diagram and document stores directly by key.
- **C — Require a reachable public base URL.** Document it and keep URLs only.

## Decision Outcome

Chosen option: **A**, because it reaches exactly what an anonymous internet client could reach
through the public URL — nothing more — and needs no knowledge of the stores behind each route.

- **Contract** (`@omadia/channel-sdk` 0.3.17): optional `CoreApi.readAttachment(url):
  Promise<AttachmentReadResult>`; result `{ ok: true, bytes, mediaType?, fileName? }` or
  `{ ok: false, reason: 'not_kernel_attachment' | 'not_found' | 'too_large' | 'failed' }`. Never
  throws. Channels feature-detect it; `not_kernel_attachment` means "use the URL".
- **Kernel** (`middleware/src/channels/attachmentByteReader.ts`): the URL's origin is ignored
  (plugins build URLs from their own base-URL settings); the path must resolve in the public-path
  grants; the request goes to `loopbackOriginFor(HOST, PORT)` with `redirect: 'manual'`, a 15 s
  deadline and a 25 MiB cap; 403/404/410 → `not_found`; the file name drops any path part.
- **Channels** upload the bytes (multipart) where the platform allows, fall back to the URL
  otherwise, and post a visible "the file could not be delivered" note when both fail.

### Consequences

- 🟢 **Good:** Files and diagrams reach Telegram (and any other upload-capable channel) without a
  public base URL.
- 🟢 **Good:** The read is bounded by the same grant and signature checks as an external request;
  no session or credential is sent.
- 🔴 **Bad — residuals of the loopback peer:** (a) a plugin router under a granted prefix that
  trusts `req.ip` / `127.0.0.1` would treat these reads as local — plugin routes must not trust
  loopback peers; (b) with `TRUSTED_PROXY_ADDRESSES` containing `loopback`, the reads count as
  coming through a trusted proxy and share one client-address bucket; (c) any channel plugin can
  read any plugin's granted paths, independent of its own network allowlist (they are anonymous
  anyway); (d) a kernel serving only HTTPS in-process would always answer `failed`.
- 🔴 **Bad:** The route still needs its public-path grant; without it the read is
  `not_kernel_attachment` exactly as the URL would 404 outside.
- 🔴 **Bad:** Each read is an HTTP round trip on loopback (cheap, but not zero) and buffers up to
  25 MiB in memory.
- ⚪ **Neutral:** The Telegram plugin (omadia-channel-telegram) adopts it in its own release;
  other channels may follow.

## Pros and Cons of the Options

### A — Loopback read of granted public paths

- 🟢 Generic, store-agnostic; reaches nothing an anonymous request could not.
- 🔴 Depends on the grant; one loopback request per attachment.

### B — Storage-level API

- 🟢 No HTTP hop.
- 🔴 The kernel would need to know every producer's store and key scheme, and the signature check
  would move or be skipped.

### C — Require a public base URL

- 🟢 No code.
- 🔴 Leaves the default installation and private networks broken — the reported bug.

## More Information

- Issue #1993; plugin side in `omadia-channel-telegram` (`telegramEmitter.ts` multipart upload and
  visible failure note).
- Related: [ADR-0052](0052-plugin-routes-auth-modes-and-public-path-grants.md) (public-path
  grants), [ADR-0135](0135-channel-plugin-contract-and-channel-type-ownership.md).
