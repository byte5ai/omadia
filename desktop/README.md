# omadia Desktop (native installer)

A native, no-Docker way to run the full omadia stack locally on macOS and Windows.
The app bundles and supervises the existing omadia kernel and admin UI, and ships
an **embedded Postgres + pgvector** engine (PGlite) so there is no database to
install. An onboarding wizard collects your AI provider key on first run.

> Status: **first version (v1)**. Wires persistence + LLM + admin UI end to end.
> Capability toggles for in-process embeddings, hosted diagrams, and the
> filesystem attachment store are surfaced in the wizard but not yet wired in the
> kernel (later milestones) — they are stored and degrade gracefully today.

## How it works

```
Electron main
 ├─ embedded Postgres (PGlite + vector) exposed over the wire protocol on loopback
 ├─ kernel        ← forked from Electron-as-Node, DATABASE_URL → embedded engine
 ├─ web-ui (Next) ← forked from Electron-as-Node, MIDDLEWARE_URL → kernel port
 ├─ vault key + provider keys ← OS keychain via Electron safeStorage
 └─ tray · auto-update · onboarding wizard
```

The kernel and UI are unmodified: the embedded DB speaks the Postgres wire
protocol, so the kernel's normal `pg`/`DATABASE_URL` path connects to it and runs
all existing migrations. See `../docs/plans/native-installer-plan.md` for the full
design and the file:line integration anchors.

## Develop

Requires a built middleware + web-ui in the repo (Node 22.x via nvm):

```bash
# from repo root
cd middleware && npm run build
cd ../web-ui   && npm run build      # next.config.ts already sets output:"standalone"

cd ../desktop
npm install
npm run dev                          # runs against the sibling repo builds
```

## Package installers

```bash
cd desktop
npm run pack:mac     # → release/*.dmg + *.zip   (arm64 + x64)
npm run pack:win     # → release/*.exe (NSIS, per-user)
npm run pack:all
```

`pack:*` first stages the built runtime into `desktop/runtime/` (via
`scripts/stage-runtime.mjs`), then runs electron-builder. Signing/notarization is
off by default; set the `CSC_*` / `APPLE_*` env vars and flip `notarize: true` in
`electron-builder.yml` for release builds.

## Release CI — signed installers on every GitHub Release

`.github/workflows/desktop-apps.yml` builds + signs the installers for **macOS,
Windows and Linux** and uploads them to the Release that triggered it (separate
from the GHCR image pipeline so neither blocks the other). Per OS it builds the
middleware + web-ui, rebuilds the middleware's native modules for Electron's ABI
(`@electron/rebuild` — electron-builder does the app's own deps but not the
staged `extraResources`), stages the runtime, then runs electron-builder.

Signing is **fail-soft** — without secrets it still ships installers (ad-hoc on
macOS):

- **macOS** (the process already proven for `byte5ai/omadia-ui`; same `_HIGH5`
  secret names so the existing values drop straight in):
  `APPLE_CERTIFICATE_P12_BASE64_HIGH5`, `APPLE_CERTIFICATE_PASSWORD_HIGH5`,
  `APPLE_ASC_KEY_ID_HIGH5`, `APPLE_ASC_ISSUER_ID_HIGH5`,
  `APPLE_ASC_KEY_P8_BASE64_HIGH5`, `APPLE_TEAM_ID_HIGH5`. The workflow imports the
  Developer ID cert, notarizes the `.app` via electron-builder, then
  `notarytool submit --wait` + `stapler staple` the DMG and verifies (rejects
  ad-hoc) — identical to the omadia-ui flow.
- **Windows — Azure Trusted Signing** (preferred): `AZURE_TENANT_ID`,
  `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGN_ENDPOINT`,
  `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_CERT_PROFILE`. electron-builder drives this
  natively via `win.azureSignOptions` and installs the `TrustedSigning`
  PowerShell module itself; the workflow passes the three account coordinates on
  the CLI so no byte5-specific value is baked into the repo. No hardware token,
  runs on GitHub-hosted runners.
- **Windows — legacy Authenticode `.p12`**: `WINDOWS_CSC_LINK_BASE64`,
  `WINDOWS_CSC_KEY_PASSWORD`. Only usable with certificates issued **before
  2023-06-01**. Since then the CA/Browser Forum requires every code-signing
  private key — OV *and* EV — to be generated and held in a FIPS 140-2 Level 2 /
  EAL4+ HSM, so a newly issued certificate cannot be exported to a file at all.
  Used only when the Azure secrets are absent.

