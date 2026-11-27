# 0187 — Generated files are recorded with person and chat and deleted with them, refcounted

## Status

Proposed

- **Date:** 2026-11-26
- **Deciders:** omadia maintainers (Welle 5, W02; owner decision #1986 taken after the recheck recommendation, reversible)
- **Supersedes:** —

## Context and Problem Statement

Office exports (`create_xlsx`, `create_docx`) and rendered diagrams go to an S3-compatible bucket
under content-addressed keys (`documents/<tenant>/<sha256>/<file>`, `<tenant>/<sha256>.png`). No
record linked a key to a person or a chat, and the store wrapper had no delete. Closing a chat,
deleting a user or running the memory purge left the files, which can hold the decrypted values of
a dataset export (#1986). The only expiry was a 90-day lifecycle rule in the local storage overlay.
ADR-0120 calls the purge the operator's tool for erasure requests. Should generated files be
tracked and deleted with their chat and person, or only expire by a documented bucket rule?

## Decision Drivers

- ADR-0120 / ADR-0186: an erasure deletes what belongs to the person.
- ADR-0115: binary objects live in an optional S3-compatible store the plugins own.
- Identical bytes from two chats share one object; deleting for one must not break the other.
- ADR-0178 (#1960): generated outputs carry no upload binding, so the record must be new.

## Considered Options

- **A — Record (key, producer, person, chat) at mint; release refcounted on chat delete, user
  purge and full purge; lifecycle rule stays as a backstop**
- **B — Only a documented, mandatory bucket lifecycle rule**
- **C — Per-chat (non-content-addressed) keys, deleted per chat**

## Decision Outcome

Chosen option: **A**.

- **Contract.** Kernel service `generatedObjects@1` (plugin-api 1.106.0): `record(producer, key)`
  files the key under the current turn's canonical omadia user id and `sessionScope`;
  `registerDeleter(producer, fn)` names how the producer deletes. Office and Diagrams declare it
  in `optional_requires` and record every key a turn gets, cache hits included.
- **Storage.** Core migration 0119 `generated_objects (storage_key, producer, owner, scope)`, one
  row per pair (missing person/chat = `''`); in-memory without a database.
- **Release.** A chat deletion releases the caller's rows of that chat; the memory purge releases
  the person's rows (axis "User") or all rows (axis "All"), counted in the preview. A key left
  without any row is deleted through its producer's deleter and only then loses its rows; a
  producer that is inactive or a delete that fails keeps the rows (`pending`, warning
  `generated_files_pending`), so the next release retries.
- **Backstop.** Records written outside a turn and files from before this change have no person;
  the operator's bucket lifecycle rule remains the expiry for those and is documented as required.

### Consequences

- 🟢 **Good:** Closing a chat or erasing a person removes their generated files, while a file
  another chat produced with the same bytes stays.
- 🟢 **Good:** No change to keys, signed links or caching.
- 🔴 **Bad:** Files generated before this change are not tracked; only the lifecycle rule
  removes them.
- 🔴 **Bad:** Deleting a dataset does not delete exports made from it (no record of the source
  dataset); the export goes with its chat or person.
- 🔴 **Bad:** The agent axis does not release files (a chat scope carries no agent).
- ⚪ **Neutral:** A third producer only needs the two calls and a delete on its store.

## Pros and Cons of the Options

### A — Recorded and refcounted

- 🟢 Ties retention to the same events as the rest of the erasure.
- 🔴 A new table and a new kernel service.

### B — Lifecycle rule only

- 🟢 No code.
- 🔴 An erasure request cannot be completed before the rule fires; operator-managed buckets have
  no rule unless someone sets one.

### C — Per-chat keys

- 🟢 Simple delete per chat.
- 🔴 Loses deduplication; still no link to the person for a user purge.

## More Information

- Issue #1986; ADR-0115, ADR-0120, ADR-0178, ADR-0186.
- Code: `middleware/src/services/generatedObjects.ts`, `migrations/0119_generated_objects.sql`,
  `packages/plugin-api/src/generatedObjects.ts`, Office/Diagrams `plugin.ts`.
