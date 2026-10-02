# omadia Desktop (native installer)

A native, no-Docker way to run the full omadia stack locally on macOS and Windows.
The app bundles and supervises the existing omadia kernel and admin UI, and ships
a **bundled PostgreSQL 17 + pgvector** engine so there is no database to
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
 ├─ embedded PostgreSQL 17 + pgvector on a private Unix socket (Windows: loopback TCP), SCRAM for every connection
 ├─ kernel        ← forked from Electron-as-Node, DATABASE_URL → embedded engine as omadia_kernel
 ├─ web-ui (Next) ← forked from Electron-as-Node, MIDDLEWARE_URL → kernel port
 ├─ vault key + keychain key + provider keys + DB passwords ← secrets.enc, OS keychain via Electron safeStorage
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
middleware + web-ui, checks that the middleware's native modules (better-sqlite3,
argon2, sharp — all N-API prebuilds) load under Electron's own Node the way the
supervisor runs the kernel (`ELECTRON_RUN_AS_NODE`; no Electron-ABI rebuild is
needed or done), stages the runtime, then runs electron-builder.
electron-builder 26 leaves the top-level `node_modules` of an `extraResources`
source out of the package, so `electron-builder.yml` lists the kernel's and the
web UI's `node_modules` as entries of their own. `afterPack` checks on every
platform that the package carries what both load at startup and fails the
build otherwise (`scripts/check-packaged-runtime.mjs`). Its test runs the
`extraResources` block through the installed electron-builder's copy code, so
an electron-builder bump that copies differently fails in PR CI already.

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
  runs on GitHub-hosted runners. The publisher name electron-builder 26 also
  requires is read from the signing certificate during the build and pinned into
  the app's `app-update.yml`, so an installed Windows app only accepts updates
  that are Authenticode-signed under that name.
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

## Install and upgrade smoke

`.github/workflows/desktop-upgrade-smoke.yml` installs the installers of one
`desktop-apps.yml` run on clean GitHub-hosted runners (macOS arm64, Windows x64,
Linux x64) and drives the app through Playwright's Electron support, so nobody
has to sit at three machines before a runtime change merges. Dispatch it with
the build's run id:

    gh workflow run desktop-upgrade-smoke.yml -f candidate_run_id=<run id>

The upgrade starts from the latest published release unless `baseline_tag`
names another one. v0.167.13 is the earliest it accepts, because older releases
get fields added to `secrets.enc` on the candidate's first start. When a PR
changes the wizard or the log lines the smoke reads, dispatch it from that
branch (`--ref <branch>`) so the driver matches the build.

Each platform runs two jobs. `fresh` installs the candidate and completes the
wizard with the `ANTHROPIC_API_KEY` repository secret. It then creates the first
admin through the kernel API, signs in, asks the kernel to verify the stored key
and waits for an update check that reads the release feed. `upgrade` runs the
same on the baseline release, without the update check, quits it, installs the
candidate over it and starts it again. That second start must log no boot
failure and no secret-store refusal, leave `secrets.enc` byte-identical, keep
the recovery key the baseline wizard showed and every other stored secret, and
still sign in and verify the stored key.

The installers receive the real key, so the workflow accepts only finished
`desktop-apps.yml` or `auto-release.yml` runs of this repository. The recovery
key and the stored keys are hashed inside the app. Each job uploads
`desktop-smoke-<platform>-<scenario>` with the report, a redacted copy of the
desktop log and screenshots.

Each runner is set up the way a user's machine looks. Windows runners run jobs
elevated, and `postgres.exe` refuses an administrator token, so the driver runs
with the Basic User token (`runas /trustlevel:0x20000`) an administrator gets
under UAC. Linux gets Xvfb and an unlocked gnome-keyring in a GNOME session,
because the packaged app keeps no secrets without OS encryption. On macOS a
keychain of its own keeps unlock prompts out of the run. The baseline starts
with a dead proxy for Chromium's network stack, so its updater cannot download
a newer release mid-test. One thing differs from a user's machine: the kernel
gets 300 s for its first boot instead of 90 s, and the report warns when a
start needed more than 90 s.

Gatekeeper and notarization are out of its reach, because nothing the runner
downloads is quarantined. Installs through the auto-updater, the `.deb` package
and Intel Macs are not covered either.

