# 0310 — Web-chat uploads are stored and bound by a kernel route and stated to the turn by the kernel, never by the request

## Status

Accepted — two residuals (no content check, no per-account limit) closed by
[ADR-0333](0333-web-chat-uploads-are-checked-by-content-and-capped-per-account.md)

- **Date:** 2026-11-27
- **Deciders:** Owner decision of 2026-11-27 (the web chat gets file uploads like Teams and
  Telegram), shaped by recommendation in wave 7, W41 (#2336, rest of #1985); reversible.
- **Supersedes:** refines in part [ADR-0178](0178-attachments-come-only-from-channel-adapters-and-bind-at-upload.md):
  its rule "HTTP routes never fill `storedAttachments` from a request" gets one exception, the
  web chat's own routes, which accept only keys their upload route stored and bound to the
  same chat; every other rule of ADR-0178 applies unchanged

## Context and Problem Statement

The web chat had no file upload: `/api/chat/stream` took no files, and since #1976 the
attachment tools were not offered on web turns. ADR-0178 says the kernel ingests storage keys
only from `ChatTurnInput.storedAttachments`, set by the channel adapter that saw the upload, and
that HTTP routes never fill it from a request. The web chat is a kernel route
([ADR-0146](0146-web-chat-is-a-kernel-route-with-ndjson-and-pinned-sessions.md)), not a plugin,
and the browser uploads a file *before* it sends the message that carries it. How does a web
upload become an attachment of the turn without letting a request name any key, and how does it
leave again with the chat?

## Decision Drivers

- ADR-0178: a file never reaches a conversation it was not uploaded to; keys are bound at upload.
- [ADR-0180](0180-web-chats-belong-to-the-creating-account.md): a web chat belongs to one account;
  another account's chat answers like a missing one.
- [ADR-0198](0198-transcripts-of-own-uploads-are-prompt-masked-not-interned.md): a transcript of
  the turn's own upload is prompt-masked, which needs the turn's upload keys.
- [ADR-0187](0187-generated-files-are-recorded-and-deleted-with-their-owner.md): files go with
  their chat or person.
- Same masking and ingest path as channel uploads; no second pipeline.

## Considered Options

- **A — Kernel upload route that binds at upload; the turn names keys, the kernel accepts only
  keys of this chat with this chat's binding and states name and type itself.**
- **B — Upload inside the turn request** (multipart `/api/chat/stream`). One request, but the
  NDJSON stream and the upload share one body; a 25 MB recording delays the first token and a
  retry re-uploads.
- **C — Separate upload registry table** (upload id → key, owner, chat). Same guarantees as A
  with one more table and migration; the binding row and the ADR-0187 ledger already record
  everything the check needs.

## Decision Outcome

Chosen option: **A**.

- **Upload route.** `POST /api/chat/uploads` (behind `requireAuth`, multipart: `sessionId`,
  `file`). Requires an account (`401 chat_upload.no_account`) and a chat the caller may use
  (`mayUseChatSession`, else `404 not_found`). Accepted by extension only: recordings (`mp3`,
  `m4a`, `wav`, `ogg`, `oga`, `opus`, `webm`, `flac`, `aac`, `mp4`), `pdf`, `docx`, `txt`, `md`,
  `csv`, `xlsx` and images (`png`, `jpg`, `jpeg`, `gif`, `webp`); anything else is
  `415 chat_upload.unsupported_type`. At most 25 MiB (`413 chat_upload.too_large`), below the
  web-ui proxy limit. Without an object store `503 chat_upload.store_unavailable`
  ([ADR-0115](0115-binary-objects-in-an-optional-s3-compatible-store.md)). The content type is
  the kernel's for the extension, never the browser's.
- **Key and binding.** The key is `web-chat/<sessionId>/<uuid>/<sanitized file name>`. The
  route binds it to the chat's conversation scope (`attachmentBindings.bindIfAbsent`) and files
  it in the `generated_objects` ledger as producer `web-chat-upload` under the account's omadia
  user id and the chat. If either write fails, the object is deleted again. The web chat is a
  one-account room, so no audience-floor check runs at upload; reads keep it.
- **Turn.** `POST /api/chat` and `/api/chat/stream` take `attachments: [{ storageKey }]`
  (at most 10) with a `sessionId` and no debug `scope`. A reference counts only
  when the key has the web-chat layout *of this chat* and its binding names this chat; one that
  does not refuses the turn with `400 chat_upload.unknown_attachment` before the stream starts.
  The kernel states file name and content type from the key (no size the client claims) and
  sets `storedAttachments`, so
  ingest, Privacy Shield masking, `read_attachment` and the ADR-0198 transcript rule run exactly
  as for a channel upload. Like a channel adapter, the route appends the human-readable
  `[attachments-info]` note (which the kernel never parses) so the model learns the
  `storage_key`. A message may be empty when it carries uploads.
- **Tools.** `read_attachment` and `transcribe_recording` are offered on any turn whose context
  carries upload keys (`turnUploadKeys`), web turns included; a web turn without uploads still
  does not get them (#1976).
- **Limits per chat.** A chat holds at most 100 uploads of an account
  (`429 chat_upload.chat_limit`).
- **Deletion.** Deleting the chat releases its ledger rows and deletes the file through the
  registered deleter; the memory purge for the person does the same (ADR-0187). A file
  removed from the composer before sending is deleted at once
  (`DELETE /api/chat/uploads?sessionId=&storageKey=`, only the account's own upload of that
  chat, else `404`). Without a bound ledger the upload is refused and the file removed, so
  no file is kept that nothing would delete.
- **Display.** The chat message keeps name, type and size of each upload (`uploads`) so the
  attachment list survives a reload; the storage key stays out of the persisted chat.

### Consequences

- 🟢 **Good:** The web chat reads, transcribes and imports uploads through the one pipeline the
  channels use, with the same masking.
- 🟢 **Good:** No new table: the binding row and the ledger row are the record of the upload.
- 🔴 **Bad:** `read_attachment` / `transcribe_recording` are offered only on the turn that
  carries the file. A follow-up question in a later turn of the same chat works from the
  answer and history; re-reading the file needs the file attached again.
- 🔴 **Bad:** Without Postgres, bindings and ledger rows live in memory: after a restart an
  earlier upload is unreadable and not deleted with the chat (bucket lifecycle rule remains the
  backstop, as in ADR-0187).
- 🔴 **Bad:** A chat id that is not stored yet may be used by any account (ADR-0180 rule for
  turns); ids are random client ids, so this matches the turn rule rather than widening it.
- ⚪ **Neutral:** API callers with a debug `scope` or without a chat cannot attach uploads.
- 🔴 **Bad:** No upload rate limit beyond the session gate and the per-chat cap; an account
  can fill storage by opening many chats. Follow-up if abuse shows: a per-account quota.
- ⚪ **Neutral:** `POST /api/chat` with a whitespace-only `message` and no attachments is now
  `400` (it used to pass `min(1)`).

## Pros and Cons of the Options

### A — Kernel upload route, keys checked against their binding

- 🟢 Upload and turn are independent; progress and retry per file in the browser.
- 🔴 Two requests per message with files.

### B — Upload inside the turn request

- 🟢 One request.
- 🔴 Mixes a large binary body with the NDJSON stream; no per-file feedback before sending.

### C — Separate upload registry

- 🟢 Explicit record per upload.
- 🔴 Duplicates the binding and ledger rows; one more migration and in-memory twin.

## More Information

- Issues #2336, #1985 (ADR-0198 remainder), #1976.
- Code: `middleware/src/routes/chatUploads.ts`, `middleware/src/routes/chat.ts`
  (`turnUploadsFor`), `middleware/src/services/generatedObjects.ts` (`recordFor`),
  `middleware/packages/harness-orchestrator/src/attachmentToolAvailability.ts`,
  `web-ui/app/_lib/chatUploads.ts`, `web-ui/app/_components/chat/ComposerAttachments.tsx`,
  `web-ui/app/_components/chat/MessageUploads.tsx`.
- Tests: `middleware/test/webChatUploads2336.test.ts`,
  `middleware/test/attachmentTurnVisibility.test.ts`.
- Related: ADR-0115, ADR-0146, ADR-0178, ADR-0180, ADR-0187, ADR-0198.