> Add the secrets under **byte5ai/omadia → Settings → Secrets → Actions**. The
> Apple values are the same ones already in the omadia-ui repo (one Developer ID
> per Apple account). Until the Windows secrets exist, Windows installers ship
> unsigned — the installer still runs, but SmartScreen shows an "unknown
> publisher" warning.
>
> Both platforms have an **always-on verification gate**: if signing is
> configured but the artifact comes out unsigned, the build fails rather than
> going green and shipping it. That failure mode is not hypothetical — v0.56.0
> and v0.57.0 shipped a macOS app that could not be opened at all (#558).

**Not yet CI-validated:** the cross-platform middleware build + native rebuild on
the Windows/macOS runners has only been exercised locally on macOS — the first
real Release run is the acceptance test.

## Review findings & v1 decisions

A full adversarial review (Forge / codex, local) was run on this code. Resolved:

- **Embedded DB is single-client (the make-or-break risk).** Empirically verified:
  `pglite-socket` serializes connections — a multi-connection `pg.Pool` (`max:10`)
  *terminates* the extra connections, but a pool capped at **1** multiplexes 20
  concurrent queries in <10ms with no loss. Fix: the kernel's single `graphPool`
  now honours `GRAPH_POOL_MAX`, and the desktop app sets it to `1`. This is the
  seam (one env var) that makes the no-Docker DB work without forking the kernel.
- **No real DB auth.** Verified: `pglite-socket` accepts any credentials. Security
  therefore rests entirely on **loopback-only** binding. The kernel previously
  bound `::` (all interfaces); it now honours `HOST`, and the desktop app sets
  `HOST=127.0.0.1` so the local install is never reachable on the LAN.
- **Setup is only marked boot-verified after a successful boot** (`completed`),
  so a failed first boot can't brick the next launch; a failed boot offers
  "Re-run setup" instead of a dead auto-boot loop.
- **Lifecycle hardening:** single-flight start/restart/stop state machine,
  generation token so intentionally-killed children aren't misreported as crashes,
  real awaited child-exit (not a fixed 500ms), SIGTERM→SIGKILL escalation
  (Windows-safe), rollback of partial boots, progress shown during restart, and a
  **blocking quit** that flushes + closes the embedded DB before exit.
- **Secrets fail closed:** if OS-backed encryption is unavailable, a packaged
  build refuses to store secrets in plaintext (matches the wizard's promise).

Accepted v1 limitations (tracked for a follow-up):

- Secrets (`VAULT_KEY`, provider keys) are passed to the kernel via the child
  **environment**, readable by same-user processes (`ps eww`). A same-user
  attacker already has the data dir, so this is accepted for v1; hardening to a
  stdin/fd handoff is a follow-up.
- Free-port selection has a small TOCTOU window (port released before the child
  binds). Rare on a local machine; surfaces as a boot-timeout, not corruption.
- No app/tray icons shipped yet (Electron defaults used).
- No Linux target in v1 (mac + win only), though the code paths are cross-platform.

## macOS: two architectures

macOS ships **arm64 and x64 separately**, each built on a runner of its own
architecture. That is forced by the design, not a preference: the omadia runtime
rides along as unpacked `extraResources` (native node modules plus the embedded
Postgres engine), which electron-builder copies verbatim and cannot arch-split.
An x64 bundle produced on an arm64 host would contain arm64 binaries and crash on
Intel — so a universal binary is not an option while the runtime ships this way.

Consequences worth knowing before touching this:

- Each run emits its own `latest-mac.yml` listing only its own artifacts, and
  both target the same release. electron-updater's `MacUpdater` picks a download
  by testing the file URL for `arm64`, so a single-architecture feed leaves Intel
  users with no matching file, or pushes every Apple Silicon user onto Rosetta.
  The mac jobs therefore **hold back** that file and the `mac-update-feed` job
  merges both (`scripts/merge-mac-update-feed.mjs`, covered by `npm test`).
- `stage-runtime.mjs` follows `process.arch`, so it needs no changes — but
  anything that hardcodes `darwin-arm64` does. The pgvector CI step now derives
  the architecture and asserts the resulting `vector.dylib` really is that
  architecture, because a mismatch would only surface at `CREATE EXTENSION`
  inside the shipped app on a user's machine.
- GitHub retires x86_64 runners in **August 2027**. At that point the Intel
  matrix entry has to go, or move to a self-hosted Intel runner.

## Data + uninstall

Everything mutable lives under the per-user app-data directory (or a folder you
pick in the wizard): the embedded database, the encrypted secrets blob, plugin
uploads, and logs. Uninstalling removes the app; delete the data folder to wipe
state.