## Review findings & v1 decisions

A full adversarial review (Forge / codex, local) was run on this code. Resolved:

- **Embedded DB is single-client (the make-or-break risk).** Empirically verified:
  `pglite-socket` serializes connections — a multi-connection `pg.Pool` (`max:10`)
  *terminates* the extra connections, but a pool capped at **1** multiplexes 20
  concurrent queries in <10ms with no loss. Fix: the kernel's single `graphPool`
  now honours `GRAPH_POOL_MAX`, and the desktop app sets it to `1`. This is the
  seam (one env var) that makes the no-Docker DB work without forking the kernel.
- **Database authentication.** The PGlite engine accepted any credentials, and
  the native PostgreSQL that replaced it was first initialised with `trust`.
  Now every connection needs a SCRAM password and the kernel connects as a role
  without superuser rights; see [Database authentication](#database-authentication).
  The server listens on a Unix socket in a private directory (Windows:
  loopback only). The kernel previously bound `::` (all interfaces); it now
  honours `HOST`, and the desktop app sets `HOST=127.0.0.1` so the local
  install is never reachable on the LAN.
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

- Secrets (`VAULT_KEY`, provider keys, and the kernel role's database password
  inside `DATABASE_URL`) are passed to the kernel via the child
  **environment**, readable by same-user processes (`ps eww`). A same-user
  attacker already has the data dir, so this is accepted for v1; hardening to a
  stdin/fd handoff is a follow-up. The database superuser's password is not in
  that environment: it never leaves the shell.
- Free-port selection has a TOCTOU window: a port is chosen free and released
  before the child binds it, and the database port is free again while the
  shell repairs a password in single-user mode. For the database this matters
  only on Windows (macOS and Linux use a private socket and no TCP port), and
  there another local user who binds it fails the boot rather than learning a
  password: the shell trusts only a server whose `postmaster.pid` names the
  process it started and that completes SCRAM. The kernel's own database
  connections are not SCRAM-only yet; see [Database authentication](#database-authentication).
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
- The merged feed also declares `minimumSystemVersion`: the macOS minimum of the
  packaged Electron, written as the Darwin kernel version electron-updater
  compares with `os.release()` (`22.0.0` = macOS 13). Macs below it are not
  offered the update and keep the version they run. `buildResources/afterPack.js`
  fails the build when the packaged app's `LSMinimumSystemVersion` no longer
  matches `MACOS_MINIMUM` in that script — after an Electron major, update the
  constant, not the check.
- electron-updater reports such a Mac with the same `update-not-available`
  event, and the same feed version, as a current one. `src/updateHoldBack.ts`
  tells the two apart, so the app says which macOS the release needs instead of
  "already on the latest version" (once per floor at startup, and on every
  manual check). Its Darwin → macOS table is the inverse of the one in the feed
  script; `test/updateHoldBack.test.mts` fails when they disagree. Only builds
  that carry this handler can say it, so a floor that leaves Macs behind has to
  ship after a release those Macs can still install.
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
`CREDENTIAL_KEYCHAIN_KEY`, the provider API keys and the two embedded-database
passwords, encrypted with the OS keychain (`src/secrets.ts`). The kernel vault,
stored credentials and encrypted dataset cells all depend on these keys, so the
app treats the file as irreplaceable:

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

## Database authentication

The embedded PostgreSQL 17 cluster asks every connection for a SCRAM-SHA-256
password. Its `pg_hba.conf` belongs to the shell (`src/embeddedDbAuth.ts`):
password-only rules for exactly two roles, rewritten whenever the file differs
but only while the server is stopped, and the server starts with `hba_file`
pinned to it on the command line. Whoever runs a client, under whichever OS
account, gets nowhere without a password.

Where it listens (`src/embeddedDbEndpoint.ts`):

- **macOS and Linux:** only on a Unix socket in `<app data>/pg-socket`, a
  directory created `0700` and checked to be owned by the desktop user, with
  the socket itself `0700` too. There is no TCP listener at all, and the
  kernel's `DATABASE_URL` names the socket directory as its host. No other OS
  user can reach the server or put a listener where the shell and the kernel
  connect. When that path is too long for a socket (about 100 bytes, a long
  home directory) or cannot be made private, the socket goes into a fresh
  private directory under the OS temp folder instead, one per start. It is
  never the chosen data folder, which may be cloud-synced.
- **Windows:** on `127.0.0.1`. A socket there too is a follow-up (see the
  end of this section).

How the shell knows the server is its own: the server counts as started once
its own `postmaster.pid` names the process the shell spawned, on the expected
socket or address, with status `ready`; that check sends no credentials. Every
connection the shell opens accepts SCRAM and nothing else
(`src/scramOnlyConnect.ts`): a server that asks for a cleartext or MD5
password, offers no SCRAM, or lets the client in without an exchange is
refused before a password is sent, and SCRAM's last step makes the server
prove it holds the password's verifier. The first login after every start is
the superuser's and must report this cluster's data directory before the
kernel's password goes anywhere. Before provisioning, before the verification
and before the kernel gets its `DATABASE_URL`, the shell checks again that the
server it started still runs and still holds its endpoint.

| Role | Used by | May |
|---|---|---|
| `omadia` | the shell only (provisioning, extensions) | everything: it is the bootstrap superuser |
| `omadia_kernel` | the kernel, via `DATABASE_URL` | own and change the `omadia` database and all it holds; no superuser, so no `COPY ... TO PROGRAM`, no server file access, no new roles or databases |

Both passwords are random, stored in `secrets.enc`, and written and read back
before a cluster is created or its authentication touched. The kernel gets only
its own. The shell creates the `vector` and `pg_trgm` extensions itself,
because pgvector is not a trusted extension and a non-superuser cannot create
it.

`omadia_kernel` owns its database, so the shell treats that database as
untrusted when it connects there as the superuser: every maintenance connection
pins a fixed `search_path` (system catalogs first) and the ownership transfer
schema-qualifies its calls, so a statement the shell runs cannot be redirected
onto an object the owning role planted. The start-up check also refuses the
kernel role a `DATABASE_URL` if it has gained a role membership, which could
otherwise restore a capability the restricted role is meant to lack.

What a start does:

- **Normal start:** the shell's `pg_hba.conf` is in place, the superuser login
  finds this cluster and the kernel role logs in, so the shell only verifies:
  a wrong password is refused for both roles, and the kernel role holds no
  privilege. The server logs those two refused attempts as
  `FATAL: password authentication failed`. That is the check, not a fault; a
  failed check stops the start instead.
- **First start of a cluster created before passwords were required:** before
  the server starts, the superuser gets its password in PostgreSQL's
  single-user mode (`postgres --single`, which opens no port), then
  `pg_hba.conf` switches to passwords. Only then does the server listen, and
  `omadia_kernel` is created and takes over the database and every object the
  kernel had created. Logged at warn (`migrating a trust-authenticated
  cluster`).
- **Stored password refused** (a lost or regenerated `secrets.enc`, a `pgdata`
  snapshot restored without its `.secrets.enc`): the shell stops the server,
  sets the password in single-user mode and starts it again. Nothing listens
  in between, so at no point does anyone get in without a password. Logged at
  warn (`single-user mode`).
- **Dev tree without pgvector:** the shell logs that `vector` is not installed
  and continues; the kernel's graph migration then fails as it always has there.

**Going back to an older version:** a build from before passwords were required
connects without one, so it cannot open a migrated cluster. Restore the
pre-update snapshot (`snapshots/pgdata-pre-<version>-<stamp>/` as `pgdata/`,
its `.secrets.enc` as `secrets.enc`); a later update migrates it again.

**What is left on Windows.** The loopback port is free while the server is
stopped: between choosing the port and starting the server, and during a
single-user password repair. Another local user can bind it in that window.
The server then fails to start, so the boot fails (the next start picks a free
port); the shell's SCRAM-only logins hand that listener no password, and its
`postmaster.pid` check never takes it for the server. The kernel's own
connections use a stock pg client, though: if the server stops while the
kernel runs and another user binds the port before the kernel reconnects,
that listener could ask the kernel for its password in cleartext. Closing that
is a follow-up: a SCRAM-only client for the kernel's pools, or a private socket
on Windows too (`docs/middleware-agent-handoff.md` §13). macOS and Linux are
not affected: the private socket directory has room for no one else's
listener.

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
