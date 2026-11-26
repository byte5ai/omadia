# 0176 — A signed download link is bound to the route that issued it

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (wave 5, W00 security fast track; issue #1979)
- **Supersedes:** the signed-payload rule of [ADR-0137](0137-generated-files-are-content-addressed-behind-signed-urls.md) ("the HMAC-SHA256 covers `<key>.<exp>`"); the rest of ADR-0137 stands

## Context and Problem Statement

Office (`/documents/dl`) and Diagrams (`/diagrams/dl`) serve stored objects through HMAC-signed,
expiring links. The env bootstrap gives both plugins the same secret (`DIAGRAM_URL_SECRET`) and
the same bucket. The signature covered only `<key>.<exp>`, and neither router checked the key's
layout, so a link worked on either route. An operator who revoked the `/diagrams/dl` public-path
grant still had every diagram served without a session through `/documents/dl`. What does a
signature have to bind so that a route's grant fully controls what that route's links reach?

## Decision Drivers

- Revoking a public-path grant must end session-less access to that plugin's objects
  ([ADR-0016](0016-least-privilege-and-the-agent-envelope.md)).
- Sharing one secret between the two built-ins stays possible (one env value for operators).
- Links stay stateless (no lookup table).

## Considered Options

- **A — Route prefix in the signed payload, plus a key-layout check per router.**
- **B — Separate secrets per plugin.** Fixes only the env bootstrap; a shared vault value
  reopens it.
- **C — Layout check only.** Holds only while the two layouts never overlap.

## Decision Outcome

Chosen option: **A**.

- **Payload.** Both signers sign `<route prefix><key>.<exp>` (`/diagrams/dl/…`,
  `/documents/dl/…`; `SIGNED_ROUTE_PREFIX` in each `signing.ts`). A link moved to the other
  route fails the signature (403).
- **Layout.** Each router serves only its own key layout and answers 404 otherwise:
  Diagrams `<tenant>/<sha256>.png` (`isDiagramKey`), Office
  `documents/<tenant>/<sha256>/<filename>` (`isDocumentKey`).
- **Rule for new signers.** Any further plugin that signs object links binds its route in the
  payload the same way; a shared secret is never a reason to accept another route's link.

### Consequences

- 🟢 **Good:** A route's grant is the single switch for its objects.
- 🟢 **Good:** The comment in `bootstrapOfficeFromEnv` that claimed this is now true.
- 🔴 **Bad:** Links signed before the deploy stop working (they expire within the signed TTL
  anyway; a chat that shows an old link needs the file created again).
- ⚪ **Neutral:** Secret rotation and TTL are unchanged.

## Pros and Cons of the Options

### A — Prefix in payload plus layout check

- 🟢 Two independent guards; neither depends on the other plugin's configuration.
- 🔴 Invalidates in-flight links once.

### B — Separate secrets

- 🟢 No payload change.
- 🔴 Depends on configuration staying separate; one copied vault value undoes it.

### C — Layout check only

- 🟢 Keeps old links valid.
- 🔴 Breaks as soon as a layout changes or a third producer appears.

## More Information

- Issue #1979. Code: `middleware/packages/harness-diagrams/src/{signing,diagramsRouter}.ts`,
  `middleware/packages/harness-plugin-office/src/{signing,documentsRouter}.ts`.
- Related: [ADR-0115](0115-binary-objects-in-an-optional-s3-compatible-store.md) (one bucket,
  prefixes per consumer).
