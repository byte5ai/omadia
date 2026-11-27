# 0178 — Stored attachments come only from channel adapters, as structured data, and are bound to their conversation at upload

## Status

Accepted — refined in part by [ADR-0310](0310-web-chat-uploads-are-stated-by-the-kernel-route-that-stored-them.md)
(the web chat's kernel route states uploads from keys a request names, checked against their binding)

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (wave 5, W00 security fast track; issues #1960, #1962)
- **Supersedes:** bind-on-first-read of #575; refines [ADR-0162](0162-scope-id-typed-session-scope.md), which describes attachment bindings as part of the audience floor

## Context and Problem Statement

Uploaded files live in the shared object store under a `storage_key`. Two paths read them by key:
the turn's auto-ingest and the `read_attachment` tool. The ingest took its keys from an
`[attachments-info]` block parsed out of the plain user message, on every channel, so anyone could
type the block and name any key (#1962). The read path's only access check was the room binding of
#575, and that binding was written on the first *read* of a key: Office reports and diagrams are
never read when they are created, so the first chat that learned such a key from a download link
bound it to itself; a non-addressable scope (`http-default`) skipped the check, and the binding
store existed only with the audience floor on. `read_attachment` is also exempt from Privacy Shield
interning on the premise "the user already has this content" (#1960). Where may a storage key come
from, and when does a conversation own it?

## Decision Drivers

- A file must never reach a conversation it was not uploaded to
  ([ADR-0016](0016-least-privilege-and-the-agent-envelope.md),
  [ADR-0019](0019-discretion-as-information-flow-control.md)).
- The intern exemption of `read_attachment` must stay true by construction.
- The kernel trusts what an installed channel plugin states about its turn, never message text
  ([ADR-0145](0145-turn-origin-states-where-a-turn-came-from.md)).
- Object storage has no ownership metadata ([ADR-0115](0115-binary-objects-in-an-optional-s3-compatible-store.md)).

## Considered Options

- **A — Structured adapter field; bind at upload; read only bound keys of this conversation.**
- **B — Keep the text block, but check a key prefix per channel.** Still forgeable on the channel
  that owns the prefix.
- **C — Bind generated outputs (Office, Diagrams) at creation too, and let `read_attachment` read
  them.** Puts tool output with real dataset rows past the intern exemption.

## Decision Outcome

Chosen option: **A**.

- **Structured field.** `ChatTurnInput.storedAttachments` (`StoredTurnAttachment`: `fileName`,
  `contentType`, `storageKey`, optional `signedUrl`, `sizeBytes`; `@omadia/channel-sdk` 0.3.16) is
  the only source the kernel ingests storage keys from. Channel adapters set it; HTTP routes never
  fill it from a request. The text parser (`attachmentsInfo.ts`) is removed. The adapter may keep a
  human-readable block in the message for the model; the kernel ignores it.
- **Binding at upload.** Before the ingest reads anything, each stated key is bound to the turn's
  conversation (`AttachmentReader.bindToCurrentConversation`, first binding wins). A read never
  binds.
- **Reads.** `readByStorageKey` serves a key only when it is bound to the conversation of the
  current turn. Unbound keys, keys of another conversation and turns without an addressable room
  are refused with the same "not found" as an unknown key.
- **Generated output is not an attachment.** Office and Diagrams outputs are never bound, so
  `read_attachment` and the ingest never read them; they are delivered as download links only.
  Migration `0114` removes bindings that earlier first reads created for those two layouts.
- **Always on.** The kernel publishes the `attachmentBindings` store with the audience floor on or
  off: Postgres when present, otherwise an in-memory store for the process lifetime. The binding
  is chat isolation, not a dispatch guard in the sense of
  [ADR-0073](0073-dispatch-guards-are-off-without-a-provider-and-refuse-as-tool-results.md):
  the audience floor itself stays "off without a provider", and a binding row is written only
  for a room the floor lets read attachments. A failed bind leaves that one key unbound and the
  turn's other attachments untouched.
- **CLI-backed agents** (`cliChatAgent.ts`) carry the turn's `sessionScope` into the loopback
  tool scope and bind the stated uploads the same way, so `read_attachment` works there too.
- **Intern exemption** of `read_attachment` stays; its premise ("the user's own upload in this
  conversation") now holds by construction.

### Consequences

- 🟢 **Good:** A typed block, a copied download link or another chat's key reads nothing.
- 🟢 **Good:** The binding no longer depends on the audience floor setting.
- 🔴 **Bad:** A channel plugin that still only writes the text block gets no auto-ingest until it
  sets `storedAttachments` (the next omadia-channel-teams release after 0.45.1 does).
- 🔴 **Bad:** The model cannot re-read an Office file it produced; it has to work from the data it
  used to build it.
- 🔴 **Bad:** HTTP callers on the shared `http-default` scope can read no attachment.
- 🔴 **Bad:** Without Postgres, bindings are lost on restart; earlier uploads become unreadable.
- ⚪ **Neutral:** The binding is per conversation, not per person: in a group chat every member's
  turn may read the group's uploads, as before.

## Pros and Cons of the Options

### A — Structured field, bind at upload

- 🟢 Ownership is decided by the only party that saw the upload happen.
- 🔴 Needs a change in every channel plugin that forwards uploads.

### B — Prefix check on the text block

- 🟢 No plugin change.
- 🔴 Any user of the owning channel can still name any key with that prefix.

### C — Bind generated output too

- 🟢 The model could re-read its own files.
- 🔴 Office files carry rows resolved from masked datasets; reading them back intern-exempt would
  put those rows on the wire in clear.

## More Information

- Issues #1960, #1962. Code: `middleware/packages/harness-channel-sdk/src/chatAgent.ts`,
  `middleware/packages/harness-orchestrator/src/attachmentReaderFactory.ts`, `ingestAttachments` in
  `orchestrator.ts`, `middleware/src/index.ts` (store wiring),
  `middleware/migrations/0114_attachment_bindings_drop_generated_outputs.sql`; Teams adapter
  `omadia-channel-teams` `teamsBot.ts`.
- Related: #575 (room binding), [ADR-0177](0177-tool-outputs-are-delivered-per-turn.md).
