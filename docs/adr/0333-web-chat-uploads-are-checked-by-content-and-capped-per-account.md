# 0333 — Web chat uploads are checked by their content and capped per account

## Status

Accepted

- **Date:** 2026-11-27
- **Deciders:** W45 cluster lead (wave 8, issue #2373; decision after the recommendation, reversible)
- **Supersedes:** — (closes two residuals of
  [ADR-0310](0310-web-chat-uploads-are-stated-by-the-kernel-route-that-stored-them.md))

## Context and Problem Statement

[ADR-0310](0310-web-chat-uploads-are-stated-by-the-kernel-route-that-stored-them.md) accepts a
web chat upload by its extension and states the kernel's content type for it. The bytes are not
looked at: an executable or an HTML page renamed to `.pdf` is stored and stated as
`application/pdf`, and the readers behind the turn find out later, if at all. ADR-0310 also
accepted that an account can fill the object store by opening many chats (100 uploads per chat,
no limit per account). What does the upload route check about the content, and how much may one
account hold?

## Decision Drivers

- The type the kernel states must not be contradicted by the stored bytes.
- No parsing in the route: the ingest, vision and transcription readers validate formats.
- A per-account bound without a migration of the `generated_objects` ledger.
- Operators can raise the bound.

## Considered Options

- **A — Signature check per accepted extension + a count cap per account
  (`WEB_CHAT_UPLOADS_PER_ACCOUNT`, default 200).**
- **B — A content sniffer that picks the type from the bytes (ignoring the extension).**
- **C — A byte quota per account (new `size_bytes` ledger column).**

## Decision Outcome

Chosen option: **A**.

- `uploadContentMatches(extension, bytes)` (`middleware/src/routes/chatUploadContent.ts`) checks
  the leading signature of every accepted extension: `ID3`/frame sync (mp3, aac), `ftyp` at
  offset 4 (m4a, mp4), `RIFF…WAVE` (wav), `OggS` (ogg, oga, opus), EBML (webm), `fLaC`, `%PDF-`,
  the ZIP local header (docx, xlsx), the PNG, JPEG and GIF signatures, `RIFF…WEBP`. Text types
  (txt, md, csv) must have no NUL byte in the first 8 KiB unless they start with a UTF-16
  byte-order mark. An extension without a signature is refused, so a type added to the accepted
  list without one fails closed (a test pins both lists to each other).
- A mismatch answers `415 chat_upload.content_mismatch` before anything is stored.
- An account holds at most `WEB_CHAT_UPLOADS_PER_ACCOUNT` uploads (default 200) across all its
  chats, counted from its `web-chat-upload` ledger rows; beyond it `429
  chat_upload.account_limit`. With the 25 MiB file limit this bounds an account at 5 GiB by
  default. Deleting a chat (or the composer's remove) frees its rows.
- The extension still decides the stated content type (ADR-0310).

### Consequences

- 🟢 **Good:** A renamed executable or page is refused at upload, not stated as a document.
- 🟢 **Good:** One account can no longer fill the store by opening chats.
- 🔴 **Bad:** A signature is not a format check: a file with a valid header and garbage after it
  passes, as does any ZIP named `.docx`. The readers still validate.
- 🔴 **Bad:** The cap counts files, not bytes; 200 small files and 200 large ones count alike.
  A byte quota needs a ledger column (option C) and stays a follow-up if needed.
- ⚪ **Neutral:** The web UI maps both new codes to messages (en + de).

## Pros and Cons of the Options

### A — Signature check + count cap

- 🟢 No migration, deterministic, cheap.
- 🔴 Counts files, not bytes.

### B — Type from the bytes

- 🟢 Independent of the name.
- 🔴 Text types have no signature; the stated type would no longer follow one rule.

### C — Byte quota

- 🟢 Bounds what an account actually stores.
- 🔴 A migration and a backfill of existing ledger rows (sizes are not recorded today).

## More Information

- Issue #2373 (follow-up of #2336).
- Tests: `middleware/test/chatUploadContent.test.ts`, `middleware/test/webChatUploads2336.test.ts`
  (ADR-0333 cases), `web-ui/app/_lib/chatUploads.test.ts`.
