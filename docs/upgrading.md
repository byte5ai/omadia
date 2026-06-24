# Upgrade and migration guide

How to move an omadia deployment from one version to the next.
[`CHANGELOG.md`](CHANGELOG.md) records *what* changed; this guide covers *how
to migrate*: renamed environment variables, schema changes, removed config
keys, and shifts in the plugin API.

> **Pre-1.0 caveat.** omadia is in public preview. Database schemas and
> internal surfaces may break between minor versions until `1.0.0`, and the
> upgrade path is hand-rolled today. An automated migration runner is on the
> v1.0 roadmap. Until then, read the section for your target version before
> pulling a new image.

## General upgrade steps

1. Read the section for your target version below, plus the
   [`CHANGELOG.md`](CHANGELOG.md) entries since your current one.
2. Back up your Postgres volume and your `VAULT_KEY`.
3. Pull the new image. Pin a release with `OMADIA_VERSION`, see the
   [README quickstart](../README.md#-quickstart).
4. Restart with `docker compose up -d`.
5. Verify the admin UI comes up and an existing agent run still works.

## Upgrading to 0.3

> Stub. Fill this in as part of the 0.3 release.

### Breaking changes

- _none recorded yet_

### Steps

1. Pull the new image.
2. Run the database migration if the schema changed (called out in the
   CHANGELOG).
3. Update any plugins built against an older `@omadia/plugin-api`.

## Keeping this guide current

Add a section per minor version as part of the release process. Even a short
stub beats a blank page: record renamed env vars, schema migrations, and
removed config keys while they are fresh.
