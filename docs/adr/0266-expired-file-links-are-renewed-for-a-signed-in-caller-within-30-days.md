# 0266 — An expired file link is renewed through a kernel route for a signed-in caller, up to 30 days after it expired

## Status

Proposed

- **Date:** 2026-11-27
- **Deciders:** omadia maintainers (wave 6, W32; issue #1964)
- **Supersedes:** —; refines [ADR-0137](0137-generated-files-are-content-addressed-behind-signed-urls.md)
  (signed links expire with no way back)

## Context and Problem Statement

Office and Diagrams hand out HMAC-signed download links
(`/documents/dl/<key>?exp=&sig=`, `/diagrams/dl/<key>?exp=&sig=`, ADR-0137, ADR-0176) that
expire after `signed_url_ttl_sec` (900 s on the env install, 3600 s from the Store). Every
chat older than that shows broken diagram images and dead file chips; the only way back was
asking the model to create the file again. The web chat reaches the middleware only through
the web-ui origin ([ADR-0161](0161-web-ui-same-origin-front-and-runtime-proxy.md)), so a
renewal must be a kernel route under `/api`, not a plugin route. And since
[ADR-0178](0178-attachments-come-only-from-channel-adapters-and-bind-at-upload.md) generated
files are deliberately bound to no conversation, so "may this caller see this key?" has no
existing answer. Who may turn an expired link into a fresh one, and through which path?

## Decision Drivers

- The web chat must be able to renew with its session cookie (ADR-0161).
- No new binding of generated files to a conversation (ADR-0178); no re-render.
- Least privilege ([ADR-0016](0016-least-privilege-and-the-agent-envelope.md)): a renewal
  must not widen who can fetch a file beyond who once held a valid link.
- Links stay stateless; the signing secret stays inside the plugin that owns it (ADR-0176:
  each route binds its own signature, a shared secret is no reason to accept another route).
- Refusals are observable without leaking the link.

## Considered Options

- **A — Kernel route `POST /api/v1/files/renew` behind the session gate; the producing plugin
  registers a renewer for its route prefix that checks its own signature with the expiry
  ignored; the kernel adds a maximum age of 30 days past the original expiry.**
- **B — Bind generated files to their conversation at creation and renew only for members of
  that conversation.**
- **C — Re-generate the file** (ask the model again, or replay the tool call).
- **D — Require a `generatedObjects` record (ADR-0187) of the caller for the key.**
- **E — Longer TTLs instead of renewal.**

## Decision Outcome

Chosen option: **A**.

- **Route.** `POST /api/v1/files/renew`, body `{ url }` (absolute or relative link, at most
  4096 characters), mounted behind `requireAuth`. The handler re-checks the session itself.
  `200 { url, expiresAt }` carries a link for the **same key**, signed with the plugin's normal
  TTL; the object is not touched.
- **Caller rule.** All three must hold:
  1. a signed-in session (`401 file_link.session_required` otherwise);
  2. the producer's renewer accepts the signature over `<route prefix><key>.<exp>` with the
     expiry ignored, and the key has the producer's layout (`403 file_link.invalid_signature`);
  3. the original `exp` is no more than 30 days in the past
     (`FILE_LINK_RENEW_MAX_AGE_SEC`; `410 file_link.too_old`).
  A malformed body is `400 file_link.bad_request`; a link under a prefix no active plugin
  renews is `404 file_link.unknown_route`.
- **Registry.** Kernel service `fileLinkRenewal@1` (plugin-api 1.107.0):
  `registerRenewer(routePrefix, { verifyIgnoringExpiry, sign })`, one renewer per prefix.
  Office (`/documents/dl`, 0.1.8) and Diagrams (`/diagrams/dl`, 0.2.5) declare it in
  `optional_requires` and register on activation; without the service an expired link
  behaves as before. The secret never leaves the plugin; the kernel owns only the caller
  rule and the age.
- **Logging.** Every refusal is logged as `[file-links] renew refused: reason=… route=…
  key=<12 hex of sha256(key)> user=<omadia user id>`. Neither the URL, the signature nor the
  raw key (which carries the file name) is logged.
- **Web chat.** A diagram image or file chip whose link is expired at render time, whose image
  fails to load, or that is clicked after expiry calls the route once and swaps the fresh URL
  in; a refusal shows a localized notice (too old / no longer available / failed). Teams cards
  and other channels are unchanged.

### Consequences

- 🟢 **Good:** Chats keep their diagrams and files for a month without re-rendering, and the
  readable error pages of #2256 stay the fallback.
- 🟢 **Good:** Each producer keeps sole control over its signature and key layout; a third
  producer only registers a renewer.
- 🔴 **Bad:** Any signed-in account that holds an old link (copied from another person's
  chat, a forwarded Teams card) can renew it within 30 days. Accepted: that account could
  have fetched the file while the link was valid, the link already is the bearer proof
  (ADR-0137), and the session adds the identity the link alone lacks. The renewal itself is
  not audited as a success, only refusals are logged.
- 🔴 **Bad:** Renewal works only for files still in the bucket; a file deleted with its chat
  or person (ADR-0187) or by the lifecycle rule renews into a 404 page.
- 🔴 **Bad:** Rotating a plugin's signing secret still ends every old link for good.
- ⚪ **Neutral:** Teams and other channels without an omadia session cannot use the route;
  they keep expiring links (follow-up if needed: renewal on card refresh).

## Pros and Cons of the Options

### A — Kernel route, plugin renewer, session, maximum age

- 🟢 Fits ADR-0161 (same-origin `/api`) and ADR-0178 (no conversation binding).
- 🟢 Stateless; works for every file a link was ever issued for.
- 🔴 A leaked link stays renewable by any signed-in account for 30 days.

### B — Bind generated files to their conversation

- 🟢 Precise: only members of the chat renew.
- 🔴 Reverses ADR-0178's deliberate choice; content-addressed keys are shared across chats,
  so a binding per key needs a table and per-chat rows, and group chats still widen it.

### C — Re-generate

- 🟢 No new surface.
- 🔴 Costs a model turn, may differ from the original (dataset changed), and the chat
  history still shows dead links.

### D — Require a `generatedObjects` record of the caller

- 🟢 Ties renewal to the person who produced the file.
- 🔴 The record is optional (no service, outside a turn, before ADR-0187, in-memory without a
  database), so many legitimate files could never renew; a group chat member who did not
  start the turn is refused. Can be added later as a stricter mode.

### E — Longer TTLs

- 🟢 No code.
- 🔴 Widens every link, including those forwarded outside omadia, for the full period.

## More Information

- Issue #1964; readable error pages in #2256.
- Code: `middleware/src/routes/fileLinkRenew.ts`, `middleware/src/services/fileLinkRenewal.ts`,
  `middleware/packages/plugin-api/src/fileLinkRenewal.ts`,
  `middleware/packages/harness-diagrams/src/linkRenewer.ts`,
  `middleware/packages/harness-plugin-office/src/linkRenewer.ts`,
  `web-ui/app/_lib/fileLinkRenewal.ts`, `web-ui/app/_components/chat/FileAttachments.tsx`.
- Tests: `middleware/test/fileLinkRenewRoute1964.test.ts`,
  `middleware/test/fileLinkRenewers1964.test.ts`, `web-ui/app/_lib/fileLinkRenewal.test.ts`.
- Related: ADR-0115, ADR-0137, ADR-0161, ADR-0176, ADR-0178, ADR-0187.
