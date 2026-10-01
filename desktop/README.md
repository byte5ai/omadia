# omadia Desktop (native installer)

A native, no-Docker way to run the full omadia stack locally on macOS and Windows.
The app bundles and supervises the existing omadia kernel and admin UI, and ships
an **embedded Postgres + pgvector** engine (PGlite) so there is no database to
install. An onboarding wizard collects your AI provider key on first run.

> Status: **first version (v1)**. Wires persistence + LLM + admin UI end to end.
> The wizard's one capability switch, **Attachments**, reaches the kernel: when it
> is on, attachments are kept in `<data folder>/attachments` (see
> [Capability switches](#capability-switches)). Semantic memory and diagrams are
> not wizard switches. The keyless embedding adapter is auto-installed and
> downloads its model from Admin → Embedding Provider; diagrams need the Diagrams
> plugin with a Kroki server and S3-compatible storage.

## How it works

```
Electron main
 ├─ embedded Postgres (PGlite + vector) exposed over the wire protocol on loopback
 ├─ kernel        ← forked from Electron-as-Node, DATABASE_URL → embedded engine
 ├─ web-ui (Next) ← forked from Electron-as-Node, MIDDLEWARE_URL → kernel port
 ├─ vault key + keychain key + provider keys ← secrets.enc, OS keychain via Electron safeStorage
 └─ tray · auto-update · onboarding wizard
```

`secrets.enc` is rewritten atomically (backup to `secrets.enc.bak`, temp file,
rename) and is created only when it is missing. The pre-update snapshot holds
`pgdata` plus `secrets.enc`, not `platform-data/`. See
[Secrets and recovery](#secrets-and-recovery).

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

npm test                             # unit + build-script tests
```

`npm test` runs plain `node --test` — the TypeScript unit tests under `test/` rely
on Node's native type stripping, so they need **Node >= 22.18** (the repo's
`.nvmrc` pins 22.22.3) and no test dependency. Test files live in `test/`, never
in `src/`: `tsconfig.json` compiles `src/**/*.ts` only, which is what keeps them
out of `dist/` and out of the shipped bundle.

## The child-process PATH

macOS/Linux GUI apps inherit a launcher-truncated PATH, so `src/pathEnv.ts`
builds the PATH handed to the forked kernel and web-ui itself. It probes:

- the standard system bins (`/opt/homebrew/{bin,sbin}`, `/usr/local/{bin,sbin}`,
  `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`) and `/snap/bin` on Linux
- `~/.volta/bin` and `~/.asdf/shims`
- `~/.local/bin` plus every `~/.local/<tool>/bin` one level deep — the shape an
  unpacked Node tarball takes, e.g. `~/.local/node/bin` (#925)
- one nvm bin dir, from `~/.nvm/alias/default` followed transitively (`lts/*`,
  `lts/<name>`, and `node` = the newest installed version all resolve)

Two invariants:

- **Appended, never prepended.** The discovered directories go *after* the
  inherited PATH, so a system install always keeps precedence.
- **Computed once at import** (`supervisor.ts`). A Node installed while the app
  is running stays invisible until the app restarts.

Every probe is failure-tolerant by design: a missing, unreadable, or hostile
`~/.local` or `~/.nvm` is skipped silently, so app boot never depends on it.

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
  "Re-run setup" instead of a dead auto-boot loop. The exception is an
  unreadable `secrets.enc`: setup would hit the same file, so that dialog
  explains the restore instead (see [Secrets and recovery](#secrets-and-recovery)).
- **Lifecycle hardening:** single-flight start/restart/stop state machine,
  generation token so intentionally-killed children aren't misreported as crashes,
  real awaited child-exit (not a fixed 500ms), SIGTERM→SIGKILL escalation
  (Windows-safe), rollback of partial boots, progress shown during restart, and a
  **blocking quit** that flushes + closes the embedded DB before exit.
- **Secrets fail closed:** if OS-backed encryption is unavailable, a packaged
  build refuses to store secrets in plaintext (matches the wizard's promise).
  An existing secrets file that cannot be read is never replaced with new keys.

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

## Who may navigate the window

The shell has one `BrowserWindow` and several code paths that want to point it
somewhere: the startup boot, the tray's *Restart*, the first-run wizard's
completion, and a crash recovery. Originally each one ended in an unconditional
`loadURL`. That is how a boot finishing while the wizard was open **overwrote**
the wizard and dropped the user on the sign-in form mid-setup, skipping the
data-directory step and the recovery-key step (round-3 finding OM-58).

`src/shellView.ts` now arbitrates every navigation. It is a pure, Electron-free
state machine so the ordering can be tested directly, and it holds two rules:

- **An open wizard is not overwritten.** Only the wizard's own completion, or a
  crash recovery (the page is already gone), may replace it.
- **A superseded navigation does not commit.** Every intent takes a monotonic
  token; a newer intent invalidates older ones, so whichever boot finishes last
  cannot stomp a view a newer one established.

Consequences worth knowing before you add a navigation:

- Call `mayStartNavigation` **before** claiming the window, and hand the token
  from `beginNavigation` back to `mayCommitNavigation` when the async work
  finishes. Skipping the second half reintroduces the original race.
- `beginNavigation` claims the view optimistically. If your load **rejects**, you
  must call `abandonNavigation` — otherwise the claim is held forever and the
  arbiter refuses every later boot and restart.
- A refused navigation is logged, never dropped silently, and user-visible where
  the user asked for it (tray → *Restart* during setup explains itself).

Renderer failure handling lives next to it in `src/loadFailure.ts`. Recovering
needs both a filter and a ceiling: `ERR_ABORTED` fires on the happy path
(`loading.html` is superseded by the app URL on every boot), subframe failures
belong to the page, and — the part that bit us — the identity check must be made
against the page a recovery would **actually** load, not a hardcoded one. Whatever
the filter cannot see is bounded by `MAX_RECOVERY_ATTEMPTS`, because
`render-process-gone` carries no URL to compare at all. There is deliberately
**no automatic retry**: a reload loop against a dead stack is worse than a screen
that names the problem.

### …and who may talk to main

The same window shows documents of very different trust: the bundled wizard
and loading pages, the loopback web UI (with third-party plugin UIs in
same-origin iframes), and, during an in-window OIDC/Entra sign-in, the IdP's
own pages. One preload serves all of them, so the trust boundary sits in main,
not in the page:

- **Every IPC channel names its surface.** `src/ipc.ts` registers channels only
  through `guardedHandle`/`guardedOn`, and `src/ipcSender.ts` decides each call
  from `event.senderFrame`, read synchronously on entry. The setup channels
  (`testLlmKey`, `chooseDataDir`, `exportRecoveryKey`, `complete`) answer only
  the bundled `dist/renderer/wizard.html` (compared as a file path) in the main
  frame, and only while the navigator above shows `wizard`. The UI pings
  (`uiReady`, `uiLocale`) answer only the running web UI's origin. A missing,
  destroyed or detached sender frame is refused, and so is any subframe.
- **The preload hands out only the document's own surface**
  (`src/bridgeSurface.ts`): the wizard gets the setup methods and the boot
  stream, the loading screen the boot stream, the web UI `uiReady` and
  `setUiLocale`, anything else no `window.omadia` at all. Plugin iframes reach
  the web UI's bridge through `window.parent`, so never add a method to the
  `app` surface that returns or writes a secret. `bridgeSurface.ts` is inlined
  into the sandboxed preload and must stay import-free.
- **Navigation is fenced** (`src/navigationPolicy.ts`,
  `src/navigationGuards.ts`, installed for every webContents and its session
  from `web-contents-created`). In place, the window stays on the web UI and
  kernel origins. Other web links and popups open in the system browser.
  `file:`, `javascript:`, `data:` and `about:blank` targets are refused; no
  page can navigate the window to a file, since main loads the bundled pages
  itself. Same-app popups open sandboxed and without a preload. Subframes may
  load web pages and `about:`/`data:`/`blob:` documents, nothing else. Web
  redirects are left alone so the in-window sign-in works; a foreign page
  reached that way has no bridge and every handler refuses it. A redirect to
  any other scheme is cancelled.
- **Nothing reaches the OS but vetted web links.** Electron hands a custom
  scheme (`ms-settings:`, `search-ms:`, an installed app's scheme) to the OS
  only after asking for the `openExternal` permission, and grants it when no
  handler is set. The session refuses it, whichever frame or redirect asked;
  the shell opens web links itself through `shell.openExternal`, after
  checking them. Every other permission keeps Electron's no-handler answer,
  which grants it to every frame; a deny-by-default allowlist per requesting
  origin and frame is an open follow-up (`docs/middleware-agent-handoff.md`
  §13, "Desktop-Shell: Trust-Boundary Renderer → Main").

Adding a bundled page means classifying it in `bridgeSurface.ts` and checking
it by path in `ipcSender.ts`, never widening the wizard surface. The full
rationale is in `docs/security-architecture.md` §10i.

## Secrets and recovery

`secrets.enc` in the data folder holds the kernel's `VAULT_KEY` and
`CREDENTIAL_KEYCHAIN_KEY` plus the provider API keys, encrypted with the OS
keychain (`src/secrets.ts`). The kernel vault, stored credentials and encrypted
dataset cells all depend on these keys, so the app treats the file as
irreplaceable:

- **New keys only for a missing file.** If `secrets.enc` exists but cannot be
  read, decrypted or parsed, the app leaves it untouched. Boot stops at a dialog
  ("omadia cannot open its secrets file") with advice for the step that failed,
  a *Show file* button and *Quit*. There is deliberately no *Re-run setup* and
  no "start over" button: the dialog also appears when a keychain prompt was
  merely denied.
- **Atomic rewrites.** A change (setup, a new provider key, the one-time
  migration that adds the credential keychain key) copies the file to
  `secrets.enc.bak` first, writes a temp file and renames it into place. A crash
  leaves the old file or the new one, never a torn one. The logic lives in the
  Electron-free `src/secretsBlob.ts` and `src/secretsStore.ts`.
- **Pre-update snapshot.** Before an update installs,
  `snapshots/pgdata-pre-<version>-<stamp>/` receives the database and
  `snapshots/pgdata-pre-<version>-<stamp>.secrets.enc` the secrets file.
  `platform-data/` (the kernel vault, installed plugins) is not included. When
  the data folder is cloud-synced, `snapshots/` lives under the app-data
  directory instead.

What to do when the dialog appears:

| The dialog says | Typical cause | What to do |
|---|---|---|
| the keychain did not unlock it | a denied keychain prompt, a changed app signature, a locked Linux keyring | The file is most likely intact. Start again and allow access (macOS: *Always Allow*). Do not delete the file. |
| encryption is unavailable | no Secret Service keyring on Linux | Start gnome-keyring or another libsecret provider, then start again. |
| it could not be read | file permissions, a disconnected drive | Restore access to the file or reconnect the drive. |
| the file is damaged | a torn or hand-edited file | Quit, replace `secrets.enc` with `secrets.enc.bak` or the newest `*.secrets.enc` in the snapshots folder, start again. |

`.bak` and the snapshot copies are encrypted with the same keychain entry as the
live file, so they help with a damaged file, not with a lost keychain entry.
**Starting over** is a manual step: quit and move the whole data folder aside
(keep it). The next start runs first-time setup with new keys. Deleting only
`secrets.enc` is not enough, because the kernel vault in `platform-data/` would
then no longer open.

## Capability switches

A switch in the setup wizard is a promise, so each one has to change what the
kernel is started with, and the kernel has to say whether it took. Earlier
builds offered three switches that were stored in `setup.json` and never read:
every choice booted the same stack.

- **Attachments** (on by default). The supervisor reads the switch from
  `setup.json` on every boot (`src/capabilities.ts`) and, when it is on, sets
  `ATTACHMENT_STORE_DIR=<data folder>/attachments`. The kernel then publishes a
  filesystem attachment store as its `tigrisStore` service
  (`middleware/src/platform/attachmentStore.ts`); objects are stored owner-only
  under the SHA-256 of their key, and nothing expires them. When the switch is
  off the variable is unset, even if the launch environment had one. S3 storage
  configured in the environment (`BUCKET_NAME` / `AWS_*`) takes precedence.
  What lands there today: files a channel persists through the kernel's store,
  such as Teams attachments with `TEAMS_ATTACHMENT_STORAGE_ENABLED=true`. The
  web UI chat has no file upload.
- **Readiness.** Once the kernel answers `/health`, the supervisor compares its
  `attachments.store` (`s3`, `filesystem` or `none`) with the switch and writes
  the verdict to the log as `[boot] attachments: …`. A disagreement is a
  warning, not a boot failure.
- **Not switches:** semantic memory and diagrams. Nothing the shell can set
  turns them on. The embedding weights are fetched from Admin → Embedding
  Provider, and diagrams need the Diagrams plugin, a Kroki server and S3
  storage, none of which a desktop install ships. `OMADIA_EMBEDDING_MODEL_DIR`
  and `DIAGRAM_PUBLIC_BASE_URL` in the kernel env are locations those features
  use once set up, not switches.

The choice cannot be changed after setup yet (there is no settings screen); the
handoff roadmap tracks that. A new switch follows the same rule: it maps to env
in `capabilityKernelEnv`, the kernel reports on `/health` whether it took,
`capabilities.ts` judges that answer, and `test/supervisorKernelEnv.test.mts`
pins the wiring. A switch that is only stored does not ship.

## Data + uninstall

Everything mutable lives under the per-user app-data directory (or a folder you
pick in the wizard): the embedded database, the encrypted secrets blob, plugin
uploads, attachments (when the switch above is on), and logs. Uninstalling
removes the app; delete the data folder to wipe state.
