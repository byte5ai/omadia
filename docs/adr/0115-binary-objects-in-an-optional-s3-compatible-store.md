# 0115 — Binary objects live in one optional S3-compatible store; metadata stays in Postgres

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively); storage overlay in #339, SeaweedFS
  instead of MinIO in #1506.
- **Supersedes:** —

## Context and Problem Statement

This record is retroactive. Chat attachments, rendered diagrams, office exports and uploaded
dataset files are binary and can be large. Postgres holds the graph and the scratch memory;
the data volume holds install-local state (vault, `installed.json`, builder drafts, uploaded
plugin packages; `middleware/src/platform/paths.ts`). A minimal install has neither a bucket
nor the wish to run one. Where do binary objects go, what happens without object storage, and
what stands in for the hosted bucket locally?

## Decision Drivers

- The minimal core must run without object storage.
- Several instances must see the same objects in production.
- One code path for hosted, compose and desktop installs.
- Stored user files need an expiry that does not depend on application code.

## Considered Options

- **A — One optional kernel service with a small object contract; S3-compatible storage
  first, a local directory second, nothing third.**
- **B — Bytes in Postgres** (`BYTEA`) for all binary objects.
- **C — Files on the data volume** for all installs.

## Decision Outcome

Chosen option: **A**.

- **Contract.** `TigrisStore` (`@omadia/diagrams`): `exists`, `put`, `getStream`. No list and
  no delete. The kernel publishes it as the service `tigrisStore`; the name is kept because
  consumers resolve it by that name.
- **Selection at boot** (`platform/attachmentStore.ts`): (1) S3 when all four of
  `BUCKET_NAME`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` are set
  (Tigris on Fly, path-style addressing); (2) else a local directory when
  `ATTACHMENT_STORE_DIR` is set (desktop app, single machine); (3) else no store. `/health`
  reports which one (`attachmentStoreHealth`).
- **No store is a supported state.** The service is not published; attachment reads answer
  "storage unconfigured" and the features that persist objects stay off.
- **One bucket, one expiry rule.** Objects expire after 90 days through a bucket lifecycle
  rule (`scripts/setup-tigris-lifecycle.ts`; the compose overlay sets the same rule), not
  through application deletes. Consumers separate themselves by key prefix
  (`TEAMS_ATTACHMENT_KEY_PREFIX`, default `teams-attachments`).
- **Postgres keeps the index.** Tables hold the object key and metadata, never the bytes:
  `teams_attachments.storage_key`, `datasets.source_storage_key`.
- **Local stand-in.** `docker-compose.storage.yaml` adds SeaweedFS (`chrislusf/seaweedfs`,
  `weed mini`, S3 API on port 9000 bound to 127.0.0.1) and a one-shot `amazon/aws-cli` container
  that creates the bucket and the 90-day rule. MinIO was replaced because its images were
  removed from Docker Hub and quay.io (#1506). Both images are pinned to a version tag.
- **Filesystem fallback confines keys.** An object is stored under the SHA-256 of its key, so a
  caller-chosen key can never become a path; writes are temp-file-then-rename, owner-only.
- **Vault backup** may use the same bucket (`VAULT_BACKUP_ENABLED`); it uploads ciphertext
  only, never `VAULT_KEY`.

### Consequences

- 🟢 **Good:** The core boots without a bucket; adding one is four env values.
- 🟢 **Good:** Retention is enforced by the storage service, also when the middleware is down.
- 🔴 **Bad:** Rows that point at an object outlive it: after 90 days a `storage_key` in
  Postgres names nothing.
- 🔴 **Bad:** The contract has no delete, so an erasure request cannot remove an object before
  its expiry through this interface ([ADR-0120](0120-memory-purge-is-complete-previewed-and-audited.md) does
  not touch the bucket).
- 🔴 **Bad:** The filesystem fallback has no expiry and is not shared between instances.
- ⚪ **Neutral:** Not everything binary goes here: profile bundles and snapshots are `BYTEA` in
  Postgres on purpose ([ADR-0122](0122-profile-state-and-snapshots-as-bytes-in-postgres.md)). The overlay's
  credentials are local-only defaults.

## Pros and Cons of the Options

### A — Optional S3-compatible service with fallbacks

- 🟢 Same contract on Fly, compose and desktop; streaming reads.
- 🔴 A second store to back up; dangling keys.

### B — Bytes in Postgres

- 🟢 One store, transactional with the metadata.
- 🔴 Large objects in a serverless database; no built-in expiry.

### C — Data volume only

- 🟢 Nothing to run.
- 🔴 Not shared between instances; ties attachments to one machine's volume.

## More Information

- Code: `middleware/src/platform/{attachmentStore,filesystemObjectStore}.ts`,
  `middleware/packages/harness-diagrams/src/tigrisStore.ts`, `middleware/src/config.ts`
  (`BUCKET_NAME` … `ATTACHMENT_STORE_DIR`), `docker-compose.storage.yaml`,
  `middleware/scripts/setup-tigris-lifecycle.ts`.
- Tests: `middleware/test/attachmentStore.test.ts`.
- Related: ADR-0004. Border: deployment / diagrams and office plugins.
