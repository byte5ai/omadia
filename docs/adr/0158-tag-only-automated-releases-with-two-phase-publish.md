# 0158 — Releases are cut automatically from Conventional Commits as tags; a release is published only once its macOS update feed exists

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from
  `.github/workflows/auto-release.yml`, `release.yml`, `publish-images.yml` and
  `CONTRIBUTING.md`; two-phase publish from #928 / OM-69)

## Context and Problem Statement

This record is retroactive: it documents a release process that is implemented on main.

omadia releases often from a protected `main` (144 releases between 2026-07-06 and #928, five on
one day, per the comment in `auto-release.yml`). Each release has three channels that
must agree: the GitHub Release with its notes, the container images on GHCR, and the desktop
installers with their update feed. The organisation does not allow GitHub Actions to open
pull requests, and `main` requires a PR even for admins. Who decides that a release happens
and what its number is, where is the changelog, and when does a release become the one that
clients are told to install?

## Decision Drivers

- No manual release step and no release PR.
- Every release has a categorised changelog, by construction.
- A client must never be pointed at a release whose artifacts do not exist yet.
- No standing credential (PAT) just to commit version bumps.

## Considered Options

- **A — Tag-only releases computed from Conventional Commits on every push to `main`; images
  and installers built in the same run; draft first, published when the macOS feed is
  attached.**
- **B — A release PR per version (release-please style) that bumps versions and the changelog.**
- **C — Manual tags by a maintainer.**
- **D — Option A, but published and flagged latest immediately.**

## Decision Outcome

Chosen option: **A**.

- **Trigger and bump.** On each push to `main`, `auto-release.yml` reads the commit subjects
  and bodies since the last `vX.Y.Z` tag. `fix:` → patch; `feat:` → minor; `feat!:` or
  `BREAKING CHANGE` → minor while the major is 0; anything else → no release.
- **The tag is the version of record.** `package.json` files are not bumped. Running builds
  learn their version from the build stamp
  ([ADR-0148](0148-build-stamp-is-the-version-of-record-and-health-reports-it.md)).
- **Changelog in the same job.** `.github/scripts/generate-changelog.mjs` writes
  Added/Changed/Fixed notes from commit subjects; there is no path that tags without notes.
  GitHub Releases are the source of truth. `docs/CHANGELOG.md` is a mirror, refreshed by hand
  with `generate-changelog.mjs backfill`, never committed by the workflow.
- **PR discipline that feeds it.** Squash merge is the default; the PR title becomes the commit
  subject, so the PR title's Conventional Commit type decides the release (`CONTRIBUTING.md`).
- **Everything downstream runs in-run.** A release created with `GITHUB_TOKEN` fires no
  `release` event, so `publish-images.yml` and `desktop-apps.yml` are called as jobs of the
  same workflow.
- **Image tags.** Every push to `main`: `:edge` and `:sha-<short>` (`release.yml`). Every
  release: `:X.Y.Z`, `:vX.Y.Z`, `:X.Y`, `:vX.Y` and `:latest`. Three images: middleware,
  web-ui, updater; `linux/amd64` and `linux/arm64`.
- **Two-phase publish.** The release is created as a **draft**. `promote-release` publishes it
  and flags it latest only when `desktop-apps` reports `mac_feed_published`. If the feed never
  appears, the release stays a draft and the job fails red; the previous release keeps the
  latest flag.
- **npm publishing is gated off** (`if: false` in `release.yml`) until the npm scope is
  decided; `@omadia/plugin-api` is not on npm.

### Consequences

- 🟢 **Good:** Merging a `feat` or `fix` PR is the release; nothing else to do.
- 🟢 **Good:** macOS clients are never told about a version whose `latest-mac.yml` is missing.
  Before #928 each release opened a 30 to 60 minute window of 404s on the update feed.
- 🔴 **Bad:** A wrong commit type releases too much or nothing; `chore`, `docs`, `test` and
  `ci` never appear in release notes.
- 🔴 **Bad, accepted:** The promotion gate is macOS-only. A red Windows leg still promotes, so
  `latest.yml` can be missing on a release flagged latest (named in the workflow as a
  deliberate trade and an obvious follow-up).
- 🔴 **Bad:** A stuck draft lets the channels drift: `publish-images` does not wait for
  promotion, so the container `:latest` moves while desktop clients stay behind, and the next
  release's notes start after the stuck tag. Someone has to act on the red run.
- 🔴 **Bad:** `docs/CHANGELOG.md` lags until a maintainer runs the backfill.
- ⚪ **Neutral:** A prerelease version scheme would move electron-updater's version selection
  onto the atom feed; the draft protects against that, clearing `make_latest` alone would not.

## Pros and Cons of the Options

### A — Tag-only, in-run, draft then promote

- 🟢 Zero manual steps; channels gated on real artifacts.
- 🔴 Depends on commit-type discipline; promotion can stick.

### B — Release PR

- 🟢 Versions and changelog in git.
- 🔴 Actions may not open PRs in this organisation; a bot identity would be a standing
  credential, and a PR per release is the manual step this removes.

### C — Manual tags

- 🟢 Full human control.
- 🔴 Does not scale to the merge rate; changelog becomes optional.

### D — Publish immediately

- 🟢 Simpler workflow.
- 🔴 The 404 window on the update feed (OM-69).

## More Information

- Code: `.github/workflows/auto-release.yml`, `release.yml`, `publish-images.yml`,
  `desktop-apps.yml`, `.github/scripts/generate-changelog.mjs`.
- Docs: `CONTRIBUTING.md` ("Releases & changelog"), `docs/CHANGELOG.md`.
- Related drafts: [ADR-0152](0152-desktop-installers-signing-and-auto-update.md),
  [ADR-0148](0148-build-stamp-is-the-version-of-record-and-health-reports-it.md).
