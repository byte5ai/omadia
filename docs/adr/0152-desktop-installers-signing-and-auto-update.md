# 0152 — Desktop installers are built per architecture on each release, signed fail-soft but verified, and update from GitHub Releases behind a snapshot

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from
  `.github/workflows/desktop-apps.yml`, `desktop/electron-builder.yml`, `desktop/README.md`;
  unopenable macOS builds #558, snapshot fixes #926 and #934, read-only archive entries OM-86)

## Context and Problem Statement

This record is retroactive: it documents a release path that is implemented on main.

The desktop app (see [ADR-0154](0154-desktop-shell-supervises-the-unmodified-stack-with-bundled-postgres.md))
ships the kernel, the web-ui and a Postgres engine as unpacked native resources. It has to
reach users as a trusted installer on macOS, Windows and Linux, keep itself up to date, and
survive an update that goes wrong, because the app holds the user's database. Releases are
cut automatically and often. How are installers built, signed and versioned, where do updates
come from, and what protects the data across an update?

## Decision Drivers

- Native resources cannot be arch-split inside one bundle.
- A contributor fork without signing secrets must still be able to build.
- A release must never ship an artifact that claims to be signed and is not.
- The database must be restorable after a failed update.

## Considered Options

- **A — electron-builder per OS and architecture in release CI; signing optional but verified
  when configured; electron-updater on the GitHub Release feed; a snapshot before install.**
- **B — One universal macOS binary.**
- **C — Signing mandatory: no secrets, no build.**
- **D — No in-app update; users download new installers.**

## Decision Outcome

Chosen option: **A**.

- **Built on every release, separately from the images.** `desktop-apps.yml` is called in-run
  by `auto-release.yml` (and by `release: published` or manual dispatch). It runs apart from
  the GHCR pipeline so neither blocks the other. Targets: macOS `dmg` + `zip`, Windows `nsis`,
  Linux `AppImage` + `deb`.
- **One runner per architecture.** macOS arm64 and x64 are built on runners of their own
  architecture (`macos-latest`, `macos-26-intel`); `extraResources` are copied verbatim, so an
  x64 bundle built on arm64 would carry arm64 binaries.
- **One merged macOS feed.** Each mac job holds back its `latest-mac.yml`; the
  `mac-update-feed` job merges both (`desktop/scripts/merge-mac-update-feed.mjs`) and adds
  `minimumSystemVersion` as a Darwin kernel version, because electron-updater compares it with
  `os.release()`. `buildResources/afterPack.js` fails a mac build whose
  `LSMinimumSystemVersion` does not match that floor.
- **The version comes from the tag.** `desktop/package.json` stays at a placeholder in git;
  `scripts/set-desktop-version.mjs` writes the release version before packaging and CI asserts
  it landed.
- **Signing is fail-soft, verification is not.** Without secrets the build still produces
  installers (ad-hoc on macOS). With Apple secrets it signs, notarizes and staples; on Windows
  it uses Azure Trusted Signing, with a legacy `.p12` path only for certificates issued before
  2023-06-01. If signing is configured and an artifact comes out unsigned, the build fails.
  The Windows publisher name from the signing certificate is pinned into `app-update.yml`.
- **The packaged runtime is checked.** `afterPack` runs `scripts/check-packaged-runtime.mjs`
  on every platform; a release step verifies that the middleware's native modules load under
  Electron's Node.
- **Updates.** electron-updater reads the GitHub Release feed (`publish: provider: github`).
  `autoDownload` is on, `autoInstallOnAppQuit` is off: the shell installs only after the user
  accepted and after a pre-update snapshot of `pgdata` plus `secrets.enc`
  (`desktop/src/dbSnapshot.ts`). Snapshots have unique names, three are kept
  (`SNAPSHOTS_TO_KEEP`), and pruning runs before the copy. After two failed install attempts
  for one version (`MAX_INSTALL_ATTEMPTS`) the app stops prompting and explains.
- **A held-back Mac is told so.** `desktop/src/updateHoldBack.ts` distinguishes "below the
  macOS floor" from "already current".
- **Smoke on real runners.** `desktop-upgrade-smoke.yml` installs a build on clean macOS,
  Windows and Linux runners, completes the wizard and upgrades over a baseline release.

### Consequences

- 🟢 **Good:** Every release has installers and a working update feed for both mac architectures.
- 🟢 **Good:** v0.56.0 and v0.57.0 shipped a macOS app that could not be opened (#558); the
  always-on verification gate turns that into a red build.
- 🔴 **Bad:** Each release costs four native builds plus notarization on Apple's clock, which is
  why release publication is two-phase (see [ADR-0158](0158-tag-only-automated-releases-with-two-phase-publish.md)).
- 🔴 **Bad:** GitHub retires x86_64 macOS runners in August 2027; the Intel leg then goes or
  moves to a self-hosted runner.
- 🔴 **Bad:** Snapshots are full copies of the cluster, up to three of them on the user's disk.
  `platform-data/` is not in the snapshot.
- 🔴 **Bad:** The smoke does not cover Gatekeeper, installs through the auto-updater, the
  `.deb` package or Intel Macs, and it is dispatched by hand.
- ⚪ **Neutral:** Until Windows signing secrets exist in a repository, its Windows installers
  ship unsigned and SmartScreen warns.

## Pros and Cons of the Options

### A — Per-arch builds, verified signing, snapshot before install

- 🟢 Works with the native-resource design; forks can build.
- 🔴 Long release pipeline; feed merge and floor are hand-built.

### B — Universal macOS binary

- 🟢 One download, one feed.
- 🔴 Not possible while the runtime ships as unpacked native `extraResources`.

### C — Mandatory signing

- 🟢 No unsigned artifact ever.
- 🔴 No build without byte5's certificates; a lapsed Apple agreement blocks every release.

### D — No auto-update

- 🟢 No updater code, no snapshot.
- 🔴 Users stay on old versions of a product that releases often (144 releases between 2026-07-06 and the #928 change, per the comment in `auto-release.yml`).

## More Information

- Code: `.github/workflows/desktop-apps.yml`, `.github/workflows/desktop-upgrade-smoke.yml`,
  `desktop/electron-builder.yml`, `desktop/buildResources/afterPack.js`, `desktop/src/updater.ts`,
  `desktop/src/dbSnapshot.ts`, `desktop/src/snapshotRetention.ts`, `desktop/src/updateAttempts.ts`.
- Tests: `desktop/scripts/merge-mac-update-feed.test.mjs`, `desktop/test/dbSnapshot.test.mts`,
  `desktop/test/updateHoldBack.test.mts`, `desktop/test/updateAttempts.test.mts`.
- Docs: `docs/security-architecture.md` §4a (Windows update signatures, macOS update floor).
- Related drafts: [ADR-0158](0158-tag-only-automated-releases-with-two-phase-publish.md),
  [ADR-0153](0153-desktop-secret-custody-and-shell-trust-boundaries.md).
