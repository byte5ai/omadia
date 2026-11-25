# 0098 — Uploaded PII cells are encrypted at rest and readable only behind the shield; link keys are a deliberate identity handle

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main); PRs
  #1119 (link keys), #1124 (cell encryption); issues #430, #727, #1546, #1560.
- **Supersedes:** —

## Context and Problem Statement

Uploaded CSV and XLSX rows were masked irreversibly at import: the surrogate was stored
and the real value was gone. That made every later use wrong for the person entitled to
the data (a merged contact list showed the same pseudonym address in every row; its Excel
export was worthless). Two uploads of the same people also shared no identity, so
de-duplicating across files was impossible without showing the model names.

How can uploaded personal data stay usable for its owner and joinable across files while
the model still never reads it? This record is retroactive.

## Decision Drivers

- The shield's boundary is the model, not the server.
- A ciphertext must not be replayable into another user's dataset or another column.
- Cross-file joins need a stable handle the model may see.
- The default Compose stack must get the protection without extra configuration.

## Considered Options

- **A — Encrypt flagged cells at rest, reveal cleartext only to a read that will be
  interned; add a keyed, per-owner HMAC companion column as join key.**
- **B — Irreversible masking at import** (the earlier behaviour).
- **C — Store cleartext and rely on the shield alone.**
- **D — A tenant-wide link key.**

## Decision Outcome

Chosen option: **A**.

- **Cells.** A flagged cell is stored as `enc1:<base64url(iv ‖ tag ‖ ciphertext)>`,
  AES-256-GCM under `HKDF(dataset secret, "omadia/dataset-cell-encryption/v1")`, with owner
  id and column name as AAD (`datasetCellCrypto.ts`).
- **Who reads cleartext.** `query_dataset` in a turn that carries a privacy handle (the
  result is interned, the model gets a digest); the owner's
  `GET /api/v1/datasets/:id/rows`. Without a guard the cells are re-masked on read. A
  reader without the key gets a fixed "encrypted, key not available" marker, never garbage
  and never a throw. `read_attachment` refuses tables and points to `query_dataset`.
- **Pinned precondition.** `query_dataset` is not intern-exempt; the reveal condition is
  the presence of the turn's privacy handle. If interning throws, the rows are withheld.
- **Link keys.** Every string column gets `__k_<column>` =
  `HMAC-SHA256(secret, ownerOmadiaUserId ‖ "\n" ‖ normalize(raw))`, 16 hex characters
  (`datasetLinkKey.ts`). The model sees this handle in clear. Filters on `__k_*` are
  refused on both `query_dataset` and `v4_filter` (#1560); a key is a join or distinct key
  only, and it cannot be listed as a non-personal field.
- **Secret.** `DATASET_LINK_KEY_SECRET`, or HKDF from `VAULT_KEY`
  (`omadia/dataset-link-key/v1`); the middleware hands the vault key to the dataset
  resolvers at boot, so the default stack has both (#1546). No key material is written to
  a dataset.

### Consequences

- 🟢 **Good:** Renders and exports hold real values for the owner; the model never reads
  them.
- 🟢 **Good:** The same person in two uploads joins without a name on the wire.
- 🔴 **Bad (deliberate weakening):** the link key is a stable identity handle the model
  sees. A filter oracle on clear-at-rest columns can in principle associate a probed row
  with its handle; the handle is worthless outside this user's datasets.
- 🔴 **Bad:** Rotating the secret (or `VAULT_KEY`) makes existing ciphertexts unreadable and
  stops older datasets linking with newer ones. An identity merge or future dataset
  sharing de-links older uploads, by design.
- 🔴 **Bad:** Names are not detected by C0 and stay clear at rest (masked downstream by the
  shape classifier); rows imported before the change hold irreversible surrogates.
- ⚪ **Neutral:** The day `query_dataset` became intern-exempt, the "behind the shield"
  branch would be a leak; `datasetCellCrypto.test.ts` pins the condition.

## Pros and Cons of the Options

### A — Encrypt, reveal behind the shield, per-owner link keys

- 🟢 Usable data, bounded exposure, no new linkability beyond what the owner had.
- 🔴 Key lifecycle becomes an operational concern.

### B — Irreversible masking

- 🟢 Nothing to decrypt, nothing to leak at rest.
- 🔴 Wrong results for the data's owner; no cross-file identity.

### C — Cleartext at rest

- 🟢 Simplest.
- 🔴 Every unshielded reader and every database dump holds the values.

### D — Tenant-wide link key

- 🟢 Links across users.
- 🔴 Adds linkability across owners that datasets otherwise do not have.

## More Information

- Related: [ADR-0094](0094-privacy-shield-data-plane-boundary.md),
  [ADR-0091](0091-non-personal-fields-scoped-entries-and-classification.md).
- Code: `middleware/packages/harness-orchestrator/src/datasetCellCrypto.ts`,
  `datasetLinkKey.ts`, `privacyInternPolicy.ts`; `docs/security-architecture.md` §6a, §6b.
- Tests: `middleware/test/datasetCellCrypto.test.ts`, `datasetLinkKey.test.ts`.
