# Changelog

All notable changes to omadia are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The canonical, always-current changelog per version is each release's GitHub
Release notes — generated automatically by `.github/workflows/auto-release.yml`
from Conventional Commit messages, no release ships without one.

This file is a mirror of the same data, and the mirror is refreshed **by hand**:

```
node .github/scripts/generate-changelog.mjs backfill
```

Nothing refreshes it automatically, and that is deliberate rather than an
oversight — `main` requires a pull request and this org forbids GitHub Actions
from opening one, so the alternatives were a standing PAT-backed bot identity
or a PR per release to merge manually. Both were judged worse than a mirror
that drifts. See the reasoning in `.github/workflows/auto-release.yml`.

**So this file can be behind, and it has been.** To check before you trust it,
compare the newest `## [x.y.z]` heading below against `git tag --sort=-v:refname
| head -1`. If they differ, the mirror is stale and the GitHub Releases are
authoritative. It drifted for 145 versions between 2026-07-06 and 2026-08-28
(#937), during which everything shipped in that span sat under `[Unreleased]`
and read as unreleased to anyone outside the team.

Add hand-written notes under `## [Unreleased]` any time; they carry over
verbatim into the next version's entry. See `CONTRIBUTING.md` § Releases &
changelog.

---

## [Unreleased]

### Fixed — The subscription-CLI agent can no longer run shell commands on the user's machine

2026-09-03 — Beta test round 4, OM-81 (#991). On the subscription path the
agent loop runs inside the external `claude` CLI, and a tester asked the omadia
chat to run `whoami && hostname`. The CLI did, with the user's OS rights, no
confirmation, and none of omadia's gates (plugin grants, audience floor, privacy
guard, `sandbox_execute_enabled`) involved. omadia had registered no shell tool;
the call came from the CLI's own built-in `Bash`. `--allowedTools mcp__omadia__*`
only pre-approves omadia's loopback tools, it never removed the built-ins.

The spawn argv now closes the boundary four ways: `--tools ""` removes the
CLI's built-in tool set (MCP tools stay), `--disallowedTools` carries a named,
test-asserted deny list (`CLI_BUILTIN_TOOL_DENYLIST`) as a fallback for a CLI
that ignores `--tools`, `--permission-mode dontAsk` denies anything not
pre-approved instead of prompting a UI nobody sees, and `--setting-sources ""`
keeps the operator's personal allow rules out of the session. Any tool call in
the trace whose name is not `mcp__omadia__*` is marked `foreign`, so a CLI-native
call can never read like an omadia call.

### Fixed — On the subscription path the agent introduces itself as omadia, not as Claude Code

2026-09-03 — OM-83 (#992). omadia's instructions were passed to the CLI with
`--append-system-prompt`, so Claude Code's own prompt stayed the primary
identity. The model told a user sitting in the omadia chat that it was "running
in a CLI session in the middleware repo", advised them to "ask the same thing in
an omadia chat", and offered to schedule the task in a different system. The
prompt is now replaced via `--system-prompt`: the agent's persona comes first,
followed by a fixed runtime note naming omadia and the only toolset the model
actually has (the `mcp__omadia__*` MCP tools). A neutral default applies when no
persona is configured, so the CLI's self-description never leaks through.

### Fixed — omadia's own tools keep the user context when called through the loopback MCP server

2026-09-03 — OM-82 (#993). Asked from the omadia chat to create a routine, the
CLI-backed agent got `Error: cannot create routine outside a channel turn (no
user context)` although the request came from a channel. On the subscription
path a tool call reaches the middleware as an HTTP request from the external
`claude` process, in a fresh async context, so every per-turn
`AsyncLocalStorage` (`routineTurnContext`, `privacyHandle`, `toolIdempotency`,
…) was undefined inside `dispatch()`. The loopback server now snapshots the
async context it is constructed in (inside the turn) and runs every
`tools/call` within it, so context-bound tools see the same tenant and user the
in-process path sees. The `manage_routine` error for a genuinely missing
context now reads as a runtime wiring fault instead of blaming the caller.

### Fixed — dashboard and readiness banner read one runtime truth (#999, #1000, #1001, #1002, #1003)

2026-09-03 — omadia beta test round 4 (TE Printline, OM-72/74/75/78/84). The
dashboard said "LLM verbunden · 3 von 3 erledigt" while the readiness card two
centimetres below said "LLM-Zugang fehlt". Both were right from their own
viewpoint: the onboarding tick checked whether an access was *stored*, the card
probed whether the orchestrator runtime *answered*. The tester had a working
subscription login; the orchestrator was still assigned to `anthropic`, for
which no key existed, so nothing ran — and the only text on screen told him to
add the key or subscription he already had, and promised chat "sofort".

**Onboarding step 1 follows the live runtime (#1001, OM-78).** Step 1 now ticks
on the same probe the banner uses (`/operator/agents` answering instead of
503ing), not on a stored key or CLI login. The counter can no longer reach
"3 von 3" for a system that cannot run an agent. When an access exists but the
runtime is down, the step names the missing orchestrator assignment and links
straight to it instead of offering to connect an access again.

**The CLI wording follows the assignment (#999, OM-74).** "Ein LLM-Anbieter ist
verbunden und sein Schlüssel wurde geprüft" was shown to a subscription user who
never stored a key. The done-copy now reads off what the orchestrator is
actually assigned to: a keyless subscription CLI gets the CLI sentence, a
key-based provider the key sentence.

**The readiness banner names the cause (#1000, OM-75).** The operator-agents 503
carries a new `cause` field — `no_llm_access` (no key, no OAuth, no CLI login
anywhere), `no_assignment` (an access exists, the orchestrator points elsewhere)
or `unknown` — computed from the same credential verdicts the providers page
renders, without a network probe. The banner renders a distinct title, body and
CTA for `no_assignment` ("Orchestrator nicht zugeordnet" → "Zuordnung öffnen")
and for `unknown` ("Agent-Runtime antwortet nicht"), which by construction
means access and assignment are set — e.g. a stored but rejected key — so the
no-access sentence would be false there. A 503 without a cause (older
middleware) keeps the no-access copy. The verdict is memoised for 8 s so a
dashboard load with several probing widgets runs one credential lookup.

**No more promises about a control that does not exist (#1002, OM-72).** The
banner body no longer says chat is available "sofort" nor that routines need
"einen Neustart der Middleware" — the web UI has no restart control, and the
only one (Tray → Restart) sits behind an icon that is still missing (#888).

**Embeddings are no longer silently off (#1003, OM-84).** A default install runs
without an embedding provider, which disables process memory, semantic search
and dedup; nothing in setup said so and the tester learned it from an agent
failing mid-answer. New `GET /api/v1/admin/embedding-provider/status` answers
from the registry alone (the existing `GET /` counts the corpus and is too
heavy for a card rendered on every dashboard load). The dashboard gets a
"Gedächtnis / Embeddings" health card linking to the embedding-provider setting,
and the onboarding card names the limitation while no provider is published.

API additions: `cause` on the `multi_orchestrator_unavailable` 503 of
`/api/v1/operator/agents`; `GET /api/v1/admin/embedding-provider/status`
(`capabilityPublished`, `activeProviderId`, `activeModel`, `installedProviderIds`).

### Fixed — The desktop app no longer renames the user's Mac on every start

2026-09-03 — Beta round 4, OM-70 (#1004). Since v0.142 the Mac of the tester
had been counting up: `MacBook-Pro-von-Silvio-8.local`, then `-9`, then `-10`,
one increment per omadia start, with macOS announcing each time that the local
hostname was "already in use on this network". The culprit was our own LAN
pairing advertiser (#293): `bonjour-service` publishes `_omadia._tcp` with the
machine's own host name as SRV target and answers A queries for it, so macOS
saw a second responder defending its `.local` name, treated it as a foreign
device and yielded. In a company network that name carries file shares,
printers, SSH targets, backups and MDM inventory.

Two layers. The desktop supervisor now passes `OMADIA_UI_MDNS_ENABLED=false`
to the kernel unless the user set the variable themselves; on a single-user
machine there is nothing to discover. And the advertiser itself never claims
the OS name any more: self-hosters advertise as `<instance>-<machine>.local`
(capped at 63 octets, a valid DNS label) or an explicit `host`, so two
responders on one device can no longer collide. The variable is documented in
`middleware/.env.example`.

### Fixed — Shell dialogs are attached to the window, and the recovery-key reminder waits for the page

2026-09-03 — Beta round 4, OM-71 (#1005). Five of the seven native dialogs,
among them all three about the vault recovery key, were shown without a parent
window. On macOS that is an application-modal, free-floating dialog: the
reminder on start was half covered by a system dialog and unreadable, and the
one dialog that shows the key decrypting the local database could get lost
behind other windows. Every dialog now goes through one helper that attaches
it to the main window (a destroyed window falls back to the old behaviour
rather than throwing over the key).

The reminder also fired the moment `loadURL` resolved, over a page that still
read "Lade Login…" — `loadURL` resolves on the document, not on a screen. The
web UI now tells the shell when its first real screen is standing
(`omadia:uiReady` via the preload bridge; `/login` and `/setup` report once
their provider fetch has settled, every other page on hydration), and both the
boot and the restart path wait for that ping before speaking. A 15-second
fallback keeps the reminder for an older or crashed renderer: it exists to
prevent silent data loss, so late beats never.

### Fixed — MCP marketplace search now answers from the cached catalog when only the registry's search is broken

2026-09-01 — Follow-up to the entry below, found by watching the deployed fix
against the live registry. Failing fast was correct but not sufficient:
`registry.modelcontextprotocol.io` serves `/v0/servers` in under a second (66
servers) while `?search=` hangs to the full timeout. So browse worked, search
showed an error card, and the operator still got no results — the reported
symptom, just faster and better explained.

`search()` now falls back to substring-filtering the browse page it already
holds in cache whenever the server-side search fails at the transport level.
That costs no network, and it is the difference between an error card and
actual hits. When nothing is cached it still fails fast as before.

Because a filter over one page is *not* the registry's ranking of its whole
catalog, `search()` now returns a `scope` (`registry` | `cached-page`) that the
route forwards and the UI renders as a `nur geladene Seite` badge beside the
result count. Without it, "1 Treffer" would read as "the registry has one", and
an operator would conclude a server is missing when it merely sits past the
cached page. The `timeout` failure card also stopped claiming the host is
"offline or blocked" — that is wrong when browsing works — and now points at
clearing the search box to list the catalog instead.

### Fixed — MCP marketplace search hung instead of failing, and told you nothing

2026-09-01 — The Marketplace tab's search sat in "Katalog durchsuchen…"
indefinitely and produced neither results nor an error. The trigger was
external: `registry.modelcontextprotocol.io` — the registry seeded as `official`
in migration `0010` — is black-holing packets (DNS resolves to 34.61.200.254,
TCP times out). What made it read as a broken feature rather than a dead host
was our own code spending **four** 15-second timeouts on it per search:
`fetchCatalog` probed two candidate URLs, and when the server-side search threw,
`search()` fell through to a local-filter fallback that re-ran the whole thing
against the same dead host. Roughly 60 seconds of spinner, then a bare error
string.

Three changes in `middleware/src/services/mcpRegistryClient.ts`:

- **Transport failures short-circuit.** `search()` rethrows a transport-level
  error instead of retrying the same unreachable host through the local-filter
  fallback. The distinction is load-bearing, so the classification was tightened
  at the same time: only the `fetchImpl` call itself yields `transport_failed` /
  `timeout`; status, body-read and `JSON.parse` failures stay on `http_error` /
  `bad_catalog_shape` and still take the fallback — a registry answering 200
  with HTML is answering, and may simply be ignoring the search param.
- **The bare base-URL candidate is dropped for `kind = 'official'`.** Migration
  `0013` assigns that kind to exactly `registry.modelcontextprotocol.io`, whose
  base URL is a landing page, never a catalog. Operator-added registries default
  to `generic` and keep the candidate.
- **A 60-second negative cache.** Successes were cached, failures were not, so
  each caller paid the full timeout. That was survivable while browsing sat
  behind an explicit button; it is not now that the UI loads the catalog on its
  own. `GET /mcp-registries/:id/catalog?refresh=1` drops both caches, so the
  UI's Retry and Refresh still reach the host.

The pane itself (`web-ui/app/admin/mcp/page.tsx`) was reworked in the same pass:
the catalog loads on registry select instead of waiting for a button, search
runs debounced as you type with in-flight requests aborted, registries are pills
rather than a select, and failures render a typed card naming the registry and
what to do about it. Results moved to a card grid with a result count and an
explicit Refresh; registry removal moved out of the search row into a folded
management panel behind a confirm dialog.

**Note for operators:** this makes the outage legible and fast — it does not
bring the official registry back. Use `smithery` (seeded, keyless to browse)
until `registry.modelcontextprotocol.io` answers again.

### Fixed — omadia beta test round 3: the desktop shell (OM-50 to OM-69, #938)

2026-08-28 — Silvio Lange (TE Printline GmbH) reached the application for the
first time in three rounds of beta testing, and every serious finding of that
round sat in one directory: `desktop/src`, which was also the only directory in
the repository with no tests and no CI run. Thirteen issues, five pull requests.
The pieces already tagged are noted per version below; #944 and #946 ship in the
next release.

**The path that blocked the whole test (#925, OM-62, in 0.142.1 via #941).**
`resolveAugmentedPath()` probed a fixed list of directories, so npm installed at
`~/.local/node/bin` was invisible and the subscription CLI install failed with
"npm was most likely not found" on a machine where Node was installed correctly.
It now scans one level below `~/.local` for `*/bin` instead of naming single
paths, resolves the nvm `default` alias rather than discarding `lts/*` and
`node`, and the failure detail names the PATH that was actually searched. With
no API key a business user has no other way in, so this closed the only door.

**A process that never started, reported as a failed install (#933, OM-68, in
0.142.2 via #945).** Every thrown runner error was labelled
`cli_install.npm_failed`, whose help text says npm ran and points at log details
that do not exist. `npmRunner` had also collapsed `execFile`'s error to
`ok: !err`, discarding the `code`/`syscall` that made the distinction possible
at all. Spawn failures now classify as `cli_install.spawn_failed` and name the
offending file; a spawn `ENOENT` deliberately stays on `no_output`, whose
searched-PATH line is the right answer for "npm is not installed here".

**The macOS update channel was dead for 30 to 60 minutes after every release
(#928, OM-69, in 0.142.2 via #943).** `auto-release.yml` flagged a release
`--latest` before the `desktop-apps` job had built and attached the macOS
artifacts, so every macOS install queried a `latest-mac.yml` that did not exist
yet — measured live at roughly 55 minutes on v0.142.1, and silent, because the
startup check logs a 404 without telling anyone. Releases are now created as
drafts and promoted only once the merged mac feed is attached AND every file it
references is present on the release with `state: uploaded`. A repeatedly
failing silent check now surfaces once instead of never.

**The shutdown path lied to the updater (#927, #926, #934, OM-64/OM-55/OM-66,
via #944).** `Supervisor.stop()` could return while the kernel and the embedded
Postgres were still running out of the app bundle — an early return that did not
await the in-flight stop, a backstop timer that resolved whether or not the
child exited, and no guard against `stop()` racing `start()` or `restart()`. So
`quitAndInstall()` handed off to ShipIt, ShipIt could not replace a bundle it
was still executing, and the updater offered the same version again on the next
launch: three download-and-snapshot cycles in nine minutes with no error logged
anywhere, ending with an application that would not start. `stop()` now returns
`{clean, survivors}` and an unclean stop aborts the install instead of
installing anyway; attempts are recorded so the same failure is explained once
rather than re-offered; snapshots get per-attempt names pruned to three instead
of overwriting the previous backup on every retry; and the data directory warns
when it points into a cloud-synced folder.

**The desktop shell now says what is happening (#929, #930, #931, #935, #936,
OM-57/OM-58/OM-56/OM-59/OM-60, via #946).** A superseded boot reached the user
as `Error: boot superseded` with two buttons that both did damage mid-update,
while the only correct action, waiting, was not offered. A failed navigation left
the window showing nothing but its own background colour, because no
`did-fail-load`, `render-process-gone` or `unresponsive` handler existed. Three
independent `loadURL` sites raced with no notion of what the window was showing,
which is what overwrote the setup wizard and cost the user both the data-location
step and the recovery key without telling them. Electron dialogs, the loading
screen and the menu headings stayed English against a German UI even though the
German strings already existed. And the loading screen streamed the raw
developer log, `.env` instructions included, to every user on every start. A
navigation arbiter now decides who may replace the window, recovery is bounded
and explained, an outstanding recovery key is reminded until it has been shown,
and the boot log is summarized with detail one click away that opens itself on
an error.

**The gap behind all of it (#932, OM-65, via #944).** `desktop/src` had 0 test
files and no CI job while `middleware` had 725 and `web-ui` 110. It now has a
test suite and its own `desktop` job in `ci.yml` running typecheck plus tests,
including a typecheck of the test tree itself — which immediately caught an
assertion written as `a < b < c`, i.e. `(a < b) < c`, that had been passing for
any values.

**Mirror hygiene (#937, OM-67).** This file listed 145 released versions under
`[Unreleased]`, which is how a reviewer came to report a fix as unreleased two
hours after it shipped. The mirror is caught up, the stale section is named
honestly, and the header now says the refresh is manual and how to tell in one
command whether the file is behind.

Not reproduced and deliberately left open: the setup-wizard overwrite (#930) is
plausible from the code and matches the observed timing, but provoking the race
would have required a build that still started.


---

## Hand-written notes awaiting a mirror refresh (2026-07-06 to 2026-08-28)

These entries were written under `[Unreleased]` while the mirror was not being
refreshed, so they accumulated for 145 versions and **every one of them has
shipped**. They are kept because they carry the reasoning behind each change,
which the generated per-version sections below do not. Each entry is dated;
match that date against the `## [x.y.z]` sections below, or against the GitHub
Release, to find the version it went out in.

Do not add to this section. New notes go under `[Unreleased]` above.

### Added — provisioning writes the `teams_bots` entry itself (#910)

2026-08-28 — After a successful Teams identity provisioning run the operator
UI showed a ready-made `teams_bot` JSON block and asked the operator to paste
it into the `teams_bots` setup field of `@omadia/channel-teams` by hand. Until
that paste happened the bot existed in Azure, in the tenant catalog and in the
team — and still did not answer, because the middleware had neither an adapter
nor a route for it. That was the only manual step in an otherwise fully
automatic chain.

The provisioning job runner now writes the entry into the plugin config when
it reaches `installed` (and re-asserts it on a later re-run, so a changed
display name or a deleted entry is repaired), then reactivates the plugin so
the bot is live without a restart. The write is idempotent by `botSlug`: a
re-run replaces its own entry in place, never appends a second one, and every
foreign entry — above all `teams_bots[0]`, the legacy scalar-shimmed
production bot — is read as a raw object and written back byte-identical, with
hand-added keys intact. A no-op run neither writes nor reloads.

Failure is a warning, not a rollback: the identity is already valid in Azure by
then, so a failed or impossible write leaves the run `installed` and records
`config_sync_failed: [reason]` in `last_error`. A `teams_bots` value that
cannot be read as JSON is never overwritten. A missing channel-teams plugin is
a clean skip, not an error.

The copy-paste block stays in the operator UI as the fallback and for
operators who configure explicitly. Its leading line now answers whether it is
still needed, rendered from the new `teams_bots_sync` field of
`GET /api/v1/operator/agents/:slug/teams-identity` — derived from the live
plugin config on every read rather than from a stored "we synced it" flag, so
a hand edit shows up immediately. Copy in EN + DE.

### Fixed — runtime-readiness banner now points to the actual LLM access page (#911)

2026-08-28 — The readiness card shown when the runtime is offline had exactly
one CTA, but it pointed to `/admin/settings`, a directory of miscellaneous
plugin configuration with no relation to LLM providers or subscriptions. That
meant the one card whose whole job is "your runtime is offline, go fix your
LLM access" sent operators to the wrong page.

The CTA now targets `/admin/providers`, the page that actually exposes the
API-key and subscription-CLI tabs added around #889. The EN/DE body copy now
names both supported access paths — adding an API key or connecting an
existing Claude/Codex subscription — instead of only referring to "your key",
and the title ("LLM API key missing" → "LLM access missing") no longer frames
the problem as API-key-specific when the body describes both paths. The
banner test now pins the CTA href so this exact regression is covered
under #911.

### Fixed — desktop PATH augmentation missed ~/.local/*/bin and non-literal nvm defaults (#925)

2026-08-28 — #906 taught `resolveAugmentedPath()` about `~/.local/bin`, but a
Node installed the other common way under that prefix — an unpacked tarball
kept under its own name, `~/.local/node/bin` — was still invisible. On a
machine where that is the only `node`/`npm`, the subscription-CLI install in
the admin panel spawned `npm` with a PATH that could not contain it,
`execFile` failed with empty stdout and stderr, and the UI showed the opaque
`cli_install.no_output` message. The probe now also scans `~/.local` one level
deep and adds every existing `~/.local/<tool>/bin` — sorted for a
deterministic PATH, capped in count so boot stays bounded, and still appended
*after* the inherited PATH so a system install keeps precedence.

The nvm probe had a second dead end: it only accepted a literal version in
`~/.nvm/alias/default` and returned "no nvm" for the two most common defaults,
`lts/*` and `node`. It now follows the alias transitively (`default` →
`lts/*` → `lts/krypton` → `v24.19.0`), resolves `node` to the newest installed
version — compared numerically, so `v22.x` beats `v8.x` rather than losing a
lexical sort — and terminates safely on hostile data: a depth cap, a
visited-set for cycles, and rejection of an alias value that is absolute or
escapes `~/.nvm/alias`. As before, any unreadable state is swallowed; app boot
never depends on the probe succeeding.

Finally, a `cli_install.no_output` failure now states the PATH the npm child
was actually handed (`Searched PATH: …`, capped at 512 characters) in the
existing failure detail, so the diagnosis no longer requires a manual
`which npm` on the host. The `cli_install.npm_failed` branch, which already
carries an npm log tail, is unchanged. `desktop/` also gains real unit tests
for the PATH rules, run by its own `npm test` on Node's native TypeScript type
stripping — no new dependency, no lockfile change.

### Fixed — desktop kernel PATH augmentation missed ~/.local/bin (#906)

2026-08-27 — #882's PATH augmentation checked Homebrew, Volta, asdf, and nvm,
but not `~/.local/bin` — where Claude Code's own native installer symlinks the
`claude` binary, independent of any Node package manager. A subscription-CLI
chat turn still failed with `spawn claude ENOENT` for anyone installed that
way, even fully logged in. A shell alias masked the symptom in manual
terminal testing (`which`/`command -v` resolve aliases; `child_process.spawn`
never does). `resolveAugmentedPath()` now also checks `~/.local/bin`.

### Fixed — a granted `memory` tool no longer lets a sub-agent write past its parent's scope (#904, part of #860)

2026-08-27 — A sub-agent that had been granted the native `memory` tool resolved
its handler out of the process-wide `NativeToolRegistry`. That entry belongs to
the memory *provider* plugin (`@omadia/memory`, `@omadia/memory-postgres`) and is
bound to the **undecorated** root store — the one below every scoping wrapper. A
sub-agent reaching it read and wrote outside its parent agent's
`orchestrator:<slug>:*` subtree, and, with the chat-context ACL from #881
enabled, outside its team's and channel's tiers too. Granting a sub-agent the
memory tool is ordinary operator configuration, and the per-agent boundary it
crossed predates the memory-ACL epic entirely.

The grant is now served by a tool bound to the same turn-scoped store the
parent's own dispatch uses: `Orchestrator.dispatchToolInner` publishes that
handler for the lifetime of a domain-tool dispatch, and
`adaptNativeToolForSubAgent` takes the resolver as a **required** parameter, so a
call site that forgets to thread it fails `typecheck` instead of silently
degrading to the unscoped store — the same hardening #903 applied to
`dispatchTool` / `dispatchToolDeadlined` / `dispatchToolInner`.

Two consequences worth knowing:

- The grant used to be a **silent no-op** on a default install: the shipped
  providers register handler-only (no wire-spec) and the adapter dropped such
  entries. It is now honoured — with the parent turn's scope.
- **Fail-closed, never fallback.** With no turn-bound store — a detached
  `ask_<slug>_start` runner, or any call outside an orchestrator turn — the tool
  refuses instead of reaching for a wider one.

Unchanged and still true: the `claude-cli` provider never constructs the
`Orchestrator`, so `context_memory` remains inert there (#899).


### Added — team uninstall for provisioned agent identities (#900, part of #860)

2026-08-27 — Assigning an agent to a Team was one-way: `DELETE
/api/v1/operator/agents/:slug/teams/:teamId` answered `501
teams_uninstall_unsupported` and the operator UI shipped the control disabled,
because `teamsProvisioner@1` published an install but no uninstall. Removing an
agent bot from a team meant going to the Teams admin center.

`@omadia/integration-microsoft365` **0.4.0** adds `uninstallFromTeam({ teamId,
teamsAppId })` — Graph deletes an installation by its *installation* id, so the
connector resolves it first
(`GET /teams/{id}/installedApps?$expand=teamsApp&$filter=teamsApp/id eq '…'`)
and then deletes it. "Not installed" is an idempotent success
(`outcome: 'already-absent'`), 403 maps to the same `ConsentMissingError` and
the same scope as the install direction — **no new Graph permission** — and 429
rides the shared `Retry-After` backoff.

The middleware mirrors the connector contract structurally rather than
importing it, so the route **feature-detects**: with a connector `< 0.4.0` it
keeps answering `501` (now carrying `min_connector_version`), and
`GET …/teams` reports `capabilities.uninstall: false` with a reason that names
the fix, so the UI renders a disabled control instead of a button that fails.
The panel was already capability-driven, so a new-enough connector lights the
button up on its own.

Graph first, row second: the identity row is only cleared after the connector
confirms the removal (state back to `catalog_uploaded`, `team_id` `NULL`), so a
failure mid-way never leaves a live install that nothing tracks. Re-installing
later resumes from the catalog entry — one Graph call, not the whole chain.

### Fixed — billing-posture badge on "Erkannte CLIs" no longer reads as a second status (#887)

2026-08-27 — Each CLI row on Admin → LLM-Zugang → Abo-CLIs showed a detection
badge ("NICHT GEFUNDEN") next to a billing badge ("Abo" / "Prüfung nötig") with
nothing distinguishing the two — two entries both "not found" could still show
different second badges, reading like conflicting statuses. The billing badge
now carries an explicit "Abrechnung:"/"Billing:" prefix so it's unmistakably a
billing-model label, not a second detection state. Display-string change only —
`cliBackendDetector.ts`'s `CliBillingPosture` type and wire field are unchanged.

### Added — der Kontext-Memory-ACL lässt sich aus der Operator-UI einschalten (#899)

2026-08-27 — W5 (#881) hatte die komplette Chat-Kontext-Memory-ACL ausgeliefert, aber
hinter `agents.context_memory` — einer Spalte ohne UI und ohne API. Einschalten ging nur
per Hand-`UPDATE`, womit die ganze Wave praktisch inert war. Neu: `GET`/`PUT
/api/v1/operator/agents/:slug/context-memory` auf dem bestehenden Operator-Router
(`{ ok: true }`-Envelope, `requireAuth`) und ein Control auf der Agent-Detailseite.
`PUT` validiert gegen dieselbe Werteliste wie der CHECK-Constraint der Migration `0050`
(`off` | `enforce` | `enforce-strict`), lehnt Unbekanntes mit `400 invalid_body` ab
statt es still auf `off` zu mappen, loggt den Wechsel mit `[security-audit]` und löst
einen `registry.reload()` aus — der nächste Turn läuft bereits im neuen Scope. Der Modus
liegt bewusst NICHT auf dem Umbenennen-/Aktivieren-`PATCH`, damit eine Änderung am
Memory-Scope nicht als Beifang einer unabhängigen Bearbeitung mitreist. Die UI zeigt vor
dem Einschalten die drei Semantiken (Team-Tier read-write, Agent-Tier read-only,
API-Turns nur agent-privat) und verlangt eine ausdrückliche Bestätigung; Zurückschalten
auf `off` ist nicht bestätigungspflichtig. Kein Schema-Change. EN/DE vollständig.

### Fixed — die Turn-Bindung der Memory-ACL kann nicht mehr stillschweigend verloren gehen (#899)

2026-08-27 — `dispatchTool`, `dispatchToolDeadlined` und `dispatchToolInner` nahmen die
`TurnMemoryBinding` in einer OPTIONALEN Position entgegen, während alle sechs übrigen
Signaturen auf dem Pfad sie verpflichtend führen. Eine Aufrufstelle, die das Argument
schlicht vergisst, kompilierte damit sauber und fiel zur Laufzeit still auf den
agent-globalen Memory-Stack zurück — genau die lautlose Scope-Ausweitung, gegen die die
Wave gebaut ist. Nachgewiesen, nicht vermutet: das Argument an den beiden Tool-Loop-
Aufrufstellen zu streichen passierte `tsc`. Die drei Parameter sind jetzt required
(`TurnMemoryBinding | undefined`), Laufzeitverhalten unverändert; dieselbe Mutation
scheitert nun im Typecheck. Dazu die erste Integrationsabdeckung der Bindung überhaupt
(`middleware/test/orchestrator/contextMemoryTurnBinding.test.ts`): echte Turns über
`runTurn` UND `chatStream` mit einem Teams-`TurnOrigin`, die den physischen Schreibpfad
im Root-Store prüfen — bislang endete jede W5-Suite beim Handler des `MemoryBinder`,
und der Streaming-Pfad war nie durchlaufen worden.

### Fixed — dashboard onboarding step 3 no longer contradicts its own done badge (#886)

2026-08-27 — Step 3 "Plugins installieren" ticked its INSTALLIERT badge from
`hasInstalledPlugin` but picked its body copy from `selectedCase === null`, so
clearing the business case turned a completed step back into "Wähle oben einen
Business-Case, um passende Empfehlungen zu sehen." The body now reads off the
same `done` signal as the badge and states the result instead — a new
`dashboard.onboarding.installStep.done` key (EN/DE, ICU plural) counted with the
shared OM-27 `isInstalled` predicate over the `plugins` array the component
already receives, so `update-available` counts as installed and the sentence
cannot drift from the health tile. The recommendation list for a selected case
is untouched.

### Added — Nutzungs-Doku: mehrere benannte Agent-Bots in Teams (#860)

2026-08-27 — Neue Operator-Doku `docs/teams-multi-agent-identities.md`, verlinkt aus
`docs/README.md`. Sie führt von null zu mehreren omadia-Agenten, die in Microsoft Teams
als jeweils eigener Bot auftreten, und deckt die Waves W0a/W0b/W1a/W2a/W5 ab:
Voraussetzungen (Plugin-Versionen, Migrationen `0049`/`0050` Core und `0031` KG,
Graph-Scopes samt der Consent-Fallstricke), Setup von M365-Connector und channel-teams,
Anlegen einer Teams-Identität über die Operator-UI (#896) mit den REST-Endpunkten als
Alternative, Team-Zuordnung inklusive `409 team_install_conflict` und der nicht
unterstützten Deinstallation, Rechte pro Agent, Persona im nativen Agent Builder,
Kontext-Memory-ACL (#881) mit dem standardmäßig ausgeschalteten Rollout-Flag, eine
Troubleshooting-Tabelle (u. a. der `.template`-Ingest-Fall aus #880, behoben ab
v0.136.2) sowie Grenzen und Ausblick. Jede API-Angabe ist gegen den Code auf `main`
verifiziert; nicht Belegbares steht als `VERIFY`-Kommentar statt als Behauptung.

### Fixed — dashboard onboarding step 1 now exposes both LLM access paths (#889)

2026-08-27 — The web-ui onboarding card promised a choice between API-provider
setup and a subscription CLI, but step 1 only rendered one CTA to
`/admin/providers`. The step now shows the existing filled API-key pill and a
matching accent-outline subscription pill that deep-links to
`/admin/providers?tab=subscriptions`, with aligned EN/DE catalog keys and a
dashboard test that pins both labels and both hrefs.

### Fixed — plugin readiness no longer calls a plugin ready without a verified LLM credential (#884)

2026-08-27 — The Hub reported "14 von 14 einsatzbereit" while no LLM provider
held a verified credential, because `computeReadiness()` only ever checked a
plugin's own manifest-required setup fields and had no concept of the provider
it routes through. The per-provider verdict logic that the providers-admin page
already computed inline (CLI login, OAuth grant, or key-based cache/durable
record) is now extracted to `middleware/src/platform/pluginLlmReadiness.ts` and
shared, so the two surfaces can no longer disagree about the same credential.
Readiness gained a fifth state, `awaiting_llm`, returned only for an
LLM-consuming plugin that would otherwise be `ready` and whose assigned
provider's verdict is anything other than `verified`. The check runs after the
existing `not_installed`/`errored`/`config_required` steps and degrades to
`ready` on any probe failure, matching the file's existing rule that an
infrastructure hiccup must never manufacture a false negative. The web-ui
mirrors the new state as a warning-toned "Konfiguriert – wartet auf LLM-Zugang"
badge plus a post-install CTA to `/admin/providers`; the Hub count, the
dashboard tile and the plugin tiles needed no change, because all three already
read the shared `isReady` predicate.

### Fixed — desktop first-run wizard no longer forces API-key entry (#890)

2026-08-27 — The Electron desktop wizard hard-blocked every first-time setup on
an API key, even though the app can boot without one and wire a Claude/Codex
CLI subscription afterwards. Step 1 now offers two explicit paths: the existing
API-key flow remains the default with its current verification behavior intact,
and a new subscription path persists `llmProvider: "subscription"` without
storing a key. The desktop main-process types and setup validation now treat
that provider as a first-class value instead of an unsupported edge case.

### Fixed — desktop app augments PATH for forked children (#882)

2026-08-27 — The Electron desktop supervisor used the OS launcher's inherited
environment as-is when spawning the kernel and web-ui children. On macOS that
can mean launchd's minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so bare
`npm` lookups inside the kernel failed with `ENOENT` even when Node tooling was
installed through Homebrew, Volta, asdf, or nvm. The desktop package now
computes one augmented PATH at app start, merges existing entries first, adds
only existing well-known tool directories, best-effort resolves nvm's default
version without shelling out, and injects the result into both child-process
env builders so every `execFile('npm', ...)` inside the kernel inherits the
same corrected lookup path.

### Fixed — builder boot observes template install failures and classifies them (#882)

2026-08-27 — The Plugin Builder boot path started `ensureBuildTemplate(...)`
eagerly, but the promise's logging `.catch(...)` re-threw before any observer
was attached. When the boot-time template `npm install` failed, Node emitted a
spurious `unhandledRejection` long before the first real build awaited the same
promise. The boot wiring now attaches a separate no-op observer to mark that
promise as handled without altering it, and `BuildPipeline.run()` re-throws a
rejected `templateReady` gate as `BuildPipelineError('template_not_ready', …)`.
That keeps the original cause for the real consumer while recording the failure
phase honestly instead of degrading to `unknown`.

### Fixed — CLI install failure says what actually happened, manual steps carry the prefix (#882)

2026-08-27 — When the kernel could not find `npm` at all, the subscription-CLI
install failed with no output, and the UI still rendered "npm install failed —
see the log tail." above an empty `<pre>`: it pointed the operator at a log that
did not exist. `cliInstallService` now classifies the failure —
`cli_install.no_output` when npm produced nothing (the command was most likely
not found) and `cli_install.npm_failed` when it ran and failed — and returns the
code on the install-status poll. The install box renders through the shared
`<ErrorHelp>` catalogue instead of its own raw-log block, so both cases get a
localized what/next line with the server's text moved into the redacted support
disclosure. The manual-install instructions were also incomplete: they showed a
bare `npm install -g …` that installs somewhere the server never looks, so
`detectCliBackends()` now exposes `cliToolsDir` and the shown command carries
`--prefix <cliToolsDir>`.

### Fixed — desktop app version was hardcoded to 0.1.0 (#883, OM-51/47/52)

`desktop/package.json` shipped every release at the placeholder version `0.1.0`, which
electron-builder reads for three release-facing surfaces at once: the packaged app's
"About omadia" panel, the generated artifact filenames, and the version electron-updater
compares against the release feed — so every build claimed to be `0.1.0` and the updater
could never detect a newer release.

- **CI now writes the real version before packaging.** A new `desktop/scripts/set-desktop-version.mjs`
  derives a bare semver from the release tag and rewrites `desktop/package.json` in a new
  `.github/workflows/desktop-apps.yml` step, placed after `npm ci` (so the lockfile's own
  `version` field is validated first) and before the build/pack steps that consume it.
- **Manual "Check for Updates".** Packaged builds previously only checked once, silently, at
  startup, with no way to ask again and no visible result either way. Both the tray menu and
  a new cross-platform Help menu now expose a "Check for Updates…" action that shows a
  dialog for every outcome — found (downloading), already up to date, or the check failed —
  without changing the silent startup check's existing (dialog-free) behavior.

### Added — operator UI for Teams agent identities, team assignment and context memory (#866, epic #860 W2a)

2026-08-27 — The provisioning chain built in W1a had no operator surface: everything ran
through curl. The agent detail page now owns the whole loop.

- **Teams identity panel.** Create the identity, watch the state machine advance live
  (`pending → app_registered → bot_created → package_built → catalog_uploaded → installed`),
  and read a failure as something actionable: the middleware classifies `last_error`
  server-side and the panel renders what happened, which scopes or setup fields are
  missing, and what to do next — with the raw English sentence demoted to a technical
  detail. Registration-only (`arm_not_configured` on `app_registered`) reads as a valid
  stop, not as a broken agent.
- **The `teams_bot` block, and the honesty about it.** The channel-teams `teams_bots[]`
  entry is shown ready to copy, together with a plain statement that pasting it into the
  plugin's setup field is a MANUAL step — nothing syncs it. Automatic config sync stays a
  documented follow-up.
- **Team assignment.** The teams an agent's app is installed in, with consent status,
  install, and an honest 501 for uninstall (`teamsProvisioner@1` publishes none).
- **Agent Builder link.** Persona and behaviour design stays in the native builder; the
  detail page deep-links to the draft that published this orchestrator's agent plugin, or
  to the overview when no single draft matches — never to a guessed id.
- **Memory context browser off the dev endpoint.** `/memory` now reads the new
  authenticated `GET /api/v1/operator/memory/contexts/{list,file}`, whose path guard
  normalizes every request into the `/memories/contexts` subtree segment-wise and rejects
  traversal before the store is touched. The browser is no longer dev-only.

Integration decisions worth recording, because two parallel units disagreed:

- **One owner for `identity.last_error_detail`.** Two units projected the same key with
  different wire shapes (camelCase vs snake_case). The camelCase
  `TeamsProvisioningErrorDetail` — produced by `classifyTeamsProvisioningError` next to the
  sentences it decodes — is the single owner; the duplicate snake_case projection and the
  duplicate web-ui sentence parser (`app/_lib/teamsIdentityErrors.ts`) are gone. One
  classifier, pinned by a round-trip test against the real producers.
- **`team_id` is required, and the UI now says so.** `TeamsIdentityProvisionSchema` declares
  it `z.string().min(1)` and the runner needs it to reach `installToTeam`, but the create
  form invited an empty value and the re-run action posted `{}` — both a guaranteed 400.
  The form requires the field, `GET …/teams-identity` additionally returns the recorded
  `team_id`, and a re-run resends it.
- **A retarget can no longer fabricate an install.** `agent_teams_identities` keeps ONE
  `team_id`, and the runner refuses a second enqueue with a RESOLVED `{status:'rejected'}`
  that a fire-and-forget caller never sees. Both POSTs now refuse a conflicting retarget
  with 409 BEFORE writing — for an already-installed row and for a run in flight toward
  another team (`TeamsProvisioningJobRunner.runningTeamId`) — and a refused enqueue is
  recorded instead of dropped.

### Changed — one `teams_bot` projection + a decoded `last_error` for the operator UI (#860 W2a)

2026-08-27 — Groundwork for the operator-facing team↔agent screens, no schema change and
no new route.

- **Single projection choke point.** The channel-teams `teams_bots[]` entry that
  `GET /api/v1/operator/agents/:slug/teams-identity` returns was assembled inline in the
  handler. It is now the exported `projectTeamsBotConfig()` of
  `middleware/src/routes/operatorAgents.ts`, so every further team↔agent route emits a
  byte-identical block. The entry is a config contract with channel-teams — a second,
  drifting copy would hand operators a config the plugin silently refuses to parse. The
  invariants are unchanged: `null` unless BOTH `app_id` and `tenant_id` are known,
  `appType` always `SingleTenant`, and the bot password only ever as the opaque vault ref
  `teams_bot_password:<appId>`. Pasting that block into channel-teams' `teams_bots` setup
  field stays a MANUAL operator step; automatic config sync remains a follow-up.
- **`last_error_detail` (additive).** The GET now also returns the identity's `last_error`
  in structured form: `{ code: consent_missing | arm_not_configured | throttled | unknown,
  scopes?, fields?, retryAfterSeconds?, raw }`. `last_error` itself is unchanged. The
  decoder (`classifyTeamsProvisioningError`) sits in
  `middleware/src/services/teamsProvisioningJob.ts` — next to the only code that WRITES
  those sentences — so changing a message and forgetting the decoder breaks a colocated
  round-trip test instead of degrading the operator UI in production. The UI renders from
  `code` plus the typed arguments; `raw` is a secondary technical detail only.
- **New sentence:** an exhausted throttle budget is now recorded as
  `throttled: … (gave up after N attempts; retry after Ns)` instead of an un-prefixed
  message, so "come back later" is machine-readable. Follow-up worth doing: persist the
  structured code as its own column from the start.
### Added — Teams E2E smoke STAGE 2 + server-side `last_error` classification (#860 W2a, #874)

2026-08-27 — The Teams identity provisioning chain had unit coverage but nothing that drove
it end to end against a real tenant, and the operator UI had no way to act on a failure
except to show an untranslated English backend sentence.

- **STAGE 2 of the Teams E2E smoke** (`middleware/scripts/smoke-teams-e2e.ts`, gitignored —
  it hits byte5-internal endpoints) drives the live chain: `POST
  /api/v1/operator/agents/:slug/teams-identity` (202), then polls `GET …/teams-identity`
  through `pending → app_registered → bot_created → package_built → catalog_uploaded →
  installed`, asserts the `teams_bot` projection and `teams_app_id` are complete, and
  verifies the new bot's `/api/teams/<botSlug>/messages` route is live and rejects an
  unsigned payload. It runs on the environment STAGE 1 establishes.
- **Production-write guard, fail-closed.** A provisioning call persists an
  `agent_teams_identities` row and creates real Entra/Azure/Teams objects, so STAGE 2 has no
  default target: it skips entirely without an explicit opt-in, requires the caller to echo
  the target host back, refuses known production hosts with no override, and aborts when the
  shell carries a non-scratch `DATABASE_URL`.
- **Registration-only is a pass.** With no ARM setup fields on the M365 connector the chain
  legitimately stops at `app_registered` with `arm_not_configured: …`; the run reports
  success-with-caveat rather than failing, matching the job runner's partial-success
  contract. Missing admin consent stays a hard stop, with the missing scopes named.
- **`identity.last_error_detail`** is emitted alongside `last_error` by `GET …/teams-identity`
  — `{ code: consent_missing | arm_not_configured | throttled | unknown, scopes?, fields?,
  retryAfterSeconds?, raw }`. Additive; no schema change, no migration. The classifier
  lives next to the code that writes those sentences
  (`services/teamsProvisioningJob.ts`), with a round-trip test
  (`test/teamsProvisioningLastError.test.ts`) so rewording a message without updating the
  parser breaks a colocated test instead of silently degrading the operator UI. Clients must
  render from the structured object, never parse the English sentence.
- **Docs:** `docs/middleware-agent-handoff.md` gains a section on pointing the smoke at a
  scratch tenant and what it needs (connector plugin installed and active, admin consent,
  ARM fields for the full chain, registration-only otherwise).

Known limitation: the smoke does not send a genuine Bot Framework turn — signing one needs
the freshly created app's secret, which never leaves the connector's vault. The visible
reply in Teams stays a one-line manual step the run prints out. Follow-up: the job runner
should persist a structured error code from the start, which needs its own migration.

### Added — chat-context memory ACL: per-team/channel/user agent memory (#860 W5, design #870)

2026-08-27 — Agent memory was isolated per AGENT but not per CHAT CONTEXT. What an agent
learned in Teams team A landed in one agent-global tree and was quotable in team B on the
next turn. This wave partitions that tree by chat context, fail-closed.

- **Scope grammar.** `ScopedMemoryStore` gains `team:<ctxKey>:*`, `channel:<ctxKey>:*` and
  `user:<ctxKey>:*`, plus an `ro:<pattern>` access modifier. The context trees live under a
  NEW top-level segment `/memories/contexts/`, deliberately not under
  `/memories/orchestrators/<slug>/`: `orchestrator:<slug>:*` matches only the agent tree, so
  no legacy scope reaches a context tree and no context scope reaches the agent tree. `ro:`
  is a veto rather than a weak grant — an overlapping pattern cannot silently re-grant write
  to a path it protects.
- **Context key.** `memoryContextKey(channelType, nativeId)` is the single sanitiser behind
  every `<ctxKey>`, every physical path, every purge selector and the promote route. A
  lossless id passes through byte-identically; anything else keeps a readable stem plus a
  64-bit digest of the RAW input, and the two output spaces are kept disjoint so an id
  spelled like a digest cannot pre-image another context's tree. The axes derivation keys on
  an injective tuple of the scope's structural parts, not on its wire form — `group:x` as a
  group ref and as a conversation id are two contexts, not one.
- **Per-turn binding.** `MemoryBinder.forOrigin()` resolves one stack per chat context
  (LRU-cached) at the start of each turn, and the orchestrator threads it to `dispatchTool`
  as an explicit parameter — never through AsyncLocalStorage, where a generator resumed in
  its caller's context would lose it silently and widen the scope rather than fail.
- **What a context turn may do.** Write its own tier; read the agent tier (`ro:`); read but
  NOT write the shared trees (`core`, `sessions`, `chat-sessions`, `_*`), which are the one
  model-facing surface two contexts address by the same path. New knowledge leaves a context
  only through the operator promote action.
- **Operator surfaces.** The Danger-Zone purge axes `user`/`team`/`channel` get a scratch
  footprint for the first time and delete the named context tree across every agent; a
  selector without a `<channelType>~` half is now refused with `invalid_selector` instead of
  silently matching nothing. New `POST|GET /api/v1/admin/memory/promotions/:slug` copies or
  moves knowledge between an agent's tiers, on the same auth gate as purge, audited three
  ways (JSONL log, provenance frontmatter, `[security-audit]` line). The memory browser gains
  a context dimension, a promote dialog and an audit tab.
- **No flag day.** Per-agent `agents.context_memory` (`off` | `enforce` | `enforce-strict`,
  migration 0050) defaults to `off`, and `ChatTurnInput.origin` is optional. Every
  combination of old/new middleware and old/new channel plugin behaves exactly as it does
  today until an operator switches an agent over; unknown and NULL flag values read as `off`.

Two properties are worth remembering because they cost a rewrite each. `formatSessionScope`
is injective only over the strings `parseSessionScope` emits, while the design has channel
adapters build scopes directly — so it cannot be used to key a security boundary. And a
sanitise-or-hash key function is not injective unless the two branches have disjoint output
spaces; without that, the hash branch is pre-imageable by anyone who can name their own id.

### Changed — the memory context browser reads the operator endpoint (#860 W2a)

2026-08-27 — W5 shipped the context browser on `/bot-api/dev/memory/{list,file}`
(`packages/harness-memory/src/devMemoryRouter.ts`), which the memory plugin only mounts when
`dev_memory_endpoints_enabled` resolves truthy — a flag the kernel forbids in production. The
panel was therefore dead exactly where an operator needs it, and it explained itself with
"set `DEV_ENDPOINTS_ENABLED`", advice no production operator can act on.

- **Both call sites move** to `GET /api/v1/operator/memory/contexts/{list,file}`
  (`middleware/src/routes/operatorMemoryContexts.ts`), `requireAuth`-gated on the same cookie
  session as the Danger-Zone purge. The wire shape is unchanged, so only the URL moves.
- **The page is now a CONTEXT browser.** That endpoint is structurally unable to read outside
  `/memories/contexts`, so the root, the breadcrumbs and "up" all stop there and the tree no
  longer offers an agent-tier node — a node that always errors is worse than an absent one.
  Promotion still TARGETS the agent tier; that is a write on the audited promote route.
- **401/403 read as words.** They are ordinary answers on a gated route, so they get their own
  copy instead of a bare "Listing failed (HTTP 401)". `memory.errorDevEndpointUnavailable` is
  gone, replaced by `errorUnauthenticated` / `errorForbidden` / `errorPathNotFound` /
  `errorOutOfScope`. The browser stays strictly READ-ONLY.

### Fixed — plugin ingest rejected the Teams app-package template (#860 W1a)

2026-08-26 — A store update to `@omadia/channel-teams` 0.21.0 failed on the live
instance with `entry appPackage/manifest.json.template has a disallowed
extension (.template)`. Producer, gatekeeper and consumer are all in-house and
disagreed, so the agent factory could not install its template anywhere:

- the published 0.21.0 artifact ships `appPackage/manifest.json.template`
  (verified against the hub zip's central directory),
- `zipExtractor`'s `EXTENSION_ALLOWLIST` is deny-by-default and had no
  `.template`, so ingest rejected the whole package,
- `teamsAppPackageAssets` reads exactly that filename and requires it by name.

`.template` is now accepted, scoped to `appPackage/` — the same construction
`.woff2` uses under `ui/`. Scoped rather than global because the extension says
nothing about content: the file is read as text and never loaded or executed,
which puts it in the class of the already-allowed `.txt` / `.md`, but only the
one directory has a reason to carry it. Renaming to an allowed extension was the
alternative and is worse: the consumer name is compiled into the running
release, so a renamed plugin would blind the factory until the middleware caught
up — an ordering constraint for no security gain.

The real gap was in the process, not the deploy: nothing ever held the published
package layout against the ingest gate (`npm run package` checks the zip builds,
the drift-guard checks versions). `pluginPackageTemplateAllowlist.test.ts` now
pushes the actual `appPackage/` layout through the extractor and pins the scope
in both directions.

### Fixed — Teams answer card: honest badges and a Fresh-Check button that means something (#859, #878)

2026-08-25/26 — Field report on a bare `ping` → `Pong.` turn: the card claimed
"✓ Antwort geprüft", repeated the AI-Act disclosure sentence that the ✨
AI-generated chip already carries, and offered "🔄 Fresh Check (ohne Memory)"
on an answer no memory had touched. Three separate over-triggers, now closed.

- **Verifier badge** (#859): `toSemanticAnswer` forwards it only when
  `claimCount > 0`. With zero extracted claims — small talk, and the
  pipeline-failure fallback, which reports `approved` with an empty claim list —
  the badge asserted a verification that never ran.
- **Disclosure sentence** (channel-teams 0.20.0): the kernel folds the AI-Act
  marking into `SemanticAnswer.text` for wire-only channels; Teams marks the
  answer itself, so the connector strips the folded line (keeping any
  operator-authored addendum) before rendering and before the history append.
- **Fresh-Check button** (#859 introduced `memoryUsed`, #878 fixed its meaning):
  the flag first meant "a prior-context block existed", and that block always
  carries the verbatim tail of the running chat — so the button never
  disappeared. It now means memory could actually have changed the answer:
  topical recall (`AssembledHit.origin !== 'tail'`), a cross-session
  plan/process/insight, or a successful memory-file read. The live tail and the
  read-convention's `/memories` directory listing do not count, and neither do
  memory writes.

Two implementation notes worth remembering. `AssembledHit.reason` is
presentational — a boost rewrites it, so a boosted tail turn reads as
`'agent-boost'`; the new sibling `origin` carries the delivering leg and is what
the gate branches on. And the run trace records only
`{callId, toolName, durationMs, isError}`, never the tool input, so the memory
command + result are captured at dispatch onto a mutable turn-context holder —
a plain field would be lost, because a privacy guard re-enters dispatch inside a
shallow copy of the turn store.

### Added — agent factory: Teams identity provisioning via teamsProvisioner@1 (W1a, #860)

- New CORE migration `0049_agent_teams_identities.sql`: one Teams identity per agent
  (unique `agent_id`), globally unique `bot_slug`, a seven-state provisioning CHECK
  (`pending → app_registered → bot_created → package_built → catalog_uploaded →
  installed`, terminal `failed`), step-evidence columns and a `team_id` install target
  for boot-time resume. Deliberately NO secret column — the bot's client secret stays
  in the M365 connector's vault (opaque ref `teams_bot_password:<appId>`).
- New operator endpoints on the agents router: `POST
  /api/v1/operator/agents/:slug/teams-identity` (create-or-provision, async — answers
  202 immediately and hands the chain to the in-process provisioning job runner) and
  `GET …/teams-identity` (status incl. a paste-ready camelCase `teams_bots[]` entry
  for channel-teams, `last_error`, and an honest `running` flag). 503 with
  `teams_provisioner_unavailable` while the connector is not installed; 409
  `bot_slug_taken` on cross-agent slug collisions.
- Every Graph/ARM call happens inside the `@omadia/integration-microsoft365`
  connector plugin (**>= 0.3.1 required**), consumed through the kernel service
  registry via the new `platform/teamsProvisionerService.ts` choke point (typed
  errors, secret-stripping boundary, SingleTenant guard, per-bot messaging-endpoint
  URL builder honoring `TEAMS_PUBLIC_BASE_URL ?? PUBLIC_BASE_URL`). Without the
  connector, provisioning jobs stay retryable-pending — never a crash.
- Boot wiring registers `agentTeamsIdentityStore` + `teamsProvisioningJobRunner`
  (Postgres required) and resumes interrupted provisioning runs idempotently; the
  Teams app package is rendered from the installed channel-teams package's
  `appPackage/` template with a deterministic per-agent catalog id.

### Fixed — facilitation lens read the verdict from a context key that never exists

- The facilitation admin lens read the latest assess verdict from `ctx.stepResult` — but
  the executor persists step results under `ctx.steps[stepId]`; `stepResult` only exists
  as the transient guard-evaluation argument. Result: `lastVerdict` (and the new interim
  results table) was ALWAYS null in the admin UI. Now read from `ctx.steps.moderate.data`,
  with the test fixture matching the executor's real durable shape.

### Added — interim results table per DoD point in the facilitation details modal

- The moderate tick's fenced-JSON verdict now carries `items[]` — one entry per numbered
  DoD point with a short label, a status (`done` / `partial` / `open`) and a one-line note
  on the concrete current state (facilitation pattern v3).
- The kernel validates the model-emitted items defensively (drops garbage, nulls bad
  fields) and serves them through the facilitation admin lens; the details modal renders
  them as a **# / point / status / current-state table** — the actual interim result at a
  glance instead of a wall of `t-keep-waiting` rows. The authoritative DoD text stays
  visible alongside (the table labels are a model paraphrase); runs started before
  pattern v3 simply show the DoD list as before.

### Added — facilitation details modal; the panel disappears when there is nothing to show

- Every facilitation card gets a **Details** modal: the summary plus the FULL durable run
  trace (every assess round with postcondition outcome and transition) — "wo stehen wir
  gerade?" without leaving the admin.
- Installations without the facilitator (or without any running facilitation) no longer see
  an empty box: the panel renders nothing when the listing is empty, and treats a
  pre-feature kernel's 501 exactly like "feature not present". Real load errors stay visible.


### Changed — facilitation panel readability + tick nudge discipline (#330 round 4 follow-up)

- The "Laufende Facilitations" card is structured now: conversation line, goal as title, the
  latest assessment as a highlighted box, the DoD split back into an ordered list
  (deterministic string handling), participant chips, and a compact meta footer — instead of
  one full-width text wall.
- The assess tick's prompt carries an explicit nudge discipline: nudge ONLY when the progress
  log has not moved since the previous tick — an actively working group needs no impulse, and
  a second facilitator voice mid-conversation reads as a duplicate bot.


### Added — Admin lens + stop for running facilitations (#330 round 4)

- New operator endpoints `GET /api/v1/operator/conductors/facilitations` and
  `POST .../facilitations/:workflowId/terminate`. Ephemeral workflows are hidden from the
  library by design, which left LIVE facilitations invisible — two instances ended up
  moderating the same meeting with no way to see or stop them.
- The overview reads only durable state: conversation (attachment row), goal/DoD + assess
  rounds + latest fenced-JSON verdict (run context), initiator role holders, participants via
  the kernel roster registry (best-effort). Terminate cancels active runs (#759 semantics) and
  disposes of the scaffold through the reaper's own cleanup path (binding + role go with it);
  idempotent, refuses non-ephemeral workflows.
- Conductor page: new "Laufende Facilitations" panel with the overview and a confirmed
  Stop & remove action (en+de).


### Added — channel directory entries can carry resolved member names

- `ChannelKeyEntry` (`@omadia/channel-sdk`) gained optional `members` (capped list of
  display names, resolved by the channel plugin — e.g. Teams via Microsoft Graph) and
  `memberCount` (uncapped total). The kernel forwards both through
  `ChannelDirectoryRegistry.listAll()` and `GET /api/v1/operator/channels`
  (`members` / `member_count`); the operator Channels dashboard renders a
  "Members: Alice, Bob +N more" line (en+de). Older plugins that don't set the
  fields are unaffected — the fields are additive and optional in both directions.

### Added — `bot_present`: an inbound group message opens facilitation eligibility (#330 round 3)

- New channel-SDK membership-event kind **`bot_present`** — the adapter observed the agent is
  ALREADY a member of a group conversation (transport-verified inbound message). A bot added
  long ago never gets another `bot_added`, so the invite index stayed closed for exactly the
  chats people talk to the bot in; two live facilitation attempts died on this.
- The kernel invite index accepts `bot_present` as **eligibility only** — the deliberate,
  announced entry (and any eager auto-bind by consumers) stays `bot_added`.

### Changed — cancelling Conductor runs no longer requires finding the hidden button (#330 field report)

- The run history offers **Cancel** directly on each running/waiting row (previously only
  inside an opened trace — the delete guard said "cancel first" while the button was
  effectively unfindable). Per-run busy state; the row-level cancel does not open the trace.
- A delete blocked by active runs (409) now **opens the run history automatically** and the
  message says where to cancel (en+de).

### Added — restart-proof facilitation groundwork (#330 field report)

- Graph migration `0009_teams_conversation_refs.sql`: `teams_conversation_refs` — write-through
  backing store for the Teams channel plugin's per-conversation Bot-Framework
  ConversationReference cache. The in-memory LRU dies with every restart, after which
  proactive delivery (group nudges via `conversationSend`, roster reads) answered
  `no_binding` until the conversation produced a new inbound activity.
- The facilitation pattern's report prompts carry hard FORMAT rules: compact Teams-flavoured
  Markdown (bold mini-headings + bullets, outcome emoji, <150 words) — no ASCII dividers or
  ALL-CAPS banner walls in chat anymore.
- `conversationBindings.listOwnAttachments({agentSlug})`: read-own listing of a plugin's
  non-expired ephemeral attachments, enriched with the workflow's newest running/waiting run
  (`activeRunId`). Lets a restarted agent plugin rehydrate its facilitation state instead of
  refusing every `facilitation_progress`/`facilitation_nudge` call. Same attribution trust
  model as bind/unbind; read-only.

### Fixed — verifier: judge sees the sentence a fragment claim was cut from (#129 follow-up)

- The claim extractor sometimes emits a subject-less fragment ("in die
  IT-Abteilung") as the qualitative claim. The evidence judge deliberately
  never sees the answer, so it could not know *who* moved where and returned
  `unverified` — `golden-eval.yml` flaked on `blocked_contradiction_role`.
- `Claim.context` now carries the enclosing sentence, cut deterministically
  (no LLM) at `.`/`!`/`?`+whitespace or newline; a dot after a number or a
  known abbreviation (`01.03.2023`, `1. März`, `z.B.`, `Dr.`) is not a
  boundary; capped at 400 chars around the span. No context is attached when
  the span occurs in more than one sentence (no guessing the subject) or
  when it already is the whole sentence. The judge gets it as a `CONTEXT:`
  line for disambiguation only and may not base a verdict on facts that
  appear only there. Extractor prompt additionally asks for self-contained
  qualitative claims. The contradiction double-check is unchanged.

### Added — Conductor workflows can be deleted from the library

- **`DELETE /api/v1/operator/conductors/:slug`** removes a workflow with the
  #330 reaper's two shapes, extended to manual workflows: physical DELETE when
  no run references any version (versions, drafts and schedules cascade),
  logical removal otherwise (`disabled` + `reaped_at` — run history retained
  as audit trace, hidden from the library and never event- or cron-triggered
  again). Active (running/waiting) runs answer `409 conductor.has_active_runs`;
  the `eph-` namespace stays owned by the ephemeral lifecycle (`400`).
- **Conductor page grows a "Delete" action** per workflow, gated by the shared
  ConfirmDialog (en+de).

### Changed — the observed-invite index survives restarts (#330 follow-up)

- Migration `0048_observed_invites.sql` (core series, `middleware/migrations/`): new table
  `observed_conversation_invites` as write-through backing store for the kernel-side invite
  index (#330 C2a) — the deny-by-default scope guard for plugin auto-binds. Until now the
  index was in-memory only, so every deploy/restart forced operators to remove and re-invite
  the bot before a facilitation could start.
- The in-memory map stays the hot path: writes are fire-and-forget (log-only on failure),
  boot hydration is TTL-filtered, capped at the in-memory limit, keyed off the table's key
  COLUMNS (a JSONB payload disagreeing with its columns is dropped — defense in depth for a
  security guard), and wrapped so a missing table degrades to the old re-invite behaviour
  instead of failing the boot. Live events observed before hydration win.

### Changed — Admin → Update shows the run as a blocking progress dialog (#432 follow-up)

- **The updater sidecar reports structured progress.** `GET /status` gains
  `phase` (`resolve | preflight | pin | replace | health_gate | rollback | done`,
  `null` while idle) and `failure` (`{kind:'health_gate', reason, observedVersion}`
  or `{kind:'replace', service}`, `null` otherwise). `runUpdate` takes an
  optional `setPhase` hook. The middleware's `/api/v1/admin/update/status`
  passes both through (normalised to `null` for an older sidecar) together
  with `previousVersion`, `startedAt` and `finishedAt`.
- **Admin → Update blocks the page while an update runs** and shows a stepper
  driven by `phase`, the polling itself (cadence, checks, last answer, and the
  restart gap as "middleware is not answering — expected"), and a decoded
  outcome. A `never_reachable` health gate is explained with its likely cause
  (a newly required secret such as `CREDENTIAL_KEYCHAIN_KEY`, a failed
  migration) and a link to `docs/upgrading.md`. The run is remembered in
  `localStorage`, so the dialog resumes after the admin UI container itself is
  replaced; a stale `rolled_back` from an earlier job cannot close a fresh run.

### Added — timer steps, machine-checkable DoD loops and conversation-addressed nudges (#330 C3)

- New Conductor step kind **`timer`** (migration `0011_timer_awaits.sql` widens the await principal-kind CHECK): parks the run via the existing await machinery and follows its `fallbackTransitionId` (the on-expiry edge) when the deadline poll fires — guarded cycles through a timer are legal, unguarded ones stay a validation error (`timer_step_invalid_duration` / `timer_requires_fallback` gate the shape). Preview simulates timers instantly; the run trace records an honest `{kind:'timer', ticked:true}` actor.
- Deterministic loop budget: the executor maintains `ctx.stepAttempts[stepId]` (bumped on every step entry), so a transition guard like `lt ctx.stepAttempts.moderate 24` bounds an assess loop without trusting the model to count — on top of the ephemeral TTL and MAX_STEPS.
- Agent steps now carry a structured verdict: the LAST fenced ```json block of an agent answer becomes `stepResult.data` (mirror of the action-step's `data`; size-capped, tolerant — a missing verdict just keeps the bounded loop going). The bundled `facilitation` pattern is **v2**: hourly assess tick (moderate → wait PT1H → moderate, max 24 rounds) that routes a met DoD to the initiator's confirmation and exhausted rounds to the abort report.
- `conductorEphemeralRuns.poke(runId)` early-fires a run's open timer await ("the group is done — don't wait out the interval").
- New deny-by-default kernel service **`conversationSend`** (+ channel-SDK seam `registerConversationSendProvider`, plugin-api **1.9.0**): conversation-addressed proactive send — the Facilitator's stall-nudges post INTO the group, distinct from targetedSend's user-addressed DMs. First-registrant ownership per channel type, named unreachable outcomes, never a throw.


### Added — zero-touch Facilitator setup: agent provisioning, invite-guarded auto-bind, scoped role assignments (#330 C2a)

- Three new plugin-facing, deny-by-default kernel services remove the manual Facilitator setup: `agentProvisioning` (`ensureAgent` — idempotently creates a top-level Agent, seeds its persona create-only via the Wave-8 `agent_persona_skills` path with the skill slug namespaced under the agent, and attaches the calling plugin; an existing agent — and an existing operator-configured `agent_plugins` row — is never touched, the `fallback` slug never managed), `conversationBindings` (`bind` only for conversations the KERNEL itself observed a group `bot_added` for, via a hub-direct invite index keyed by channel type + conversation; `unbind` is equally guarded to the caller's own ephemeral attachments, so operator bindings are out of reach and the `channel_bindings` PK plus guard close the steal path; both mutations land in the new `channel.binding_change` audit action), and `conductorRoleAssignments` (role writes hard-confined to the `facilitation-` namespace, every holder mutation audited through the #759 `conductor.role_holders_change` sink).
- Migration `0010_ephemeral_attachments.sql`: auto-provisioned bindings/roles are recorded per facilitation and live exactly as long as its ephemeral workflow. Both reap paths (terminal-state hook + TTL reaper) dispose of them through one shared cleanup, and rows only disappear AFTER a successful cleanup — an attachment sweep retries expired `pending` (invite never became a facilitation) and expired `attached` (reap-time cleanup failed or ran before the kernel stores were up) rows. A pre-existing operator binding is never adopted into this self-disposing lifecycle.
- `configStore`/`orchestratorRegistry` are resolved lazily per call (the orchestrator plugin publishes them at its own activation), so the seam is independent of plugin boot order.

### Added — `transcription@1` capability + batch recording ingestion (#584 WS T+I)

- **Speech-to-text is a Core capability.** New provider-swappable
  `transcription@1` seam in `@omadia/plugin-api` (`transcribeFile` batch +
  `transcribeStream` realtime, provider-neutral types, keyword/language/context
  hint carrier) with day-one cost guardrails: per-call duration cap, per-agent
  minute quota (in-memory spend brake) and minute metering, mirroring the
  conductor's #818 guardrails. Contract `@omadia/plugin-api` → 1.8.0 (additive).
- **First provider: `@omadia/transcription-adapter-openai`.** `gpt-transcribe`
  (batch, `POST /v1/audio/transcriptions`, $0.0045/min) ships ungated;
  `gpt-live-transcribe` (Realtime WebSocket, $0.017/min) ships behind
  `TRANSCRIPTION_REALTIME_EXPERIMENTAL` until its consumer (#584 WS S,
  AudioMeetingSource) lands. Vault-backed BYO key; injectable socket/fetch
  seams keep the whole wire protocol unit-tested without credentials.
- **`transcribe_recording` native tool (Workstream I).** Transcribes an
  uploaded recording and ingests it into the SAME artifact substrate as a live
  chat session — speaker-attributed session-log entries, per-utterance KG
  turns (new additive `speaker`/`time` fields on `SessionLogEntry` /
  `TurnIngest`), briefing availability. Transcript text re-enters as a tool
  result, so it rides the standard per-turn privacy choke points.
- **Admin → Transcription provider panel** (`/admin/transcription-provider` +
  `/api/v1/admin/transcription-provider`): live provider switch with verified
  rollback (embeddings-route mechanics minus the corpus machinery) — and the
  operator-facing consent surface: an active provider sends raw audio to its
  external endpoint.

### Added — "Sign in with ChatGPT" subscription provider (#294, experimental)

- **Connect a ChatGPT subscription as an LLM provider via OAuth, no API key.**
  A new `openai-chatgpt` provider connects through the real device-code login
  flow (`POST /api/v1/admin/providers/oauth/{start,poll}`): the operator gets a
  user code, approves it at `auth.openai.com/codex/device`, and the resulting
  bearer drives the ChatGPT/Codex **Responses** backend (a new
  `openai-responses` SSE wire format + adapter). Gated behind
  `CHATGPT_SUBSCRIPTION_EXPERIMENTAL` (off by default) — driving programmatic
  calls through a consumer subscription is a ToS grey area, so the connect modal
  shows a prominent notice and it is not an enterprise feature.
- **Rotation-safe token store.** Refresh tokens rotate (reuse is a terminal
  error), so tokens live in one process-wide store with single-flight refresh;
  rotated tokens fan out to every LLM-plugin vault scope with a newest-wins
  stamp, and a dead grant parks the provider in a clean "reconnect required"
  state instead of retry-hammering. Empirically verified live: tools, forced
  tool choice, parallel tool calls and vision all work on the backend.
- Contract `@omadia/llm-provider-api` → 1.1.0 (additive: `openai-responses`
  wire format, descriptor `oauth`, adapter `bearerProvider`).

### Added — group-conversation primitives in the channel SDK + Principal-addressed targeted delivery (#330 Workstream B1)

- Channel SDK (strictly additive; Teams 0.12.7 / Telegram 0.2.0 run unchanged): `IncomingTurn.conversationType` (`'direct' | 'group'`, absent = unknown → treated as direct via the new `isGroupConversation`), a `ConversationRoster` contract with `partial` lower-bound semantics, typed `ConversationMembershipEvent`s (`bot_added` incl. WHO invited the agent, `members_added`/`members_removed`), and a `TargetedSendProvider` that only ever delivers to ONE already-resolved user.
- Three new optional `CoreApi` methods in the `registerWebSocket` feature-detect mould: `registerRosterProvider`, `registerTargetedSendProvider`, `emitConversationEvent` — defined only when the kernel wired the matching registry; channel deactivation drops the channel's contributions.
- Kernel: per-channel roster + targeted-send registries, a conversation-event hub with per-subscriber isolation, and a `targetedSend` kernel service (deny-by-default) that resolves Principals — `user:<id>` → one delivery, `role:<key>` → late-bound fan-out to ALL current holders (notification semantics, one delivery per holder, no quorum). Empty roles, partial holder lists and unreachable holders are named diagnostics, never silent drops; on the no-Postgres path role sends degrade to `role_resolution_unavailable` while user sends keep working.
- `@omadia/plugin-api` 1.7.0 (additive MINOR, snapshot updated): `TARGETED_SEND_SERVICE_NAME` + request/result shapes so an agent plugin (the #330 Facilitator) can send reports without depending on the channel SDK.

### Added — pattern-based ephemeral Conductor workflows with TTL reaper (#330 Workstream A)

- Workflows now carry an `origin` (`manual` | `ephemeral`, migration `0009_ephemeral_workflows.sql`): agent-generated JIT workflows live in the reserved `eph-` slug namespace, never appear in the workflow library (`list()` filters to `manual`), and the create/instantiate routes reject the reserved prefix (`conductor.reserved_slug_prefix`).
- New kernel service `conductorEphemeralRuns` (deny-by-default like every plugin service — no grants-catalog entry yet, the Facilitator plugin adds one): `createEphemeralRun({ agentId, patternId, slots, payload, ttlMs })` instantiates a curated pattern from the new bundled `src/conductor/patterns/` catalog (slot-fill via the existing template machinery — agents can never submit arbitrary graphs), publishes it as `origin='ephemeral'` and starts the run with the previously call-site-less `triggerKind: 'agent'`.
- Guardrails (env-tunable, `CONDUCTOR_EPHEMERAL_*`): mandatory clamped TTL (default 24h, max 7d), per-agent concurrent-run cap (3) and hourly create rate limit (10).
- Disposal is "discard the scaffold, never the minutes": on a terminal run state (immediate hook) or TTL expiry (new reaper worker) the definition is disabled + stamped `reaped_at`; expired-but-active runs get a #759 cancel request; a physical DELETE only happens for definitions no run references. Run history and version graph are retained as the audit trace.
- First bundled pattern: `facilitation` (moderate → initiator confirmation with 24h deadline → report / abort-report) — the Conductor substrate for the #330 Facilitator.

### Removed — the core-decoupling ratchet is retired (#470 C14)

- `scripts/check-core-decoupling.mjs`, its colocated detector test
  `scripts/check-core-decoupling.test.mjs`, `specs/470-dev-platform-plugin/decoupling-baseline.json`
  and the CI job `core decoupling ratchet (#470)` are removed. The guard ran from 2026-07-30
  (#539) to 2026-08-21, peaked at **3,448** counted Dev Platform references in core, fell to
  214 at C10 and reached **0** at C13, where the floor was pinned permanently.
- It was scaffolding for a migration in flight: it made a file inventory's staleness
  survivable, because a checklist goes stale on contact and a count does not. The extraction
  is finished and the Dev Platform lives in `byte5ai/omadia-dev-platform`, so the guard has
  nothing left to guard — keeping it would cost a CI job and leave an editable number behind.
  Reintroducing that coupling is now an ordinary architectural decision, argued for in review.
- No behaviour change: the job is not among `main`'s required status checks and no other job
  declared `needs: decoupling`, so removing it cannot leave a branch waiting on a check that
  will never report. (The job's own comment claimed required-check status; branch protection
  says otherwise — worth knowing before trusting a comment about CI over the API.) The specs
  under `specs/470-dev-platform-plugin/` keep a closing note in place of the live baseline rows.
### Added — runtime install of subscription CLIs from the admin UI (#309 extension, enabler for #294)

- **The Subscription-CLIs page can now install a missing vendor CLI in-app.**
  The public image deliberately does not bundle the Claude/Codex/Gemini CLIs
  (redistribution needs legal review); previously a missing CLI dead-ended in
  manual shell steps. A new "Install now" button triggers an operator-side
  `npm install` from the public registry into `CLI_TOOLS_DIR` (defaults to
  `<PLATFORM_DATA_DIR>/cli-tools` on the persisted volume, so installs survive
  restarts). Detection and the in-app login prefer that directory over PATH.
- **New routes** (auth-required, same router as the existing login flow):
  `POST /api/v1/admin/cli-backends/:id/install` (202 accepted / 200 already
  installed / 409 while another install runs / 400 unknown id or non-semver
  version) and `GET /api/v1/admin/cli-backends/:id/install/status`.
- **Hardening:** package names only from a fixed allowlist, optional version
  strictly semver-validated, `execFile` without a shell, bounded time/output,
  host-global single-flight. New env vars documented in `middleware/.env.example`:
  `CLI_TOOLS_DIR`, `CODEX_HOME`.

### Fixed — handoff plans now stay inside the package after symlinks and fail closed on declared dry runs (#470 C15)

- `middleware/src/platform/pluginHandoffPlan.ts` now re-checks `permissions.sql.handoff` containment after resolving real paths for BOTH the package root and the target, closing the two escapes PR #815 left open: a file symlink inside the package pointing outside, and a directory symlink inside the package whose child path points outside. Missing targets still refuse as `unreadable`, not as an escape, so the operator still hears "the package does not ship this file" for the case they can actually fix.
- The same loader now refuses `"dryRun": true` in a kernel-run handoff plan. Preview mode belongs to `middleware/scripts/plugin-ledger-handoff.mjs --dry-run`; if core honoured a plan-level dry run it would write nothing, then immediately let its own migration runner apply every file, silently recreating the exact G7 failure C15 exists to remove.
- Regression locks now cover the two fail-closed properties the feature lives or dies on: a witness that fails at the database aborts activation before the migration runner can run, and a manifest whose SQL grant no longer matches its declared ledger is treated as ungranted so neither the handoff nor the runner can reach the database.

### Fixed — core-decoupling zero floor no longer hides same-named files (#470 C13 review)

- `scripts/check-core-decoupling.mjs` now excludes only the exact detector path `scripts/check-core-decoupling.mjs` instead of any basename match, closing the hole where a same-named file dropped under `middleware/src/` could hide Dev Platform identifiers from the permanent zero floor. A colocated regression test proves the detector stays self-excluded while a probe file at `middleware/src/__probe/check-core-decoupling.mjs` is counted.
- The remaining human-readable fixture labels left behind by the C13 identifier rename now use the neutral example-plugin naming too (`Example Plugin` / `Beispiel-Plugin`), so the tests assert against the strings their fixtures actually define and no permanently-green "old assertion, new fixture" trap remains.
- `middleware/test/auth/staticPublicPathsClosedSet.test.ts` still skips the loopback-listener half in restrictive local sandboxes, but if `CI` is set the same bind failure now throws with a clear message instead of silently skipping the five 401 assertions.

### Added — migration handoff: a plugin can adopt an existing installation's schema (#470 C11)

- **Plugins extracted out of core no longer re-apply core's migrations.**
  `ctx.sql.seedLedger({ entries, dryRun })` records a plugin's migration files as
  already applied — but only where a per-file **witness** (a catalog query such as
  `SELECT to_regclass('public.<table>') IS NOT NULL`) proves the schema object that
  file creates is actually present. The core ledger is corroboration; the witness is
  the decision.
- **This is the failure it prevents.** The obvious handoff copies core's ledger rows
  and skips those files. On a database where the rows are present but the tables are
  **absent** — a restore from an older snapshot, a version-skewed rollback, an
  operator who dropped a table during an incident — that seed activates the plugin
  green and makes every request 500, nine steps behind the cause. With witnesses the
  plugin's migration runner simply applies the files, which is the repair.
- **Core's rows are never deleted.** They are the rollback path: while core still
  ships the same files, removing them would make core's own migrator re-run them on
  the next boot. Uninstalling the plugin and reverting the extraction leaves core's
  migrator exactly as it was.
- **Operator CLI, dry-run by default.**
  `node middleware/scripts/plugin-ledger-handoff.mjs --plan <plan.json>` prints the
  plan against `$DATABASE_URL` and writes nothing; `--apply` is the only way to
  write. It highlights the one number worth reading — the files core recorded whose
  witness is false. Running it against production before installing the plugin is
  the cheapest de-risking of this step there is.
- `@omadia/plugin-api` **1.3.0** (additive): `SqlAccessor.seedLedger` (optional, so
  a plugin still activates against a 1.2.0 core), `LedgerSeedEntry`,
  `SeedLedgerOptions`, `LedgerSeedReport`.


### Removed — Dev Platform moved to byte5ai/omadia-dev-platform (install via Hub/ZIP) (#470 C10)

- **BREAKING for operators who ran it.** The Dev Platform — isolated per-job code
  runners (clone → agent-edit → diff → server-side PR), its repo/job/gate admin
  surface, the GitHub App onboarding, the webhook trigger, the LLM proxy and the
  runner sidecars — is no longer part of core. It ships as an installable,
  uninstallable plugin from
  [`byte5ai/omadia-dev-platform`](https://github.com/byte5ai/omadia-dev-platform).
  **Install it through the plugin Hub, or upload its ZIP.**
- **Configuration moves with it.** All 43 `DEV_PLATFORM_*` / `DEV_JOB_*` /
  `DEV_RUNNER_*` / `DEV_FLY_*` / `DEV_EGRESS_*` / `DEV_ARTIFACT_*` /
  `DEV_WEBHOOK*` environment variables are gone from the middleware schema and are
  now plugin settings. `middleware/.env.example` points operators at the plugin.
  Unrelated lookalikes are **unchanged**: `DEV_ENDPOINTS_ENABLED` and
  `DEV_ENDPOINTS_LOOPBACK_ONLY` are core's dev-graph endpoints, and `FLY_APP_NAME`
  describes the host.
- **Your data is not touched.** Migrations `0022`–`0030` and every `dev_*` table
  stay exactly where they are; core still ships and applies them. The handoff of
  ledger ownership to the plugin is a separate, independently revertible change
  (#470 C11), and it seeds by filename only against a per-file schema witness —
  it never deletes the donor rows.
- **In-flight jobs keep working across the upgrade.** The two `auth/publicPaths.ts`
  exemptions that let a runner phone home without a session are deliberately still
  present; they are removed on their own afterwards (#470 C12).
- The `dev-runner` and `dev-runner-daemon` images are no longer built, signed or
  published from this repository. The plugin repo owns their GHCR publishing, SBOM
  and cosign signing. A daemon pinning the old keyless certificate identity needs
  the transition `--certificate-identity-regexp` before it will accept images from
  the new signer.
- In chat, a dev-job start no longer renders its bespoke card; it uses the generic
  long-running-task card instead (#470 H3).

### Fixed — plugin SQL ledgers now live in a core-proof namespace

- `permissions.sql.ledger` is now kernel-validated as
  `plg_<sanitized-plugin-id>_<suffix>`, closing the hole where a plugin whose
  folded id matched a real core table name could adopt that table as its
  migration ledger. The validator now also fails loudly when the mandatory
  namespace leaves too little room inside Postgres' 63-byte identifier limit,
  instead of relying on later DDL truncation behavior.

### Fixed — service-grant gate covers legacy rows, plugin-facing callers, and per-plugin factories (#470 C2b, PR #783)

- Filled the dated `ctx.services.get` legacy allowlist with the currently-real built-in and hub-plugin rows the first audit missed: some service names are hidden behind exported constants (`PROCESS_MEMORY_SERVICE_NAME`, `PLUGIN_CAPABILITIES_SERVICE`, `CHANNEL_RESOLVER_SERVICE`, …) and some channel repos resolve them through shared `@omadia/channel-sdk` helpers rather than a literal string in the plugin's own file. The boot-breaking orchestrator/orchestrator-extras gaps are now grandfathered explicitly until their manifests catch up.
- Added `test/pluginServiceGrantCoverage.test.ts`, which derives service reads from every built-in `middleware/packages/*/manifest.yaml` plus its `src/**/*.ts` call sites and fails loud on undeclared or stale legacy rows instead of trusting a hand-maintained snapshot.
- Threaded the plugin's `ServiceCaller` through plugin-facing accessors that resolved services outside `ctx.services.get` (`ctx.memory`, the knowledge-graph accessor, `ctx.mcp`, `ctx.subAgents`, `ctx.llm`, `ctx.events`) so `perCallerService(...)` providers see the consuming plugin instead of the kernel.
- Made `perCallerService(...)` truthful to its docs: one implementation is now memoized per consuming plugin and per factory object, so repeat reads by the same plugin reuse the same instance while a replaced provider starts cold automatically.

### Fixed — verifier: hallucinated record references no longer pass with a disclaimer (#129, PR #781)

- **Behaviour change (blocking).** A qualitative answer that names a concrete
  Odoo document (`INV/2026/0099`, `SO0123`, `RE-4711`) which does **not**
  exist is now `blocked`, not `approved_with_disclaimer`. Root cause: the
  LLM claim extractor typed such sentences as `qualitative` in roughly a
  third of samples, and qualitative claims bypassed the deterministic
  re-query entirely. `golden-eval.yml` flaked on exactly this
  (`blocked_deterministic_id_absent`).
- Scope is deliberately narrow: only `qualitative` claims with a
  document-style `ref` (contains a digit) or numeric `id`; only models with
  known reference fields (`account.move` `name|ref`, `sale.order`
  `name|client_order_ref`, `purchase.order` `name|partner_ref`,
  `stock.picking` `name|origin`, `account.payment`, `hr.expense.sheet`).
  Person/company names, unknown models and reader errors stay on the judge
  path (fail-open). Anchors already covered by a hard `id` claim in the same
  turn are not re-queried twice.
- Extractor prompt now asks for a separate `id` claim per record reference.

### Added — provenance verification surface: verify API, signed export, offline verifier (#761)

- **`GET /api/v1/operator/provenance/verify`** walks the stored chain,
  recomputes every entry hash, validates checkpoint signatures against the
  operator key, checks the retention prefix for a signed anchor, and enforces
  the #758 laundering rule: a reaped row a checkpoint proves was younger than
  the retention window is a `premature_deletion` finding, not retention.
- **Signed JSONL export** (`/provenance/export`) + a **zero-dependency
  offline verifier** (`scripts/verify-audit-export.mjs`, node:crypto only) —
  an external auditor verifies the export with the out-of-band public key
  WITHOUT trusting the server; a zero-entry export refuses to report green.
  The verifier is itself covered by end-to-end tests (clean export → exit 0;
  tampered payload → exit 1 naming the exact seq).
- **Chain-status card** on `/operator/receipts`: posture (key, cadence,
  anchor), on-demand verify, findings list, export download.
- **`docs/provenance-verification.md`**: mechanism explainer, the
  five-minute tamper demo, and the explicit proves/does-not-prove list. With
  this, "cryptographically verifiable" is backed by code; the public wording
  change stays a deliberate separate step per `docs/ai-act-transparency.md`.

### Added — tamper-evident receipt chain: hash chaining + signed checkpoints (#758)

- **Hash chain (migration `0041`).** Every persisted receipt row now joins a
  per-stream chain: `entry_hash = sha256(stream ‖ seq ‖ prev_hash ‖
  canonical(payload))`, appends serialized through a `FOR UPDATE`-locked
  stream head so concurrent turns form one linear chain. Editing row *n*
  breaks the copy of its hash stored in row *n+1* — visible to every later
  entry. Replayed turns roll the whole transaction back (no phantom head
  movement). UPDATE on `turn_receipts` is trigger-forbidden (defence in
  depth; the chain is the proof); DELETE stays legal for retention, and
  deletions show as seq gaps.
- **Ed25519 checkpoints.** On an interval (`AUDIT_CHECKPOINT_INTERVAL_MINUTES`,
  default 60) the stream head is signed with a key held ONLY in
  env/secret-manager (`AUDIT_SIGNING_KEY` — never in Postgres, or the admin
  the chain defends against could re-sign a rewritten chain). Optional
  external anchor file (`AUDIT_ANCHOR_PATH`, JSONL) for WORM storage.
  Keygen: `node scripts/generate-audit-signing-key.mjs`. Public key +
  fingerprint served at `GET /api/v1/operator/provenance/public-key`.
- **Verification foundation** (`verifyChainSegment`) ships with tamper tests
  (edit → `hash_mismatch` at the exact seq; delete → `seq_gap`; forged
  suffix → `link_mismatch`); the operator-facing verify surface (endpoint,
  signed export, offline verifier, UI) is #761 — until it ships,
  "cryptographically verifiable" remains a non-claim
  (`docs/ai-act-transparency.md`).
- Known limitations, stated: detection not prevention; per-row time is
  anchored by checkpoint cadence, not per-row (`created_at` is outside the
  hash); pre-chain rows carry NULL chain columns ("pre-chain era").

### Added — Privacy Shield: operator deny-lists, miss-report queue, idnum coverage, eval CI gate (#760)

- **Operator deny-list.** Two new privacy-plugin setup fields: `custom_terms`
  (literal terms — project code names, customer names — ';'/newline-separated,
  word-boundary + case-insensitive) and `custom_patterns` (advanced regexes,
  one per newline). Patterns are vetted at config change: invalid syntax and
  catastrophic-backtracking candidates (escalating-probe time budget) are
  rejected with a loud `customPatternRejected` log, never silently dropped.
  Spans report type `custom` in the receipt and ride the same fail-closed
  surrogate machinery as the built-in patterns.
- **Miss-report catch basin.** Fail-closed guards execution, not
  non-detection — so a value the detectors miss now has a human path back:
  "report a missed value" on the privacy receipt card files into
  `privacy_miss_reports` (migration `0040`), reviewed at
  `/operator/privacy-reports` (copy term → add to `custom_terms` → resolve).
- **`idnum` promoted from informational to gated.** C0 now detects DE
  Steuer-ID/USt-IdNr., ES NIE/DNI, IT Codice Fiscale, UK NINO, FR n° sécu.
  Deliberately unpatterned: NL BSN (9 bare digits, no distinguishing shape) —
  a recorded miss, not an ungated type.
- **Detection quality is now a CI gate.** `promptDetectorEval.ts --check`
  (deterministic C0 set) runs on every PR against committed per-locale floors
  (`validation/ci-baseline.json`); an empty evaluation fails rather than
  reporting green.
- Open, deliberately: surrogate-TYPE assertions in the eval fixtures (the
  #727 bug class stays invisible to span-coverage scoring), fixture
  auto-export from resolved reports, the `mask_user_prompt` default (product
  decision), setup-time feedback for rejected custom patterns (today the
  rejection is server-log-only), and the residual runtime risk that a
  polynomial pattern's FIRST over-budget turn is slow before the fail-closed
  block lands (exponential cases are caught at vet time by the digit/letter/
  unicode probe escalation).

### Added — Conductor run cancellation + approval hardening (#759)

- **Run cancel.** `POST /api/v1/operator/conductors/:slug/runs/:runId/cancel`
  (+ a cancel button on the run trace): a `waiting` run ends immediately — its
  open awaits close as `cancelled` (writing, for the first time, the enum value
  the schema carried since 0001) and a synthetic step records the cancelling
  operator; a `running` run is flagged and its driver stops at the next step
  boundary (a mid-step kill is deliberately not attempted — the at-least-once
  effect window stays bounded to one step, same as crash recovery); terminal
  runs answer 409. Schema: conductor migration `0008_run_cancel.sql` (status
  CHECK + `cancel_requested_by/at`).
- **Strict approvals.** New per-human-step `strictApproval` flag (designer
  checkbox): only an explicit `{approved:true}` advances — inverting the
  documented fail-open default where anything but `{approved:false}` counts as
  approval. Default unchanged for existing workflows.
- **Validator warnings (non-blocking).** `timeout_equals_approval` (a deadline
  fallback that lands on the approval path — a timeout would silently approve)
  and `approval_fail_open` (a non-strict human step gating an action step),
  surfaced amber in the designer on publish.
- **Role-holder audit.** Every baton add/remove now lands in `admin_audit`
  (`conductor.role_holders_change`) — who may approve is a security decision;
  in the current single-role system any operator can assign themselves.

### Added — persistent per-turn privacy receipts (#757)

- **`turn_receipts` (migration `0039`).** The per-turn `PrivacyReceipt` is no
  longer ephemeral UI state: every completed turn writes its PII-free receipt
  (counts + routing metadata, never a value) synchronously to Postgres — no
  optional graph sink, no user-cluster precondition. Failures are counted and
  logged, never silent. Schema note: `turn_id` unique (idempotent on replayed
  `done` events); retention bounded by the new `RECEIPT_RETENTION_DAYS`
  (default 90) via an unref'd reaper anchored on the DB clock.
- **Operator surface.** Auth-gated `GET /api/v1/operator/receipts` (+
  `/:turnId`) with composite-keyset pagination, and a web-ui page under
  `/operator/receipts` rendering the exact receipt card the user saw.
- Not yet tamper-evident — hash chaining, signatures, and verification are
  #758/#761; `docs/ai-act-transparency.md` §6 keeps "cryptographically
  verifiable" a non-claim until they ship.

### Added — a command policy that reads what a command actually does

- **Shell-normalizing command policy (#580).** Command gating is not
  regex-on-the-raw-string: `r""m -rf /`, `rm${IFS}-rf${IFS}/`, `$'\x72\x6d' -rf /`
  and `$(printf rm) -rf /` are the same command wearing four disguises, and a
  naive `includes('rm -rf')` misses every one. The new primitive **normalizes
  first** — unwraps quoting, decodes ANSI-C `$'…'`, collapses `${IFS}` to a field
  split, recurses into `$(…)` and backticks — then tokenizes, and only then runs
  the rule cascade (org floor → org allowlist → scope rules → default).
- **The org floor holds in every posture.** Recursive `rm`, `git push --force`,
  destructive SQL, fork bombs and pipe-to-shell are denied with no caller flag
  that turns them off — a `dangerous` posture is not an exemption. The shipped
  floor is **deep-frozen**, so no caller can flip a rule from `deny` to `allow`
  on the shared value.
- **A command that could not be fully read is refused, not cleared.** When
  substitution nesting passes the depth cap the normalizer reports `truncated`;
  the enforcement seam treats that as suspicious rather than clean, because a
  floored command could be hiding below the cap (`$($($(…rm -rf…)))`).
- **This is a speed bump, not a sandbox boundary** — the framing is borrowed
  from qm's own SECURITY.md, and it is the honest one. Unresolved variables,
  `eval` of a computed string and exotic here-docs are documented blind spots;
  the durable sandbox is the real containment.
- The enforcement seam is **honest-inert**: omadia ships no shell-execute tool
  yet, and with no policy provider installed the guard is a no-op. Nothing
  changes for any existing turn.

### Changed — a restricted room keeps the curated knowledge it is entitled to

- **`sharedOnly` recall (#575).** Narrowing a room to its own conversation used
  to drop curated memory entirely along with the other cross-session legs. But
  curated memory is **tiered**: `team` / `public` knowledge is shared by
  construction, so a restricted room may have it — only rows the recalling user
  privately owns are off-limits.
- **`sharedOnly` is not the opposite of `teamVisibility`.** The latter *widens*
  the ACL (owner rows plus shared ones); this *narrows* it to the shared tier
  alone. They answer different questions, and the audience floor needs the
  second one: "what may **everyone present** see?"
- `sharedOnly` **implies** the shared branch in every implementation — asking
  for shared rows while that branch is off would silently return only the
  viewer's own shared rows, a misconfiguration with no legitimate use.

### Fixed — shielded result tables no longer render blank columns

- **Masked columns came out empty on the canvas (#326).** A privacy-shield
  dataset resolves to rows *keyed by the source's column paths*, but the canvas
  composer looked cells up under the **agent's** field keys. Where the agent
  called a column `invoice_number` and Odoo's path was `name`, the lookup missed
  and the cell was silently blanked — so an invoice table rendered without
  invoice numbers or customers.
- Columns that happened to reuse the real field name filled correctly, which is
  why this looked like a rendering glitch rather than a mapping fault.
- **Fixed by deriving the table's columns from the resolved dataset**, so values
  resolve by path. Shielded columns now also carry
  `privacy: "guard-protected"` — a marking the canvas protocol already defined
  and the `v4_render_answer` path already emitted; only this path never did.
- **Labels are matched positionally**, and only when the agent's and the
  dataset's column lists are the same length; otherwise the raw path is shown.
  No field-key↔path mapping exists anywhere in the system, so the alternative
  would be a header that confidently names the wrong column.

### Changed — a restricted room narrows its recall instead of losing it

- **`memory:recall:cross_scope` (#575).** Recall used to be all-or-nothing: a
  room that could not satisfy `memory:recall` got no prior context at all. A
  room can now hold `memory:recall` without the new capability — it recalls its
  **own** history and drops hits from other conversations.
- **Why it matters:** recall is ACL-gated by the *recalling* user, so in a
  shared room a hit from that person's other chats lands in the single prompt
  everyone's answer is derived from. Only one participant was entitled to it.
- **The cross-session legs are skipped too** — plans, processes and curated
  insights bypass the candidate pool and render their own blocks, so filtering
  candidates alone would have looked thorough while letting those through.
- Dropped hits are recorded as exclusions with reason `audience-scope`, so a
  thin context block is explainable rather than mysterious.

### Added — outbound hosts can be read as an allow-list, not just prohibitions

- **`AUDIENCE_HOST_ALLOWLIST_ENABLED` (default off, #575).** With it, a host must
  also be granted through the audience floor — `net:<host>` per host, or `net:*`
  for unrestricted — and the grants intersect across everyone present. This is
  the "allowlist = intersection of allowed hosts" half of the issue.
- **Off by default because switching it on is consequential**, not out of
  caution: outbound hosts are granted by a plugin's manifest, so a room whose
  participants hold no host grants reaches nothing at all. Seed grants first.
- **A prohibition beats `net:*`.** The unrestricted grant is a convenience for
  operators who should not have to enumerate hosts; if it also overrode an
  explicit veto, the veto would be worthless exactly where it matters, since
  `net:*` is what a broad role is most likely to carry.
- **`net:*` intersects like any other capability** — the room is unrestricted
  only when *everyone* present is. One host-restricted participant restricts the
  room.

### Added — a room can forbid an outbound host

- **Host-level egress (#575).** A `net:<host>` prohibition now narrows a
  plugin's manifest outbound allow-list for the duration of a turn, enforced in
  `ctx.http` — the accessor that already carries the manifest allow-list, the
  SSRF guard and the rate limiter.
- **It binds `public-web` audit mode too**, so a `web_scanner` plugin is not a
  way around a host an operator forbade, and it is checked *before* the rate
  limiter so a refused call costs the plugin nothing.
- **Prohibitions only — the allow-side intersection is deliberately not
  shipped.** Outbound hosts are granted by the plugin manifest, not by the grant
  store, so intersecting would reduce every room's effective allow-list to the
  empty set the moment the floor is switched on. A prohibition can only ever
  narrow, and only where an operator wrote one.
- `AudienceFloor` now exposes the union of prohibitions alongside the permitted
  set: with only the difference, "explicitly forbidden" and "never granted" are
  indistinguishable, and a consumer with its own allow-list has to tell them
  apart.

### Added — one participant's prohibition binds the whole room

- **The audience floor could express "may" but not "must not" (#575).** It
  intersected allowances, which is half of what spec §5.2 asks for
  ("allowlist ∩, denylist ∪"). There was no way to say *this person must never
  do X* at all.
- **New:** explicit denials for a principal or a role (migration
  `0037_audience_denials.sql`), with endpoints under
  `/api/v1/admin/audience-grants/{direct,roles}/deny`.
- **Allowances intersect, prohibitions union — deliberately asymmetric.** An
  allowance says what someone *may* do, so the room may do what everyone may;
  a prohibition binds the room even when only one participant carries it.
  Applying intersection to prohibitions would mean a rule only bites when
  everybody is under it.
- **A denial overrides a grant**, rather than being modelled as "simply do not
  grant it" — otherwise any role that happens to confer the capability would
  silently lift an operator's explicit prohibition.

### Added — an attachment handle only redeems in the room that minted it

- **A storage key was just a string (#575).** The handle guard checked the floor
  at *redemption* — may this room read attachments — but not at *minting*. So a
  key issued in a private chat stayed redeemable in any room that happened to
  hold `attachment:read`, which is what "a string can be pasted into a group
  chat" means in practice.
- **New:** each key is pinned on first sighting to the `ScopeId` it was resolved
  in (migration `0036_attachment_scope_bindings.sql`), and every later
  resolution must come from the same room.
- **The binding rides on the reader, not on the call sites** — a storage key
  outlives its turn, so a check at one resolution site holds only until somebody
  adds the next one.
- **Non-addressable scopes are deliberately not bound.** `'http-default'` is
  shared by every unscoped HTTP caller (the #445 cross-user hole) and
  `teams-unknown` by every Teams activity without a conversation id. Binding to
  one of those would declare all of them the same room — enforcement in
  appearance, universal access in fact.
- Enabled by the same `AUDIENCE_FLOOR_ENABLED` flag; without it the check stands
  down and the reader behaves exactly as before.

### Added — audience-floor grants survive a restart, and an operator can see them

- **The audience floor had no durable store (#575).** `InMemoryGrantStore` was
  the only implementation, so a deployment that switched the floor on lost every
  grant on restart. Because the floor fails closed, that did not degrade the
  feature — an empty grant table means "nobody may do anything", so a restart
  shut every room until someone re-seeded by hand.
- **New:** `AUDIENCE_FLOOR_ENABLED` (default off) plus Postgres-backed grants
  (migration `0035_audience_grants.sql`) and an operator surface at
  `/api/v1/admin/audience-grants` (cookie auth, like the other admin routers).
- **The admin surface is available whenever Postgres is, independently of
  enforcement** — grants have to be seedable and reviewable *before* the floor
  starts enforcing, or the only way to populate the table would be to switch the
  floor on against an empty one.
- **Enabling the floor without Postgres refuses to boot.** The alternative is
  worse than a crash: every lookup would throw, every room would refuse every
  tool, recall nothing and read no attachment, and the deployment would look
  configured while behaving as though someone had forbidden everything.
- Role grants additionally need a role source registered (#333 phase 2); direct
  grants work on their own, because an empty role registry is a complete answer
  rather than a partial one.

### Fixed — a withheld answer no longer ships its full reasoning to the channel

- **`NO_REPLY` stopped suppressing delivery the moment the AI-Act Art. 50
  marking shipped (#661, #662).** `isNoReply` anchors the sentinel at the END of
  the message; `applyAiDisclosure` folds the marking line into that same `text`.
  Folded onto a sentinel answer, the anchor stops matching and the agent's
  entire turn goes out.
- **Seen in production.** A weekly approval routine emitted the sentinel in all
  four of its recorded runs and still pushed 9,381 characters of intermediate
  reasoning into a Teams chat on the first Monday after the deploy. Every
  routine on every channel that relies on the sentinel was affected, and both
  sentinel forms were — the mandated bare `NO_REPLY` as much as the lenient
  trailing one.
- **Suppression now precedes decoration.** The guard sits in the one shared
  derivation, so the streaming and non-streaming paths, and every channel that
  renders `text`, are covered by construction rather than per call site.
- **A withheld message no longer spends the scope's first-turn marking slot.**
  The guard short-circuits before `shouldFold`, which marks a scope seen as a
  side effect; otherwise the next answer that really was delivered would have
  shipped without its Art. 50 marking.
### Added — the audience floor can now be switched on (#575)

- **The piece that makes the three guards non-inert.** Until now the floor, the
  grants and all three guards were merged but unreachable, because nothing
  installed an audience source. Passing `audienceGrants` to the orchestrator now
  builds one per turn, and enforcement begins.
- **It is an explicit opt-in, not a default.** The floor fails closed by design,
  so a deployment that has not decided who may do what would otherwise find its
  rooms bounded by an empty grant table. Omit the option and every guard
  short-circuits exactly as before.
- **The chain runs end to end**: roster → Principal per participant (via the
  same knowledge-graph join `resolveTurnOwnerIdentity` uses) → roles → grants →
  the intersection. Every failure along it was already made explicit by the
  layer that owns it, so this adds no policy of its own — an unreadable role
  source, an unplaceable participant or an empty roster each close the room,
  with a reason.
- **It deliberately does not cache.** The egress guard re-evaluates per tool
  call so a mid-turn joiner narrows the floor before the next call fires;
  memoizing the roster here would hand it the turn's opening answer every time.
  Caching stays where the `ChatParticipantsProvider` contract already puts it —
  with the channel adapter, which knows when its roster goes stale.
- A turn that did not arrive through a channel resolves to no principals rather
  than defaulting to a plausible-looking channel kind: a wrong kind resolves to
  a *different* identity cluster, which would hand the room somebody else's
  grants.

### Added — the audience floor now guards attachment-handle resolution (#575)

- **The floor's third and last guard**, completing the trio the spec names. A
  storage key is a handle: it is minted in one turn and can be redeemed later,
  potentially in a different room.
- **The check rides with the handle, not with the call sites.** Enforcement
  lives in a wrapper around `AttachmentReader` applied at its single
  construction site, so `read_attachment`, the orchestrator's own
  `ingestAttachments` and any future resolution path are covered by
  construction rather than by remembering to add a call.
- **This closes a path the egress guard did not.** `read_attachment` is a tool
  and so already passed the first guard, but `ingestAttachments` resolves
  storage keys straight off the inbound turn with no tool call involved — the
  path a caller actually controls.
- **A refusal is indistinguishable from "unknown key" to the caller, on
  purpose.** Confirming that a key exists but is off-limits would leak the
  document's existence to a room that may not know it. The real reason goes to
  the operator log, where it is actionable and not a side channel. The inner
  reader is never reached, so a refused redemption does not even touch the
  store.
- Redeeming a handle and invoking the read tool are separate capabilities;
  neither grants the other.

> **Remaining gap, named rather than assumed closed.** This checks the floor at
> *redemption*, not at *minting*. It stops a room from redeeming a handle that
> room may not read, but cannot yet stop a handle minted in a narrow room from
> being redeemed in a wider one that happens to hold the capability. Binding the
> minting audience to the handle needs the attachment store to persist it, and
> that store lives in the channel plugins.

### Added — the audience floor now guards context recall (#575)

- **The floor's second guard**, at the single context-assembly call site. In a
  shared room the recalled context is rendered into one prompt that everyone's
  reply derives from, so the room may only recall what **everyone present** may
  read. That is the same intersection, applied to a `memory:recall` capability.
- **This one snapshots, while egress re-computes** — the two halves of decision
  D4. Rendered context cannot be un-sent, so re-filtering it later in the turn
  would be theatre; an unfired tool call can still be refused, so that one
  recomputes per call.
- **A denial is a skip, not an error.** The turn proceeds without prior context,
  exactly as it already does when no retriever is configured, and the reason is
  logged. Dressing a policy decision up as a fault would be misleading.
- **Recall and tool use are separate capabilities.** Being allowed to run a tool
  says nothing about being allowed to read the room's history, and neither
  grants the other.
- Same inertness as the egress guard: with no audience source installed, recall
  behaves exactly as before.

> **Known limitation, stated rather than papered over.** The spec asks for "per
> retrieval, **per recipient**", and this is not that. Two preconditions do not
> exist in the tree yet: context is assembled once per turn into a single prompt
> (there is no per-recipient render for a per-recipient context to go to), and
> recalled items carry scores and scopes but no capability labels (there is
> nothing per item to check). A per-item filter would have to invent a labelling
> scheme, which is policy and not this layer's to invent.

### Added — the audience floor now guards tool egress (#575)

- **The first of the floor's three guards is wired**, at `dispatchTool` — the
  single choke point every tool call passes through. Placed before the dispatch
  deadline so a refused call costs nothing, and before the Privacy Shield
  boundary because the floor decides *whether* an effect happens while Privacy
  Shield decides what a permitted one may carry.
- **Evaluated per call, not per turn.** A turn-start snapshot is a TOCTOU hole:
  somebody can join between the model choosing a tool and the call firing. This
  is also the half of decision D4 that re-evaluates — rendered context cannot be
  un-sent, but an unfired call can still be refused.
- **Inert unless a deployment opts in.** No audience source installed means the
  floor is *not enforced*, which is emphatically not the same as *closed*. A
  closed floor denies everything, so reading "nobody configured this" as
  "closed" would silently disable every tool everywhere. Same shape and same
  reasoning as `turnContext.privacyHandle`.
- **But a provider that throws closes rather than opens** — deliberately the
  opposite of the privacy precedent. Privacy degrading to "unmodified"
  over-shares detail; this degrading to "allowed" performs an effect nobody
  authorized.
- A refusal comes back as a tool result, not an exception, and says that
  retrying will not help — a policy decision should not read as an outage, and
  an unexplained denial just produces a retry loop.

### Added — the audience floor and capability grants (#575, phase 2)

- **The first module in this cluster that decides something.** #333 produces
  Principals and says what they are entitled to; this consumes them and answers
  *"given who is present, what may happen in this room?"*.
- **One intersection function, three guards.** The spec is emphatic that the
  floor is not a single interception point: egress must be checked **per tool
  call** (a turn-start snapshot is a TOCTOU hole), context **per retrieval, per
  recipient**, and file/credential handles **at handle resolution**. So the
  intersection ships as a pure, cheap function the three guards share rather
  than as a hook.
- **Everything fails closed, because the intersection of nothing is
  everything.** An audience that cannot be established permits nothing rather
  than everything, and that trap is live today: `ChatParticipantsProvider`'s own
  contract says "returning an empty array is a valid unknown/unavailable state",
  so an empty roster is `unknown`, never "the room is empty". One participant
  who cannot be resolved to a Principal closes the whole room — bounding only
  the people you could identify is not bounding the room.
- **`closed` and `open`-with-nothing are different answers.** Both permit
  nothing, but the first is an outage and the second is policy. An operator
  looking at a blocked workflow needs to tell them apart.
- **Grants: capabilities union within a principal, intersect across the room.**
  A principal's capabilities are their direct grants plus the grants of every
  role they hold; the room's floor is the intersection of everyone's. The two
  directions live in separate modules because confusing them is a privilege bug
  either way.
- **A partial role lookup never becomes a capability set.** #333 phase 2 made
  "we could not read a role source" distinct from "no roles"; that distinction
  survives into the floor, which closes with a diagnosable reason instead of
  quietly applying a stricter policy nobody chose.
- Capabilities are deliberately **not** roles: intersecting role labels would be
  wrong in a way that looks right, since two people with different roles may
  well share a right.

### Fixed — an approval quorum could complete with too few approvals (#333, phase 3)

- **Conductor's role→holder resolution is now pluggable — and two decisions built
  on it were fail-open.** Holders used to come only from
  `conductor_role_assignments`, so a *partially known* holder list could not
  exist. Sourcing holders from an Entra group or an Odoo HR reporting line makes
  it possible, and it turns out two places treated a shrunken list as the truth:
  - **`quorum='all'` completed with too few approvals.** Every holder still
    visible may have answered while the people an unreachable directory knows
    about were never asked — a four-eyes approval silently becoming two-eyes.
    The pre-existing guard covered only the *empty* list; the partial one looks
    legitimate. It now refuses to complete and lets the deadline fallback run.
  - **A human step could be skipped entirely.** "Role has no holder" triggers
    the step's fallback by design (FR-024), but an empty list from a failed
    lookup is *"we could not ask"*, not *"nobody holds this"*. It now parks the
    await instead, so the real holders still get their chance.
- **The authorization gate is deliberately left alone.** A shrunken list there
  only rejects a genuine holder — it fails closed, which is the safe direction.
- **The local assignment table is registered as an ordinary holder source**
  rather than special-cased, so there is one merge path and the local store gets
  the same throw-becomes-`unavailable` handling as any remote directory. A
  source may not claim the reserved `conductor-local` id — that would substitute
  its own approver list, so it is a boot-time collision.
- With no external source configured the behaviour is unchanged: one source,
  never partial.

### Added — role and attribute sources: what a `Principal` is entitled to (#333, phase 2)

- **A pluggable `RoleSource` registry in the channel SDK.** Phase 1 answered
  *who* a turn's caller is; this answers *what they are entitled to* — the roles
  an Entra group membership or an Odoo HR record confers. It still evaluates no
  permission: the audience floor, grants and per-recipient filtering belong to
  #575, which consumes these facts.
- **Absence is a type, not an empty array.** `rolesFor` returns
  `resolved | unavailable`, and the aggregate carries a `partial` flag. An empty
  role set and "the directory was unreachable" are different facts, and merging
  them is an authorization bug in whichever direction the caller guesses: read as
  "this user has no roles" an outage silently strips every entitlement; read as
  "unknown, so allow" it is a silent full grant. The same reasoning that made
  `ScopeId`'s `unscoped` and `Principal`'s `undefined` types rather than values.
- **The operator gate from `ProviderRegistry` is mirrored, and matters more
  here.** Sources must be catalogued before they can be activated. An auth
  provider decides whether you get in; a role source decides what you *are* once
  inside, so registering one silently is privilege escalation with no login
  event to notice.
- **A throwing source degrades to `unavailable` instead of failing the turn** —
  but it still appears in the per-source breakdown and still sets `partial`, so
  a directory outage is diagnosable rather than invisible. Sources are queried
  concurrently; they are independent network reads on a turn's hot path.
- **A `role:` principal short-circuits without consulting any source.** Asking
  what roles a role has is a category error — a role is an indirection over
  holders — and answering it would invite a source to invent role nesting that
  #575 has not specified.

### Added — `Principal`, the platform's typed answer to "who is this?" (#333, phase 1)

- **A `Principal` type in the channel SDK**, the same home as `ScopeId` and for
  the same reason: the orchestrator, the kernel and `middleware/src` all depend
  on that package and it depends on none of them. Until now only Conductor could
  name a principal, and only as two loose columns (`principal_kind`,
  `principal_ref`) plus a bare-string canonicalizer. `specs/575-scope-and-identity-foundation/spec.md`
  §6 draws the line this implements: **#333 produces Principals, #575 consumes
  them and produces decisions.** Nothing in the new code evaluates a permission.
- **`user` and `role` do not share a canonicalization rule, and now cannot be
  written as if they did.** User ids are trimmed and lowercased, because the SQL
  deciding whether a reminder reaches a person is a case-sensitive `=`. Role keys
  are trimmed only, because `createRole` writes them verbatim — lowercasing them
  would stop matching every mixed-case row already in a deployment's
  `conductor_roles` table. The two variants therefore carry differently-named
  fields (`userId` / `roleKey`), so the difference is visible at each use site
  rather than hidden behind a shared `ref: string`.
- **`parsePrincipal` splits on the first separator only.** Principal references
  legitimately contain colons — `coreApi.resolveIdentity` builds its platform id
  as `` `${kind}:${id}` `` — so `user:teams:29:1a2b` is a real value that a naive
  `split(':')` would truncate into a principal addressing the wrong person. An
  unparseable string yields `undefined`, never a `user`: a role key misread as a
  user id routes an approval to somebody who does not exist.
- **Conductor's `canonicalizePrincipalId` now delegates to that rule** instead of
  keeping its own copy, so the two cannot drift apart and reintroduce the
  case-sensitive miss both exist to prevent.
- **`resolveTurnOwnerIdentity` also returns the turn owner as a `Principal`**,
  widening the `{ omadiaUserId?, authSubjectKey? }` answer #568 shipped. Derived
  from the canonical omadia id only — an IdP subject names an account at a
  *provider*, not a subject in omadia's id space, so a turn with a login but no
  canonical id still has no principal.

### Added — a wiring test for the injective graph-scope key (#575 D3)

- **`OMADIA_INJECTIVE_SCOPE_KEYS` now has a test proving `graphScopeFor` reads
  it.** `scopeGraphKey`'s own tests show the *function* is injective; they say
  nothing about whether the formula both the write and the read side use ever
  consults the flag. A gate that is declared but never read passes every test
  while the fix it guards is unreachable.

### Fixed — the resume/reaper conformance test raced the wall clock

- **`a RESUMED task survives the reaper` could fail for reasons unrelated to
  the behaviour it guards.** It aged a parked task by `sleep(120)`, resumed it,
  and then swept with `staleAfterMs: 60` using the reaper's *default real-time*
  `now`. That left a 60ms budget between `provideInput` returning and the sweep
  running: any stall longer than that — a GC pause, a loaded CI box, the serial
  Postgres job sharing a runner — aged the freshly reset heartbeat past its own
  window, so the reaper failed the task and the test went red while the code
  was correct. Reproduced deterministically by inserting an 80ms stall before
  the sweep.
- The sweep now takes an explicit `now` anchored on the resume's own
  `updatedAt`. `provideInput` writes `updatedAt` and `lastHeartbeatAt` in one
  statement, so that timestamp comes from the same clock that stamped the row —
  the database's for the durable store, the process's for the in-memory one —
  and the comparison no longer depends on how long the test itself takes. With
  the fix the test survives even a 3s injected stall.
- `updatedAt` is the anchor precisely because it stays correct when the
  behaviour regresses: dropping the `lastHeartbeatAt` reset still advances
  `updatedAt`, so the frozen heartbeat lands outside the window and the test
  goes red. Verified by mutation against **both** stores — in-memory and real
  Postgres.

### Fixed — the rest of the test servers now bind the port they dial (#707)

- **The remaining 57 `listen(0)` sites are converted.** #703 fixed the
  mechanism but could only convert the call sites that already waited for
  their `listening` callback. The rest read `server.address().port`
  synchronously on the next line, which stops working the moment a host is
  passed — `listen` then goes through the `dns.lookup` path even for an IP
  literal and no longer binds synchronously. They now go through a
  `listenLoopback()` helper that binds 127.0.0.1 and resolves on `listening`,
  so no test server is left holding a port it never dials.
- **A correction to #703's explanation.** That entry said the wildcard socket
  is `IPV6_V6ONLY`. Measured on macOS, it is not: `[::]` is dual-stack and
  `http://127.0.0.1:<port>` normally reaches it, which is exactly why the bug
  presented as intermittent rather than as a hard failure. The real mechanism
  is that the wildcard bind's port is chosen only against other wildcard
  binds, while a process that binds `127.0.0.1:<port>` **specifically** may
  already hold it — and on BSD/macOS the more specific bind coexists with the
  wildcard and wins for connections to 127.0.0.1. Local dev servers bind
  127.0.0.1 by default, which is why the observed shadowers were an MCP server
  and a Flask app. The fix and its rationale are unchanged; only the
  description of *why* the port was unprotected was wrong.
- `canvas-core`'s WebSocket stub server had the same shape (`port: 0`, no
  host, callers dialling `ws://127.0.0.1:<port>`) and now binds the loopback
  too.
- Removed 23 now-dead `await once('listening')` waits that followed a
  converted site. The helper already resolves after `listening`, so a second
  wait could never fire — it hung 12 files to the 120s test timeout.


### Added — the public MCP endpoint serves MRTR to 2026-07-28 clients (#700)

- **Two SDK generations behind one path, routed by protocol era.** A request
  that negotiates the 2025 `initialize` handshake is served by the v1 wiring
  exactly as before; one carrying the 2026-07-28 envelope is served by
  `@modelcontextprotocol/server@2`. Neither generation can serve the other's
  era, which is why this is a router and not a port: the v1 line never answers
  `server/discover` (so a modern client negotiating against it falls back to
  legacy, where it strips `resultType` and MRTR becomes invisible to it), and
  the v2 line refuses to emit omadia's flat `inputRequests` array at all, on
  either era. Routing is the SDK's own documented composition for this.
- **The documented 2025 contract is untouched.** Same array dialect, same
  `arguments.inputResponses` retry, byte for byte — the existing endpoint suite
  passes unmodified. Modern callers instead get the revision's shape: one
  embedded `elicitation/create` request and an opaque `requestState`.
- **`requestState` is integrity-protected, which the spec requires and the SDK
  does not do for you.** HMAC-SHA256 via the SDK's own codec, over a
  vault-persisted key (so any instance behind the load balancer can verify what
  another minted), bound to the API key and the method, one-hour TTL. A
  modified, expired or borrowed state is refused with the frozen `-32602`.
  Without a vault the endpoint generates a per-process key and warns — still
  signed and still verified, just not across instances.
- **The bounce cap stops being guessable.** On the 2025 dialect it is inferred
  from `inputResponses` appearing in the arguments, so a caller that strips the
  key gets a fresh card forever. On the modern dialect the round counter is
  inside the signed state.
- **A tool cannot tell which era its caller spoke.** The translation lives
  entirely in the endpoint: a tool still asks with the `_pendingInputRequest`
  sentinel and still receives a flat `inputResponses` object.
- **Known gap, stated rather than papered over:** the revision's elicitation
  schema has no masked-input concept (`email`, `date`, `uri`, `date-time` are
  the only string formats), so a field the tool marked `secret` is named in the
  prose instead of flagged in the schema. Emitting a `password` format anyway
  would produce a request a conforming client rejects.
### Fixed — test servers bound a port they never dialled (CI flake)

- **Intermittent 401/404 in the middleware test suite.** A test would fail with
  a `401 devplatform.unauthorized` on a request that carried perfectly valid
  session headers, or a `404` on a repo it had just registered — and pass on
  the next run. The cause was neither the routes nor the fakes: the harnesses
  bound their server with `app.listen(0)`, which binds the **IPv6** wildcard
  `[::]`. On macOS/BSD that socket is `IPV6_V6ONLY`, so the kernel reserved the
  port in the IPv6 ephemeral space only — while every harness handed out
  `http://127.0.0.1:<port>`, an **IPv4** URL. The two spaces are independent,
  so the port the test dialled was never reserved at all, and any unrelated
  process holding that IPv4 port received the request and answered it. Observed
  foreign responders on a developer machine included a local MCP server
  (`401 … provide valid authorization token`) and a Flask dev server
  (`404 Not Found`); a non-HTTP peer surfaced instead as
  `HTTPParserError: Response does not match the HTTP/1.1 protocol`.
- Every test listener that already waits for its `listening` callback now binds
  `127.0.0.1` explicitly (both dev-platform harnesses, 36 call sites in all,
  plus the updater sidecar's server test), so the reserved port and the dialled
  port are the same port and the OS guarantees exclusivity — a colliding bind is
  refused with `EADDRINUSE` instead of silently shadowing the harness. A
  `harness socket binding` suite in each affected route test guards the
  property so the old shape cannot come back.
- Note for follow-up work: passing a host makes `listen()` bind
  **asynchronously**, so the remaining 55 `app.listen(0)` sites that read
  `server.address().port` synchronously on the next line cannot be converted by
  adding the host alone — they each need to await `listening` first. They are
  still exposed to this failure mode.

### Fixed — the Fly updater asked for a wait longer than Fly allows (#696)

- **`/wait?timeout=120` is rejected outright.** Fly caps the machine-wait at
  60s and answers anything larger with
  `400 invalid WaitMachineRequest.Timeout: value must be inside range
  [1s, 1m0s]` — asking for more does not buy a longer wait, it buys no wait at
  all. `waitForState`'s 120s default therefore failed every update on the step
  right after the image was written. Found on a real deployment, once the
  lease-nonce fix let the update get that far. The request is now capped at the
  API maximum and re-issued until the caller's own budget is spent, and the
  machine's state is re-read and checked explicitly instead of trusting the
  long-poll's timeout semantics — a `/wait` that errors is not the oracle.
- **A "rolled back" job now really rolls back.** `replace()` can fail *past the
  point of mutation*: on Fly the machine is already carrying the new image when
  the wait step throws. The bookkeeping entry was written only after `replace()`
  returned, so that case left `replaced` empty, rollback restored nothing, and
  the operator was told the update had been rolled back while the service ran
  the new build — exactly what happened in production. The entry is now recorded
  before the call; restoring an image the service never left is a no-op, so
  pessimistic bookkeeping is safe in the other direction.

### Fixed — the Fly updater was blocked by its own lease (#696)

- **Applying an update on Fly always failed and rolled back.** `replace()`
  leases the Machine, and Fly gates every write to a leased Machine behind the
  `fly-machine-lease-nonce` header — which was sent nowhere. `updateMachine`
  declared `leaseNonce` in its signature but never read it, the engine never
  passed it, and the HTTP helper had no way to carry a header at all. Every
  real update therefore came back
  `409 aborted: … lease currently held by …@tokens.fly.io` and rolled back,
  seconds after taking that lease itself. Threaded end to end now: per-call
  headers on the client, the nonce on the update, the lease from the engine.
- **The lease is handed back in a `finally`.** It was acquired and abandoned,
  so it kept blocking writes for the rest of its 300s TTL — which also meant
  the rollback after a failed update hit the same 409, and the machine stayed
  locked against a human `fly deploy` for minutes.
- **The test fake now enforces the lease.** It returned a nonce and ignored it
  on writes, so it could not produce Fly's 409 and 263 lines of green tests
  said the path worked. It now rejects an unnonced write and validates the
  nonce on release. New wire-level `flyApi.test.mjs` asserts against the bytes
  an HTTP server actually receives, because a fake can only ever prove the
  engine *passes* a value, never that the client *sends* it.

### Added — one-click updates on Fly.io (#696, follow-up to #432)

- **A Fly executor for the rolling self-update.** Fly Machines are Firecracker
  microVMs with no Docker daemon, so the compose executor could never run
  there. The updater now has an **engine seam**: `updateJob.mjs` keeps
  everything platform-independent — the ordering that makes a failure safe, the
  health gate on the *reported* version, rollback, the protected list — and an
  engine supplies only the four things that differ. The Fly engine drives the
  Machines API. **The middleware needed no changes** beyond passing two new
  status fields through, which is the seam working as intended.
- **Deployed as its own tiny app**, opt-in via `OMADIA_WITH_UPDATER=1
  ./fly/deploy.sh`. It has no public address (6PN only), and holds one
  **app-scoped** deploy token per managed app — a narrower capability than the
  compose design, where a mounted Docker socket is host-root-equivalent and
  all-or-nothing. It also has to be a separate app: `/data` is a Fly volume and
  a volume attaches to exactly one machine, so the middleware is structurally
  single-machine there and cannot health-gate its own replacement.
- **The "pull before you stop anything" property is preserved** without a pull
  step: Fly fetches the image itself, so the engine checks the registry
  manifest up front. A missing tag now aborts before any machine is told to
  move, and an unreachable registry is reported as such rather than as a
  missing tag.
- **Named the limit instead of hiding it:** the Fly engine reports
  `pinPersisted: false`, and Admin → Update says so next to the button. On
  compose the updater writes `OMADIA_VERSION` into the project `.env`; on Fly
  nothing can, because `fly deploy` reads the operator's local `fly.toml`.
### Changed — Admin → Update names the operator's actual Fly apps (#432)

- **The manual update command is no longer a template.** On Fly the middleware
  reads `FLY_APP_NAME` / `FLY_MACHINE_ID` (set inside every Machine) and reports
  them through `GET /api/v1/admin/update/status`; the admin page's server shell
  contributes the web-ui app's own name. The notify-only box therefore prints
  `fly deploy --app omadia-middleware-<yours> …` instead of
  `--app <middleware-app>`, for both apps, middleware first.
- Detection is **positive-only**: anything not demonstrably Fly reports
  `unknown` and keeps the generic placeholders. A wrong app name in a
  copy-pasteable command is worse than an obviously incomplete one.
- **Named the `--image` pin caveat**, in the UI and in `docs/upgrading.md`:
  `--image` applies to one deploy, so a later plain `fly deploy` silently puts
  the app back on the tag in `fly.toml`. This is the Fly counterpart to the
  compose `.env` pin — except nothing server-side can write it, so the operator
  has to. Also corrected the docs' implication that Fly rolls back on its own;
  neither `fly deploy` nor the Machines API does.
### Added — MRTR reads the declared 2026-07-28 contract, not an SDK internal (#562, phase 3)

- **`callTool` now passes `allowInputRequired: true`.** On a modern-era
  connection that is what makes the SDK hand an `input_required` result back
  with `resultType`, `inputRequests` and `requestState` present verbatim,
  instead of fulfilling it in-process or raising a typed error. Until now MRTR
  read those fields only because SDK 1.30's `ResultSchema` happens to be a
  `.passthrough()` — a dependency `mcpClient.ts` already documented as one it
  did not want.
- **The elicitation capability is declared** — measured prerequisite, not
  boilerplate: without it the SDK refuses an embedded `elicitation/create`
  request with `MissingRequiredClientCapabilityError` *before* the result
  reaches omadia, so every modern-era MRTR call would fail instead of parking.
  A decline handler backs the declaration, because omadia genuinely does not
  answer elicitation in-process — it asks a human over a channel.
- **The parser learned the spec's dialect.** A 2026-07-28 peer sends
  `inputRequests` as a MAP of whole elicitation requests, not omadia's flat
  array; each request's `requestedSchema` properties become card fields, with
  `required` honoured literally and `format: 'password'` / `writeOnly` marking a
  field masked. The array dialect is untouched — the *shape* decides, so both
  eras work on the same code path. `sampling/createMessage` and `roots/list`
  are reported as `unsupported_request_method` rather than silently dropped: a
  card missing one of several embedded requests could never satisfy the retry.
- **`requestState` is adopted instead of running a second park handle.** The
  server's opaque state rides the parked record and is echoed back byte-exact on
  the retry, alongside spec-shaped `inputResponses` keyed by the server's own
  request ids. The tool's `arguments` stay unchanged across the park — on the
  modern dialect the answers ride the params, not the arguments.
- **The park-and-ask form survives, which was the explicit risk.** Auto-fulfil
  stays off, and the bounce cap now reads an explicit replay marker: on the spec
  dialect there is nothing left in `arguments` for it to recognise, so without
  that a server asking forever would bounce forever.
- Coverage is **per era, and each file pins its own era** so neither can quietly
  stop being exercised: `mcpPendingInput.test.ts` (2025) and the new
  `mcpModernMrtr.test.ts` (2026-07-28, against a real v2 server, asserting on
  the wire bodies because v2's server decode consumes the retry params before a
  raw handler sees them).

### Changed — the MCP **client** speaks `@modelcontextprotocol/client@2` over `http` (#562, phase 2)

- **Only `http` moved.** `McpManager` now connects streamable-HTTP servers with
  the v2 `Client` + `StreamableHTTPClientTransport` and
  `versionNegotiation: { mode: 'auto' }`, so a 2026-07-28 peer is negotiated as
  such and a 2025-era peer still falls back to the plain `initialize` handshake.
  Deliberately **not** a pin: a pin has no fallback and most third-party servers
  are 2025-era, so pinning would break exactly the peers that work today.
- **`stdio` and `sse` stay on v1**, from measurement rather than convenience:
  `McpServer` never answers `server/discover` off the HTTP edge, so an `'auto'`
  probe there can only fall back and a pin fails with `ERA_NEGOTIATION_FAILED`.
  Porting them would swap the API and buy no protocol capability.
- **MRTR on 2025-era peers keeps working — this is the part the port could have
  broken in silence.** v2 treats `resultType` as a wire-only discriminator and
  strips it when it decodes a legacy `tools/call` reply as a complete result,
  while leaving `inputRequests` in place. Unrepaired, `isInputRequiredResult`
  goes false, the call is never parked, the human is never asked, and the model
  is handed the server's holding text as if it were the answer — with nothing
  red anywhere. `restoreLegacyInputRequired` puts the discriminator back on
  legacy-era connections only (on a modern one `resultType` arrives verbatim and
  inventing one would mask a real divergence). Removing it turns eleven tests in
  `mcpPendingInput.test.ts` red.
- **Two v2 behaviours are switched off on purpose.** Auto-fulfilment of
  `input_required` (`inputRequired: { autoFulfill: false }`) — omadia parks the
  call and asks a *human* over a channel, possibly hours later, and letting the
  driver answer in-process would mean the human silently stops being asked. And
  client-side output-schema validation, by fetching `tools/list` with
  `cacheMode: 'bypass'` — it would turn a server whose `structuredContent` does
  not match its declared `outputSchema` into a hard call failure on `http` only,
  and its validator is reachable only through an `ajv` that neither
  `@modelcontextprotocol/client` nor `/core` declares as a dependency.
- Coverage runs on **both eras**: the existing live round-trip suite plus a new
  modern-era assertion against the phase-1 loopback server, and a hand-rolled
  2025-era peer that refuses `server/discover`.

### Changed — the loopback MCP server runs on the `@modelcontextprotocol/*@2` family (#562, phase 1)

- **`createMcpHandler` replaces a hand-rolled per-request dance.** The loopback
  server built a fresh `Server` + stateless `StreamableHTTPServerTransport` for
  every request and tore both down in a `finally`, purely because v1 throws
  `'Stateless transport cannot be reused across requests'` on a transport's
  second use. v2 offers that per-request-instance model as the serving entry
  itself, so the workaround and its teardown block are deleted rather than
  ported. `toNodeHandler` bridges the handler's web-standard `fetch` to the
  Node `(req, res)` this server speaks.
- **No wire change.** Statelessness, the POST-only `405` on the standalone SSE
  stream, the `413` body cap, bearer auth, and name-sorted `tools/list` all
  behave exactly as before — the existing suite passes unmodified, and the
  omadia MCP *client* (still on v1) talks to the ported server unchanged, which
  is the cross-era interop check.
- **Scope is deliberately one surface.** The public MCP endpoint is NOT ported
  in this phase: it serves MRTR (`resultType: "input_required"`, #544/#570), and
  v2 offers no mode that reproduces that wire shape on a 2025-era connection —
  its legacy shim converts the return into server→client `elicitation/create`
  requests, and disabling the shim makes the same return fail loudly. Tracked on
  #562.

### Fixed — skill import no longer drops frontmatter silently

- **`parseSkillMarkdown` reports what it cannot read.** omadia's SKILL.md
  frontmatter is a flat one-line `key: scalar` format. Lines carrying lists or
  nested mappings — routine in skills authored for other ecosystems — were
  skipped with a bare `continue`, so an import reported success while the skill
  landed with data missing. The parser now returns those lines, and the import
  preview shows them as a warning before the user confirms.
- **A key whose block could not be parsed is no longer stored as an empty
  string.** `allowed-tools:` followed by list entries used to persist
  `allowed-tools: ""` — a value the source file never contained, which then
  travelled into the skill content hash and the risk scan. Such a key is now
  reported together with its block instead of being invented, which also keeps
  two identical dropped entries distinguishable by their owning key.
- No YAML support was added; the parser stays deliberately flat. The response of
  `POST /v1/operator/skills/import` gains an `unparsedFrontmatter: string[]`
  field (additive; the web-ui treats it as optional so an older middleware still
  type-checks). `loadSkill()` for plugin-borne on-disk skills is unchanged.

### Added — the updater sidecar is published, and the manual path is per-platform (#432)

- **`ghcr.io/byte5ai/omadia-updater`** is now built and pushed by
  `publish-images.yml` on the same tags as the middleware it updates, so
  `docker-compose.update.yaml` pulls it with the same `${OMADIA_VERSION}` as
  everything else instead of requiring a source build. Deliberately not added to
  `docker-compose.build.yaml`: a service defined there would start an updater on
  stacks that never opted into one.
- **Admin → Update labels its manual commands per platform.** The executor is
  compose-only, so Fly.io and Kubernetes deployments land in notify-only mode —
  where an unlabelled `docker compose up -d` line was actively misleading. The
  page now shows the compose *and* the `fly deploy --image` form, and points at
  `docs/upgrading.md` for anything else.
- **`docs/upgrading.md` gained a Fly.io section**: what Admin → Update can and
  cannot do there, the middleware-before-web-ui redeploy order, the `/health`
  version check between the two, rollback via `fly releases`, and the reminder
  not to redeploy the Postgres app during a version bump.

### Added — product documentation for the AI marking (#649, epic #642)

- **New `docs/ai-act-transparency.md`** — what omadia actually marks and, just as
  explicitly, what it does not. Every statement carries the code site it comes
  from; the binding rule for the document is that a claim without one does not
  go in. A promise phrased too widely on a public page is worse than a named gap.
- **DE and EN copy blocks** for the product section of `omadia.ai/ai-transparency`,
  written along what the code actually does. Finished here, **not live**: the
  section goes through internal approval before publication.
- **Corrected `docs/architecture.md`**, which claimed the full trace "is stored as
  the run's audit receipt". That collides with the #684 decision, so it now states
  best-effort telemetry and names the three ways a turn can leave no trace.
- **`docs/middleware-agent-handoff.md`**: the outgoing-contract extension in §11
  (stream protocol), the five `ai_disclosure_*` setup fields in §10, and the open
  provenance items in §13. The issue pointed at §3/§8 for the contract half; §8 is
  "Skills" on current main, and the contract actually belongs next to the stream
  protocol, so it went there.
- **Limits named rather than omitted**: the coarser `.xlsx` coverage, connectors
  being plugins whose rendering the core cannot force, two provenance vocabularies
  in one epic, per-channel overrides that only fire on teams/slack/telegram, and
  C2PA — which appears nowhere in the tree and is therefore an open point, not a
  capability.
### Fixed — the structural i18n categories left by #601 (#679)

- **I4 — page titles now follow the active locale.** All **10** remaining
  `export const metadata` exports became `generateMetadata`, so the window /
  tab title is German for a German operator instead of always English. A static
  `metadata` object is evaluated once at build time, where no request and
  therefore no locale exists. The category is now at **zero** and pinned
  repo-wide by a test.
- **I5 — the boot-seeded agent description.** Decided rather than translated:
  the sentence is written by the server into the database at first boot, before
  any locale exists to write it in, so it is a record of why the row exists,
  not UI copy. Localising it at write time would freeze whichever locale the
  boot happened to pick into persisted data; dropping it would leave consumers
  without a catalogue (API, exports, CLI) saying nothing at all. The UI now
  renders its own catalogued sentence, recognising the untouched seed by exact
  match — the moment an operator edits it, their words are shown verbatim.
- **I6 — currency and number formatting.** `admin/usage` rendered cost with a
  hardcoded `$` and `toFixed`, and — not mentioned in the issue — pinned
  `de-DE` for compact counts and timestamps, so an *English* operator read
  German grouping. All now go through next-intl's `useFormatter()`. The
  currency stays USD deliberately: the ledger records USD, and converting
  without an exchange rate would present a fabricated number as a ledger
  figure. What is localised is the presentation.
- **I3 — hardcoded literals**, scoped and measured. `app/graph/ListView.tsx`
  held three GERMAN sentences (the rule broken twice over — hardcoded, and in
  the language that belongs only in `de.json`); `admin/kg-lifecycle`, the
  issue's named worst offender, is fully swept. API enum values (`HOT`/`WARM`/
  `COLD`, `memory`/`process`/`task`) stay untranslated on purpose so the screen
  still matches logs and SQL.
- **The issue's I3 count did not survive measurement**: it claims 25 literals
  across 11 files with 11 in `kg-lifecycle`; that file alone holds **22**, and
  the scan under-counts multi-line JSX text on top. The remaining tail
  (~217 candidates / 63 files, plus 18 files still calling `toLocaleString`) is
  filed as its own issue rather than silently declared done.
### Added — the AI-marking posture is readable per channel (#648, epic #642)

- **`GET /health` gains a `disclosure` block**: the resolved AI-Act Art. 50
  marking level per channel, whether it came from the shipping default or the
  operator, and whether it deviates from the delivered state. Builds on the
  post-#665 shape (`{ status, kg }` → `{ status, kg, disclosure }`) rather than
  the older registry-projector form.
- **Boot warning on deviation only.** A delivered-state instance logs nothing —
  a line that fires on every default install is one nobody reads.
- **Operator channels dashboard** shows an informing hint when the instance
  deviates, DE/EN through the message catalogue. In the delivered state the
  surface is unchanged and completely quiet.
- **Why**: the operator may grade the marking down per channel or switch it off
  — omadia is self-hosted, that is their decision. The problem was that the
  decision was visible nowhere, so a copied config or a leftover from a test
  setup was never noticed. The hint describes the state and blocks nothing.
- **One derivation, not two.** `resolveDisclosureLevelForChannel` is now the
  single place the override → global → shipped precedence lives;
  `Orchestrator.resolveTurnDisclosure` calls it per turn and the posture view
  calls it per channel. A second copy of those rules would let the reported
  posture disagree with what turns actually do, silently — the exact failure
  this feature exists to prevent.
- **An override that cannot fire says so.** Only `teams` / `slack` / `telegram`
  currently carry a `channelKind` into a turn, so a configured `web=off` never
  takes effect. Both `/health` and the dashboard report that instead of letting
  the operator conclude their override is in force.
- **Nothing that permits conclusions about content or users leaves the process**:
  levels, sources and booleans only. The assistant name and the free-form
  operator note are reported as *configured* / *not configured*, never by value
  — asserted against the serialised payload, not left to review.
### Changed — the run trace is best-effort telemetry, and its gaps are now countable (#684, epic #642)

- **Decision recorded, not behaviour changed.** #650 added `model` / `provider`
  to the persisted trace and deliberately left the harder question open: is the
  record guaranteed? It is not, and #684 settled that it should not be promised
  to be. A missing trace now means "not recorded" — never "no such turn".
- **Why telemetry and not a provenance record.** The graph sink is optional by
  construction (`SessionLogger` guards every ingest behind `if (this.graph)`);
  the Markdown transcript is the surface that is actually guaranteed, and the
  logger already refuses graph ingest when the transcript write fails so the two
  can never disagree. Promoting the trace to a record would require
  auto-creating User-Cluster nodes — which both backends refuse on purpose,
  because orphan clusters with no `IS_IDENTITY_OF` edges would hide exactly the
  channel-resolution bugs the refusal exists to surface. That trades a visible
  gap for an invisible data-integrity defect.
- **Named where a reader looks**: `RunTrace` and `KnowledgeGraph.ingestRun` now
  state the contract in their own doc comments, so nobody builds a compliance
  answer on a best-effort store by inference.
- **Every drop is now observable** (`runTraceObservability.ts`): one greppable
  `console.warn` naming the reason, plus per-outcome tallies on
  `SessionLogger.runTraceStats`. The issue described the drops as silent; three
  of the four paths already logged. The genuinely invisible one was **no graph
  sink configured**, which returned with no signal at all — a deployment that
  had never recorded a single trace looked identical to a healthy one.
- **`warn`, not `error`**: the turn succeeded. Logging at error level would flag
  every single turn in a deployment that simply runs without a knowledge graph.
- A turn that carried no trace is not counted as a drop — counting it would make
  the drop total meaningless.

### Added — the persisted run trace records which model answered (#650, epic #642)

- **`RunTrace` / `RunTracePayload`** gain optional `model` and `provider`. The
  trace recorded how long a turn ran, which sub-agents ran and which tools were
  called, but not the one fact a provenance question about a past turn starts
  from. The model id already existed on the `done` event and in the cost
  telemetry; it just never reached the persisted record.
- **Stamped once per turn**, right after model routing resolves
  (`RunTraceCollector.recordModel`), on both the buffered and streaming paths —
  not threaded through `finish()`'s five call sites, where missing one would
  leave the field absent on a single exit path and looking recorded elsewhere.
- **Both knowledge-graph backends** write it, so the answer to "which model
  wrote this?" does not depend on which store a deployment runs.
- **No schema migration, and none was needed.** The issue's acceptance criteria
  asked for one; that premise does not hold for this table.
  `graph_nodes.properties` is a generic `JSONB` column (`0001_graph_init.sql`)
  and `RunPropsSchema` is `.passthrough()`, so adding a property is a
  schema-level change only. The fields are declared optional in the Zod schema
  anyway — passthrough means "tolerated", and a provenance field that is merely
  tolerated is one nothing validates and nothing documents. Run nodes written
  before this change stay valid and readable, which is what a migration would
  have existed to guarantee.
- Absent rather than empty when unknown: a trace carrying `model: ''` claims to
  know and does not.

### Added — admin UI for the public API keys (#567)

- **Admin UI** (`web-ui/app/admin/api-keys/`): create/list/revoke against
  `/api/public/v1/admin/keys`, which shipped in #438/#439 with no page at all —
  keys could only be minted with `curl`. Each row shows the key's
  `ApiKeyRecord.id` verbatim with a one-click copy, which is the point of the
  issue: a public MCP key-binding (#550) is keyed on that id, so an operator
  previously had to read it out of the API by hand.
- A created key's plaintext token is shown exactly once, right after creation,
  and creation is blocked while that one-time reveal is still on screen — the
  create button and every form field stay disabled until the operator
  explicitly dismisses it, so a second key can never silently overwrite the
  first one's only-ever-shown token before it is copied. Revoking is a
  two-step confirm-then-revoke per row with independent busy/confirm state per
  key, and the list reload is guarded against out-of-order responses so a
  slower in-flight fetch cannot stomp a newer one's result. Known backend
  codes (`not_found`, `operator_auth.unavailable`,
  `auth.missing`/`auth.invalid`, `invalid_request`) map to translated messages
  rather than surfacing the raw response body.

### Added — errors on the LLM-access and credential screens now explain themselves (#604)

- The providers panel used to render the middleware's English rejection
  sentence verbatim in every locale, and the plugin credential editor rendered
  `runtime.vault_unavailable: vault not wired into runtime route` — an internal
  identifier next to an English sentence. Neither told the operator what to do
  next, which is what the customer report was about.
- `ApiError` now parses the machine code out of the JSON error body once
  (`ApiError.code`), and a localized catalogue (`errorHelp.<code>.{what,next}`
  in `messages/en.json` + `de.json`) turns it into two sentences: what
  happened, and the one action that fixes it. The server's own text survives
  only inside a collapsed "details for support" disclosure, redacted through
  `supportDetail()`.
- A rejected provider key now carries a machine-readable code end to end:
  `ProviderVerification.code` and a new optional `verifyErrorCode` on the
  admin-providers DTO. Both are additive — `verifyError` keeps its value and
  meaning, so an older web-ui against a new middleware, and a new web-ui
  against an older middleware, both keep working.
- Scope is bounded and guarded. The catalogue covers the 56 codes emitted by
  `middleware/src/routes/{install,runtime,adminProviders,store,adminSettings}.ts`
  plus `providers.key_rejected`. That count includes the ten `install.*` codes
  that never appear as a literal in a route file at all: `install.ts`'s
  `handleError` re-emits them from an `InstallError` thrown in
  `plugins/installService.ts`, and `errorHelpCoverage.test.ts` follows that
  forwarder rather than assume the file only writes literals. The guard fails
  when a covered file emits a code with no copy in any locale, when copy exists
  with no emitter, and when a covered file writes a `code:` the extractor
  cannot read — an unregistered forwarding shape is a failure, not a silent
  gap. NOT covered: the other middleware route families, shipped
  troubleshooting pages, and any LLM-backed help assistant — the issue's own
  corrected scope rules the last one out.
- `web-ui/messages/README.md` documents the `errorHelp.<code>.{what,next}` key
  convention, the optional `action` label, how to add a code, and why adding a
  `code:` literal to one of the five covered route files turns the web-ui suite
  red until the copy exists in both locales.
- The providers panel's very first request is on that path too. A failed
  `GET /v1/admin/providers` used to render the client-assembled
  `GET /v1/admin/providers failed: 500` as the entire message, in every locale;
  it now resolves `providers.read_failed` through the catalogue, keeps the
  request line for the support disclosure, and falls back to a localized "the
  provider list could not be loaded" when the server sends no code.
- `PATCH /v1/admin/settings` now answers a fully-rejected batch with two codes
  instead of one, because the operator's next step differs:
  `settings.invalid_values` when the server refused the values (correct the
  value the details flag) and `settings.no_valid_changes` when no submitted key
  is a setting it currently offers (reload — the page's field list is stale).
  With one code, saving a malformed `ANTHROPIC_API_KEY` was reported as an
  unknown setting and the operator was told to reload, which cannot fix it.

### Added — AI-assistant install path via a public skill file (#338)

- New `docs/onboarding/SKILL.md`: a public, copy-paste onboarding path for
  non-technical evaluators. Pasting a short prompt into the Claude or Codex
  desktop app points the assistant at the skill file, which installs the native
  omadia desktop app and opens the onboarding wizard — no Docker, no build tools.
  The skill is idempotent (re-running only relaunches an existing install) and
  resolves each release asset by its API `browser_download_url`, so it survives
  the independently-pinned desktop version. It scans recent releases for the
  newest one that actually carries a build for the user's OS, rather than assuming
  `releases/latest` is complete — a release whose macOS/Windows build failed can
  ship Linux-only.
- `README.md` gains a copy-paste setup prompt next to the Quickstart, including
  the key-free note for Claude Pro/Max subscriptions (#309).

### Changed — MCP connection lifetime is now explicit (#563)

- The MCP pool kept its state in two parallel maps keyed by server id **plus** a
  hash of the caller's bearer token. Since a stdio child process never sees that
  token, N callers with N tokens spawned N identical child processes for the
  same server. Pool keys now carry exactly what the transport consumes: stdio is
  keyed by server id alone, http/sse by server id + token.
- Pooled connections are dropped when a server is deleted
  (`DELETE /mcp-servers/:id`), when its config is saved
  (`PUT /mcp-servers/:id/config`) and when its token is revoked
  (`DELETE /mcp-servers/:id/token`) — previously the live connection kept
  running with the old command, env, headers and token — and on SIGTERM/SIGINT,
  which no longer leaves MCP stdio children behind.
- Connections idle longer than `McpManagerOptions.idleTtlMs` (default 5 minutes)
  are evicted on the next connect attempt, which bounds a pool that previously
  grew by one entry — and, for stdio, one process — per OAuth token rotation.
- **Behaviour change for out-of-repo callers:** `McpManager.close(serverId)` now
  closes every token-scoped connection of that server instead of a single exact
  pool key. Passing a full pool key still matches only itself, and a server id
  never matches a different server whose id shares its prefix.
- Rationale and rejected alternatives: `docs/adr/0008-mcp-connection-lifetime.md`.
### Added — MCP structured output is accounted in the privacy receipt (#547 / #569)

- External MCP tools that return `structuredContent` now surface in the turn's
  Privacy Shield receipt, as a neutral "structured output received" section
  (tool name, server name, byte count, and whether the tool declared an
  `outputSchema`). This closes the #569 gap: the structured-content sidecar
  fires inside `McpManager.callTool`, beneath every dispatcher, so structured
  content previously appeared in **no** receipt or dataset accounting at all —
  an operator auditing what a turn touched could not see it. Scope note: like
  every receipt line, this appears only when a `privacy.redact@1` provider is
  active; with no Privacy Shield installed there is no receipt and the sink
  no-ops (it produces no receipt entry and nothing observable — the one change
  in that case is that the previously-inert structured sidecar now has a wired
  consumer at all).
- **Accounting, not masking.** Privacy Shield's data-plane boundary is server ↔
  LLM provider, not server ↔ browser. The structured payload is emitted
  out-of-band and never crosses the model wire (the model still sees only the
  interned digest of the tool's text result), so nothing is masked — the browser
  is the trusted side. The receipt entry is PII-free by construction: counts and
  names only, never the structured value. A regression test pins that the
  accounting metadata carries none of the raw values the sidecar legitimately
  still holds, over a real MCP socket.
- New optional `PrivacyGuardService.recordStructuredPayload` on the published
  `@omadia/plugin-api` surface, mirroring `recordBypassedTool`; the boot-wired
  `McpManager.structuredSink` is its first consumer. Fail-closed: an accounting
  failure never breaks a tool call, and a payload with no turn identity is
  skipped rather than mis-filed.
- Deliberately **not** included: a renderer that draws a canvas card from the
  structured payload. That is #547's remaining half, unblocked by this
  accounting decision — the decision #569 asked for *before* anything renders
  from the sidecar.

### Fixed — a mistyped id no longer produces a dead-but-configured-looking public MCP binding

- `public_mcp_key_bindings.key_id` and `agent_id` are not foreign keys — the key
  records live in the secret vault and the agents in the in-process registry, not
  in Postgres (`migrations/0033`) — and nothing in the application layer compensated.
  A one-character typo in either id got `201 Created`, a row in the list, and a
  fully-configured-**looking** binding that reached zero tools forever, visually
  indistinguishable from a working one.
- The operator write path now resolves both ids against the same sources a real
  request does. A `agent_id` the registry does not know is a **hard `400`
  (`agent_not_found`)** with no row written — the registry is cheap and
  authoritative in-process. A `key_id` that matches no vault record is a
  **warning, not a rejection** (the honest interim until the key-lister UI from
  #438/#439 ships): the row still saves, but the write response and every list
  row carry a `key_id_unknown` warning so the operator sees it reaches nothing.
- The list endpoint annotates **pre-existing** rows too, so a binding that was
  already dead — created before this shipped, or bound to an agent later deleted —
  is flagged the next time the pane is opened, not only on save. The MCP Control
  Center's Public API keys tab renders these warnings inline.
- Fail-honest, never fail-red: when a source cannot be read (no registry wired, a
  vault that failed to load) the check returns "cannot tell" and neither rejects
  the agent nor invents a warning, so a transient read failure never paints a
  working install as broken.

### Fixed — `per_user` MCP delegation was unreachable from chat

- Migration `0031` made delegation explicit per MCP server and gave new servers a
  fail-closed `per_user` default. `resolveMcpUserKey` reads
  `turnContext.current()?.mcpUserKey` — but **the only thing that ever set it was
  the operator discover route.** `routes/chat.ts` did not so much as import
  `turnContext`. Every newly created `per_user` server was therefore dead from
  chat out of the box: no token sent, the audit row recording the literal
  `unresolved`, and the turn failing closed. Existing installs were masked only
  because `0031` backfills token-holding servers to `service`.
- Both HTTP chat entries now open a turn scope carrying `mcpUserKey`. The
  streaming entry uses `turnContext.runGenerator`, not `enter`: `enterWith` binds
  to the async resource executing at that instant, and an async generator resumes
  in the caller's context, so the identity would be gone by the orchestrator's
  first yield — before any tool, and therefore before any MCP call, runs.
- The value is `sessionIdentity(req)` (`session.sub || session.email`), extracted
  from `routes/agentBuilder.ts` into `src/auth/sessionIdentity.ts`. Deliberately
  **not** `resolveUserId(req)`, which falls through to the client-sent
  `x-user-id` header — keying MCP tokens on a client-controlled header would let
  any caller act as any user. When nothing resolves, `mcpUserKey` stays unset and
  a `per_user` server fails closed exactly as intended; there is no fallback.
- Channel turns set `mcpUserKey` inside the orchestrator from the already-resolved
  `resolvedOmadiaUserId`, gated on `channelIdentity` — which only the dispatcher
  mints, from the adapter's authenticated `userRef`, so it is server-attested end
  to end. ⚠️ **Known limit:** channel turns key on the canonical omadia uuid while
  `/authorize` stores tokens under the session-shaped key, so an affected user
  still fails closed rather than reaching their server. Closing that needs a new
  method on the `KnowledgeGraph` contract. Narrower than it sounds: a `per_user`
  token can only exist for someone who completed `/authorize`, which requires a
  session, so a channel-only user has no token and failing closed is correct.

### Fixed — migration `0031` built neither of its guards reliably

- The CHECK guard looked up `pg_constraint` by `conname` alone. `conname` is
  unique per `(connamespace, conrelid)`, not cluster-wide, so a same-named
  constraint in **any** other schema made the guard true and the `ALTER TABLE` was
  silently skipped — the migration did not build the constraint it claims to. Now
  anchored on `conrelid = 'mcp_servers'::regclass`.
- The backfill guard hardcoded `to_regclass('public.mcp_oauth_tokens')` in a file
  that is otherwise entirely unqualified, so wherever the domain is applied outside
  `public` it answered about a table the statement never touches. Demonstrated on a
  database with an empty `public`: the old guard left an operator-token server on
  `per_user`, losing its grandfathering and breaking it fail-closed.
- The backfill test previously **rewrote** the migration to make it apply; it now
  applies verbatim, with a guard that fails if a schema-qualified reference is ever
  reintroduced, plus the assertion the suite had dropped as a known flake.

### Fixed — the middleware suite had no per-test timeout

- `--test-timeout=120000`. Previously unset, so Node's default of `Infinity`
  applied and a hung test burned the CI job's 15-minute wall with no attribution.
  Note the ceiling is **per file**, not per leaf — a file whose total exceeds it is
  killed as a unit — so the value is sized on the slowest file (18.4 s), not the
  slowest test (7.8 s). `web-ui` needs no change; vitest already bounds at 5 s.

### Added — operator surface for public MCP key bindings

- The public MCP endpoint's authorization is driven entirely by rows in
  `public_mcp_key_bindings`, and there was **no way to create one** except
  hand-written SQL — the endpoint was inert as shipped. A Public API keys tab in
  the MCP Control Center now lists, creates and revokes bindings.
- The public endpoint's dependency bag is unchanged and still receives the
  read-only store: it gains no write path to its own authorization table. The
  admin path validates through the same `normalizeBindingRow` the enforcement path
  uses, so the two cannot drift. Revoke parks the row rather than deleting it.
- **Revoke is sticky.** A cross-vendor review found that saving a binding
  re-enabled it: an omitted `enabled` was defaulted to `true` and written over the
  stored value, so any later save — a stale browser tab, a second operator, a
  config replay, or this pane's own form, which does not round-trip the field —
  silently handed a revoked key its whole allowlist back. An absent `enabled` now
  preserves the stored flag (a genuinely new row still starts enabled), and
  un-parking is an explicit act: `POST /:keyId/restore`, or an explicit
  `enabled: true` on the upsert. The pane grew a confirmed **Restore access**
  button so the stricter server does not strand an operator in psql.
- `POST /` answers **200** for a row it replaced and keeps 201 for one it created
  — "Created" is the operator's only per-request signal that they landed on a
  binding somebody else had already configured, or parked.
- `writeRateLimitPerMinute` and `enabled` are type-checked rather than coerced. A
  JSON `null` reached `Number(null)` → `0`, a valid write budget, so a client
  sending `null` to mean "use the default" got an integration that authenticates,
  resolves its binding, and is throttled to nothing on every write while the UI
  showed write tools listed. `[]`, `false` and `""` coerced identically; `true`
  became 1. Bad values are now a 400.
- 500 bodies no longer carry `String(err)`. pg errors name tables, columns and
  constraints and sometimes the connection host, and those bodies land in browser
  devtools and UI logs; the detail is logged server-side instead.

### Fixed — raw NUL bytes made ripgrep silently truncate eight source files

- Fifteen literal `0x00` bytes, used as composite map-key separators, are now
  written as `\0`. Provably a no-op — none is followed by an ASCII digit, the only
  case where the escape would change meaning. Behaviour is bit-identical; what
  changes is that `rg` no longer classifies these files as binary and stops
  searching partway through, silently truncating every audit that crosses them.

### Fixed — the MCP input-replay path put raw tool output on the LLM wire

- Privacy Shield v4's boundary is **server ↔ LLM provider**, not server ↔ browser:
  `internToolResultV4` returns an identity-free digest for the `tool_result` block
  while the real rows stay server-side behind a `datasetId`, and the browser
  legitimately receives real values (`PrivacyRenderedAnswer.text`, highlighted via
  `maskedValues` so the user can see what the server resolved).
- The replay that runs after a user answers an MCP input card called
  `mcpManager.callTool` **directly** rather than going through `dispatchTool`, so
  the result was never interned — and was then interpolated verbatim into the note
  folded into the turn's ingested text. A replayed HR or accounting tool returning a
  personnel row sent that row to the model in cleartext, where the identical tool on
  an ordinary turn would have yielded only a digest.
- The comment above the interpolation shows this was a near-miss rather than a
  decision: it reasons explicitly about the LLM wire, but only about the user's
  typed values, and overlooks the tool result two lines below. Found by
  cross-vendor review, live in any deployment with a graph pool.

### Known limitation — #547 structured content still has no renderer

- `emitStructured` fires inside `McpManager.callTool`, beneath every dispatcher, so
  the sidecar is not interned. `middleware/test/mcpStructuredOutputPrivacy.test.ts`
  pins that mechanism over a real MCP socket, and confirms `outputSchema` and
  `turnId` already reach the sidecar.
- **This is not a leak to the browser** — an earlier reading of it as one was
  corrected by cross-vendor review; the browser is the trusted side. The renderer is
  deferred for two ordinary reasons instead: it is a full-stack change across eight
  web-ui files on an already-large PR, and the sidecar bypasses Privacy Shield's
  receipt and dataset *accounting* even where masking is not owed, which wants a
  decision before anything renders from it.

### Added — public, stateless MCP endpoint (`POST /api/v1/mcp`)

- omadia can now expose **its own tools** over a stateless Streamable-HTTP MCP
  server so an external MCP client (Claude Desktop, an agent framework, your own
  service) can call them with an API key instead of driving the operator UI.
  External-consumer documentation: `middleware/src/mcp/README.md`.
- **Stateless by construction.** `sessionIdGenerator: undefined`, no
  `initialize` handshake required, no `Mcp-Session-Id` ever issued, and a fresh
  `Server` + transport pair per request torn down in a `finally`. That is what
  makes the endpoint horizontally scalable — any instance can answer any
  request. `POST` only; a non-POST gets `405` (a per-request transport leaks on
  `GET`, because an SSE stream never ends and the teardown never runs).
- ⚠️ **DARK BY DEFAULT.** `PUBLIC_MCP_ENABLED=false` mounts **no router at
  all**. This is the highest-blast-radius surface in the MCP cluster — an
  internet-facing route that reaches the tool layer, including WRITE tools — so
  not mounting is a stronger guarantee than mounting something that answers 403.

#### Authorization — default-deny at four independent layers

- New scopes on `@omadia/api-key-auth`: `mcp:list`, `mcp:invoke`, and per-tool
  `mcp:write:<tool>`.
- **`mcp:invoke` is not sufficient for a write**, and **`*` (`WILDCARD_SCOPE`)
  does not grant any write.** The wildcard exclusion lives inside `hasScope`
  itself, so no caller can reach a permissive matcher by accident. The bare
  two-segment `mcp:write` is rejected at key creation: it would validate,
  persist, and grant nothing — indistinguishable from a revoked key.
- **Allowlist per KEY, not per server** (`public_mcp_key_bindings`, migration
  `0033`). A key reaches exactly one **agent** and exactly the tool names listed
  on it. A key with no binding authenticates and reaches **zero** tools, which
  is how integration-backed and write-capable tools (Odoo, Microsoft 365,
  Confluence) stay out of reach by default — nothing is included until an
  operator names it.
- `tools/list` is filtered per caller to exactly the set the key could
  successfully **call**. A tool name the caller cannot invoke is itself a
  disclosure, and a non-allowlisted tool is indistinguishable from a
  nonexistent one.
- **Write capability is the union** of the tool's own `writeCapabilities`
  declaration (`isWriteCapableTool`) and the operator's `write_tools` list, so a
  mistake in either direction fails toward "treat it as a write".

#### Privacy — fails CLOSED for public callers

- The shared dispatch path masks PII at chat-path **parity**, which includes two
  behaviours that are wrong for an untrusted caller. This endpoint overrides
  both, without changing the chat path:
  - **Masking failure refuses the call** instead of returning the raw result.
  - **An operator's per-plugin privacy bypass does not extend** to a public
    caller.
  - **Intern-exempt tools** (`memory`, `read_attachment`, …) — whose results the
    Privacy Shield deliberately hands over in clear — are **never servable**
    here, whatever an operator configures.
- With **no privacy provider installed**, tool calls are refused and say why
  (`tools/list` still works). `PUBLIC_MCP_ALLOW_WITHOUT_PRIVACY_MASKING=true` is
  the documented escape hatch for an install whose allowlisted tools provably
  carry no personal data.

#### Limits, audit, and what idempotency does NOT promise

- 8 MB request body, 30 s per-tool timeout, endpoint-wide concurrency ceiling,
  and a **separate, tighter rate-limit budget for writes** — heavy reading
  cannot fund a write burst.
- One `mcp_call_log` row per call **including every refusal**, with
  `caller_kind = 'api_key'` (new in migration `0033`) and the acting identity
  `apikey:<id>`. The acting identity is now **visible in the admin MCP call-log
  UI** for every row, not just for public calls — it had been recorded but never
  surfaced.
- `_meta.idempotencyKey` is honoured for write-capable tools but is
  **advisory**: process-local, ~15 minute window, so two instances behind a load
  balancer can both execute. It is retry safety, **not distributed
  exactly-once** — see the README before relying on it.

### Added — MCP Client ID Metadata Documents, as a third client-acquisition mode

- omadia can now identify itself to an MCP authorization server by a **Client ID
  Metadata Document** — an https `client_id` the server dereferences — served at
  `GET /.well-known/omadia-mcp-client`. This removes the app-registration step at
  MCP-native brokers that support it.
- Client acquisition is now an explicit ordered chain:
  `stored → cimd → dcr (deprecated, warns) → manual`. CIMD is attempted only when
  the authorization server advertises `client_id_metadata_document_supported`
  **and** the document is verifiably reachable.
- **Nothing is deprecated on omadia's side.** Dynamic Client Registration keeps
  working and merely logs a deprecation notice (the MCP spec's sunset is a
  12-month clock). The manual OAuth client stays **permanently first-class**: it
  is the protocol-correct path for Microsoft Entra ID and Okta, neither of which
  supports CIMD.
- ⚠️ **Deployment requirement — CIMD needs INBOUND HTTPS reachability.** The
  identity provider must fetch the document from omadia, which is strictly
  stronger than the outbound-redirect-only requirement every other mode has. Set
  `FLOW_PUBLIC_BASE_URL` to an https origin reachable from the internet.
  Deliberately *not* derived from `PUBLIC_BASE_URL`, whose `localhost` default is
  exactly the shape that cannot work.
- **A firewalled or air-gapped install degrades cleanly, it does not break.** The
  metadata endpoint answers **501 with an actionable message** rather than 500,
  the acquisition chain falls through to the manual client, and the MCP Control
  Center explains which mode a server is on plus why CIMD is unavailable when it
  is. A byte5-hosted metadata relay is **not** offered by default — it would make
  every customer's `client_id` identify byte5 to that customer's IdP.
- Migration `0032_mcp_oauth_cimd.sql` adds `'cimd'` to the
  `mcp_oauth_clients.registered_via` CHECK set and a `client_metadata_url`
  column. The CHECK is widened, not dropped — an unknown mode is still rejected.
- Security: the metadata-URL probe reuses the existing `assertPublicHttpsUrl`
  SSRF guard (no second validator), a CIMD client is public by construction so no
  secret is stored, the document carries no secret, and the W0-1 RFC 9207 `iss`
  validation plus flow-bound endpoint pinning are untouched. `mcp_oauth_flows`
  TTL pruning was verified to actually exist in both places it is claimed.
- Rationale, rejected options, and the full deployment note:
  [ADR-0007](adr/0007-mcp-client-id-metadata-documents.md).
- Note on issue #546: its premise that the registry "supports only static headers
  with `secretRef`" was incorrect — the provider-agnostic OAuth 2.1 + PKCE stack
  shipped in epic #459 W9. This release is a delta on that stack.
### Added — MCP tools can ask the user for input mid-call (MRTR `input_required`, #544)

- An MCP server that answers `tools/call` with
  `resultType: "input_required"` plus `inputRequests` now gets a real input
  form instead of a failed tool call. The turn ends, the channel renders the
  fields, and the user's answer replays the parked call automatically.
  `resultType` and `inputRequests` are read off the **shipped SDK 1.29.0** —
  no version bump and no dependency on the `@modelcontextprotocol/*@2.0.0`
  family (#540).
- **Two turns, not a suspended one.** MRTR imagines the client retrying the
  *original* request with the call still in flight. omadia has no per-turn
  suspend/resume store — `turnContext` is an `AsyncLocalStorage` whose
  lifetime is the turn — and parking a turn mid-tool-loop would hold the HTTP
  or Teams connection open past every proxy idle timeout. So the feature rides
  the existing `ask_user_choice` short-circuit: the turn ends, and the answer
  arrives as a fresh turn that re-calls the tool with
  `{...originalArgs, inputResponses}`.
  **Accepted limitation:** the replay is a NEW `tools/call` in a LATER turn
  against a possibly reconnected transport. For a stateless HTTP server that
  is indistinguishable from the retry MRTR describes; for a **stdio server
  holding process state tied to the original in-flight call** it is not — that
  state may be gone and the server sees a fresh call rather than a
  continuation. Servers needing true continuation semantics are out of scope
  until omadia has a real turn suspend/resume store.
- **The card always names the asking server.** An MCP server can now make
  omadia display arbitrary prose and collect arbitrary free text
  mid-conversation, so a card that hid the asker would let a hostile server
  phish credentials behind omadia's own chrome. Every surface attributes the
  request: the web-ui form, the plain-text fallback for channels without form
  support, and the session-log line. Server-supplied prose is rendered quoted
  and attributed, never as omadia's own copy, and `secret` fields say plainly
  that the value still reaches the server as entered.
- A parked record is bound to `{userId, sessionId, correlationId}` and is
  replayable by that triple only. `sessionScope` alone is deliberately not a
  key: `resolveScope` returns the literal `'http-default'` for unscoped HTTP
  turns, which was the live cross-user hole in #445. Records are single-use,
  TTL-bounded (15 min), and a second `input_required` raised *by* a replay is
  capped rather than bouncing the user indefinitely.
- The MCP call audit gains a three-valued `outcome`
  (`ok` | `fail` | `input_required`). A parked call previously had nowhere
  honest to go: `ok: false` would put a phantom failure in front of operators
  debugging a healthy server, and a bare `ok: true` would claim a result that
  was never delivered. `ok` keeps its narrower meaning ("did not fail") and
  the finer truth gets its own field.
- When both an `ask_user_choice` card and an MCP input request are pending in
  the same tool batch, **the choice card wins** — deterministically, not by
  dispatch order. A model that asked its own clarifying question has decided
  it does not yet understand the request, so collecting server-specific field
  values first would answer the wrong question. The MCP record is not
  discarded; it stays replayable until its TTL.
- Not included: omadia acting as an MCP *server* and signalling
  `input_required` to its own clients. That needs a `ToolDispatchService`
  result-type widening touching every plugin dispatch handler, and is a
  separate issue.

### Fixed — `turnContext` is empty inside tool handlers on the streaming path

- Found while building #544. `Orchestrator.chatStream` establishes the turn
  context with `turnContext.enter()` (`AsyncLocalStorage.enterWith`) inside an
  async generator, which does **not** propagate into the generator's own
  continuations — so `turnContext.current()` is `undefined` in every tool
  handler on every streaming turn, including the web-ui path. Verified with a
  probe against both entry points.
- #544 does not depend on it (the parked-record owner is bound from the turn
  input the orchestrator holds directly), and `userId` + `sessionScope` are now
  populated on both entry points. The broader consequences for
  `mcpCallerKind` / `mcpUserKey` audit attribution on streaming turns are
  **not** addressed here and want their own issue.

### Fixed — the CI schema job never applied `middleware/migrations`

- `MIGRATION_DOMAINS` in `.github/workflows/ci.yml` listed five domains and
  omitted `middleware/migrations` — the core runtime domain holding `0001`
  through `0030`. Every migration there had therefore shipped without ever
  being applied, or re-applied for the idempotency check, against a real
  Postgres in CI: the whole MCP schema (`0003` agent-builder graph, `0008`
  tool verdicts, `0009` call log, `0010`/`0013` registries, `0012`/`0014`
  grants, `0015`/`0016` OAuth 2.1 + PKCE, `0017`–`0020`) and every
  dev-platform migration (`0022`–`0030`). The gap was suspected during #330
  and is now closed; the domain is applied first, ahead of the knowledge-graph
  domain.
- **No latent schema defect was exposed.** All 30 files apply and re-apply
  cleanly against `pgvector/pgvector:pg16`, in both possible domain
  orderings, and additionally with rows present. The domain is fully
  self-contained: no cross-domain foreign keys, no shared object names with
  the other five domains, and no extension dependency at all
  (`gen_random_uuid()` is core since pg13). Verified locally with a
  reproduction of the CI job before the workflow change was pushed.
- The workflow comment now records the three domains that remain uncovered
  (`middleware/src/conductor/migrations`,
  `middleware/src/services/graph/migrations`,
  `middleware/packages/harness-memory-postgres/src/migrations`), each of which
  needs its own audit before being enabled.

### Added — first pg coverage for the MCP schema

- `middleware/test/mcpRegistrySchema.pg.test.ts` — no pg test touched MCP
  before this (only `memoryStoreConformance`, `pluginVerdictStore` and
  `skillLifecycleStore` existed). Asserts the registry seed and catalog-kind
  backfill (`0010` + `0013`, including that `0013`'s `UPDATE` actually lifts
  the official registry off the `generic` column default), the `kind` /
  `auth_kind` / `source` / `registered_via` CHECK sets, marketplace
  provenance defaults with `ON DELETE SET NULL` detaching an imported server
  from a deleted catalog, the `0014` partial unique index on top-level MCP
  grants (and that it leaves native grants alone), and the `0015`/`0016`
  OAuth surface — authorize-time endpoint pinning plus token/flow cascade on
  server delete.
- A second suite covers what the CI gate structurally cannot: the CI
  idempotency check re-applies against an **empty** database, so it can never
  catch a migration that only breaks once rows exist. That suite re-applies
  all 30 files with MCP rows in place. It runs against a dedicated schema on
  a pinned connection with `public` off the `search_path`, so the migrations
  build a private copy of the domain: re-running `0001`/`0003` drops and
  recreates the NOTIFY triggers and takes ACCESS EXCLUSIVE on shared tables,
  which must not happen underneath a concurrently running suite. A scratch
  *database* isolates just as well but `CREATE`/`DROP DATABASE` is a
  cluster-wide operation — it stalled the dev-platform pg suites long enough
  to cancel 29 of their tests, so the schema is the cheaper boundary. The
  test asserts the isolation itself, since a leaked `search_path` would make
  every later assertion pass vacuously.
- Both suites skip when no test Postgres is reachable, and scope every row
  they write to a `w04-mcp-` tenant prefix, matching the existing pg-suite
  convention. They share one capped pool: the runner executes test files
  concurrently and ~16 other pg suites each hold a default-sized (max 10)
  pool, so an uncapped extra pool in one file exhausts `max_connections` and
  cancels an unrelated suite mid-run.
### Security — MCP OAuth: issuer binding, explicit delegation, refresh race (W0-1)

Three live defects in the MCP OAuth path, one migration
(`middleware/migrations/0031_mcp_oauth_iss_delegation.sql`).

- **RFC 9207 `iss` validation at the OAuth callback.** The callback trusted the
  `state` parameter alone. `state` proves a response belongs to a flow we
  started; it does **not** prove which authorization server issued the code, so
  a malicious or compromised MCP server could steer the callback and have a code
  minted by one AS redeemed at another. `iss` is now validated against the
  issuer bound to the flow **before** the code is exchanged — a mismatch, or an
  absent `iss` from an AS that advertised
  `authorization_response_iss_parameter_supported`, is rejected and persists
  nothing. Whether the AS advertised `iss` is captured at authorize time
  (`mcp_oauth_flows.iss_required`), never re-discovered at the callback, for the
  same reason migration 0016 pinned the token endpoint.
- **Confused deputy removed.** Both the operator router and the runtime
  `McpManager` resolved the OAuth user key as `… ?? 'operator'`. A Teams or
  Telegram turn whose user had no mapped identity therefore reached the
  customer's MCP server holding the **operator's** token. Resolution is now
  explicit per server via the new `mcp_servers.delegation` column: `per_user`
  fails closed through the existing `onAuthFailure` path when no identity
  resolves, and `service` is the explicit opt-in to one shared identity. The
  fallback literal is gone from every call site.
- **Refresh race.** `getValidAccessToken` allowed N concurrent refreshes per
  (server, user). Against an AS with rotating refresh tokens the losers get
  `invalid_grant` and the last writer can persist an already-retired token,
  silently disconnecting the user. Concurrent callers now share one in-flight
  refresh, verified by a test that asserts exactly one token-endpoint **HTTP
  request** under 8 concurrent callers.
- `mcp_oauth_tokens.issuer` records which AS minted a token, so a rotated issuer
  invalidates it instead of replaying it against a different server.
- `mcp_call_log.acting_identity` records **whose** authority each call used
  (`caller_agent` is the orchestrator slug, not the identity); an unattributable
  call is recorded as `unresolved` rather than left blank.
- OAuth failure logging now goes through a redactor
  (`middleware/src/services/secretRedaction.ts`) — tokens, `code`, and
  `code_verifier` can no longer reach a log line, including values echoed back
  by a provider that we never minted.

> ⚠️ **Operator-visible behaviour change.** A fail-closed `per_user` default for
> every row would break installed deployments whose channel users reach MCP
> servers today *because of* the `'operator'` fallback. The migration is
> therefore deliberately asymmetric: every **existing** `mcp_servers` row that
> already holds a stored operator token is set to `delegation = 'service'`,
> preserving today's behaviour, and only **newly created** servers get the safe
> `per_user` default. Review each grandfathered server in the MCP Control Center
> and switch the ones that should be per-user — while a server stays on
> `service`, anyone who can reach an orchestrator it is granted to acts with the
> operator's authority at that server.
### Deprecated — legacy HTTP+SSE MCP transport (#541)

- MCP 2026-07-28 reclassifies the legacy HTTP+SSE transport as **Deprecated**,
  with a removal window of at least 12 months. omadia now discourages `sse` for
  **new** registrations while keeping every existing SSE server fully working —
  this is a discouragement, not a removal. No protocol work: `SSEClientTransport`
  stays wired, the `agent_mcp_servers.transport` CHECK constraint still accepts
  `'sse'`, and no migration ships with this change. Streamable HTTP (`http`) is
  the migration target.
- `@omadia/orchestrator` exports `DEPRECATED_MCP_TRANSPORTS` and
  `isDeprecatedMcpTransport()` as the single source of truth. The operator API's
  MCP server node gained an additive `transportDeprecated: boolean` derived from
  it; `McpTransport`/`McpTransportKind` keep `'sse'` in every union, so the
  published plugin contract is unchanged.
- **MCP Control Center:** `sse` is no longer offered in the transport picker
  unless "Show deprecated transports" is ticked (`http` remains the default),
  and existing `sse` servers carry a *Deprecated* badge pointing at Streamable
  HTTP. Nothing is hard-blocked — an operator can still deliberately register a
  legacy SSE server while the removal window is open.
- **Marketplace imports** are covered too, not just the UI: when a catalog entry
  advertises both a Streamable-HTTP and an HTTP+SSE remote, the importer now
  picks the `http` one. An `sse`-only entry still imports, flagged via
  `McpCatalogEntry.transportDeprecated`. The untrusted-remote guard (https only,
  no internal/metadata hosts) applies to every candidate as before.
### Added — MCP structured-content sidecar and `outputSchema` capture (#547, W1-3)

- Discovery now keeps a tool's declared `outputSchema`. `McpToolDescriptor`
  and `McpDiscoveredTool` gained an optional `outputSchema` field, and
  `McpManager.listTools()` copies it from `tools/list` (object-valued only;
  anything else is dropped rather than propagated). It is persisted with the
  rest of the descriptor in the existing `mcp_servers.discovered_tools`
  `jsonb` column, so it survives a restart without re-discovery — **no
  migration required**. `subAgentToolHydration` rehydrates it on the way back
  out.
- `structuredContent` returned by an MCP tool is no longer discarded. A new
  `extractStructured(res)` reads it, and `McpManager` hands it to an optional
  `McpManagerOptions.structuredSink` as `{ kind: 'structured_output',
  serverId, toolName, turnId, structured, outputSchema? }`, keyed so a
  consumer can correlate it with the turn that produced it. Error results and
  absent/null payloads emit nothing.
- This is deliberately an **out-of-band** channel, not a widened return type.
  `McpManager.callTool()` still returns `Promise<string>` and
  `NativeToolHandler` is untouched, which keeps the published plugin contract
  stable and — more importantly — keeps every MCP result on the
  `typeof result === 'string'` path that gates Privacy Shield masking in the
  orchestrator. A non-string result would silently bypass the shield.
- Operator surface: the MCP Control Center's tool list shows a read-only
  "returns structured output" badge for any tool that declares an output
  schema.
- No canvas/synthesis behaviour is attached yet — this change is plumbing
  only. The sink's payload union is a discriminated `kind` so the MRTR work
  (#544) can add `input_required` without another refactor.
### Changed — long-running tools stop blocking chat turns (#543)

- New generic **long-running task seam** in `@omadia/orchestrator`
  (`TaskDescriptor` / `TaskStore`, `defineLongRunningTool`). Mark a tool
  `longRunning` and it gets a non-blocking `<tool>_start` / `<tool>_status` /
  `<tool>_list` triple plus a streaming status card: `_start` returns a handle in
  milliseconds, the work runs detached, and the model collects the result on a
  later poll. Generalized from the `dev_job_*` tools, which hand-rolled exactly
  this shape.
- **A chat turn is never parked.** There is no park/resume for a chat turn —
  `chat.ts` streams SSE with a heartbeat and ends when the model loop ends — so
  holding the stream open for minutes only buys proxy idle timeouts, Teams
  activity expiry, and reaped connections. The model says "started, I'll report
  back" instead; that is the intended UX.
- **`dev_job` is the seam's first implementor, with no behaviour change.** A new
  adapter projects `DevJobStore` onto the seam (ten-value `DevJobStatus` down to
  `working | input_required | completed | failed`, `dev_job_events` onto the event
  tail, `claimNextQueued` onto the claim, `finalizeDevJob` onto the terminal
  write so the brand-gated choke point is preserved). `dev_job_start` still
  returns `{"status":"job_started",…}`; nothing in `devJobStore.ts` or
  `devJobOrchestratorTool.ts` changed and no migration was added.
- **Deferred sub-agent dispatch** is the second consumer. A slow sub-agent
  delegated from a chat turn blocks that turn for as long as its `LocalSubAgent`
  loop runs; opt one in via `LONG_RUNNING_SUBAGENT_TOOLS` (comma-separated
  `ask_<slug>` names) and it also gets the non-blocking triple. The blocking
  `ask_<slug>` tool stays registered either way, so a sub-agent that answers in
  seconds keeps answering inline. Empty by default — no existing behaviour moves.
- **Orphan handling**: a periodic reaper fails live tasks whose worker went
  silent (including tasks no worker ever claimed) and purges terminal tasks past
  a retain window, so an unpolled task cannot leak a `working` row forever.
  Windows: `LONG_RUNNING_TASK_STALE_MS` (default 15 min),
  `LONG_RUNNING_TASK_RETAIN_MS` (default 1 h).
- **Deferred-result privacy**: a task's result reaches the model only as the
  return value of `<tool>_status` — an ordinary tool call inside a live turn — so
  the Privacy Shield interning that `dispatchTool` performs still applies, at poll
  time instead of completion time. Status cards deliberately carry no result and
  no input (they bypass `dispatchTool`), which is enforced by test. Known v1
  limitation: privacy **bypass attribution** for work done inside the detached
  runner cannot be recorded against the originating turn, since that turn has
  already ended. No data leaks; the audit line is what is missing.
- Not the MCP Tasks extension: internal `LocalSubAgent` dispatches never cross an
  MCP boundary, and the redesigned extension (SEP-2663) is unshipped even in SDK
  v2 (`tasks/update` does not exist). The status vocabulary above was chosen to
  match MCP Tasks so a later protocol projection is mechanical.

### Fixed — background chat turns write into their own session (#617)

- A turn that was still streaming when the user switched to another chat tab
  lost its content: every transcript write went through the active-session
  helpers, so the fold landed in whichever session happened to be in the
  foreground — nowhere at all, in practice. The tab marker reported a finished
  answer that the transcript never received, and the pending bubble stayed
  stuck in its `streaming` state.
- The chat-sessions store now exposes `mutateById(sessionId, mutator)` and
  `persistById(sessionId)`; `applyStreamEvent`, `finalizePending` and the
  stream runner's terminal persist all address the session the turn belongs to.
  `mutateActive` / `persistActive` are gone — the active-scoped call sites on
  the chat page pass their id explicitly.
- `persistById` also fixes a second half of the bug: it enqueues rather than
  reading an effect-synced ref, so the PUT carries state from *after* the
  `done` fold committed. Without that, a background answer survived in memory
  but not across a reload — a background turn gets no corrective follow-up turn
  to repair the snapshot. A session deleted mid-stream is never resurrected:
  the queued write is dropped when the id is gone.

### Changed — background chat streams surface in-context, not as toasts (#286)

- **Removed `StreamToasts`** (the bottom-right floating cards for background
  chat turns). Per the Lume visual spec §7.6, toasts / floating notifications
  are a ship-blocking anti-pattern; §7.4 makes the chat the surface of record.
- **Background-stream state now lives on the chat tab**: a running turn shows a
  hollow accent ring (pulsing), a finished one a solid accent disc, an errored
  one a hollow danger ring carrying a `!` glyph. The states differ by *shape*,
  so colour is never the sole signal (§8) and the distinction survives
  `prefers-reduced-motion` disabling the pulse — running vs done separates on
  fill, error vs running on the glyph. The state also reaches the tab's
  accessible name via an `sr-only` label (the glyph itself is `aria-hidden`, so
  screen readers don't speak it twice). Switching tabs clears the unread marker
  on the tab being left as well as the one entered; active-session errors
  continue to render inline on the turn.
- **A polite live region** (`ChatTabs`) announces background turns that finish
  or fail, replacing the `aria-live` container the removed toast overlay
  carried. Announcements fire only for non-active tabs.
- **Known consequence**: background-stream state is now visible only on
  `/chat`. `StreamToasts` was mounted in the root layout and rendered on every
  route; the tab strip renders only from the chat page. Accepted in
  [ADR-0006](adr/0006-in-context-background-stream-surfacing.md).

### Added — API keys as a first-class authentication method, with per-key scopes (#439)

- New workspace package `@omadia/api-key-auth`
  (`middleware/packages/harness-api-key-auth/`). The API-key primitives
  #438 shipped inside `@omadia/channel-api` — mint/sha256-hash/constant-time
  verify, the vault-backed key store, the per-key rate limiter, the usage
  audit log — moved here unchanged, so there is exactly **one**
  implementation of the credential. A shared workspace package is the only
  home both sides can reach: the kernel must never import a channel plugin,
  and a plugin cannot import kernel source (`middleware/src/auth/` is not
  resolvable from a package whose `tsconfig` has `rootDir: src`). Same role
  `@omadia/plugin-api` and `@omadia/channel-sdk` already play. The package is
  dependency-free apart from an `express` peer — its storage dependency is a
  structural subset (`ApiKeySecretStorage`) that `SecretsAccessor` satisfies
  without an adapter. No new npm dependencies, matching #438.
- New mountable Express middleware `requireApiKey({ apiKeys, rateLimiter,
  auditLog, scope })`: any route or plugin can apply it and be authenticated
  by a server-to-server bearer key instead of the `omadia_session` cookie
  (driving use case: a Laravel/PHP integration with no human session behind
  it). It attaches an `ApiKeyPrincipal` to `req.apiKey` and deliberately does
  **not** populate `req.session` — `SessionClaims.role` is hard-typed
  `'admin'`, so synthesizing a session for a machine would make every
  session-reading route downstream silently treat a key as an operator.
  401/403/429 use the `{ error, message }` shape #438 established for the
  public API surface, not the session gate's `{ code, message }`, so the wire
  format of `POST /api/public/v1/chat` is unchanged.
- Per-key **scopes**: `<resource>:<action>` strings (or the global `*`),
  matched exactly — no prefix wildcards, which are how "I thought `admin:*`
  didn't cover `admin:delete`" happens. A route declares the scope it needs;
  a key without it gets `403 forbidden` and a `forbidden` audit entry.
  Backward compatible: a key persisted before scopes existed carries no
  `scopes` field and is normalized to `['chat:write']` — exactly the one
  capability it had when it was minted. Defaulting such keys to `*` would
  also keep them working and would silently widen every existing key to
  whatever scoped surface lands next, so it is not what we do.
  `POST /api/public/v1/admin/keys` accepts a `scopes` array (validated, 400
  on a malformed scope) and `GET` lists it.
- `normalizeScopes` distinguishes an **absent** `scopes` field from a
  **malformed** one, because collapsing the two turns a read error into a
  capability grant. Absent (`undefined`) → the legacy `['chat:write']`.
  Present but unreadable — not an array (`"memory:read"` stored as a bare
  string), an empty array, or an array with any invalid entry
  (`['Chat:Write']`, `['chat:write','nonsense']`) → the **empty** scope set:
  the key still authenticates, and every scope check on it fails closed with
  `403`. A malformed record is at least as likely to be a key an operator
  deliberately restricted *away* from chat as it is to be a lost pre-#439
  key, and defaulting it to `chat:write` would hand back exactly the access
  that was removed. Partially-valid arrays deny rather than silently narrow.
  Every such case logs `[api-key-auth] malformed persisted scopes` so an
  operator can tell a corrupt record from a revoked key. The scope set is
  always persisted explicitly at `create()` time, so nothing this store
  writes can be mistaken for a pre-#439 record.
- Creation agrees with that read path on the same value. Only an **omitted**
  `scopes` field resolves to the legacy default; an explicitly supplied `[]`
  is rejected — `400` at the admin route, and a throw from `create()` for
  callers using the package directly. Otherwise one field would mean "deny
  everything" on read and "grant `chat:write`" on write, so an operator asking
  for a zero-capability key would have been handed a chat-capable one.
- `@omadia/channel-api` now consumes the shared package instead of owning
  the code: `chatRouter.ts` mounts `requireApiKey` with `scope: 'chat:write'`
  rather than parsing bearer headers itself. Behaviour and wire format of
  `POST /api/public/v1/chat` are unchanged, and its existing test suite
  passes as written (only the moved modules' import paths were repointed).
- `middleware/src/auth/publicPaths.ts` is deliberately **not** broadened —
  `/api/public/v1/chat` is still the only exempted API-key route. Its comment
  now records what a future route that mounts `requireApiKey` has to do.
- The `scopes` additions to `/api/public/v1/admin/keys` sit **on top of** the
  kernel-level `ctx.operatorAuth` session gate that the entry below adds to
  that router, not beside it: an anonymous `POST` carrying `scopes: ['*']`
  is rejected `401` before any handler runs, covered by its own regression
  test in `adminKeysRouter.test.ts`.
- Tests: `test/auth/requireApiKey.test.ts`, `test/auth/apiKeyScopes.test.ts`,
  and `test/channelApi/apiKeyAuthReuseSeam.test.ts` — the last one is a
  structural guard on the seam itself (the plugin holds no second copy of the
  primitives, and `middleware/src` imports no channel plugin), because
  "where does this code live" is a property no runtime assertion can express
  and the cheapest one to regress.

### Added — public API channel: chat over HTTP with per-key auth (#438)

- New built-in channel package `@omadia/channel-api`
  (`middleware/packages/harness-channel-api/`) exposes `POST
  /api/public/v1/chat` — a documented, self-authenticating HTTP entry point
  external systems can drive without a channel adapter or the operator UI.
  Streams the SAME NDJSON event framing as `/chat/stream` and dispatches
  through `CoreApi.handleTurnStream`, so PII masking (privacy-guard), memory,
  and the knowledge graph all apply exactly as they do for every other
  channel — no second response-masking path.
- Credential model (locked design decision on the issue): each API key **is**
  its own identity — `ChannelUserRef{ channel: 'api', id: 'key:<id>' }` —
  not a delegate for a human end-user. No impersonation surface.
- Full v1 security posture, not deferred: API keys are vault-backed (this
  plugin's own `ctx.secrets` namespace, no DB migration) and verified with
  `crypto.timingSafeEqual` against a sha256 hash — the plaintext is shown
  exactly once, at creation; per-key configurable rate limits (fixed-window,
  429 on overage); an explicit revoke endpoint (`POST
  /api/public/v1/admin/keys/:id/revoke`) that fails the next request
  immediately; and a usage audit log (who/what/when) recorded on every
  authenticated call.
- Key lifecycle (`GET`/`POST /api/public/v1/admin/keys`, revoke) is
  deliberately mounted under the SAME `/api/public/v1` prefix but NOT added
  to `middleware/src/auth/publicPaths.ts`'s exemption list — only `.../chat`
  is public. Key management stays behind the normal operator session, like
  every other admin surface in this app — see the security-fixup entry below
  for how that's enforced both implicitly (the kernel's broad `/api`
  session gate) and, after that entry's change, explicitly as well.
- Review fixups: the internal `conversationId` handed to `CoreApi` is now
  namespaced by key id (`${key.id}:${callerConversationId}`) so two
  different API keys can never collide on the same core-side scope, even
  when they send an identical caller-supplied `conversationId` — closes a
  cross-key transcript/context leak. The usage audit log now records one
  entry for every authenticated call (not just the success path) with a
  status reflecting the real outcome — `ok` | `rate_limited` |
  `invalid_request` | `error` — instead of writing `status: 'ok'`
  optimistically before dispatch.
- Second review fixup round: the audit-status fix above still had a gap —
  `deps.core.handleTurnStream` can yield an in-band `{type:'error',
  message}` event on the already-open stream WITHOUT throwing (same bug
  class as #403), and the loop completing normally was still recorded as
  `ok`. `chatRouter.ts` now tracks whether an `error`-type event was
  forwarded during iteration and audits `error` in that case too, with a
  regression test covering the no-throw path. Docs: the README's event
  table no longer claims `agent_bound` is emitted on this route (it isn't —
  that event is synthesized by the kernel's own `/api/chat/stream` handler,
  not by `CoreApi.handleTurnStream`) and now documents the verifier-mode
  `{type:'verifier'}` event that can follow `done`. `docs/security-architecture.md`
  § 8 and the README's rate-limiting section now say explicitly that the
  limiter is in-memory and per-process, not shared across replicas
  (accepted v1 trade-off, no code change). `harness-channel-api`'s
  `peerDependencies` on `@omadia/channel-sdk` / `@omadia/plugin-api` are now
  pinned to `^0.1.0` instead of `"*"`, per `CONTRIBUTING.md`'s dependency
  hardening policy.
- Security fixup: an earlier note here overstated this as a live
  authentication bypass. It wasn't — `/api/public/v1/admin/keys` was
  already covered by the kernel's pre-existing broad `app.use('/api',
  requireAuth, ...)` mount (`src/index.ts`), which runs ahead of
  `pluginRouteRegistry.mountAll(app)` in boot order and gates every
  `/api/*` path not listed in `publicPaths.ts`, same as any other
  non-exempted channel route. That coverage is real but implicit — it
  depends on mount order and on this path never being added to
  `publicPaths.ts`, either of which a future refactor could break silently.
  Hardened at the kernel level so the guarantee doesn't depend on that
  coincidence, and so future plugins needing an admin surface get a
  reusable, explicit check: `PluginContext` gains an optional `ctx.operatorAuth`
  (`OperatorAuthAccessor`, `packages/plugin-api/src/pluginContext.ts`),
  published by the kernel and threaded into every plugin runtime
  (`ToolPluginRuntime`, `DynamicAgentRuntime`, `DefaultChannelRegistry`) so
  any future plugin needing an operator-only admin surface can reuse it.
  `hasValidSession(cookieHeader)` reuses the EXACT SAME session-verification
  logic `requireAuth` runs (extracted to `evaluateSessionToken` in
  `src/auth/requireAuth.ts`) — one code path, not two that can drift apart.
  `adminKeysRouter.ts` now applies it as router-level middleware ahead of
  every route: missing/invalid session → `401`; `ctx.operatorAuth` itself
  unavailable → `503` (fail closed, never silently unauthenticated). New
  end-to-end coverage in `adminKeysRouter.test.ts` mounts the router behind
  the REAL accessor (not a stub) and asserts the no-cookie / invalid-cookie
  / valid-cookie and fail-closed paths. `docs/security-architecture.md` § 9,
  this package's `README.md`, and `docs/middleware-agent-handoff.md` are
  corrected to describe the real mechanism.
- Third review fixup: the key-id namespacing above (`${key.id}:${callerConversationId}`)
  was itself still lossy. `SessionLogger`'s `sanitizeScope` collapses any run
  of punctuation to a single `-`, lowercases, and truncates to 80 chars
  before persisting — so two DIFFERENT caller-supplied `conversationId`s
  under the SAME key could still land on the identical sanitized scope (for
  example `"case/a"` and `"case?a"`, or two long ids differing only past the
  truncation cutoff), letting one conversation thread recall another
  thread's memory/graph content. `chatRouter.ts` now derives the internal
  `conversationId` as `sha256(key.id:callerConversationId)` (hex digest —
  fixed-width, already lowercase alphanumeric, so nothing about it can be
  mangled or truncated into colliding with a different digest) instead of
  plain concatenation. Regression coverage in `chatRouter.test.ts` sends
  both collision shapes through the real `createApiChatRouter` and asserts
  the resulting scopes differ after being run through the real
  `graphScopeFor`/`sanitizeScope`.
### Added — pluggable embedding provider (#440)

- The `EmbeddingClient` contract moved from `@omadia/embeddings` (the Ollama
  adapter) to `@omadia/plugin-api`, extended with provider metadata
  (`modelId`, `dimensions`) via the new `EmbeddingProvider` type — the same
  split the LLM side already has between `llm-provider-api` and the adapter
  packages. `@omadia/embeddings` re-exports the contract, so out-of-repo
  plugins compiled against its `dist/` keep working. The capability name
  stays `embeddingClient@1`; no consumer manifest changed.
- New adapter `@omadia/embedding-adapter-openai` provides the same
  `embeddingClient@1` capability over the OpenAI wire format
  (`POST {base_url}/v1/embeddings` — OpenAI, Azure behind a gateway, vLLM, LM
  Studio, LiteLLM). Base URL, model, dimensions, timeout and concurrency are
  manifest `setup.fields`; the API key is a `secret`-typed field and lives in
  the vault, never in `installed.json`. Because it declares a secret field the
  built-in catch-all bootstrap does not auto-install it — installing a second
  embedding provider stays an explicit operator act, and
  `ctx.services.provide` still throws if two ever end up active.
- **Vector width is a hard constraint out of the box.** The knowledge graph
  creates its vector columns as `vector(768)` (`graph_nodes.embedding` from
  `0005_turn_embeddings_768.sql`, `processes.embedding` from
  `0009_process_memory.sql`). Until an operator migrates those columns, only
  768-dimensional models are usable — `text-embedding-3-small` (1536),
  `text-embedding-3-large` (3072) and `text-embedding-ada-002` (1536) are
  refused by the gate rather than silently failing per row. The column
  migration follows `0005_turn_embeddings_768.sql`: drop index → drop column →
  re-add at the new size → re-create index, for every governed column.
- Neither adapter publishes a vector size it has not confirmed. The
  `dimensions` / `embedding_dimensions` settings carry **no manifest default**
  any more (a default would be seeded into every install by bootstrap and
  would contradict whatever model the operator picked). Known models resolve
  their width from a table in the adapter; an unknown model needs the field;
  a field that contradicts a known model makes the adapter refuse to publish.
  The Ollama adapter keeps working unchanged for an unknown model — it then
  publishes the client *without* provider metadata, and the gate treats the
  provider as "identity unknown" exactly as before #440, rather than switching
  an existing deployment to FTS-only on upgrade.
- Migration `0030_embedding_model_registry.sql` (KG-neon chain): new
  `graph_embedding_model` table, one row per tenant, recording the model id
  and vector size the stored embeddings were produced with, plus a
  `clear_pending` flag that makes a model switch resumable.
- Knowledge-graph activation now runs a model/dimension gate. It reads the
  **declared** width of every `vector` column on a tenant-scoped table from
  the catalog (`pg_attribute` / `format_type`), not from sampled rows, so an
  empty corpus is checked exactly like a full one. Outcomes: column width ≠
  provider width → vector writes refused for the boot; empty or unrecorded
  corpus of matching width → the active model is recorded; same width,
  different model → every governed vector column is cleared in bounded
  batches (attempt counters reset) and the `embeddingBackfill` sweep
  re-embeds, finishing any clear the activation capped; recorded width ≠
  provider width → refused. Vector columns are discovered rather than
  hard-coded, so a future migration adding one is covered by the width check.
- `processes.embedding` is now governed too. It is a second cosine space used
  for the write-path dedup pre-check and for hybrid process recall; before
  this it was neither cleared on a model switch nor re-embeddable, so a
  same-width provider swap corrupted process recall permanently. The backfill
  sweep gained a process pass (retries capped in memory — `processes` has no
  attempt column, and the condition is transient).
- **What the gate does and does not cover.** It governs the knowledge-graph
  plugin's own embedding client: all vector writes into `graph_nodes` and
  `processes`, plus the backfill sweep. It does not withdraw the
  `embeddingClient@1` capability from the service registry, so
  `contextRetriever`, `inconsistencyDetector`, `mergeCandidateDetector` and
  `topicDetector` keep resolving and calling the provider on a blocked boot.
  Their vector queries then fail inside the try/catch each already has, so
  recall is FTS-only in effect — at the cost of one wasted embed call and one
  error log per attempt. Withdrawing a published capability centrally would
  need a kernel-side revoke hook that does not exist yet.
- Activation is not allowed to stall or crash on the gate. The vector clear
  runs in bounded batches, each in its own transaction with a
  `statement_timeout`, capped per activation; the remainder is finished by
  the backfill sweep. A gate failure degrades to the safe path (no embeddings,
  FTS-only) instead of throwing out of `activate()` — the kernel treats
  `knowledgeGraph` as a required service, so a throw there is a boot loop.
- The `/health` KG snapshot no longer equates "embeddings configured" with
  "Ollama base URL set" — an active alternative provider counts as well, and
  it reads the gate outcome rather than the registry alone (see the fixup
  below).
- Unchanged for existing deployments: `bootstrapEmbeddingsFromEnv()` still
  seeds only the Ollama adapter from `OLLAMA_BASE_URL` /
  `OLLAMA_EMBEDDING_MODEL`, and a deployment with no embedding provider still
  boots into the FTS-only path.
- Fixup (round 2, two independent adversarial reviews). Eight blocking
  findings, all in the gate's failure modes rather than its happy path:
  - **`/health` no longer reports a blocked gate as healthy.** The KG snapshot
    was a registry-only projection: with `vector(768)` columns and an active
    1536-dimensional adapter it answered `embeddings: true, semanticRecall:
    true, durableTier: true, processReuse: true, warnings: []` for a boot
    where the gate had refused every vector write and `NeonProcessMemoryStore`
    was rejecting every `write()`/`edit()` with `embedding-unavailable`. The
    knowledge-graph plugin now publishes its gate outcome as an
    `embeddingModelGateStatus` service; `/health` reads it and reports
    `embeddings: false` plus a warning naming the active model against the
    recorded one.
  - **Vector writes are refused while a stale-vector clear is pending.** This
    changes the write semantics of a same-width model switch. Previously
    `status: 're-embedding'` kept the live embedding client, so fresh
    new-model vectors were written while `clear_pending` was still TRUE — and
    the resumed clear, which selects on `embedding IS NOT NULL` with no model
    or timestamp discriminator, then destroyed them. On a large corpus (≈21 h
    of clearing at the defaults) that meant a Turn ingested at T+1min was
    embedded and wiped at T+5min, and sustained ingest could keep the clear
    from ever draining. `allowsVectorWrites()` now returns false until the
    clear completes, which makes the documented invariant ("a non-NULL
    governed vector is an old-model vector") true by construction. The
    backfill sweep is still armed in that state — it is the only thing that
    can finish the clear — and once the flag drops the same sweep re-embeds
    every NULL vector, including whatever was ingested during the window.
  - **The `match` path consults `clear_pending`.** A switch flips the registry
    row *before* clearing, so the boot after an interrupted switch matches and
    used to return early. The only resumer was the backfill, which is skipped
    when `graph_embedding_backfill_enabled=false` or when the embeddings
    plugin is later deactivated — leaving `clear_pending` TRUE forever with
    two models mixed in one cosine space and nobody reading the flag. The
    match path now resumes the clear itself.
  - **The `embedding_attempts = 0` reset got its own statement.** It rode
    along with `SET embedding = NULL … WHERE embedding IS NOT NULL`, which by
    construction can never match a row that exhausted its retries — those have
    `embedding IS NULL`, which is *why* they are exhausted. Such rows stayed
    at `attempts = maxAttempts` and the backfill's `embedding_attempts <
    maxAttempts` predicate skipped them forever. A dedicated bounded UPDATE
    over `embedding IS NULL AND embedding_attempts > 0` now rescues them.
  - **The process sweep no longer starves itself.** The poison-row filter ran
    *after* `LIMIT`, so `batchSize` permanently-failing rows filled every page
    and the healthy rows behind them were unreachable for the lifetime of the
    handle. The exclusion moved into the SQL (`AND id <> ALL($3::text[])`).
  - **`INSERT … ON CONFLICT DO NOTHING` is checked with `RETURNING`.** A lost
    race is a no-op that used to be reported as `{status: 'recorded',
    modelId: <this instance's model>}`, letting the loser write into a vector
    space the registry says belongs to the winner. The insert now reports
    whether it won; a loser that disagrees about the model is blocked with the
    new `registry-conflict` reason.
  - **Clear termination is sound.** `rowCount < limit` was treated as "done",
    but under READ COMMITTED a concurrent updater makes rows drop out of the
    predicate after the LIMIT was applied — an incomplete clear then lowered
    `clear_pending`. Batches now use `FOR UPDATE SKIP LOCKED`, the loop only
    stops on a batch that changed nothing, and a residual probe decides
    whether the clear may be declared finished. A session-level
    `pg_try_advisory_lock` keeps two clearers (activation vs. backfill sweep,
    or two instances) off the same tenant; a clearer that cannot take the lock
    reports the work as still owed rather than doing nothing quietly.
  - **The registry flip is serialised and conditional.** Read → decide → flip
    now runs in one transaction holding `pg_advisory_xact_lock(tenant)`, and
    the `UPDATE` carries a CAS predicate on the model/dimensions it read.
    Additionally a switch is refused when the registry row was written within
    a 10-minute cooldown *and* the corpus still holds vectors: during a
    rolling deploy where the two machine versions carry different same-width
    adapters, each side would otherwise switch, clear, and wipe what the other
    had just re-embedded, oscillating with no error surfaced anywhere.
  - The clear machinery moved to `staleVectorClear.ts`;
    `embeddingModelGate.ts` re-exports it, so no import path changed.
  - New `middleware/test/embeddingModelGate.pg.test.ts` exercises the SQL
    against a real Postgres + pgvector (catalog width read on an actual
    `vector(n)` column, the `ON CONFLICT` race, a switch → capped clear →
    resume cycle, advisory-lock exclusion). It self-skips when no database is
    reachable, same convention as `test/devplatform/*.pg.test.ts`.
- Follow-up — **switching the embedding provider without a restart.**
  - The knowledge-graph stores resolve their embedding client *live* instead
    of capturing it in their constructors, so a refusal that ends (a drained
    stale-vector clear, a provider switch) re-enables vector writes in-process
    rather than needing an operator restart.
  - New admin page **Admin → Embedding provider**
    (`/api/v1/admin/embedding-provider`, cookie-session auth) lists every
    installed `embeddingClient@1` adapter, prices the switch up front (how
    many stored vectors it discards, whether the column width changes) and
    performs it: deactivate the outgoing provider, activate the target, then
    ask the knowledge-graph's gate to **re-evaluate itself in place**. The
    switch refuses to run without an explicit `confirmDiscardVectors`.
  - The re-evaluation is an entry point on the published
    `embeddingModelGateStatus` service (`reevaluate`): it re-resolves the
    embedding client from the service registry, re-runs the model/dimension
    gate, replaces the published verdict and re-arms or stands down the
    backfill sweep. It deliberately does **not** re-activate the
    knowledge-graph plugin: that would run its `close()`, which ends the
    `graphPool` the kernel captured once and shares with ~40 subsystems
    (routines, dev-platform webhooks, agent schedules, cost telemetry, MCP
    audit, `AgentGraphStore`, `McpConfigService`), poisoning all of them with
    `Cannot use a pool after calling end on the pool` until the next restart.
    Re-resolving the client is load-bearing rather than tidy: the plugin used
    to close over the boot-time client, so a "successful" switch left the
    registry holding the new provider while the graph kept embedding with the
    old one, silently.
  - On a declared-width mismatch the gate can now rewrite the governed
    `vector(n)` columns at the active provider's width (capture index
    definitions via `pg_depend` → drop index → drop column → re-add at the new
    width → replay the index definitions verbatim → reset `embedding_attempts`
    → flip the registry), under the same anti-oscillation cooldown a
    same-width switch uses and a wall-clock budget that keeps `activate()`
    inside its 10 s cap.
  - **That rewrite never runs on the boot path.** It destroys every stored
    embedding, so the capability is an explicit parameter of the gate
    evaluation rather than an ambient default: plugin activation does not pass
    it and a width mismatch therefore stays `blocked/column-width-mismatch` —
    reversible, nothing dropped, operator decides — exactly as before this
    work. Only an operator-confirmed switch through the admin UI passes it.
    Without this, a deployment already sitting on the documented
    `blocked/column-width-mismatch` (768-wide columns, a 1536-wide provider)
    would have lost its entire embedding corpus by doing nothing but upgrading
    and restarting, with no prompt anywhere — `confirmDiscardVectors` only
    ever existed on the HTTP route.
  - `auto_migrate_vector_columns` (KG setup field,
    `GRAPH_AUTO_MIGRATE_VECTOR_COLUMNS`) is therefore a **master switch over
    the confirmed path**, not a boot-path behaviour. `'false'` forbids the
    destructive rewrite even from a confirmed switch in the admin UI, leaving
    the hand-written `0005_turn_embeddings_768.sql`-style migration as the only
    route. `'true'` (default) permits it *when an operator confirms it*; it can
    no longer let a restart wipe a corpus.

### Added — plugin-contributed navigation (#470, phase 1 of the Dev Platform extraction)

- New plugin capability `ctx.uiRoutes.registerNav({ navId, href, cluster?,
  order?, label })` lets an installed plugin contribute entries to the
  operator navigation. Backed by `UiRouteCatalog.registerNav()` /
  `listNav(locale)` and served by a new session-gated route
  `GET /api/v1/ui/navigation?locale=<l>`, which returns labels **already
  resolved** for the requested locale — the browser never receives the
  per-locale map, so the web UI stays on next-intl's single i18n clock.
- The web-ui shell (`Nav.tsx`) now merges its static nav with the
  contributed entries, fetched server-side in the root layout. An entry
  joins the cluster it names; an unknown or absent cluster promotes it to
  top level; an href colliding with a static one is dropped so a plugin
  cannot shadow a core destination. Every plugin-supplied field is
  validated as untrusted input (canonical in-app hrefs only; labels
  length-capped and screened for control, bidi and zero-width codepoints).
- Dev Platform is the first consumer: its menu entry and its `/admin` grid
  card now come from that registration instead of being hardcoded, so
  disabling the feature removes both with no frontend rebuild. Removes the
  now-unused `nav.devPlatform` key from `messages/{en,de}.json`.
- Rationale and the remaining extraction phases:
  `specs/470-dev-platform-plugin/plan.md`.

### Fixed — deactivated tool plugins kept serving their Express routes

- `ToolPluginRuntime.deactivate()` stopped background jobs and disposed UI
  routes but never called `pluginRouteRegistry.disposeBySource()`, although
  it held that dependency and threaded it into every plugin context
  (`DynamicAgentRuntime` already did). Express cannot unmount, so an
  uninstalled or hot-upgraded plugin's routers stayed live and — because
  Express matches first-mount-wins — kept answering and shadowed anything
  later mounted at the same prefix.
- Disposal now also runs **before** the plugin-controlled `close()` is
  awaited; previously a plugin whose `close()` hung kept its routes and menu
  entry live for the full 5s budget after the operator triggered
  deactivation. `activate()` additionally rolls back its own route/nav/job
  registrations when a plugin registers and then throws or times out —
  such a plugin never reaches the active set, so `deactivate()` could never
  clean it up and the orphan survived for the life of the process.

### Added — Conductor generic webhook support, inbound + outbound (#437)

- **Inbound**: `POST /api/hooks/:endpointId` (unauthenticated mount, raw-body
  HMAC verification ahead of the global `express.json()` — same pattern as
  `routes/devWebhooks.ts`). An endpoint maps to a Conductor `eventId`; a
  verified delivery calls the existing `ConductorEventRouter.emit()`, so any
  workflow with a matching `event` **or** `webhook` trigger starts a run — the
  previously declared-but-dead `'webhook'` `TriggerKind`
  (`conductor-core/src/types.ts`) is now implemented as `event`'s sibling, not
  a separate mechanism. Every claimed delivery id lands in
  `conductor_webhook_inbound_deliveries` with a terminal outcome (dedupe +
  audit ledger); noise (disabled endpoint, malformed JSON, no subscriber)
  always answers 2xx to avoid a redelivery storm, while a bad/absent signature
  and an unknown endpoint id answer byte-for-byte the same 401.
- **Outbound**: `ConductorWebhookDispatcher` fires an HMAC-signed delivery to
  every enabled `conductor_webhook_subscriptions` row matching an internal
  event (`run.completed` / `run.failed`, wired via a new
  `ConductorRunExecutor` terminal-run hook), with exponential backoff up to a
  configurable attempt cap and a persisted `conductor_webhook_deliveries` log
  (`ConductorWebhookRetryWorker` re-attempts anything still `pending` on a
  poll loop, so a delivery survives a process restart).
- **Designer action**: a new built-in `webhook.post` action lets a workflow
  step fire an ad-hoc outbound POST to an operator-supplied URL.
- **Security**: inbound endpoint secrets and outbound subscription signing
  secrets live in the secret vault (`core:conductor` namespace, metadata in
  Postgres / secret in Vault split, modeled on `DevGithubAppStore`) — never in
  graph JSON or an API response beyond their one-time creation/rotation
  reply. Both the dispatcher and `webhook.post` share one SSRF guard
  (`conductor/webhookOutbound.ts`, reusing the existing
  `platform/ssrfGuard.ts` guarded-`Agent` defence) that rejects a private /
  loopback / link-local / cloud-metadata target before a request is ever
  attempted.
- New config: `CONDUCTOR_WEBHOOKS_ENABLED` (global inbound kill switch,
  default `true`) — see `middleware/.env.example`.
- New migration: `middleware/src/conductor/migrations/0007_webhooks.sql`
  (`conductor_webhook_endpoints`, `conductor_webhook_inbound_deliveries`,
  `conductor_webhook_subscriptions`, `conductor_webhook_deliveries`).
- Admin CRUD (list/create/rotate-secret/enable-disable/delivery-log) is
  exposed under the existing auth-gated
  `/api/v1/operator/conductors/webhooks/*`, with a minimal admin UI at
  `/admin/webhooks` (endpoints + subscriptions, secret rotation, delivery
  history) satisfying the issue's admin-surface acceptance criterion.
- **Rate limiting**: the inbound route enforces a per-endpoint cap over a
  rolling minute (`CONDUCTOR_WEBHOOK_MAX_DELIVERIES_PER_MINUTE`, default 60),
  atomically alongside the delivery-id dedupe claim — a correctly-signed
  sender minting a fresh delivery id on every call can no longer start an
  unbounded number of workflow runs.
- **Dedupe fix**: the inbound delivery ledger's dedupe key is scoped per
  `(endpoint_id, delivery_id)`, not globally on `delivery_id` alone — two
  endpoints can now each process their own delivery id '1' without one
  shadowing the other.
- **Outbound durability fix**: a periodic reconciliation pass (run by the
  existing retry worker) finds terminal, non-dry-run runs from the last 24h
  with no delivery row yet for an enabled subscription and creates the
  missing one — closing the gap where a process kill between a run's
  terminal-status commit and its fire-and-forget delivery-row creation lost
  the webhook permanently.
- **Outbound race fix**: the first, inline delivery attempt now claims its
  row (`FOR UPDATE SKIP LOCKED`, same claim the retry worker's poll loop
  uses) before sending, so the inline path and a concurrent retry-worker
  tick can never attempt — and duplicate-report the outcome of — the same
  delivery.
- **Second-review fixups (#437):**
  - **Inbound claim/emit ordering**: `ConductorWebhookEndpointStore.claim()`
    inserts the delivery row (`outcome='received'`) BEFORE the route calls
    `emit()`, so a crash between the two (e.g. `emit()` throwing on a
    Postgres error) used to strand the row at `'received'` forever — a
    retry with the same `X-Webhook-Delivery-Id` then got a cached
    `'duplicate'` 200 without `emit()` ever running again, losing the event
    permanently. `claim()` now treats a still-`'received'` row older than
    `IN_FLIGHT_CLAIM_STALE_MS` (30s) as an abandoned claim and lets a
    legitimate retry re-attempt processing, while a genuinely concurrent
    redelivery within that window is still reported `'duplicate'` as
    before.
  - **Outbound reconciliation lifecycle bound**: `listMissingRunDeliveries`
    previously only bounded its backfill by the caller's lookback window,
    so creating a subscription — or re-enabling a disabled one — resurrected
    every matching run in that whole window, including runs that ended
    before the subscription existed or while it was disabled. A new
    `conductor_webhook_subscriptions.enabled_since` column (defaults to
    creation time, bumped on every transition into the enabled state) now
    also bounds the reconciliation JOIN, so only runs that ended while the
    subscription was genuinely active are ever backfilled.
  - **Outbound delivery uniqueness**: reconciliation's unlocked `NOT EXISTS`
    read followed by an unconstrained insert could race the live
    terminal-run hook (or a second replica's reconciliation pass) into
    creating two deliveries for the same run+subscription. A generated
    `conductor_webhook_deliveries.run_id` column (from `payload->>'runId'`)
    plus a partial unique index on `(subscription_id, run_id)` now cap this
    at one delivery per run per subscription; `createDelivery` is
    conflict-safe (`ON CONFLICT ... DO NOTHING`, returning the row that
    already won on a race) instead of erroring or silently returning
    nothing.
  - **Admin UI inbound URL**: the endpoint list/create response now includes
    a server-computed `inboundUrl` (`CONDUCTOR_WEBHOOK_PUBLIC_BASE_URL` —
    new, optional — falling back to `PUBLIC_BASE_URL`) and the admin UI
    displays that instead of building the URL from
    `window.location.origin`. In the standard local dev setup that origin is
    the Next.js dev server, which only proxies `/bot-api/*`
    (`web-ui/next.config.ts`) — a copied `window.location.origin` URL 404s
    instead of reaching the middleware.
  - **Webhook trigger validation**: `conductor-core/src/validate.ts` now
    requires `eventId` for `kind === 'webhook'` triggers, the same
    validation `kind === 'event'` already had. `eventRouter.ts#emit` matches
    a trigger by `(kind === 'event' || kind === 'webhook') && eventId ===
    <emitted id>`, so a `webhook` trigger with no/invalid `eventId` used to
    publish successfully but could never actually fire.
  - **Docs**: added a webhook section to `docs/security-architecture.md`
    (secret placement, inbound auth model, outbound SSRF guard) and fixed
    the stale "admin UI is not part of this change" claim in
    `docs/middleware-agent-handoff.md`.
### Added — structured dataset ingestion (CSV import) for the Knowledge Graph (#430)

- New `KnowledgeGraph` surface (`ingestDataset`, `listDatasets`, `getDataset`,
  `queryDatasetRows`, `deleteDataset`) backed by a relational sidecar —
  `datasets` + `dataset_rows` tables (migration `0029_datasets.sql`) — NOT a
  graph-node explosion: individual rows never become graph nodes, only one
  `Dataset` node (`PluginEntity`, `system='dataset'`) is created per dataset
  for recall/citation linking. Implemented in both `@omadia/knowledge-graph-neon`
  (real SQL, parameterized JSONB filters/aggregates) and
  `@omadia/knowledge-graph-inmemory` (full parity, not a stub).
- `POST /api/v1/datasets` (multipart CSV upload), `GET /api/v1/datasets`,
  `GET /api/v1/datasets/:id`, `GET /api/v1/datasets/:id/rows`,
  `DELETE /api/v1/datasets/:id` — ACL pattern mirrors `/api/v1/memory`
  (session-derived owner, no anonymous access).
- CSV attachments in chat now import as a queryable dataset instead of being
  silently truncated at the existing 20,000-char text cap
  (`attachmentExtract.ts`'s `MAX_TEXT_CHARS`).
- New `query_dataset` native tool: `list_datasets` / `get_schema` /
  `query_rows` (a constrained filter+aggregate DSL — never raw SQL from the
  model), always paginated/aggregated server-side.
- Every imported row runs through the existing C0 regex PII-detector
  baseline (`@omadia/plugin-privacy-guard`) before being persisted — the
  same masking pipeline that already protects free-text user prompts.
- Admin UI (upload/schema/delete page under `web-ui/app/admin/`) is
  intentionally NOT part of this change — see the PR description.
- Fixup: `inferColumnType` (`datasetImport.ts`) no longer types a column as
  `'number'` when any value has a leading zero (`'0301234567'`, `'01234'`) —
  such columns are zero-padded identifiers (phone numbers, postal codes),
  not numbers. Previously `Number()` silently dropped the leading zero
  (data corruption) AND the column skipped the mandatory C0 privacy scan
  because number-typed columns are assumed to have no free-text surface.
  Both bugs are fixed by keeping such columns `'string'`-typed, which
  restores the scan and preserves the value verbatim.
- Fixup (round 2, adversarial cross-vendor review): the chat-attachment CSV
  auto-ingest path (`orchestrator.ts`'s `ingestAttachments`) was writing
  `ownerOmadiaUserId` from the turn's raw channel-native id (Teams AAD oid,
  …) instead of the canonical `omadiaUserId` uuid the KG's ACL routes
  filter on. `ChatTurnInput` gains an optional `channelIdentity` field
  (`{ channelKind, channelUserId }`, populated only by
  `createOrchestratorDispatcher` for channel kinds the KG model has a
  mapping for); the CSV-import call site now resolves it via
  `KnowledgeGraph.resolveOrCreateChannelIdentity` before using it as the
  dataset owner, and declines the KG-import branch (falling back to the
  plain-text attachment path) rather than guess for a channel it can't map.
- Fixup (round 2): per-cell CSV truncation (`MAX_CELL_CHARS` in
  `datasetImport.ts`) is still applied but is no longer silent —
  `parseCsv`/`buildDatasetFromCsv`/`importCsvDataset` now return a
  `truncation: { truncatedCellCount, truncatedColumns }` alongside
  `privacyScan`, surfaced in the `POST /api/v1/datasets` response and in the
  chat-ingest tool-result note.
- Fixup (round 2): `NeonKnowledgeGraph`'s `contains` dataset filter now
  escapes `%`, `_`, and `\` in the filter value before wrapping it for
  `ILIKE ... ESCAPE '\'`, so a literal `%`/`_` in the value matches literally
  instead of being treated as a SQL wildcard — matching the in-memory
  backend's literal substring `.includes()` semantics.
- Fixup (round 2): `InMemoryKnowledgeGraph`'s grouped dataset query now caps
  results at 200 groups (sorted by aggregate value descending, nulls last),
  matching `NeonKnowledgeGraph`'s existing `LIMIT 200` — an unbounded
  group-by could otherwise blow the turn token budget through the
  in-memory backend only.
- Scope correction: this change addresses #430's CSV import/query path.
  #430's own triage acceptance criteria also call for an admin
  upload/schema/delete UI, which is deliberately not part of this change —
  see Phase 14 in `docs/middleware-agent-handoff.md` §13 for the tracked
  follow-up.
- Fixup (round 3, adversarial review): `InMemoryKnowledgeGraph`'s
  `matchesDatasetFilter` compared `eq`/`neq`/`contains` filter values with
  no type coercion (`value === filter.value`), while
  `NeonKnowledgeGraph`'s `buildDatasetFilterClause` already coerced
  `filter.value` to the target column's declared type
  (`::numeric`/`::text`) before comparing. Concrete failing case: a
  `number` column `amount` storing `250` (a JS number) with
  `query_dataset` filter `{column:'amount', op:'eq', value:'250'}` (a JSON
  string — the tool's Zod schema permits this regardless of column type or
  op) matched on Neon but silently returned `totalMatched: 0` on the
  in-memory backend for the identical logical query. Fixed by coercing
  `filter.value` against the row value using the column's schema-declared
  type, mirroring Neon's cast choice exactly (`Number(...)` for a
  `number` column, `String(...)` otherwise; `contains` now also coerces a
  non-string `filter.value` to a string before the substring check instead
  of rejecting it). Regression test added in
  `middleware/test/inMemoryKnowledgeGraph.test.ts` reproducing the exact
  case above plus the `neq`/`contains` mirrors.
- Fixup (round 5, adversarial review): round 2's channel-identity fix only
  covered the IMPORT path (`ingestAttachments`) — `QueryDatasetTool.handle`
  still resolved the viewer as `turnContext.current()?.userId`, the RAW
  channel-native id, never the canonical `omadiaUserId` a channel turn's
  dataset was actually stored under. Net effect: a dataset imported via
  Teams/Slack/Telegram chat could never be found again by `list_datasets` /
  `get_schema` / `query_rows` from that same chat — the exact "query
  ingested datasets" requirement #430 exists for. Fixed by resolving the
  canonical id ONCE per turn (`resolveTurnOwnerIdentity`, new
  `TurnContextValue.resolvedOmadiaUserId`) in both `runTurn` and
  `chatStream` (the latter is what channel adapters actually call —
  previously it never populated any per-turn user identity at all for the
  `query_dataset`/dataset-ACL purpose), and pointing both `QueryDatasetTool`
  and `ingestAttachments` at that single shared value instead of each
  re-deriving it. Regression test in `queryDatasetTool.test.ts` simulates a
  channel turn's raw-id-at-write-vs-read mismatch end-to-end.
- Fixup (round 6, adversarial review): round 1's `LEADING_ZERO_RE` fix only
  matched an UNSIGNED leading zero (`/^0\d/`), so a signed zero-padded value
  like `-0123`/`-0456` still passed `NUMBER_RE` (which allows an optional
  leading `-`) without tripping the leading-zero guard — the exact same
  corruption-plus-scan-bypass defect as round 1, just missed for the signed
  case. Fixed by widening the pattern to `/^-?0\d/`, which still correctly
  excludes a bare `0`/`-0` or a `0.x`/`-0.x` decimal (those are followed by
  nothing or a `.`, not another digit). Regression test added in
  `datasetImport.test.ts` with signed zero-padded values proving the column
  types as `'string'`, the value round-trips with sign and leading zero
  intact, and the privacy scan runs on it.
- Fixup (round 7, adversarial review): `POST /api/v1/datasets` was the only
  one of the five dataset route handlers (`middleware/src/routes/datasets.ts`)
  with no `try/catch` around its core call (`importCsvDataset`). Since
  Express 5 auto-forwards async rejections to its default error handler and
  this app registers no global JSON error middleware, an unexpected THROWN
  error during import (e.g. a transient Postgres error inside
  `NeonKnowledgeGraph.ingestDataset`) fell through to Express's default
  handler and returned an HTML error page instead of the `{code, message}`
  JSON envelope every other dataset endpoint already returns via
  `mapErrorToHttp`. Fixed by wrapping the handler's `importCsvDataset` call
  in the same `try/catch` + `mapErrorToHttp` pattern the other four
  handlers use — the existing, already-handled `{ok: false, reason}`
  not-ok/privacy-rejection return path is unchanged. Regression test added
  in `datasetsRoute.test.ts` with a graph whose `ingestDataset` throws,
  asserting the route returns a JSON `{code, message}` body.

### Fixed — orchestrator no longer offers or invokes a not-yet-authenticated plugin's tools (#474)

- A native plugin (`ctx.tools.register` from `activate()`) whose own
  connection/auth setup is still pending — reported via the existing
  `ctx.status.report({state: 'needs_action' | 'error'})` — is now excluded
  from the tool list the orchestrator offers the model
  (`Orchestrator.buildToolsList`), instead of being offered and failing on
  the first call. The same check runs again at invocation time
  (`Orchestrator.dispatchToolInner` and the standalone
  `ToolDispatchService` used by the subscription-CLI provider), so a status
  change between list-assembly and the actual call can't slip through
  either. Plugins that never report a status (the common case — no
  connection step) are unaffected. Deliberately separate from the
  MCP-server-specific auth-gap flow (`mcpOAuthService`), which already
  handles that case for MCP servers.
- Follow-up (review round 2): `Orchestrator.getSystemPrompt()` now applies
  the same `isToolAvailable` gate to the plugin `promptDoc` collection that
  `buildToolsList()` already applied to the tool specs — a gated plugin's
  documentation is no longer spliced into the system prompt while its tool
  is simultaneously hidden from `tools[]`. Previously the model would still
  be told about a capability whose spec had just been removed, replacing a
  clean "tool not offered" state with a confusing "documented but missing
  tool" one.
- Follow-up (review round 3): the gate only covered native tools registered
  via `ctx.tools.register()` — `Orchestrator.buildToolsList()` still
  appended every `DomainTool` (the dynamic-agent-plugin tools, e.g.
  `query_<slug>`) unconditionally, and `dispatchToolInner()` still invoked
  a matching one without any readiness check. Both call sites now apply
  the same `isToolAvailable(agentId)` gate `DomainTool.agentId` already
  carries, so a not-ready plugin's domain tool is excluded from `tools[]`
  and refused (`Error:`-prefixed, handler never invoked) at dispatch time,
  matching the native-tool path exactly.
- Follow-up (review round 4): two remaining gaps of the same kind. First,
  `Orchestrator.buildSystemPrompt()`'s "Fach-Agenten" roster block — the
  human-readable list of domain tools rendered ahead of the tool specs —
  still listed every `DomainTool` unconditionally, so a not-ready plugin's
  tool was hidden from `tools[]` but the model was still told to route to it
  by name. `Orchestrator.getSystemPrompt()` now filters the roster through
  the same `isToolAvailable(agentId)` gate before it reaches
  `buildSystemPrompt()`. Second, `PluginStatusRegistry.isReady()` only
  returned `true` when there was no stored status entry at all — correctness
  depended entirely on every caller normalizing `state: 'ok'` into `clear()`
  before it reached the registry's own `set()`, which only the higher-level
  `StatusAccessor.report()` in `pluginContext.ts` did. `isReady()` now
  checks the stored entry's `state` directly (`!entry ||
  (entry.state !== 'needs_action' && entry.state !== 'error')`), so it stays
  correct even for a caller that stores `{state: 'ok'}` via `set()` directly.
  Also closed during the same audit: `Orchestrator.directLineObligationState()`
  (the `#332` forced-delegation primitive) could still resolve a not-ready
  plugin's domain tool as the turn's forced `tool_choice`, which would name a
  tool `buildToolsList()` had already excluded from `tools[]` — now gated the
  same way.
- Follow-up (review round 4/final): the last unguarded consumer of
  `domainToolsByName` — the DirectLine (`#token`) candidate resolution in
  `Orchestrator.executeDirectLine()` — still let a not-ready plugin's
  `#token` resolve successfully. `dispatchToolInner()` already refused the
  handler safely, but its raw `Error: tool … is unavailable …` string was
  then wrapped into a `delegatedAnswer` and shown to the user as though the
  specialist itself had answered. The resolved candidate's readiness is now
  checked against the same `isToolAvailable(agentId)` gate right after
  resolution, reusing the existing "Specialist … is no longer available."
  notice already used for a deleted tool, instead of surfacing the internal
  dispatch-error string.
- Follow-up (review round 5): every gate above depended on the plugin's own
  code calling `ctx.status.report(...)`. The generic install/Connect flow
  never does this automatically — `installService.ts` activates a
  `type:'oauth'` plugin (registering its tools) the moment `configure()`
  completes, which is BEFORE the operator has clicked "Connect" and the
  kernel OAuth broker has stored any tokens. A plugin author who never wrote
  an explicit status-report call for this (the common case) still had its
  tools offered and invoked, failing with `OAuthTokenError('not_connected')`
  on the first call — the exact round-trip #474 was filed to eliminate. A
  new `OAuthReadinessTracker` derives connection state from the same vault
  state `ctx.oauthTokens` reads, refreshed on every `ToolPluginRuntime` /
  `DynamicAgentRuntime` `activate()` (fresh install, boot reactivation, and
  post-Connect reactivation all funnel through this single choke point per
  runtime). The orchestrator's readiness gate now ANDs this automatic signal
  with the existing `PluginStatusRegistry` one — either can withhold
  readiness — kept as two separate caches rather than one merged into the
  other, so neither can silently clobber the other's verdict.
- Follow-up (review round 8): every gate above only covered
  `ctx.tools.register()` — `NativeToolRegistry.registerHandler()` (used by
  `ctx.tools.registerHandler()` for tools whose wire-spec the kernel emits
  itself, e.g. the Anthropic-native `memory` tool used today by
  `harness-memory` / `harness-memory-postgres`) never stored an `agentId` on
  its entry at all, so `isToolAvailable`'s `agentId === undefined ⇒
  always-available` default — correct for a genuinely kernel-internal
  registration — incorrectly also applied to ANY plugin using this path
  instead of `register()`, leaving its `promptDoc` in the system prompt and
  its handler dispatchable regardless of the plugin's own readiness.
  `NativeToolHandlerRegistrationOptions` and the stored
  `NativeToolRegistration` entry both gained the same optional `agentId` the
  `register()` path already carries, and `ctx.tools.registerHandler()` in
  `pluginContext.ts` now passes the calling plugin's own id, mirroring
  `ctx.tools.register()`'s existing wiring exactly — no new gate logic, the
  entry just flows through the same `isToolAvailable(agentId)` check every
  other path already uses. The two current `registerHandler()` callers
  (`harness-memory`, `harness-memory-postgres`) are unaffected in practice:
  neither reports a connection status, so `PluginStatusRegistry.isReady()`
  defaults them to ready, exactly as before this fix.
- Follow-up (review round 10), two remaining gaps: (1)
  `OAuthReadinessTracker.refresh()` treated `tokens !== undefined` alone as
  "connected" — it only checked that SOME token bundle was stored in the
  vault, not that it was actually usable. `ctx.oauthTokens.get()`
  (`pluginContext.ts`) throws `OAuthTokenError('refresh_failed')` for a
  token that's expired AND has no refresh token to renew it with, so a
  plugin in that state was still reported ready, offered, and dispatched —
  failing on the first real call with the exact wasted round-trip #474 was
  filed to eliminate. The "still fresh" expiry check `ctx.oauthTokens.get()`
  already computes is now factored out into `tokenStore.ts`'s
  `isTokenStillFresh`/`isTokenRefreshable` and reused by both call sites, so
  the two can never drift on what counts as expired; a token that's expired
  but HAS a refresh token still counts as ready (a refresh is expected to
  succeed transparently). (2) The built-in Anthropic `memory` tool
  (`{type:'memory_20250818', name:'memory'}`) is special-cased in both
  `buildToolsList()` and `dispatchToolInner()` and dispatched via the
  orchestrator's own per-Agent-scoped `memoryToolHandler` BEFORE the general
  `NativeToolRegistry`/`isToolAvailable(agentId)` gate is ever consulted —
  so a plugin contributing `memory` via `ctx.tools.registerHandler('memory',
  ...)` (the same path `harness-memory`/`harness-memory-postgres` use) with
  `isPluginToolsReady(pluginId) === false` still had it offered and
  dispatched, completely bypassing round 8's fix. Both call sites now look
  up the `memory` entry's own `agentId` (if any plugin registered it) and
  run it through the same `isToolAvailable` gate before taking the fast
  path. A marker-only / agentId-less entry (nothing registered `memory` via
  a plugin) keeps the existing "no agentId ⇒ always-available" default, so
  the two current always-ready memory plugins are unaffected as long as they
  haven't reported not-ready — covered by a new test alongside the
  gated-plugin case.
- Follow-up (review round 12): `OAuthReadinessTracker.isConnected()` read a
  boolean cached once inside `refresh()` — activation time — instead of
  re-checking freshness against the current wall clock. A plugin activating
  with, say, 10 minutes of token freshness left and no refresh token cached
  as "ready" and stayed that way until the NEXT activation, even after
  crossing `tokenStore.ts`'s 5-minute `OAUTH_REFRESH_MARGIN_MS`, where a real
  `ctx.oauthTokens.get()` call would already throw
  `OAuthTokenError('refresh_failed')` — reproducing the exact wasted
  round-trip #474 exists to prevent, just shifted into the gap between
  activations instead of at activation time. `refresh()` now caches only the
  raw per-field `StoredOAuthTokens` (the genuinely async vault read), and
  `isConnected()` recomputes `isTokenRefreshable()`/`isTokenStillFresh()`
  fresh on every call against `Date.now()` — both are pure, synchronous,
  in-memory checks, so recomputing per read has no latency cost. Mirrors how
  `ctx.oauthTokens.get()` itself never caches a verdict either. Covered by a
  new test using `t.mock.timers` to advance the clock past the refresh
  margin without a new `refresh()` call.

### Fixed — streamed turns no longer report a bare error after a tool already committed (#506)

- Root-cause fix for issue #506's actual one-click repro (the earlier
  reconciliation work below only helped on a *retry*). `chatStreamInner`
  in `middleware/packages/harness-orchestrator/src/orchestrator.ts` wraps
  its whole per-turn iteration loop — tool dispatch and every subsequent
  `streamMessageEvents` call — in a single `try`/`catch`. Any exception
  caught there unconditionally yielded a bare `{ type: 'error' }` event,
  even when it happened in a LATER iteration (e.g. the model call that
  generates the natural-language confirmation), after an EARLIER
  iteration's tool call had already committed its side effect and already
  yielded a successful `tool_result`. A user who clicked a create action
  exactly once would have it created server-side and still see a generic
  "Etwas ist schief gegangen" with zero diagnostic value — the false
  negative the issue was filed against. The streaming iteration loop now
  tracks, generically and tool-agnostically (by name only, no per-tool
  special-casing), whether at least one `tool_result` succeeded
  (`isError` falsy) this turn. When the catch block is reached with at
  least one such committed result recorded, it now yields a `done` event
  instead — `ChatStreamEvent`'s existing normal-completion shape,
  already rendered correctly by every channel adapter — with an honest
  answer naming the tool(s) that completed and stating that the turn
  itself could not finish generating a follow-up response. It does not
  claim the whole turn succeeded, and it does not fabricate tool-specific
  detail it doesn't generically have. The underlying error is still
  `console.error`-logged exactly as before for server-side diagnostics;
  only the event yielded to the caller changes. A turn where nothing
  committed yet (the genuine-failure case — e.g. the very first model
  call fails, or the tool call itself errored) still yields `{ type:
  'error' }` unchanged. Together with the reconciliation fix below, this
  closes #506 for both the one-click repro and the retry-duplication
  case; the correlation-id/error-token secondary ask remains explicitly
  out of scope (see below).
- Review follow-up: the emergency `done` yielded from the catch block above
  did not call `this.sessionLogger.log(...)` first — the ONE thing every
  other `done`-emission site in `chatStreamInner` does before yielding (see
  `SessionLogger`'s doc comment: the transcript is what lets a follow-up
  turn recall prior discussion, and what survives a mid-turn crash). For a
  tool whose side effect isn't idempotently reconciled the way routine-create
  now is (e.g. `send_email`, `book_meeting`), an unlogged commit meant the
  *next* turn had no record it happened and could re-invoke the same tool —
  the exact duplicate-side-effect class of bug this fix exists to prevent,
  reintroduced by the fix's own new code path. The emergency-`done` path now
  calls `sessionLogger.log(...)` with the same argument shape as the other
  sites (`scope`, `userMessage`, `assistantAnswer`, `toolCalls`,
  `iterations`, `entityRefs`, optional `userId`/`runTrace`), best-effort
  (a logging failure is caught and logged, never swallows the `done`), and
  surfaces `turnId`/`runTrace` on the yielded event when persistence
  succeeded. `committedToolReporting.test.ts` now constructs the test
  orchestrator WITH a recording `sessionLogger` (the prior 2 tests built one
  without any logger at all, which is why the gap was invisible) and asserts
  the log call happened, with matching `scope`/`userMessage`/
  `assistantAnswer`/`toolCalls`/`iterations`, plus that a genuine failure
  (nothing committed) still does not log.
- Review follow-up: the fix above tracks `committedToolNames` generically —
  ANY successful `tool_result` this turn counts as "committed," with no
  distinction between a read-only tool and a mutating one. A reviewer raised
  the concrete scenario where a read-only tool (e.g. `list_routines`)
  succeeds and a LATER, more consequential tool call then never runs because
  of a transient failure in the model call that would have requested it —
  the turn still reports `done`. This tradeoff — generic-across-all-tools
  vs. narrowed-to-routine-create-only vs. dropping the orchestrator fix
  entirely — was weighed and resolved in favor of keeping the current
  generic, tool-agnostic behavior across all tools, accepting the residual
  risk described above in exchange for fixing the false-negative-on-success
  bug for every side-effecting tool, not just routine creation. This is now
  documented as a deliberate decision (not an oversight) directly in the
  code, on both `committedToolNames`'s
  declaration and the catch block's done-vs-error branch in
  `orchestrator.ts`, and pinned by a new `committedToolReporting.test.ts`
  case (`reports done even when a later intended action never ran (accepted
  tradeoff, see code comment)`) that exercises exactly this multi-tool
  scenario. No production logic changed in this round.

### Fixed — routine create no longer reports failure for a retry that already succeeded (#506)

- `RoutineRunner.createRoutine` previously let a retried `create` (e.g. after
  the turn's own confirmation never made it back over the channel) fall
  through to `RoutineNameConflictError` — a message with no diagnostic value
  that nudged the caller toward trying again under a different name and
  actually duplicating the routine. It now reconciles: on a name conflict it
  looks up the existing row (`RoutineStore.getByName`, new) and, if the
  `cron`/`prompt`/`channel`/`timeoutMs` match what was just requested,
  returns that row instead of raising — the earlier call already succeeded,
  so the retry now sees success too. Reconciliation only fires against an
  `active` existing row: a paused/inactive same-name row with otherwise
  identical fields still raises `RoutineNameConflictError`, because that is
  a genuine, separate collision (e.g. a paused "demo" routine plus a new,
  deliberate create under the same name), not the caller's own in-flight
  retry — silently reconciling there would report a successful create with
  no active schedule, which is a worse instance of the exact
  false-negative/false-positive problem this issue was filed to fix.
  Reconciliation deliberately does not additionally gate on the existing
  row's age/`createdAt`; see the code comment in `createRoutine` for why. A
  conflict with genuinely different fields still raises
  `RoutineNameConflictError` as before. Threading a
  request/trace correlation id through routine-turn error responses
  end-to-end (the issue's secondary ask) remains open — it would require a
  new field on the shared `ChatTurnInput`/`ChatTurnResult` contract
  (`@omadia/channel-sdk`) plus support in every channel adapter, which is
  broader than this fix. The literal error wording shown in Teams
  ("Etwas ist schief gegangen …") lives in the external Teams-channel
  adapter plugin and is out of scope for this repo.
  `isSameRoutineRequest`'s field comparison omitted `outputTemplate` — an
  independently-settable object field on both `Routine` and
  `CreateRoutineInput` (Phase C structured-output templates). A retried
  create that agreed on `cron`/`prompt`/`channel`/`timeoutMs` but carried a
  *different* `outputTemplate` (e.g. the caller adding or changing the
  structured template on an existing schedule) would reconcile to the old
  row and silently discard the new template while reporting success — the
  exact class of bug this issue exists to eliminate, on a field the fix's
  own comparison had missed. `isSameRoutineRequest` now compares
  `outputTemplate` too, via `node:util`'s `isDeepStrictEqual` (it is an
  object, so reference/`===` equality is not sufficient); an identical
  template (including the `null`/`null` case) still reconciles as before.
  The reconciliation check also ran too late: `createRoutine` evaluated the
  per-user quota (`countActiveForUser`) *before* attempting `store.create()`,
  so a retry from a user already sitting at `maxActivePerUser` — exactly the
  state their own successful-but-unconfirmed first call left them in — was
  rejected with `RoutineQuotaExceededError` before it ever reached the
  conflict-reconciliation logic, resurfacing the same false-negative under a
  different exception type. `createRoutine` now looks up
  `RoutineStore.getByName` and reconciles a same-request, `active` retry
  *before* the quota check and before calling `store.create()` at all — no
  new row is needed for a retry that already succeeded. The quota check
  still applies to every genuinely new routine request. The reconciliation
  logic in the `store.create()` catch block is unchanged and remains the
  necessary race-safety net for a concurrent request that creates the
  matching row between this proactive lookup and the insert.
  `isSameRoutineRequest` also excluded `conversationRef` from its
  comparison, reasoning it was a delivery-mechanism detail the caller
  doesn't control byte-for-byte. That's wrong on the cold-start outreach
  path: `ManageRoutineTool.handleCreate` resolves `conversationRef` from
  a caller-supplied `targetEmail` via `buildEmailColdStartTarget` before
  calling `createRoutine`, so it *is* caller-specified there. A create for
  a new `targetEmail` that otherwise matched an existing active routine
  (same tenant/user/name/cron/prompt/channel/timeoutMs/`outputTemplate`)
  would silently reconcile to the existing row and report success, while
  the new recipient was never set up and the routine kept messaging the
  original one — a silent-wrong-recipient bug. `isSameRoutineRequest` now
  compares `conversationRef` too, via `isDeepStrictEqual` (same rationale
  as `outputTemplate`: it is an object, and `buildEmailColdStartTarget`
  resolves deterministically per email, so deep equality correctly
  distinguishes a true retry from a different-recipient request).
- Review follow-up: `RoutineStore.create()` normalizes an omitted
  `conversationRef` to `{}` before persisting it (and reads it back the
  same way — `JSON.stringify(input.conversationRef ?? {})`), but
  `isSameRoutineRequest`'s new `conversationRef` comparison above compared
  the stored (normalized) value against the RAW retry input with no
  equivalent `?? {}` default, unlike `timeoutMs` and `outputTemplate`,
  which already apply the same default the store itself uses. On the
  ordinary (non-cold-start) create path — where `conversationRef` is
  legitimately `undefined`/omitted both on the original call and the retry,
  since only the `targetEmail` cold-start branch sets a non-default value —
  the stored `{}` never matched the retry's raw `undefined`, so the retry
  fell through to `RoutineNameConflictError`, reintroducing the exact
  false-negative issue #506 exists to fix for that path.
  `isSameRoutineRequest` now applies the same `?? {}` normalization the
  store uses: `isDeepStrictEqual(existing.conversationRef, input.conversationRef ?? {})`.

### Fixed — Teams-uploaded images now reach the model as vision input (#504, #505)

- Teams delivers inbound images via a Tigris `storage_key` + `[attachments-info]`
  manifest, never inline `bytesBase64`. The attachment auto-ingest path fetched
  those bytes but handed them to the text extractor, which correctly refuses
  images — so the fetched image was silently dropped and never reached the
  model, leaving the agent to falsely claim it couldn't see the image.
  `ingestAttachments` now routes image candidates through a new
  `checkVisionEmbeddable` guard (supported type + size cap) and embeds them
  as Anthropic vision content-blocks via `buildUserContent`, the same path
  Telegram's inline `bytesBase64` attachments already use (#504).
- Also implemented the `url`-fetch fallback that `chatAgent.ts` / `incoming.ts`
  document but the orchestrator never honored: an image attachment with a
  `url` and no pre-fetched `bytesBase64` is now fetched and embedded the same
  way. Latent today (no in-repo channel triggers it yet), but closes the gap
  before a future url-only channel (Slack, Discord, WhatsApp) ships broken
  vision silently (#505).
- Review round 2: neither path checked whether the active provider/model
  actually supports vision before building an image content-block, so a
  turn routed through a non-vision provider could still get an image block
  the API might reject or silently drop — reintroducing the same "agent
  can't see the image, nothing indicates why" failure. Both call sites now
  read `this.provider.capabilities.vision` and thread it through
  `ingestAttachments`/`buildUserContent`: when unsupported, no image
  content-block is built (avoids the provider rejecting the whole request),
  and image candidates aren't even fetched — but the attachment is never
  silently dropped either. A visible note (`[N image attachment(s) received
  but the active model does not support image input]`) is folded into the
  turn's text instead, so the model — and the user — knows an image existed
  and why it wasn't seen. `claude-cli`-routed turns (`CliChatAgent`, swapped
  in by `buildOrchestrator.ts` on `provider.id === 'claude-cli'`) take a
  separate code path that never calls `buildUserContent`/`ingestAttachments`
  at all; this change does not touch, fix, or regress that path.
- Review round 4: a fetched image candidate that failed the
  `checkVisionEmbeddable` guard (oversized, or an unsupported format
  such as SVG/BMP/TIFF) under a VISION-CAPABLE provider was only logged via
  `console.warn` and silently dropped otherwise — the same silent-drop
  failure #504 exists to close, just triggered by size/format instead of
  provider capability. `ingestAttachments` now also collects each
  rejection's reason, and `buildUserContent` folds a visible
  `[N image attachment(s) could not be shown: <reason(s)>]` note into the
  turn's text alongside (never instead of) the existing non-vision-provider
  note.
- Review round 6 (cross-vendor): the vision guard read
  `this.provider.capabilities.vision` — a flag on the PROVIDER CONNECTION,
  not the active MODEL. This is wrong whenever one connection serves
  multiple models with different vision support, which is not hypothetical:
  the bundled `mistral` openai-compatible connection serves
  `mistral-large-latest` and `mistral-medium-latest` (vision) alongside
  `mistral-small-latest` (no vision), yet `llm-adapter-openai`'s
  `openaiProvider.ts` hardcodes `capabilities.vision = true` on the
  connection regardless of the active model — so a turn on
  `mistral-small-latest` would still build an image block for a model that
  can't use it. `OrchestratorOptions` gained a new optional
  `visionSupported?: boolean` — the ACTIVE model's vision capability, meant
  to be resolved by the caller the same way `maxTokens` is already resolved
  per-model, since `harness-orchestrator` deliberately has no dependency on
  `@omadia/llm-provider`/`@omadia/llm-provider-api` and does not resolve the
  model registry itself. Both call sites now read `this.visionSupported ??
  this.provider.capabilities.vision` — an explicit per-model value would win
  if one were passed; omitting it preserves the exact prior provider-level
  behavior. **This is a mechanism, not an end-to-end fix**: as of this PR no
  real caller (`buildOrchestrator.ts`, `plugin.ts`, or any bundled config)
  sets `visionSupported` yet, so the concrete `mistral-small` scenario above
  is made fixable, not actually resolved in production today — a future
  change still needs to wire the active model's real vision capability
  through to `OrchestratorOptions` for any given connection. Backward
  compatible either way: no caller passing it is a no-op, not a regression.
- Review round 7: `checkVisionEmbeddable` compared the fetched image's RAW
  byte length against a 5MB cap, but that cap is Anthropic's documented
  per-image *base64-encoded* payload limit — comparing raw bytes against a
  base64-payload limit is the wrong unit, and rejected valid images (e.g. a
  ~5.5MB raw screenshot, ~7.3MB once base64-encoded) that were well under the
  real limit. The 5MB figure was also wrong for this deployment: the bundled
  Anthropic provider (`builtinLlmProviders.ts`) uses
  `https://api.anthropic.com` — the direct API, whose documented limit is
  10MB base64-encoded (5MB base64 applies only to Bedrock/Vertex). The guard
  now computes the base64-encoded size (`Math.ceil(rawBytes / 3) * 4`) and
  compares it against a corrected `MAX_VISION_IMAGE_BASE64_BYTES = 10MB`
  constant.

### Fixed — codegen: manifest capabilities[] now reflect per-tool spec flags (#507)

- `reproduceManifestCapabilities` (builder codegen) used to clone the
  boilerplate's `search` capability (`input_schema:{query}`,
  `side_effects:'read'`, `idempotent:true`, `autonomous:true`,
  `timeout_ms:20000`) onto every tool, substituting only id/description.
  `toolkit.ts` was generated correctly per-tool from the real Zod schemas,
  but `manifest.yaml`'s declared metadata was not: write tools shipped as
  `side_effects:'read'` + `autonomous:true`, misrepresenting their real
  behavior to anything that reads the manifest (marketplace listings,
  human reviewers, or any orchestrator-side consumer of these flags).
  `ToolSpecSchema` gained explicit `output`, `side_effects`, `idempotent`,
  `autonomous`, and `timeout_ms` fields (previously stripped silently by
  Zod's non-strict mode) so codegen can synthesise each `capabilities[]`
  entry from the real per-tool spec, falling back to the boilerplate
  defaults only for fields a tool omits. Applies uniformly to single- and
  multi-tool specs. `side_effects` is declared and passed through as the
  manifest's own `'read' | 'write' | 'none'` string enum (matching
  `agent-integration/manifest.yaml` and `agent-reference-maximum/manifest.yaml`),
  not a boolean — an earlier draft of this fix used a boolean field with a
  boolean-to-string mapping in codegen, which rejected valid spec/patch
  payloads shaped like the manifest's real contract.

### Added — Builder health score: context-quality decomposition, first slice (#499)

- `middleware/src/profileSnapshots/healthScore.ts` gained
  `computeContextQualityScore`, decomposing Builder agent-spec quality into
  the seven context-quality criteria from arXiv:2607.14275 ("AI Agents Do Not
  Fail Alone: The Context Fails First"): role clarity, guardrail coverage,
  instruction consistency, tool schema quality, grounding sufficiency,
  injection hardening, token efficiency. Each criterion carries a score (or
  `null` when not yet evaluated), a rationale, the failure mode it predicts,
  and a fix hint.
- Four criteria are deterministic and wired to existing subsystems:
  guardrail coverage (`boundaryPresets.ts` category coverage), tool schema
  quality (`manifestLinter.validateSpec` tool-id checks plus
  `agentSpec.validateSpecForCodegen`'s tools/external_reads namespace
  collision + reserved-id checks), grounding sufficiency (a knowledge-source
  attached-and-resolvable proxy on `permissions.graph.entity_systems` /
  `external_reads`, cross-checked against manifestLinter's
  `external_read_unknown_service` / `external_read_integration_missing`
  violations so an unregistered service doesn't score as "grounded"), and
  token efficiency (a persona-delta token budget via `personaCompose.ts`).
- Role clarity, instruction consistency, and the domain-coverage half of
  grounding sufficiency need judgment a deterministic check can't provide;
  they're returned as `evaluated: false` pending a future LLM-juror pass
  rather than faked with a proxy.
- Purely additive — `computeHealthScore` (the diff-based drift score
  `driftWorker.ts` persists) is untouched. Builder UI wiring and
  `driftWorker.ts` snapshot wiring are deferred to follow-up work; see #499.
### Fixed — templates v2 review round 3: owner-aware publish vs. auth timing (#478)

- The save-as-template dialog no longer reads the viewer's own template id as
  "taken" while the `getAuthMe` identity probe is still in flight. Ownership is
  now derived from live viewer state plus a new `viewerPending` flag: a
  user-sourced id collision holds a gated "Checking ownership" pending state
  (busy-dots, submit disabled) and flips to "Publish as v{n+1}" — or the
  id-taken error — once the viewer is known. Bundled/plugin collisions stay
  terminal, and the 409-race re-check keeps working (now also pending-aware).

### Fixed — templates v2 review round 2: input hardening, token placement (#478)

- `checkTemplateManifest` (conductor-core) no longer throws on malformed input:
  `POST /conductors/templates` with `{}` (or a manifest whose `slots` / kind
  lists / entries have the wrong shape) now returns a 400
  `conductor.template_invalid` envelope instead of a 500. The localized-text
  helpers moved to `conductor-core/src/localizedText.ts` (500-line rule; the
  `@omadia/conductor-core` export surface is unchanged).
- Save-as-template text slots are now actually publishable: the dialog gained a
  "Place text-slot tokens" section that edits the graph's designated step texts
  (`step.prompt`, `human.message`) with per-field insert buttons for each
  declared `slot:text:<key>` token, and blocks publish until every declared
  slot's token is placed — previously the manifest shipped without tokens and
  the backend rejected it as `template_text_slot_unused`.
- Stripped committed trailing whitespace from the conductor template test files
  (`git diff --check` hygiene).

### Changed — templates v2 review fixups: step-kind tokens, component splits (#478)

- The Conductor step-kind palette (agent/action/human node colors + badge text)
  moved from hardcoded hex in `ConductorCanvas`/`TemplatePreview` into Lume
  tokens (`--step-kind-*` in `web-ui/app/_lib/theme.css`), consumed through the
  shared `stepKindColors.ts` map — one source of truth, no per-component hex.
- Oversized web-ui files split per the 500-line rule, behavior-preserving:
  `SaveAsTemplateDialog` extracted its ref-/text-slot editor sections into
  `SaveAsTemplateSlotEditors.tsx`; `conductor/page.tsx` extracted the Roles
  (US6) and emit-event sections into `ConductorRolesSection.tsx` and
  `ConductorEmitSection.tsx`.

### Added — builder-chat template proposal cards (#478)

- `ConductorChatPane` (`web-ui/app/conductor/_components/`) renders B4's
  `templateProposals` as up to 3 compact cards under the assistant reply:
  locale-resolved template name, `v{n}` tag, the agent's one-line reason, and a
  slot-coverage line ("{filled} of {total} slots prefilled" — counted against
  DECLARED slots only, parity with the form's prefill seeding). One action,
  **"Use template"**, hands off to the instantiate form via the page's existing
  state plumbing (a prefill analog of the chat→canvas `setChatGraphRequest`
  hand-off): the form opens pinned to the proposed version with the proposal's
  prefill as `initialMapping`. Chat never auto-instantiates — creation stays a
  deliberate form action. A proposal whose template id no longer resolves in
  the catalog degrades to plain text (no dead action). Turns without proposals
  render byte-identically to before; the API client's builder-turn result type
  gains the additive `templateProposals` field.

### Added — instantiate form v2: text slots, graph preview, version pin, update hint (#478)

- `TemplateInstantiateForm` (`web-ui/app/conductor/_components/`) renders one
  required-fill input per declared **text slot** (`slots.text`), the declared
  default prefilled; an emptied defaulted slot is omitted from the mapping so
  the server substitutes the default. The client completeness gate mirrors
  `missingSlotMappings` (a text slot passes with a value OR a default), and the
  server's `kind:'text'` incomplete-mapping entries land inline on the right
  fields via the shared `text:<key>` flag ids. The submitted
  `TemplateSlotMapping` carries the additive `text` record.
- **Graph preview**: new `TemplatePreview` renders the MANIFEST graph — slot
  placeholders shown as their locale-resolved declared labels — into a small
  read-only designer canvas (no stored thumbnails), collapsed by default behind
  a "Preview graph" toggle so only an OPENED form mounts a flow instance. The
  plan drafted this on Cytoscape; the designer actually runs on
  `@xyflow/react`, so the preview is a locked-down React Flow reusing the
  canvas's node styling.
- **Versioning surface**: the form header shows the manifest version
  (`v{n}`); an explicit pinned version travels into `resolve`/`instantiate`.
  Workflows carrying B3's `template.updateAvailable` hint render
  "Template updated (v{n} → v{m})" (warning-colored text only, per Lume) with
  a **"Re-instantiate from v{m}"** action (`TemplateUpdateHint`) that opens the
  instantiate form pinned to the latest version — a deliberate NEW workflow;
  the existing instance keeps its copy (copy-not-reference).
- The form accepts an `initialMapping` prefill (consumed by the builder-chat
  template proposals, F4). API client: `mapping.text` + optional `version` on
  resolve/instantiate, `fetchConductorTemplateVersions`, and the additive
  `template` hint on the workflow wire type.

### Added — template gallery v2: facets, pending-review queue, search, manage actions (#478)

- `TemplateGallery` (`web-ui/app/conductor/_components/`) now renders the
  composite catalog with **provenance facets** (All / Bundled / My templates /
  Shared / Plugins / **Pending review**), client-side **text search** over the
  locale-resolved name/description/useCase, and secondary **use-case chips**.
  "My templates" derives ownership from `createdBy = viewer` (viewer identity
  via the page's existing `getAuthMe` plumbing), falling back to "a visible
  private template is the viewer's own" per the backend visibility rule.
- **Pending review is the reviewer queue**: every `status = 'pending'` user
  template is listed for EVERY operator (the install-wide pending visibility
  rule makes the review gate reachable by non-author reviewers), with the
  submitter shown and **Approve / Reject** actions directly on the card — not
  inside an author-only menu. The facet label carries a waiting-count badge;
  empty state: "No templates waiting for review".
- Cards gain a provenance/status badge (text + edge color only, per Lume), a
  `v{n}` tag, an instantiation count ("Used {n}×"), and author manage actions
  on own user templates: **Submit for review** (private only) and **Delete**
  behind an inline confirm. All mutations refetch the catalog through the
  page (`onCatalogChanged` → `reload()`); errors surface inline as text with
  the server's error message.
- API client (`web-ui/app/_lib/api.ts`): `deleteConductorTemplate`,
  `submitConductorTemplate`, `approveConductorTemplate`,
  `rejectConductorTemplate` over B3's review-gate routes.

### Added — save-as-template dialog in the Conductor admin UI (#478)

- Published workflows in the Conductor page's workflow list gain a **"Save as
  template"** action (only with an active published version). It opens
  `SaveAsTemplateDialog` (`web-ui/app/conductor/_components/`), seeded by the
  backend's inference draft (`POST /:slug/save-as-template`): metadata with
  separate en/de inputs (en required — the manifest's universal fallback; de
  present → a `LocalizedText` record travels, absent → a plain string), the
  inferred ref slots grouped per kind with editable en/de labels and the
  original concrete ref shown as context, and a manual text-slot editor
  (key/label/default, with the paste-able `slot:text:<key>` token shown per
  row — text slots are never inferred).
- **Owner-aware primary action** (the v2 version-publish path): the entered id
  is resolved against the loaded viewer-scoped catalog — unused id → "Publish
  template" (`POST /templates`); an existing USER template with
  `createdBy = viewer` → **"Publish as v{latestVersion+1}"**
  (`PUT /templates/:id`, with a copy-not-reference note that existing
  instances are unaffected and will show an update hint); bundled/plugin/
  foreign id → inline "id taken" error, primary disabled. A **409 race** on
  POST re-fetches the template (`GET /templates/:id`) and, when it turns out
  viewer-owned, switches the dialog into the PUT state instead of
  dead-ending. Viewer identity comes from `GET /auth/me` (`user.id` = the
  session `sub` the backend scopes the catalog by).
- API client (`web-ui/app/_lib/api.ts`): `saveWorkflowAsTemplate`,
  `createConductorTemplate`, `updateConductorTemplate`,
  `fetchConductorTemplate`; `ConductorTemplate` widened with the additive
  catalog metadata (`source/status/createdBy/version/latestVersion/
  instantiationCount/updatedAt`) and `slots.text`
  (`ConductorTemplateTextSlot`). Lume throughout (state colors text/edge
  only, Button busy verb+dots, `.lume-skeleton` while the draft loads); all
  strings i18n'd en+de. Tests:
  `__tests__/SaveAsTemplateDialog.test.tsx` (draft rendering, POST manifest
  shape incl. text slot + de label map, owned-id PUT switch, foreign/bundled
  dead-end, 409-race recovery both ways, missing-en gate, busy-dots).

### Added — builder-chat template awareness (#478)

- The Conductor conversational builder (`src/conductor/builderAgent.ts`) now
  sees the workflow-template catalog: its system prompt carries a compact,
  **viewer-scoped** catalog digest (id, en-resolved name/useCase, version,
  slot list incl. text slots; capped at 30 templates with a count note), and
  the reply protocol accepts an additional `templateProposals` block.
  `POST /builder/turn` returns it **additively** as
  `templateProposals?: [{ templateId, version, reason, prefill }]` — the key
  is absent entirely when there are no proposals, so the v1 wire shape stays
  byte-identical for existing consumers.
- The proposals are server-side gated inside the agent seam (defensive, never
  throws): unknown or viewer-invisible template ids are dropped against the
  composite catalog, duplicates deduped, at most 3 survive, `version` is
  catalog-authoritative (the LLM's claim is ignored), and `prefill` guesses
  are kept only for declared slot keys whose ref values resolve against the
  live `KnownRefs` sets (`channels` has no KnownRefs set → structural
  acceptance, mirroring `validate()`). A stripped guess renders as an empty
  form field, never a broken one. A failing catalog/KnownRefs read degrades
  to a template-less turn instead of a 500. Chat proposes and prefills only —
  instantiation stays on the existing `resolve`/`instantiate` form flow, no
  auto-instantiation. The shared `templateKnownRefs` function is hoisted in
  `src/conductor/index.ts` so the builder's prefill vetting and the template
  routes' strict validation can never drift apart. Tests: extended
  `test/conductorBuilder.test.ts` (digest visibility incl. pending/foreign-
  private, proposal vetting, malformed blocks, no-proposal regression).

### Added — template authoring, review gate, plugin-borne templates, update hint (#478)

- **Save as template** (`POST /:slug/save-as-template` on the conductor
  router — it is mounted at `/api/v1/operator/conductors`, so there is no
  `/workflows` path prefix): loads the workflow's active published version and
  returns an `inferTemplateManifest` **draft** (`{ draft, sourceWorkflow:
  { slug, version } }`) with one declared slot per distinct concrete ref
  (label = the original ref). Nothing is persisted — the UI edits the draft
  and publishes via `POST /templates` (fresh id) or `PUT /templates/:id`
  (new version of an owned id). Body overrides `{ id?, name?, description?,
  useCase? }`; the default id derives from the slug with a `-template` suffix
  on collision; `404 conductor.workflow_not_found` without a published version.
- **Review state machine** (Make's team-template shape, `private → pending →
  shared`): `POST /templates/:id/submit` (author-only; `409
  conductor.template_status_conflict` from any status but `private`),
  `POST /templates/:id/approve` / `reject` (**any authenticated operator** —
  reachable because `pending` templates are visible install-wide; resolved
  through the viewer-scoped catalog `get`, so a non-author reviewer never
  404s). `reviewed_by` is recorded for audit; self-approval stays permitted
  (single-operator installs must not deadlock, separation of duties is an
  explicit deferral). A reject by a non-author flips the template `private`
  and out of the reviewer's visibility — the response then carries
  `template: null`.
- **Template update hint**: workflow list (`GET /`) and detail (`GET /:slug`)
  additively report `template?: { id, version, latestVersion,
  updateAvailable }` when the row carries `template_id`/`template_version`
  provenance. Viewer-scoped: a template the viewer cannot see degrades to
  `latestVersion = version, updateAvailable: false` (no existence leak).
  Copy-not-reference stands — the hint powers deliberate re-instantiation,
  never silent propagation.
- **Plugin-borne workflow templates** — the designed trust boundary (recorded
  in `docs/security-architecture.md` §4): plugins declare TemplateManifest
  JSON files under `permissions.templates` (package-relative paths). Install
  is gated **fail-closed** in the new `src/plugins/pluginTemplates.ts`:
  `.json` only, path confinement after symlink unwrapping, id namespacing
  `plugin:<pluginId>:<name>` (no shadowing of bundled/user ids),
  `checkTemplateManifest({ strict: true })` (undeclared concrete refs
  rejected as confusion/exfiltration vectors), `isValidCron` on cron
  triggers; any violation fails the install with `install.template_invalid`.
  Accepted manifests register as read-only `source: 'plugin'` catalog entries
  (write paths 403), are removed on uninstall, and re-register at boot
  (fail-open per template — the hard gate ran at install time). Templates are
  data, never code: no runtime template API, nothing executed. Tests:
  `test/pluginTemplates.test.ts` (new; gate incl. symlink escape,
  InstallService integration, boot sweep) + extended
  `test/conductorTemplateRoutes.test.ts` (state machine incl. non-author
  approve, inference round-trip, update hint, plugin source read-only).

### Added — DB-backed workflow templates: store, composite catalog, CRUD + versioning routes (#478)

- New Conductor migration **`0006_templates.sql`** (conductor chain,
  `_conductor_migrations`; verified free against open PRs — the top-level
  chain's `0022` belongs to PR #476 and is not used here): `conductor_templates`
  (owner, review `status` `private|pending|shared` — TEXT without CHECK, growable
  enum per the #470 lesson, `latest_version`, `reviewed_by`),
  `conductor_template_versions` (immutable JSONB manifest snapshots,
  PK `(template_id, version)`, mirroring the workflow version store),
  `conductor_template_instantiations` (append-only anonymous telemetry with
  denormalized `template_name` so rows survive deletion — the `0009_mcp_call_log`
  pattern), plus `template_id`/`template_version` provenance columns on
  `conductor_workflows`. Idempotent (`IF NOT EXISTS`), forward-only. The
  conductor migrations dir is now also mirrored into `dist/` by
  `copy-build-assets.mjs` (previously Dockerfile-COPY only, so a plain
  `npm run build` dist missed it).
- New `src/conductor/templateStore.ts` (`createTemplateStore(pool, log)`):
  create (unique violation → typed 409), atomic `addVersion`
  (`latest_version + 1` under `FOR UPDATE`), get/list/delete/setStatus,
  `listVersions`/`getVersion`, `recordInstantiation` + `instantiationCounts`,
  and `stampWorkflowProvenance` (runs on the publish transaction's client).
  The `version` column is authoritative — it is stamped into
  `manifest.version` at write and read, so the JSONB can never drift.
- `templateCatalog.ts` gains the **composite catalog** (bundled files + DB user
  templates + a plugin registration seam for #478 B3) behind a viewer-scoped
  `{ list(viewer), get(id, viewer) }`. **Visibility rule (the reviewer-reachable
  review gate):** bundled/plugin → everyone; a user template is visible iff
  `shared` OR `createdBy = viewer` OR **`pending`** — every operator on the
  single-tier operator API is a potential reviewer, so pending submissions are
  visible install-wide; only foreign `private` templates are hidden. `get`
  applies exactly the list's rule (no 404-vs-list divergence).
- Template routes (split into `src/conductor/templateRoutes.ts` for file size;
  same mount + order, before the `/:slug` catch-all): `GET /templates` now
  serves `TemplateSummary` = manifest + ADDITIVE `source`/`status`/`createdBy`/
  `version`/`latestVersion`/`instantiationCount`/`updatedAt` (v1 fields
  untouched — #330 contract-tested); new `GET /templates/:id`,
  `POST /templates` (private create, `409 conductor.template_id_exists`,
  `400 conductor.template_invalid`), `PUT /templates/:id` (author-only version
  bump; sharing status deliberately unchanged — the gate governs sharing, not
  each version), `DELETE /templates/:id` (author-only, user source only),
  `GET /templates/:id/versions`; `resolve`/`instantiate` accept an optional
  body `version` (default latest). `instantiate` stamps `{template_id,
  template_version}` provenance inside the same transaction as the publish and
  appends a best-effort telemetry row. Viewer identity: `req.session?.sub ??
  'operator'`. Tests: `test/conductorTemplateStore.test.ts` (new, stateful
  fake-pool) + `test/conductorTemplateRoutes.test.ts` (real composite catalog;
  explicit reviewer-reachability cases incl. "pending template of A is listed
  and gettable by B").

### Added — template contract v2: versioning, text slots, slot inference, strict import gate (#478)

- `@omadia/conductor-core` extends the workflow-template contract for templates
  v2, purely additively over the #429 v1 surface: `TemplateManifest.version`
  (integer ≥ 1, absent = 1 — read via the new `templateManifestVersion()`),
  declared **text slots** (`slots.text`, referenced as `slot:text:<key>` tokens
  inside the designated text fields `step.prompt` / `step.human.message` only,
  disjoint from `{{...}}` run-context interpolation, with optional per-slot
  `default`), `TemplateSlotMapping.text` for their instantiation values, and
  `missingSlotMappings` reporting unfilled text slots as `kind: 'text'` entries.
  `checkTemplateManifest` now validates text-slot declaration/usage both ways
  (`template_text_slot_undeclared` / `template_text_slot_unused`) and gains a
  `{ strict: true }` mode for distributed (plugin/hub-imported) manifests that
  rejects any concrete ref left in the five ref fields
  (`template_concrete_ref_in_strict_mode`) — undeclared install-local refs are
  confusion/exfiltration vectors, so distributed templates must declare every
  external ref as a slot. New `inferTemplateManifest(graph, opts)` reverses the
  `extractSlotRefs` walk for "save as template": each distinct concrete ref
  becomes a declared slot with a slugified, de-duplicated key (pre-existing
  `slot:` placeholders pass through), round-trip covered by tests. Pure
  functions only; text-slot machinery lives in the new `src/textSlots.ts`,
  v2 tests in `test/templateV2.test.ts`.

### Fixed — template instantiation slug race can no longer republish over a fresh workflow (#429)

- Two concurrent `POST /templates/:id/instantiate` with the same not-yet-existing
  slug could both pass the route's `getBySlug` pre-check; the loser then fell
  into `createOrPublish`'s `ON CONFLICT DO UPDATE` upsert and silently published
  a second version over the just-created workflow, answering 201 — violating the
  route's own create-new contract. The 409 is now enforced **atomically**:
  `createOrPublish` gains a create-only mode (`expectNew: true` →
  `INSERT … ON CONFLICT (slug) DO NOTHING`; zero returned rows aborts the publish
  transaction with the new `WorkflowSlugExistsError`), the instantiate route drops
  the racy pre-check entirely and maps the error to the existing
  `409 conductor.slug_exists` envelope. `POST /` and the canvas save path keep
  their idempotent upsert untouched. Store-level tests (fake-pool, SQL-shape
  scripted) in `middleware/test/conductorWorkflowStore.test.ts` (new); route
  mapping covered in `middleware/test/conductorTemplateRoutes.test.ts`.

### Fixed — template metadata is localizable in the manifest; bundled templates ship German (#429)

- Template name, description, `useCase` tag, and slot labels/help texts rendered
  raw English strings from the bundled manifests in the German UI. Because
  templates are data (v2 distributes them outside the repo), localization now
  travels **in the manifest**: those fields accept a plain string or an
  `{ en, de?, … }` record with `en` required as the universal fallback
  (`LocalizedText` + `resolveLocalizedText` in `@omadia/conductor-core`;
  `checkTemplateManifest` validates the shape with the new
  `template_invalid_localized_text` code). All four bundled manifests carry
  proper German translations, and the catalog CI gate now asserts bundled en/de
  parity. `GET /templates` keeps returning full, unresolved manifests
  (machine-readable contract for #330) — the gallery and the slot-mapping form
  resolve the active locale client-side via next-intl's `useLocale()` with en
  fallback (`resolveConductorText` in `web-ui/app/_lib/api.ts`); the instantiate
  route resolves its manifest-borne name/description fallbacks to the en base
  before persisting. Missing-slot error envelopes keep flat English labels
  (clients localize by kind+key). Tests: conductor-core `template.test.ts`,
  `conductorTemplateCatalog.test.ts` (parity gate), and de-locale/en-fallback
  component tests for `TemplateGallery` and `TemplateInstantiateForm`.

### Fixed — "Open in designer" no longer drops the template form's enable=OFF default (#429)

- The template slot-mapping form's "Open in designer" handoff only passed
  graph/slug/name to `ConductorCanvas`, whose save path hardcoded
  `publishConductorWorkflow({ ..., enable: true })` — so a cron template left
  on the default-off enable toggle was created **enabled** on Save and started
  its schedule without the form's schedule notice ever applying. The form now
  hands its `enable` choice along (`onOpenInDesigner` target +
  `CanvasGraphRequest.enable`), and the canvas publishes with it. Requests
  without an `enable` choice (chat drafts, US7) and the edit-existing path
  keep the historical enabled-on-save behaviour (the store only applies
  `enable` on first create anyway). Regression tests in
  `web-ui/app/conductor/_components/__tests__/ConductorCanvas.test.tsx` (new)
  and the form tests.

### Added — workflow-template slot-mapping form on /conductor (#429, unit f2)

- Picking "Use template" on `/conductor` now renders the guided instantiation
  form (`web-ui/app/conductor/_components/TemplateInstantiateForm.tsx`) inline
  below the gallery: ONE upfront mapping form for the whole template (never
  per-node walking) with prefilled slug/name fields and one picker per declared
  slot, grouped by kind — roles/agents/actions/events fed by the existing
  designer catalog fetchers (`getConductorRoles` / `getConductorAgents` /
  `getConductorActions` / `getConductorEventCatalog`), channels via the shared
  `ChannelSelect` (prefilled `teams` so the mapping state matches the select's
  display). Three actions: **Create workflow** (primary →
  `POST /templates/:id/instantiate`, then the list reloads), **Open in
  designer** (secondary → `POST /templates/:id/resolve`; the resolved graph
  hydrates `ConductorCanvas` through the existing chat→canvas
  `loadGraphRequest` mechanism — extended with optional `slug`/`name` so the
  canvas form arrives publish-ready under the template instance identity and
  never republishes over a previously loaded workflow's slug; publish then
  goes through the canvas's normal save flow) and **Cancel** (ghost). Enable toggle defaults to OFF; with a
  cron-triggered template and the toggle ON, a persistent warning-colored TEXT
  notice states that the schedule starts as soon as the workflow is created.
  Client gate mirrors the server's completeness check (slug + every slot
  mapped); the b3 error envelope maps to inline errors — missing slots flagged
  field-level (error text + border only), `conductor.slug_exists` (409) on the
  slug field, `conductor.invalid_graph` as a message list. In-flight = verb +
  animated dots via the Button busy recipe (no spinners). i18n en+de under
  `conductor`; Vitest tests in
  `app/conductor/_components/__tests__/TemplateInstantiateForm.test.tsx`.

### Added — workflow-template gallery on /conductor (#429, unit f1)

- The `/conductor` admin page gains a "Workflow templates" section above the
  workflows list: a card grid (`web-ui/app/conductor/_components/TemplateGallery.tsx`)
  rendering the bundled catalog from `GET /templates`. Each card answers "what
  problem does this solve and what will I need to map" before commit — name,
  `useCase` tag, description, a pluralized "You will map: 2 roles · 2 agents ·
  1 channel" slot summary, and a text/edge "Runs on a schedule" badge for
  cron-triggered templates. An empty catalog renders nothing (no empty-state
  noise). "Use template" stores the selection for the slot-mapping form
  (follow-up unit f2). API client (`web-ui/app/_lib/api.ts`) mirrors the
  `TemplateManifest` wire shape locally (web-ui does not depend on
  `@omadia/conductor-core`) and ships all three fetchers —
  `fetchConductorTemplates`, `resolveConductorTemplate`,
  `instantiateConductorTemplate` — so f2 only builds UI. i18n keys under the
  `conductor` namespace in `messages/en.json` + `messages/de.json`; Vitest
  component tests in `app/conductor/_components/__tests__/`.

### Added — conductor workflow-template routes (#429, unit b3)

- Three new operator routes on the auth-gated `/api/v1/operator/conductors`
  (registered before the `/:slug` catch-all): `GET /templates` (full manifests
  incl. graph + slot declarations — machine-readable for #330),
  `POST /templates/:id/resolve` (ephemeral instantiation: substitute the slot
  mapping, validate, return the graph, persist nothing) and
  `POST /templates/:id/instantiate` (publish through the ordinary
  `createOrPublish` path incl. the atomic cron-schedule reconcile; `enable`
  defaults to `false`, `name`/`description` default to the manifest). Error
  contract: `404 conductor.template_not_found`,
  `400 conductor.template_slot_mapping_incomplete` with
  `missing: [{ kind, key, label }]`, `400 conductor.invalid_graph` with the
  existing `unknown_*_ref` codes, `400 conductor.invalid_input` on a missing
  slug and `409 conductor.slug_exists` on a slug collision (deliberate
  divergence from `POST /`'s upsert — instantiation means "create new"). Both
  template routes validate with **live `KnownRefs`** (registry agent slugs,
  action ids, role keys, event catalog) — stricter than `POST /`'s structural
  validation on purpose: a template instance must be runnable, not merely
  well-formed. Wired in `wireConductor`
  (`middleware/src/conductor/index.ts`); route tests with stubbed deps in
  `middleware/test/conductorTemplateRoutes.test.ts`; API documented in
  `docs/middleware-agent-handoff.md` §3.

### Added — bundled conductor workflow-template catalog (#429, unit b2)

- Four curated workflow-template manifests ship as JSON assets in
  `middleware/src/conductor/templates/`: `expense-approval` (manual trigger,
  summarize → approve with 48h deadline → escalation → outcome announcement),
  `notify-and-escalate` (event trigger, triage → acknowledge with hourly
  reminders and 4h deadline → escalation), `weekly-report` (cron `0 8 * * 1`,
  compose → review) and `onboarding-checklist` (sequential HR → IT → manager
  checklists with daily reminders → confirmation). New loader
  `middleware/src/conductor/templateCatalog.ts` scans the dir next to its own
  compiled module (same dirname-relative pattern as the conductor migrator),
  runs `checkTemplateManifest` on every file, and skips invalid/unparsable
  assets with a `[conductor] template <file> invalid: …` log line instead of
  failing boot; `middleware/test/conductorTemplateCatalog.test.ts` is the hard
  CI gate (manifest integrity, synthetic-mapping end-to-end instantiability
  incl. `validate()` with live-style KnownRefs, cron validity, unique
  kebab-case ids, loader skip/duplicate behavior). Build plumbing in the same
  change: `middleware/scripts/copy-build-assets.mjs` mirrors the dir into
  `dist/conductor/templates` — that alone covers the Docker image too, since
  the builder stage runs `npm run build` and the runtime stage copies the
  resulting `dist/` (no Dockerfile change). File-based catalog — **no DB
  migration** (the conductor chain's next free number stays `0006`).

### Added — conductor-core workflow-template contract (#429, unit b1)

- `@omadia/conductor-core` gains the shared workflow-template contract:
  `TemplateManifest` / `TemplateSlots` / `TemplateSlotMapping` types plus pure
  helpers in `src/template.ts` — `extractSlotRefs` (structural walk of the five
  ref fields `step.agentId`, `step.actionId`, role `step.human.principal.ref`,
  `step.human.channel`, `trigger.eventId`), `missingSlotMappings`,
  `applyTemplateSlots` (deep-clone, field-targeted `slot:<kind>:<key>`
  substitution; never touches `{{ctx.*}}` prompt/message interpolation) and
  `checkTemplateManifest` (metadata + structural validate + bidirectional slot
  coverage). Foundation for the file-based template catalog and the
  `/templates` middleware routes (follow-up units on the same branch).

### Added — advisory SkillSpector code scanning for plugin packages (#453)

- Every ingested plugin package (direct upload, hub install, Builder install)
  is optionally scanned by an NVIDIA SkillSpector sidecar
  (`middleware/sidecars/skillspector/`, enabled via `SKILLSPECTOR_URL` /
  `docker-compose.skillspector.yaml`). Fire-and-forget after ingest success —
  a scanner outage records a `scan_failed` verdict and never fails an
  install; with `SKILLSPECTOR_URL` unset nothing is scheduled and NO verdict
  row is written (store pages show no badge on unconfigured deployments).
  The shim and the middleware parser are **fail-closed**: only the
  positively-verified SkillSpector report schema (exit 0, `issues` list +
  `risk_assessment` object — observed against the pinned commit, CLI
  v2.3.11) counts as a scan; any unrecognized output surfaces as
  `scan_failed`, never as a false `no_signals` all-clear. Coverage of the
  executed entry point is guaranteed the same way: upload validation
  rejects a `lifecycle.entry` below `node_modules`/hidden directories
  (`package.entry_unscannable`), and the scanner force-includes the entry
  file when the directory walk skipped it — failing closed (`scan_failed`)
  when it cannot. The sidecar
  dependency is pinned to an exact upstream commit SHA (pin-bump procedure:
  sidecar README). Verdicts are cached by ZIP sha256 + scanner version
  (**migration `0021_plugin_verdict.sql`**, table `plugin_verdicts` incl.
  inline operator ack columns), surface as a badge + `verdict` field on
  `GET /api/v1/store/plugins/:id`, and can be acknowledged via
  `POST /api/v1/store/plugins/:id/verdict/ack`. An ack records the severity
  the operator saw (`ack_severity`) and is cleared automatically when a
  later re-scan WORSENS the verdict; it survives equal-or-better results.
  Advisory-only in v1: nothing blocks. New env vars: `SKILLSPECTOR_URL`,
  `SKILLSPECTOR_TIMEOUT_MS`.

### Added — free-text user-prompt PII masking, default off (#361)

- `harness-plugin-privacy-guard` 0.3.0: new **default-off** setup field
  `mask_user_prompt`. When on, PII spans detected in the user's own message
  (C0 regex baseline: email, IBAN, phone, German street+postal address,
  amounts, DOB dates) are replaced by realistic pseudonyms before the prompt
  crosses the LLM wire (pseudonym projection via the shipped `v4/pseudonym`
  mechanism — no on-wire token map); the real values are restored
  server-side in the final answer, and the spans surface (PII-free) as
  `maskedPromptSpans` on the `PrivacyReceipt`. Failure-closed: C1-detector
  failure degrades to C0 with audit; a baseline failure or residual span
  blocks the turn — there is no pass-through-unmasked path. Flag-off is
  byte-identical to previous behavior.
- Orchestrator: every LLM-bound site (message assembly, **live chat
  history/`priorTurns` — which replays persisted REAL values from earlier
  turns**, ingested attachment tail, **mid-turn steering messages injected
  via `POST /chat/steer`** (masked through the same per-turn map before the
  iteration loop folds them into the conversation), model/persona routing,
  KG-recall query, recalled-context injection, **direct-line relay
  payloads**, fact-extraction prompt, nudge pipeline, card router, excerpt
  pass) consumes the masked wire variant. Server-side persistence stores real
  values only: the session log / KG persist the POST-restore answer,
  extracted facts and the Palaia excerpt are restored surrogate→real before
  ingest/promotion (fire-and-forget extraction uses a snapshot of the
  turn's map, `snapshotPromptRestorer`), and receipt attribution keeps the
  original text. User-facing card content (`ask_user_choice` question/
  options, follow-up buttons) is restored surrogate→real before rendering.
  Direct-line turns mask the relayed payload before dispatch, restore the
  sub-agent's answer, fail closed (generic privacy error, audited) when
  masking is blocked, and mask the fact-extraction inputs the same way.
  Streamed deltas may transiently show a surrogate; the `done` answer is
  authoritative (same contract as the v4 rendered-answer swap).
- Committed runnable validation harness with pre-committed gates:
  `harness-plugin-privacy-guard/src/validation/` (not a CI gate). Current
  coverage: `de` + `en` fixture sets, **C0 regex tier only** — the C1
  transformer slot (Piiranha/GLiNER) is an inert stub. Gates: recall ≥ 0.97
  for structured identifiers, ≥ 0.90 for names/free-form entities (needs
  C1 — C0 does not detect names), precision proxy ≥ 0.85 on PII-free
  negatives, p95 added latency ≤ 400 ms. Enabling `mask_user_prompt` for a
  locale requires posting a green harness run for that locale to issue
  #361 first.

### Added — GLiNER PII-detector sidecar for prompt masking (#361)

- New optional inference sidecar `middleware/sidecars/pii-detector/`
  (skillspector pattern: stdlib-only HTTP shim, stateless, fail-closed):
  runs `urchade/gliner_multi_pii-v1` (Apache-2.0, quantized ONNX backend by
  default, torch fallback) and answers `POST /detect` with scored
  `person`/`address` spans as Unicode code-point offsets — the C1
  transformer tier that detects the PII classes the C0 regex baseline
  structurally cannot (names, free-form addresses). Model + deps are pinned
  to exact versions and baked into the image at build time (pinned HF
  revision, `HF_HUB_OFFLINE=1` — the running container performs no egress).
  Enable via the `docker-compose.pii-detector.yaml` overlay, which keeps the
  sidecar internal-network-only (no published ports — it receives raw prompt
  PII; request text and span values are never logged) and sets the new
  middleware env var `PRIVACY_C1_DETECTOR_URL`. Without the overlay the
  default stack is unchanged; sidecar down at runtime means the audited
  degrade-to-C0 path (`promptMaskDegraded`), never a silent unmasked
  pass-through.
- `harness-plugin-privacy-guard` 0.4.0: the sidecar is wired into the
  shipped `PromptPiiDetector` seam via a new fail-closed HTTP client
  (`createC1HttpDetector`, detector id `c1-gliner`) injected through the
  existing `createPrivacyGuardService({c1Detector})` slot — no service-,
  mask- or orchestrator-logic changes. New non-secret setup field
  `c1_detector_url` (live-read per call; `PRIVACY_C1_DETECTOR_URL` env
  fallback; empty ⇒ C0-only, no C1 call attempted) and one deliberate
  `permissions.network.outbound` entry for the sidecar (the plugin was
  previously pure compute). The client positively validates the sidecar's
  response schema and converts its Unicode code-point offsets to UTF-16
  exactly, asserting per span that the converted slice reproduces the
  sidecar's text — any mismatch, timeout (default 1500 ms), non-200 or
  malformed body throws and rides the audited degrade-to-C0 path.

### Added — 6-locale prompt-PII validation build-out (#361)

- The runnable validation harness
  (`harness-plugin-privacy-guard/src/validation/`, still NOT a CI gate) now
  covers all six target locales: fixtures for fr/es/it/nl plus scaled-up
  de/en — 121 items per locale (89 positives incl. a 25-item hand-built
  out-of-distribution slice, 32 PII-free negatives). All committed fixtures
  are original (hand-built + LLM-generated synthetic); no ai4privacy rows or
  derivatives are committed (restricted commercial terms — local uncommitted
  use only). fr/es/it/nl carry a recorded "native-speaker spot-check
  pending" caveat. Locale ID numbers (Steuer-ID, NINO, NIE/DNI, codice
  fiscale, BSN) are typed `idnum` and measured informationally, never gated
  in v1.
- Harness extensions: with `PII_DETECTOR_URL` set, the eval adds a `c0+c1`
  set (person recall ≥ 0.90 now enforceable, plus the shipped structured /
  precision / latency gates) and a `c1-solo` ablation (reported, never
  gated); one un-timed warm-up call per set keeps model warm-up out of p95;
  `--markdown` emits GitHub-flavored tables for posting run results to
  issue #361. Fixture files are linted at load (verbatim span values, known
  types/tiers, duplicate rejection) and a malformed file fails the run
  loudly. Without `PII_DETECTOR_URL` the harness runs c0-only exactly as
  before: de/en still PASS their structured gates, while the fr/es/it/nl
  runs now honestly document the C0 baseline's locale gaps (French
  space-grouped amounts, Dutch address/date formats, Spanish local phones)
  in the validation README instead of the fixtures being softened. The
  per-locale flag policy is unchanged: results posted to #361 before any
  locale flips `mask_user_prompt` on.

### Fixed — prompt-mask overlap resolution kept only the winning span (#361)

- `promptMask.ts#dedupSpans` resolved detector overlaps by dropping the
  lower-confidence span wholesale. A long C1 span (e.g. a free-form address
  GLiNER scored 0.8) that merely brushed a short confidence-1 C0 hit inside
  it (the postal code) therefore lost its ENTIRE coverage — the rest of the
  address reached the LLM wire unmasked, and the post-mask residual check
  only asserts kept values, so it could not catch the drop (review finding
  on the #361 branch). Overlap resolution now lets the winner own only the
  contested characters: every uncovered remainder of a losing span is kept
  as a masking span of its own (word-boundary re-extended, output still
  non-overlapping). Regression tests cover the exact reviewer scenario at
  both the `dedupSpans` and the `maskPrompt` level.

### Added — recorded 6-locale validation run (#361)

- `harness-plugin-privacy-guard/src/validation/RESULTS.md` commits the full
  `c0` / `c0+c1` / `c1-solo` × 6-locale harness run (2026-07-10, pinned
  GLiNER ONNX model, sidecar defaults, dedup fix included): **de/en/it pass
  ALL gates on `c0+c1`** (person recall 100% incl. the hand-built OOD
  slice); es/fr/nl fail on recorded C0 structured locale gaps (amounts /
  dates / phone formats), not on C1 quality; the `c1-solo` ablation
  confirms C0 stays load-bearing for structured identifiers. The flag
  policy is unchanged — these tables must be posted to issue #361 before
  any locale flips `mask_user_prompt` on; the validation README now links
  the recorded run.

### Added — privacy receipt card shows masked prompt spans (#361)

- The chat privacy-receipt card now surfaces the backend receipt field
  `maskedPromptSpans` (shipped with the prompt-masking runtime path, but
  until now unknown to the frontend mirror): a collapsed summary chunk
  ("prompt: N masked") plus an expanded fact row with a per-type breakdown
  (e.g. "3 (2 × person, 1 × email)"). Span types are an open set rendered
  verbatim; detector ids stay in the data and are not rendered. A dedicated
  explainer line states that identifiers in the user's own message were
  pseudonymised before the model call and restored in the answer. Absent or
  empty field ⇒ the card renders byte-identically to before. New
  `privacyReceipt.{summaryPromptMasked,factPromptMasked,explainerPromptMasked}`
  i18n keys in en + de.

### Changed — v1.0 readiness pass across the earliest core plugins (#431)

- `harness-plugin-web-search`, `harness-plugin-privacy-guard`, and
  `harness-plugin-quality-guard` now ship READMEs (purpose, config keys,
  published capabilities/tools, recorded `ctx.jobs`/`ctx.status`/`ctx.llm`/
  `ctx.mcp` adopt-or-skip decisions).
- `agent-seo-analyst`: operator-catalog `identity.description` translated to
  English; README gains the same PluginContext-surface audit section.
- `harness-plugin-privacy-guard`: `package.json` version aligned to the
  manifest (`0.2.0` at the time of #431; both sit at `0.3.0` after the #361
  bump in this branch); the v4 path (`src/service.ts` + `src/v4/`) is
  declared the single canonical implementation — no legacy branch exists
  (see README).
- Recorded decisions: plugins stay independently versioned (no lockstep bump
  with core); package layout is per-kind (tool plugins `src/`→`dist/`, agent
  packages flat, per `agent-reference-maximum` + boilerplate templates).

### Added — pluggable LLM provider (OpenAI as an admin-selectable provider)

- **`@omadia/llm-provider`**: a neutral LLM provider contract with Anthropic and
  OpenAI adapters (the OpenAI adapter also serves OpenAI-compatible endpoints —
  Mistral / Ollama / vLLM / Azure — via a `baseURL`), a global provider-qualified
  model registry (`anthropic:…` / `openai:…`, capability classes
  `fast|balanced|frontier`, role defaults), and a `resolveLlmProvider` factory
  that builds the right adapter from vault credentials.
- **Provider-namespaced vault credentials** (`provider:<id>/api_key`) with an
  idempotent migration off the legacy flat `anthropic_api_key`, plus a
  config-driven provider-selection runtime.
- **Class-based LLM whitelisting in agent manifests**: agents declare
  `permissions.llm.models_allowed` with provider-agnostic class refs
  (`class:fast|balanced|frontier`); the runtime gate resolves them against the
  active provider. Concrete vendor ids and `*`-wildcards still work (back-compat).
- **Provider-aware `ctx.llm` with per-plugin pinning**: each plugin's host-LLM
  runs on its assigned provider (per-plugin pin → global default → Anthropic),
  resolved consistently for both the whitelist gate and execution. The Anthropic
  default path is byte-identical.
- **Provider admin**: `GET/POST /api/v1/admin/providers` (connection status,
  per-agent provider+model assignment) and a `/admin/providers` operator page
  with an AVV / data-flow disclosure (DSGVO Art. 28) on non-Anthropic selection.
- **Usage telemetry**: OpenAI model pricing tables with provider-aware,
  double-count-safe cost computation (OpenAI cached-input semantics differ from
  Anthropic's).
- `@omadia/orchestrator`: migrated the orchestrator and local-sub-agent LLM
  boundary off direct `@anthropic-ai/sdk` calls onto the neutral
  `@omadia/llm-provider` seam. Internal loops still build Anthropic-shaped
  params and read Anthropic-shaped responses; only the boundary call path now
  translates through `llmProviderSeam`, including streaming final-event usage
  telemetry and provider-based retry classification.

### Fixed

- **web-ui/chat**: provider errors (quota, rate-limit, billing) are now surfaced
  as the provider's human-readable sentence across all chat surfaces — the main
  chat bubble, the builder chat, the preview chat, and the default simple
  builder intake — with a translated generic fallback, instead of the raw HTTP
  status and JSON envelope. On the primary path the orchestrator failure arrives
  as an in-band error event on an already-streaming 200 response; the background
  stream toast now finishes that turn as a failure showing the same humanized
  sentence, instead of reporting it as 'done' (a successful turn) as it did
  before (#403).

---

## [0.142.2] - 2026-08-28

### Fixed

- promote a release to latest only once its artifacts exist (#943)
- tell a spawn failure apart from a failed npm install (#945)

---

## [0.142.1] - 2026-08-28

### Fixed

- PATH augmentation misses ~/.local/node/bin for CLI install (#941)

---

## [0.142.0] - 2026-08-28

### Added

- the full persona designer on the agent's own identity page (#940)

---

## [0.141.0] - 2026-08-28

### Added

- agents own their identity, decoupled from the Agent Builder (#923)
- persist team bindings per (agent, team) and show teams by name (#919)

---

## [0.140.3] - 2026-08-28

### Fixed

- qualify the Azure bot handle, and stop retrying a taken one (#922)
- **web-ui**: render localized setup-field labels in the plugin config drawer (#917)

---

## [0.140.2] - 2026-08-28

### Fixed

- persist the Entra app id the moment the registration exists (#920)

---

## [0.140.1] - 2026-08-28

### Fixed

- **#911**: runtime-readiness banner now points to the actual LLM access page (#913)

---

## [0.140.0] - 2026-08-28

### Added

- write the teams_bots entry automatically after provisioning (#912)

---

## [0.139.1] - 2026-08-27

### Fixed

- sub-agent memory tool writes through the scoped store (#908)
- **#906**: desktop kernel PATH augmentation now checks ~/.local/bin (#907)

---

## [0.139.0] - 2026-08-27

### Added

- enable team uninstall for provisioned agent identities (#905)
- make the context-memory ACL switchable from the operator UI (#903)

---

## [0.138.2] - 2026-08-27

### Fixed

- **#887**: billing-posture badge no longer reads as a second status (#902)

---

## [0.138.1] - 2026-08-27

### Fixed

- **#886**: dashboard onboarding step 3 shows a result, not a stale CTA, when done (#901)

---

## [0.138.0] - 2026-08-27

### Added

- operator UI for Teams agent identities + end-to-end smoke (#896)

---

## [0.137.5] - 2026-08-27

### Fixed

- **#889**: dashboard onboarding step 1 links to both API-key and subscription paths (#895)

---

## [0.137.4] - 2026-08-27

### Fixed

- **#884**: plugin Hub stops counting a plugin ready with no verified LLM credential (#894)

---

## [0.137.3] - 2026-08-27

### Fixed

- **#890**: desktop first-run wizard offers a subscription path, not just API key (#893)

---

## [0.137.2] - 2026-08-27

### Fixed

- **#883**: write real version into desktop package before packaging (#892)

---

## [0.137.1] - 2026-08-27

### Fixed

- **#882**: augment kernel PATH so npm-based CLI install/builder work on desktop (#891)

---

## [0.137.0] - 2026-08-27

### Added

- chat-context memory ACL — per-team/channel/user agent memory with fail-closed scoping (#881)

---

## [0.136.2] - 2026-08-26

### Fixed

- accept the Teams app-package template on plugin ingest (#880)

---

## [0.136.1] - 2026-08-26

### Fixed

- Fresh-Check-Button nur bei echtem Recall, nicht beim Chat-Tail (#878)

---

## [0.136.0] - 2026-08-26

### Added

- agent factory — Teams identity provisioning via teamsProvisioner@1 (#877)

---

## [0.135.0] - 2026-08-25

### Added

- per-agent plugin & MCP grant assignment (operator UI + endpoints) (#876)

---

## [0.134.3] - 2026-08-25

### Fixed

- teams_conversation_refs migration was orphaned — move to KG-neon series as 0031 with per-bot key (#875)

---

## [0.134.2] - 2026-08-25

### Fixed

- gate verifier badge on real checked claims + memoryUsed signal for Fresh Check (#859)

---

## [0.134.1] - 2026-08-25

### Fixed

- facilitation lens must read the verdict from ctx.steps.moderate, not ctx.stepResult (#330 follow-up) (#858)

---

## [0.134.0] - 2026-08-25

### Added

- interim results table per DoD point in the facilitation details modal (#330 follow-up) (#857)

---

## [0.133.0] - 2026-08-24

### Added

- facilitation details modal; hide the panel when nothing runs (#330 follow-up) (#856)

---

## [0.132.0] - 2026-08-24

### Added

- readable facilitation cards and tick nudge discipline (#330 follow-up) (#855)

---

## [0.131.0] - 2026-08-24

### Added

- admin lens and stop for running facilitations (#330 round 4) (#854)

### Fixed

- **publish**: atomic version allocation — upsert instead of SELECT FOR UPDATE + bare INSERT (fixes #834) (#852)

---

## [0.130.0] - 2026-08-24

### Added

- **channels**: channel directory entries can carry resolved member names (#851)

---

## [0.129.0] - 2026-08-24

### Added

- bot_present opens facilitation eligibility (#330 round 3) (#850)

---

## [0.128.0] - 2026-08-23

### Added

- restart-proof facilitation groundwork (#330 field report) (#841)

---

## [0.127.0] - 2026-08-22

### Added

- cancel Conductor runs straight from the run list (#330 field report) (#840)

---

## [0.126.1] - 2026-08-21

### Fixed

- **install**: derive the install job's terminal state from the activation outcome — errored vs failed, activation_state (fixes #825) (#833)

---

## [0.126.0] - 2026-08-21

### Added

- delete conductor workflows from the library (#836)

### Fixed

- **verifier**: pass enclosing sentence to judge for fragment claims (#831)
- **platform**: provides: grants only after a real provide(), gate replace(), origin-scoped legacy allowlist, refuse bundled-id uploads (fixes #788 #789) (#835)

---

## [0.125.0] - 2026-08-21

### Added

- persist observed-invite index across restarts (0048) (#837)
- timer steps, machine-checkable DoD loops and scoped conversation nudges (#330 C3) (#830)

---

## [0.124.0] - 2026-08-21

### Added

- transcription@1 capability + batch recording ingestion (#584 WS T+I) (#829)

---

## [0.123.0] - 2026-08-21

### Added

- **update**: blocking progress dialog with stepper, visible polling, decoded rollback (#828)

---

## [0.122.0] - 2026-08-21

### Added

- zero-touch facilitator setup — agent provisioning, invite-guarded auto-bind, scoped role assignments (#330 C2a) (#827)

---

## [0.121.0] - 2026-08-21

### Added

- **runtime**: one operator consent for plugin SQL + public-path grants — wizard step, grants panel, in-process re-activation (epic #470 C16, fixes #817) (#824)

---

## [0.120.0] - 2026-08-21

### Added

- **llm**: Sign in with ChatGPT — OAuth device flow (#294) (#823)

---

## [0.119.0] - 2026-08-21

### Added

- knowledge-graph datasets admin UI with paginated list (#532) (#821)
- channel-SDK group-conversation primitives + principal-addressed targeted delivery (#330 Workstream B1) (#822)

---

## [0.118.0] - 2026-08-21

### Added

- pattern-based ephemeral conductor workflows with TTL reaper (#330 Workstream A) (#818)

### Fixed

- **#764, #775**: run workspace package suites in CI; land the role-holders audit row (#820)

---

## [0.117.1] - 2026-08-21

### Fixed

- run the declared ledger handoff before core's pre-activate migrations (#470 C15) (#815)

---

## [0.117.0] - 2026-08-21

### Added

- **admin**: runtime install of subscription CLIs from the admin UI (#816)

### Changed

- **auth**: drop the two static public-path exemptions of the extracted subsystem (epic #470 C12) (#807)

---

## [0.116.0] - 2026-08-21

### Added

- **platform**: plugin migration handoff with schema witnesses + ctx.sql.seedLedger (epic #470 C11) (#806)

### Changed

- **core**: delete the Dev Platform — now byte5ai/omadia-dev-platform (epic #470 C10) (#804)

---

## [0.115.3] - 2026-08-21

### Fixed

- **#603**: native required on upload-covered fields blocked the submit silently (#812)

---

## [0.115.2] - 2026-08-21

### Fixed

- **#603**: the install wizard's json_file upload was wired to nothing (#811)

---

## [0.115.1] - 2026-08-21

### Fixed

- fresh installs died at first boot — supervisor never passed CREDENTIAL_KEYCHAIN_KEY (#810)

---

## [0.115.0] - 2026-08-20

### Added

- close the field-test gap list — localized descriptions, visible connection verdicts, error classes, app menu, subscription notice (#809)

---

## [0.114.0] - 2026-08-20

### Added

- **platform**: optional_requires, core migrations at boot, pluginUi nav (epic #470 C9; fixes #795 #796 #798) (#802)

### Fixed

- **platform**: bundled plugins reach graphPool through the C7 SQL gate (#794) (#801)

---

## [0.113.1] - 2026-08-20

### Fixed

- four defects found retesting the packaged Intel app against the field-test report (#800)

---

## [0.113.0] - 2026-08-20

### Added

- **platform**: permissions.sql gate for graphPool + shared advisory-locked plugin migrations (epic #470 C7/G4) (#787)

### Fixed

- **#470**: make the C8 plugin-UI host actually work — same-origin frame, scoped ids, emitted CSS (C8b) (#793)
- **install**: report a failed activation as errored, not active (#470 P5) (#799)

---

## [0.112.0] - 2026-08-20

### Added

- **#778**: wire #577 skill-promotion route + #578 credential-asks mount (W1) (#792)
- **platform**: plugin route auth modes + route-local raw body slot (epic #470 C6) (#791)

---

## [0.111.0] - 2026-08-20

### Added

- **platform**: operator-consented plugin public-path grants with terminating early mount (epic #470 C4/H1) (#782)

---

## [0.110.0] - 2026-08-20

### Added

- **#470**: grant-gate ctx.services.get and cut plugin-api 1.0.0 (C2b) (#783)
- **#470**: plugin UI — generated Tailwind subset, static SPA serving, ingest gate (C8) (#784)
- **#581**: publish sharing via GrantStore — read=use, write=redeploy/rollback (P3) (#790)

---

## [0.109.0] - 2026-08-20

### Added

- **#581**: publish/publish_rollback native tools behind sandbox_publish_enabled (P2) (#786)
- **#581**: publish primitive P1 — version store + Docker runtime + origin-isolating gateway (#785)
- **plugin-api**: golden .d.ts API snapshot test (epic #470 C1) (#780)

---

## [0.108.0] - 2026-08-20

### Added

- **#576**: durable per-scope sandbox — P3 scope durability + RO-layer content hash + reaper (#779)

### Fixed

- **verifier**: check Odoo record existence for anchored soft claims (#781)

---

## [0.107.0] - 2026-08-20

### Added

- **#576**: durable per-scope sandbox — P2 execute tool + command-policy gate (#777)
- **#576**: durable per-scope sandbox — P1 interface + Docker backend (#776)
- **#578**: keychain-asks — request, owner-approval, grant (phase 3/4) (#774)

---

## [0.106.0] - 2026-08-20

### Added

- **#578**: credential broker — the egress-stamping layer (phase 2/4) (#772)
- **#578**: credential keychain data model + store (phase 1/4) (#769)
- **#577**: sharing via GrantStore + admin-gated promotion + cron write-guard (P3) (#771)

---

## [0.105.0] - 2026-08-20

### Added

- provenance verification surface — verify API, signed export, offline verifier (#761) (#773)
- **#577**: scope-ordered skill resolution with shadowing (P2) (#768)
- **#577**: skill ownership + lifecycle model (P1) (#767)
- tamper-evident receipt chain with signed checkpoints (#758) (#770)

---

## [0.104.0] - 2026-08-20

### Added

- privacy shield operator deny-lists, miss queue, idnum, eval gate (#760) (#766)
- conductor run cancellation + strict approvals + baton audit (#759) (#765)

---

## [0.103.0] - 2026-08-20

### Added

- persist per-turn privacy receipts with operator API (#757) (#763)

---

## [0.102.0] - 2026-08-20

### Added

- **i18n**: sweep the remaining #687 translate-category literals (#762)
- **i18n**: sweep the I6 toLocaleString tail (#687) (#756)

---

## [0.101.0] - 2026-08-20

### Added

- **i18n**: resolve #687 tagline and roadmap-stamp product questions (#755)

---

## [0.100.0] - 2026-08-20

### Added

- **ci**: deterministic Odoo fixture + full verified/contradicted coverage (#753)
- **#343**: adopt Lume icon + state-as-glyph specs (additive, gate-ready) (#725)

---

## [0.99.0] - 2026-08-20

### Added

- **#749**: make a failing security screener visible (#750)

---

## [0.98.4] - 2026-08-20

### Fixed

- **#687**: triage the I3 literal tail — 21 sites, 7 files on the ratchet (#751)

---

## [0.98.3] - 2026-08-20

### Fixed

- **ci**: the decoupling ratchet was timing out before it ran (#752)

---

## [0.98.2] - 2026-08-19

### Fixed

- **#687**: measure i18n literals with an AST scan, sweep ListView (#747)

---

## [0.98.1] - 2026-08-19

### Fixed

- drop temperature for models that reject it (screener was fail-open) (#748)

---

## [0.98.0] - 2026-08-19

### Added

- **#498**: adversarial injection/manipulation eval suite (#730)

---

## [0.97.0] - 2026-08-19

### Added

- **#580**: shell-normalizing command policy + honest-inert enforcement seam (#736)

---

## [0.96.1] - 2026-08-19

### Fixed

- **#727**: mask ISO-8601 dates as dates, not phone numbers (#744)

---

## [0.96.0] - 2026-08-19

### Added

- **#575**: sharedOnly recall — a restricted room keeps what it may have (#745)

---

## [0.95.1] - 2026-08-19

### Fixed

- **#326**: render masked columns on the canvas dataset-publish path (#743)

---

## [0.95.0] - 2026-08-19

### Added

- **#575**: a restricted room narrows its recall instead of losing it (#742)

---

## [0.94.0] - 2026-08-19

### Added

- **#575**: read outbound hosts as an allow-list, behind a flag (#741)

---

## [0.93.0] - 2026-08-19

### Added

- **#575**: a room can forbid an outbound host (#740)

---

## [0.92.0] - 2026-08-18

### Added

- **#575**: prohibitions — one participant's veto binds the whole room (#739)
- **#575**: bind an attachment handle to the room that minted it (#738)

---

## [0.91.0] - 2026-08-18

### Added

- **#575**: durable audience-floor grants + an operator surface for them (#737)

---

## [0.90.1] - 2026-08-18

### Fixed

- **channel-sdk**: keep NO_REPLY suppressible after the Art. 50 disclosure fold (#735)

---

## [0.90.0] - 2026-08-18

### Added

- **#575**: let a deployment switch the audience floor on (#734)
- **#575**: wire the audience floor's handle-resolution guard (#733)

---

## [0.89.0] - 2026-08-18

### Added

- **#575**: wire the audience floor's context-recall guard (#732)

---

## [0.88.0] - 2026-08-18

### Added

- **#575**: wire the audience floor's egress guard into tool dispatch (#731)

---

## [0.87.0] - 2026-08-18

### Added

- **#575**: the audience floor and capability grants (phase 2) (#729)

---

## [0.86.0] - 2026-08-18

### Added

- **#333**: role sources + pluggable role→holder resolution (phases 2 and 3) (#726)

---

## [0.85.0] - 2026-08-17

### Added

- **#333**: Principal — the platform's typed answer to "who is this?" (phase 1) (#724)

---

## [0.84.0] - 2026-08-17

### Added

- **#579**: org security postures + provenance-labelled inbound scree… (#681)

---

## [0.83.0] - 2026-08-17

### Added

- **#575**: unsharedConversationScope — a channel turn never lands in a shared scope (#714)

---

## [0.82.0] - 2026-08-17

### Added

- **#575**: ScopeId, and directLineSticky drops both denylists (#713)

---

## [0.81.2] - 2026-08-16

### Fixed

- **#709**: anchor the resume/reaper test on the store's own clock (#710)

---

## [0.81.1] - 2026-08-16

### Fixed

- **#707**: route the remaining test servers through a loopback listen helper (#708)

---

## [0.81.0] - 2026-08-15

### Added

- **issue-545**: cache mcp tool lists (#702)

---

## [0.80.0] - 2026-08-14

### Added

- **#700**: serve MRTR to 2026-07-28 clients on the public MCP endpoint (#704)

---

## [0.79.3] - 2026-08-14

### Fixed

- bind test servers to the IPv4 loopback they dial (#703)

---

## [0.79.2] - 2026-08-14

### Fixed

- **#696**: cap the Fly machine-wait at the API limit and roll back what was really replaced (#706)

---

## [0.79.1] - 2026-08-14

### Fixed

- **#696**: thread the Fly lease nonce so the updater stops blocking itself (#705)

---

## [0.79.0] - 2026-08-14

### Added

- **#432**: name the operator's actual Fly apps in the manual update command (#698)

---

## [0.78.0] - 2026-08-14

### Added

- **#562**: read MRTR off the declared 2026-07-28 contract (phase 3) (#699)

---

## [0.77.0] - 2026-08-14

### Added

- **#562**: connect http MCP servers on the v2 client family (phase 2) (#697)

---

## [0.76.0] - 2026-08-14

### Added

- **#562**: serve the loopback MCP server on the v2 SDK family (phase 1) (#695)

### Fixed

- **skills**: surface frontmatter the SKILL.md import silently drops (#690)

---

## [0.75.0] - 2026-08-14

### Added

- **#432**: publish the updater sidecar image, document the Fly path (#693)

---

## [0.74.2] - 2026-08-14

### Fixed

- **#568**: bridge channel turns to per_user MCP tokens via the IdP subject (#691)

---

## [0.74.1] - 2026-08-13

### Fixed

- **#679**: close the structural i18n categories I3-I6 (#688)

---

## [0.74.0] - 2026-08-13

### Added

- **#648**: make the AI-marking posture readable per channel (#686)

---

## [0.73.0] - 2026-08-13

### Added

- **#650**: record model and provider on the persisted run trace (#683)

---

## [0.72.0] - 2026-08-13

### Added

- **#603**: json_file setup fields — upload the key, do not transcribe it (#682)

---

## [0.71.2] - 2026-08-13

### Fixed

- **#641,#667**: give turn errors a correlation handle and stop blaming the middleware (#680)

---

## [0.71.1] - 2026-08-13

### Fixed

- **#601**: translate the flagged German strings and make the i18n gate real (#678)

---

## [0.71.0] - 2026-08-13

### Added

- **#544**: render MRTR input_required on the public MCP endpoint (#677)

---

## [0.70.2] - 2026-08-13

### Fixed

- **#570**: exempt the MRTR sentinel from interning by provenance, not by prefix (#676)
- **ci**: stop source-building better-sqlite3 in the desktop build (#675)

---

## [0.70.1] - 2026-08-13

### Fixed

- **#561**: fence the orphan-sweep metric at the store, not the schedule (#670)

---

## [0.70.0] - 2026-08-13

### Added

- **#602**: localized setup-field labels + store-card setup profile (OM-17/OM-15) (#673)

---

## [0.69.0] - 2026-08-13

### Added

- **#560**: durable Postgres TaskStore + boot resume driver for long-running tools (#663)

---

## [0.68.5] - 2026-08-12

### Fixed

- **#669**: authenticate /api/dev and lift the KG operator surfaces off the dev flag (#674)

---

## [0.68.4] - 2026-08-12

### Fixed

- **#671**: stop the store offering installs the server refuses, and say why a key is unverified (#672)

---

## [0.68.3] - 2026-08-12

### Fixed

- **#665**: stop the KG plugin ending the process-wide pg pool (#668)

---

## [0.68.2] - 2026-08-12

### Fixed

- **#566**: guard the file-scoped test timeout instead of splitting by size (#666)

---

## [0.68.1] - 2026-08-12

### Changed

- **dev-platform**: one-way layering + namespaced config (epic #470 C3) (#557)
- **plugins**: delete the never-provided ctx.devJobs surface (epic #470 C2a) (#555)
- **conductor**: delete the dead dev-job step coupling (epic #470 C5) (#554)

### Fixed

- **#605**: declare the ICU parser, correct the i18n docs, pin test concurrency (#664)

---

## [0.68.0] - 2026-08-12

### Added

- **#567**: admin UI for channel API keys (#608)

---

## [0.67.2] - 2026-08-11

### Fixed

- **#573**: typecheck test/ + scripts/ trees behind a ratchet (#611)

---

## [0.67.1] - 2026-08-11

### Fixed

- **ci**: run *.pg.test.ts suites — middleware job had no postgres ser… (#612)

---

## [0.67.0] - 2026-08-11

### Added

- **channel-sdk**: channel-agnostic AI-disclosure carrier in outgoing… (#661)

---

## [0.66.0] - 2026-08-11

### Added

- **ci**: golden-set regression eval for LLM verifier behaviour (#129) (#640)

---

## [0.65.0] - 2026-08-11

### Added

- **office**: deterministic OOXML provenance metadata in .docx/.xlsx … (#656)
- **channel-api**: AI-Act Art. 50 provenance marker in public chat-API and MCP envelope (#647) (#660)

---

## [0.64.0] - 2026-08-11

### Added

- **diagrams**: stamp AI-Act provenance iTXt chunk into rendered diagram PNGs (#646) (#657)

---

## [0.63.0] - 2026-08-10

### Added

- **privacy-guard**: locale-aware C0 prompt-PII patterns for es/fr/nl (#482) (#614)

---

## [0.62.1] - 2026-08-09

### Fixed

- **deps**: bump nanoid to 3.3.18 (GHSA-2v37-7h3g-55p8) (#627)

---

## [0.62.0] - 2026-08-09

### Added

- **web-ui**: migrate drifted buttons to canonical Button + add raw-<button> lint gate (#290) (#616)

---

## [0.61.0] - 2026-08-07

### Added

- OM-09 in-product help — localized error help catalogue (#621)

### Changed

- **mcp**: give pooled connections an explicit lifetime (#563) (#622)

---

## [0.60.0] - 2026-08-07

### Added

- **privacy**: account MCP structured output in the turn receipt (#569) (#624)

---

## [0.59.2] - 2026-08-07

### Fixed

- **web-ui**: override js-yaml to ^4.3.1 (GHSA-5p4m-2wfm-xmqj) (#623)

---

## [0.59.1] - 2026-08-06

### Fixed

- **web-ui**: route chat stream writes by session id (#617) (#620)

---

## [0.59.0] - 2026-08-05

### Added

- **chat**: surface background streams as per-tab status dots (#409)

### Changed

- **read-me**: docs: hoist Prerequisites and Quickstart above the 2-minute pitch (#597)

---

## [0.58.3] - 2026-08-04

### Fixed

- **plugins**: bound the setup-field match, not the worker's birth (#607) (#609)

---

## [0.58.2] - 2026-08-03

### Fixed

- accept {n,} patterns and localize setup-field hints (#606)

---

## [0.58.1] - 2026-08-03

### Fixed

- honest status reporting, routines crash, and setup-field safety (#599)

---

## [0.58.0] - 2026-07-31

### Added

- **desktop**: build and ship a macOS Intel (x64) installer (#574)

---

## [0.57.1] - 2026-07-31

### Fixed

- **desktop**: macOS installer ships an unopenable, unsigned app bundle (#558)

---

## [0.57.0] - 2026-07-31

### Added

- **plugins**: allow .sql in packages + make the 8 migrators concurrency-safe (#552)
- **channel-api**: public API channel with server-to-server API keys + scopes (#438, #439) (#549)
- **embeddings**: pluggable embedding provider with a live switch and a model/dimension safety gate (#440) (#537)
- **platform**: plugin-contributed navigation (phase 1 of Dev Platform extraction) (#536)
- **direct-line**: sticky multi-turn mode for Direct Line (#445) (#535)
- **conductor**: add inbound/outbound webhooks (#437) (#534)
- **issues**: attach sanitized diagnostics excerpt to issues (#433) (#486)
- **knowledge-graph**: structured dataset ingestion via CSV import (#533)
- **builder**: decompose health score into seven context-quality criteria (#499) (#522)
- **dev-platform**: epic #470 implementation — W0–W5 (job spine, isolation, Fly/webhooks/budget, hardening) (#485)
- **scripts**: spec-driven wave workflows + W0 unit manifest (epic #470) (#476)
- issue-adapt workflow pair — research-first adaptation of external toolset features (#480)
- **conductor**: workflow-template library — bundled catalog, slot mapping, guided instantiation (#429) (#479)
- **scripts**: add checklist reconciliation to the issue-triage workflow (#467)
- **mcp**: MCP as a first-class capability across Orchestrator/Sub-Agent/Skill/Plugin + Control Center (epic #459) (#464)

### Changed

- **470**: Dev Platform → installable plugin in its own repo — plan + implementation (#539)

### Fixed

- **ci**: auto-release never detects feat/fix once the log exceeds the pipe buffer (#556)
- **channel-api**: drop dev-platform cross-references from API-key comments (#553)
- **plugins**: reject path traversal in manifest identity before the install rm (#548)
- **dev-platform**: wire the runner image into the middleware's job policy + delete jobs (#529)
- MCP OAuth callback 401 + per-user token key mismatch (#531)
- **dev-platform**: wire GitHub-App onboarding + device-flow into the composition root (#497)
- **dev-platform**: make the local docker-compose deploy actually run a job (#496)
- **orchestrator**: gate unauthenticated plugin tools from the orchestrator's tool surface (#474) (#528)
- honest done-vs-error reporting on committed tools + routine retry reconciliation (#506) (#527)
- **orchestrator**: embed image attachments as vision input (#525)
- **builder**: synthesize manifest capabilities per tool (#507) (#523)
- **ci**: grant id-token: write to release.yml's edge-images job (#514)
- **scripts**: issue-loop follow-ups from the first live run (#475)
- **routines**: hot-enable on LLM key save — resolve chat agent live per run (#483)
- **web-ui**: humanize provider errors across chat surfaces (#403) (#472)
- **mcp**: store registry bearer tokens in the vault, not the DB row (#463) (#466)

---

## [0.56.0] - 2026-07-06

### Added

- **skills**: add skill verdict system (issue #436, OpenClaw/SkillSpector eval) (#452)

---

## [0.55.3] - 2026-07-06

### Fixed

- **release**: drop the PR-based docs/CHANGELOG.md auto-sync entirely (#451)
- **web-ui**: make session-warning "Relogin now" actually re-login (#412) (#449)

---

## [0.55.2] - 2026-07-06

### Fixed

- **web-ui**: replace hardcoded German UI strings with next-intl translations (#447)
- close #332 gaps — agentId, Direct Line privacy masking, standing L3 obligation, web-ui render (#446)

---

## [0.55.1] - 2026-07-06

### Fixed

- **release**: isolate the changelog PR job from image/desktop publishing (#444)

---

## [0.55.0] - 2026-07-06

### ⚠ BREAKING CHANGES

- **release**: automate a categorized changelog for every release (#443)

### Added

- **release**: automate a categorized changelog for every release (#443)

---

## [0.54.0] - 2026-07-06

### Added

- **web-ui/chat**: collapsible debug-chat intro banner (#428)

---

## [0.53.0] - 2026-07-06

### Added

- **web-ui**: restore Days One face for the omadia wordmark (#427)

---

## [0.52.3] - 2026-07-06

### Fixed

- **channels**: rebind inbound route handler on hot-reinstall (#395) (#407)

---

## [0.52.2] - 2026-07-06

### Changed

- move Orchestrators/Conductor into Admin cluster, enlarge chevron (#424)

### Fixed

- **web-ui**: stop chat auto-scroll from yanking user back to bottom (#404) (#425)

---

## [0.52.1] - 2026-07-06

### Fixed

- **web-ui**: allow changing or removing an LLM provider's API key (#402) (#423)

---

## [0.52.0] - 2026-07-03

### Added

- **builder**: wire type:oauth UI + gate provider/scopes
- **builder**: add oauth_providers descriptor + type:oauth wiring for AgentSpec (#371)

---

## [0.51.0] - 2026-07-03

### Added

- **skills**: skill lifecycle — import, edit, safety guard, multi-source adapters, bundles, and direct-answer persona skills (#411)

---

## [0.50.1] - 2026-07-03

### Fixed

- **store**: portal install drawer above global header

---

## [0.50.0] - 2026-07-02

### Added

- **orchestrator**: per-Agent LLM model selection

### Fixed

- **orchestrator**: address per-Agent model selection review

---

## [0.49.0] - 2026-07-02

### Added

- **ui-prefs**: persist Lume palette/appearance server-side per user (#287)

### Fixed

- **ui-prefs**: avoid 401 bounce; clear prefs cookie on logout

---

## [0.48.0] - 2026-07-01

### Added

- **store**: dynamic post-install setup options for plugin fields (#393)

---

## [0.47.0] - 2026-07-01

### Added

- **conductor**: guided designer UX — dropdowns + builders replace raw ISO/cron/JSON inputs (#398)

---

## [0.46.1] - 2026-06-30

### Fixed

- **ui**: update table rendering behavior (#366)

---

## [0.46.0] - 2026-06-30

### Added

- **conductor**: approval-card reminder contract + holder-authorized await resolution (#394)

---

## [0.45.0] - 2026-06-30

### Added

- **conductor**: principalRef identity-bridge for channel-binding delivery (P2a) (#389)

---

## [0.44.0] - 2026-06-30

### Added

- Omadia Conductor — deterministic workflow engine (Spec 005, US1–US9 + waves 1–6 + channel event-emit) (#388)

---

## [0.43.1] - 2026-06-29

### Fixed

- implement pr feedback
- **ui**: update dropdown font + bg color

---

## [0.43.0] - 2026-06-29

### Added

- **platform**: plugin egress primitives — ctx.net (raw TCP) + $config.* in network.outbound (#370)

---

## [0.42.0] - 2026-06-29

### Added

- implement pr feedback

### Fixed

- **auth**: redirect /login to dashboard if already logged in

---

## [0.41.0] - 2026-06-24

### Added

- **#309**: run agents on LLM subscriptions via the official CLIs (#367)

---

## [0.40.0] - 2026-06-24

### Added

- in-app "Create Issue" button (operator GitHub device flow) (#363)

---

## [0.39.0] - 2026-06-23

### Added

- **builder**: run codegen + preview on any configured LLM provider (#297) (#320)

---

## [0.38.0] - 2026-06-22

### Added

- **platform**: declarative kernel OAuth broker (descriptor engine) — spec 005 core (#325)

---

## [0.37.3] - 2026-06-22

### Fixed

- **web-ui**: lowercase the omadia brand name in user-facing text (#359)

---

## [0.37.2] - 2026-06-22

### Fixed

- **desktop**: rename wizard bridge const to avoid global name collision (#358)

---

## [0.37.1] - 2026-06-22

### Fixed

- **desktop**: bundle preload so the onboarding wizard works (+ install verbosity) (#357)

---

## [0.37.0] - 2026-06-22

### Added

- **desktop**: native one-click installer with bundled PostgreSQL 17 + pgvector (macOS/Linux/Windows) (#355)

---

## [0.36.0] - 2026-06-19

### Added

- **desktop**: native one-click installer (Electron + embedded PGlite) + signing CI (#341)

---

## [0.35.1] - 2026-06-19

### Fixed

- **ci**: publish versioned + latest images on auto-release (#340)

---

## [0.35.0] - 2026-06-19

### Added

- minimal-core onboarding stack (prebuilt images + opt-in overlays) (#339)

---

## [0.34.0] - 2026-06-18

### Added

- **orchestrator**: agent transparency + Direct Line + forced delegation (#332) (#335)

---

## [0.33.2] - 2026-06-18

### Fixed

- **builder**: persist preview test-credentials on apply + host-backed preview ctx.llm (#334)

---

## [0.33.1] - 2026-06-18

### Fixed

- **builder**: provide ctx.jobs + ctx.status stubs in preview harness (#328)

---

## [0.33.0] - 2026-06-17

### Added

- **privacy-guard**: render V4 results as a structured, guard-flagged canvas table (#324)

---

## [0.32.0] - 2026-06-17

### Added

- **llm**: contract-only SDK-free core + wire-format adapter packages (#298) (#323)

---

## [0.31.0] - 2026-06-16

### Added

- **kg**: automatic self-curation — durable coverage grows + duplicates auto-merge (#322)

---

## [0.30.0] - 2026-06-16

### Added

- **platform**: runtime credentials + flow toolkit + plugin status (spec 004) (#318)

---

## [0.29.0] - 2026-06-16

### Added

- Lumens (Live Interactivity) 1.1 — canvas-core + Tier-2 producer (server) (#315)

---

## [0.28.0] - 2026-06-16

### Added

- **orchestrator**: durable long-term knowledge tier + auto-promotion (#317)

---

## [0.27.1] - 2026-06-16

### Fixed

- **web-ui**: widen markdown table cell spacing to Lume density (#316)

---

## [0.27.0] - 2026-06-15

### Added

- **orchestrator-extras**: relevance-gate + LLM-agnostic judge for cross-session recall (#310)

---

## [0.26.0] - 2026-06-15

### Added

- **llm-provider**: support keyless local providers (e.g. Ollama) (#308)

---

## [0.25.2] - 2026-06-15

### Fixed

- **ui-orchestrator**: canvas composition uses model classes + mirror provider keys (fixes stuck "Working on it…") (#307)

---

## [0.25.1] - 2026-06-15

### Fixed

- **llm**: register provider plugins on hot-install, not just at boot (#306)

---

## [0.25.0] - 2026-06-15

### Added

- **install**: multiline setup fields for string/secret values (#305)

---

## [0.24.1] - 2026-06-15

### Fixed

- **llm**: preserve server tools through the provider seam (live 400 hotfix) (#304)

---

## [0.24.0] - 2026-06-15

### Added

- **pairing**: friction-free Omadia UI ↔ host pairing — server side (#293) (#303)

---

## [0.23.0] - 2026-06-15

### Added

- **admin**: data-driven provider compliance flags (requiresAvvDisclosure/euHosted) (#302)

---

## [0.22.0] - 2026-06-15

### Added

- **llm**: everything-is-a-plugin — pluggable provider seam + empty core (Anthropic/OpenAI/Mistral/MiniMax plugins) (#300)

---

## [0.21.0] - 2026-06-14

### Added

- **llm**: Mistral as a first-class admin-selectable provider (#299)

---

## [0.20.0] - 2026-06-14

### Added

- **llm**: pluggable LLM provider — OpenAI (GPT-5.x) as admin-selectable provider (#292)

---

## [0.19.0] - 2026-06-14

### Added

- **canvas**: publish privacy-shield datasets — canvas_publish_rows accepts datasetId

### Fixed

- **canvas**: carry the sentinel sink through the STREAMING turn scope too
- **canvas**: carry the sentinel sink into the turn scope — the tap never fired
- **canvas**: tap raw sentinels before privacy interning — guarded servers never rendered

---

## [0.18.0] - 2026-06-12

### Added

- **omadia-ui**: Tier-2 canvas pipeline — skeleton fix, producer tools (rows/charts/choice), typed UI actions, per-user canvas registry (#277)

---

## [0.17.1] - 2026-06-12

### Fixed

- **builder**: resolve Anthropic client per turn so vault-seeded keys reach the Builder (#281)

---

## [0.17.0] - 2026-06-10

### Added

- **builder**: one-click agent export from dashboard cards (#270) (#279)

---

## [0.16.2] - 2026-06-10

### Changed

- **plan-runner**: reuse stored processes + batch plan-step reads, cache overlay (#276)

### Fixed

- **memory**: stop logging expected memory-tool errors as crashes (#278)

---

## [0.16.1] - 2026-06-10

### Fixed

- **builder-preview**: wire ctx.http into the preview runtime (#275)

---

## [0.16.0] - 2026-06-09

### Added

- **ui-orchestrator**: skeleton composition + requirement handoff (#273)

---

## [0.15.0] - 2026-06-09

### Added

- **ui-channel**: thread localOperations + turn action into metadata (#272)

---

## [0.14.0] - 2026-06-08

### Added

- **admin**: de-duplicate per-plugin settings out of the .env admin page (#265)

---

## [0.13.2] - 2026-06-08

### Fixed

- **agent-builder**: propagate runtime agent installs to fallback even when boot was chat-disabled (#266)

---

## [0.13.1] - 2026-06-08

### Fixed

- **orchestrator**: forward modelRouting to per-Agent orchestrators (#263)

---

## [0.13.0] - 2026-06-08

### Added

- **chat**: show the Haiku-triage decision inline in the turn card (#261)

---

## [0.12.1] - 2026-06-08

### Fixed

- **web-ui**: dismiss stream toasts visually + explicit abort with confirm (#260)

---

## [0.12.0] - 2026-06-08

### Added

- **admin**: .env-based settings overview with live auto-apply + model-routing env wiring (#259)

---

## [0.11.1] - 2026-06-07

### Fixed

- **web-ui**: usage dashboard 404 + show per-turn model & tokens in chat (#258)

---

## [0.11.0] - 2026-06-07

### Added

- **plugins**: auto-author self-extension + standalone-plugin SDK (#255)

---

## [0.10.0] - 2026-06-07

### Added

- LLM cost telemetry, dashboard & per-turn Sonnet/Opus routing (#253)

---

## [0.9.0] - 2026-06-07

### Added

- **routines**: cold-start delivery-target model for proactive 1:1 outreach (#252)

---

## [0.8.2] - 2026-06-07

### Fixed

- **middleware**: propagate runtime plugin (de)activation to per-Agent orchestrators (#257)

---

## [0.8.1] - 2026-06-07

### Fixed

- **dynamic-runtime**: late-resolve vault-armed Anthropic client for sub-agents (#256)

---

## [0.8.0] - 2026-06-07

### Added

- **plugins**: operator-gated, non-escalating plugin self-extension (#254)

---

## [0.7.0] - 2026-06-07

### Added

- **plan-runner**: GC semantically-duplicate plans on materialise (#241)

---

## [0.6.1] - 2026-06-06

### Fixed

- **orchestrator**: raise tool-loop cap 25→100 with round-loop guard + best-effort finalize (#240)

---

## [0.6.0] - 2026-06-06

### Added

- **orchestrator**: live mid-turn steering of a running chat turn (#239)

---

## [0.5.2] - 2026-06-06

### Fixed

- **orchestrator**: raise tool-loop cap 12→25 with floor on stale configs (#237)

---

## [0.5.1] - 2026-06-06

### Fixed

- **config**: treat empty optional diagram/S3 env vars as unset, not a boot-crash (#238)

---

## [0.5.0] - 2026-06-06

### Added

- **ui-orchestrator**: Tier-2 surface synthesis in canvasChatAgent (PR-9b-1) (#235)

---

## [0.4.0] - 2026-06-06

### Added

- **builder**: codegen/build/runtime observability tools for the Builder agent (#227) (#236)

---

## [0.3.8] - 2026-06-05

### Fixed

- **middleware**: arm host-LLM plugins on vault key-entry so plan-runner works on fresh installs (#234)

---

## [0.3.7] - 2026-06-05

### Fixed

- **builder**: author plugins from spec.author, not hardcoded "byte5 GmbH" (#225) (#233)

---

## [0.3.6] - 2026-06-05

### Fixed

- **builder**: prevent message loss when toggling simple/extended view (#224) (#231)

---

## [0.3.5] - 2026-06-05

### Fixed

- **web-ui**: install drawer overlays render above global header (#232)

---

## [0.3.4] - 2026-06-05

### Fixed

- **web-ui**: survive stale/foreign chat-session shapes instead of a blank crash (#230)

---

## [0.3.3] - 2026-06-05

### Fixed

- **builder**: raise report_platform_issue summary cap 280→500 (#229)

---

## [0.3.2] - 2026-06-05

### Fixed

- **orchestrator**: boot gracefully without ANTHROPIC_API_KEY (Setup-Wizard key entry) (#228)

---

## [0.3.1] - 2026-06-05

### Fixed

- **knowledge-graph**: survive first-boot Postgres race instead of crash-looping (#226)

---

## [0.3.0] - 2026-06-05

### Added

- **builder**: native core-bug reporting — GitHub App direct-create + UI (#223)

---

## [0.2.1] - 2026-06-05

### Changed

- **builder**: user-facing 'Veröffentlichen' → 'Bereitstellen' (i18n de, redo of #208) (#217)

### Fixed

- **ci**: set git identity before annotated release tag (#218)
- **builder**: ctx.memory in preview runtime, accessor permission lint, and setup_fields rename (#207)

---

## [0.2.0] — 2026-06-05

Second public release of omadia — *An Agentic OS*. 155 commits since v0.1.0.
Headline work: a multi-orchestrator runtime, the omadia UI canvas channel with a
WebSocket transport, a plugin store with remote registries, a major builder
upgrade (persona / quality / audit), the answer verifier, operator-owned Privacy
Mode, and headless Office generation. Pre-1.0: schemas and internal surfaces may
still change between minor versions.

### Added

- **Multi-orchestrator runtime** (US1–US9): run multiple orchestrators with
  strict per-orchestrator memory + Knowledge-Graph isolation, per-channel
  `dispatch_service` routing, and per-binding agent routing with `channelType`
  autodiscovery.
- **omadia UI canvas channel**: an additive canvas interface surface on the
  channel SDK, a WebSocket transport for channel plugins (handshake + turn +
  surface fan-out), canvas sentinel parsers with a canvas-output gate, and
  skeleton `ui-channel` / `ui-orchestrator` plugins.
- **Plugin store (MVP)**: admin-managed remote registries, remote install with
  `depends_on` chaining, and update detection with store-card update prompts.
- **Builder upgrades**: service-type auto-discovery for integration-backed
  agents, preview that reads through to the live `ServiceRegistry`, persona
  templates + gallery (6 archetypes), a quality-score engine + panel, a
  live compiled system-prompt preview, culture presets (6 industry overlays),
  an audit-log backend + timeline UI, a `read_slot` tool, and plan-as-data
  foundations.
- **Answer verifier**: tool-output postcondition validation with retry,
  citation enforcement for Knowledge-Graph-grounded answers, and
  confidence-gated re-sampling on borderline verdicts.
- **Privacy**: operator-owned per-plugin Privacy Mode and stable-id
  tokenization for the privacy-guard proxy.
- **Headless Office**: deterministic `.xlsx` / `.docx` generation with
  multi-channel delivery.
- **Cross-session memory**: a Knowledge-Graph recall probe for plans, processes
  and team insights, with relevance-filtered cross-session plan recall.
- **Knowledge-Graph ACL + curated-memory** system.
- **Setup wizard collects the LLM key** (OB-61): the Anthropic API key is now
  gathered through the first-user setup wizard and stored encrypted in the
  per-plugin vault — `ANTHROPIC_API_KEY` in the environment is no longer
  required.
- **plugin-api**: structured-output + `writeCapabilities` contract, and
  `EntityRef.op` widened to `'read' | 'write'`.
- Localized third-party setup guides (`setup.guide`).
- Architecture Decision Records under `docs/adr`.
- Native issue-reporting + workaround-tracking for the agent builder.
  When the builder hits a platform-side failure (forbidden-import
  gate on valid code, codegen-internal error, core-stack-frame
  crash, admin-route schema violation), it now offers the operator
  a smart card with three options: report + workaround, report +
  pause, or skip. Reports go through a browser-submit flow against
  `byte5ai/omadia` so the operator owns the GitHub attribution; the
  middleware never sees a PAT in v1. A 64 KB sanitizer strips
  AWS keys / GitHub PATs / Slack tokens / IBANs / emails / internal
  URLs before the operator confirms. Per-operator rate limit of 3
  platform reports per 24 h, deduplication via a stable
  fingerprint hash + GitHub search, ETag-aware status cache with
  rate-limit backoff, pause-on-issue with operator-triggered
  resume. Workaround lifecycle state survives re-installs in the
  new `agent_workaround_state` table; identity (issue ref +
  fingerprint + summary) lives on the spec so the manifest carries
  it through to installed agents.
- RFC `docs/cross-channel-memory.md` proposing two new core capabilities,
  `platformIdentity@1` and `crossChannelConversationMemory@1`, plus four
  provider plugins (Neon + in-memory siblings per capability). Driven by
  the omadia-ui Tier-2 orchestrator's hard dependency on
  `crossChannelConversationMemory@1` and the "Telegram → desktop"
  continuity scenario. Additive against `harness-channel-sdk`: the
  existing `ConversationHistoryStore` contract stays unchanged; a new
  `DurableConversationHistoryStore` adapter bridges to the capability
  and falls back to in-memory behavior when the capability is not
  installed. The RFC also specifies a small additive extension to
  `TurnContextValue` in `harness-orchestrator` (`tenantId?`,
  `originatorUserRef?`, `originatorUserId?`, `canvasSessionId?`),
  which lands with PR 4 and absorbs the Phase-12 `tenantId` work from
  `docs/middleware-agent-handoff.md`. The RFC went through three
  Codex-style review rounds before landing: service-registry-key form,
  `TurnContextValue` field availability, the dual `ConversationTurn`
  shape in the SDK, misuse of `ctx.notifications` as an ops/audit
  surface, identity-merge race-safety, outbox idempotency via
  `client_message_id`, structured `CcmAppendError` failure taxonomy,
  audit-event PII minimization plus retention, and the absence of a
  `permissions.routes` manifest key were all fixed against the real
  code in `middleware/packages/` before merge. PR sequence and
  consumer mechanics are spelled out in §15 of the RFC;
  `docs/middleware-agent-handoff.md` §13 gains a Phase 13 roadmap
  entry pointing at the RFC.
- byte5ai engineering-standards applied to the repo
  (`status: applied` in `.github/engineering-standards.yml`):
  - `.hooks/pre-push` blocks direct pushes to `main`/`master` locally.
  - `script/setup` activates the hook and runs the npm bootstrap in one step.
  - AGENTS.md gained a "Git Workflow & Engineering Standards" section.
  - CONTRIBUTING.md documents the pre-push guard and forbids
    `Co-Authored-By:` trailers for AI agents.
  - Server-side branch protection on `main`: pull request required,
    force-push and deletion blocked, all five CI workflow contexts wired
    up as required status checks.
- GitHub Actions re-enabled after the 2026-05-11 outage; first
  post-reactivation runs landed green on the same day.

### Changed

- Public-facing text now brands the product as **omadia** (formerly "Harness").
- Default orchestrator model set to `claude-opus-4-7` (a stale id previously
  caused 404s).
- web-ui: `middleware.ts` renamed to `proxy.ts` for Next.js 16 compatibility.
- `docs/CHANGELOG.md` reformatted to follow the Keep-a-Changelog convention.
  Detailed operational history prior to v0.1.0 is preserved in the git log.
- Replaced the internal `docs/security-migration-plan.md` post-mortem with
  `docs/security-architecture.md`, which describes the generic patterns
  (proxy-over-direct calls, secrets in a vault, scope-locked sub-agent tools)
  without incident-specific identifiers.
- Sanitised `middleware/packages/harness-diagrams` package metadata to remove
  internal hostnames and branding.

### Fixed

- Orchestrator resilience: retry on mid-stream Anthropic `overloaded_error`,
  explicit `maxRetries=5` with turn-failure logging, quarantine of uninstalled
  plugins instead of aborting registry boot, and per-Agent domain tools scoped
  to enabled plugins only.
- Privacy: hardened outbound payloads against lone UTF-16 surrogates; the
  privacy-guard now renders real names instead of apologising, and expands
  "summary + detail" tool results into per-record rows.
- Builder: AST-writes `network.outbound` so integration-backed agents build,
  unblocked non-search plugin specs, scoped plugin ids work end-to-end, and
  new agents emit the `@omadia/agent-*` namespace.
- web-ui: visible session-expiry handling (warning + auto-logout), the plugin
  install drawer is scrollable for long config forms, and the React-Compiler
  warnings were cleared.
- CI pipeline brought back to green after the Actions outage:
  - `actions/setup-node` bumped from `20` to `22` to match
    `middleware/package.json` `engines.node ">=22 <23"`.
  - `schema (migrations on pgvector)` job moved from a stale hardcoded
    list to a glob over five migration domains; coverage went from 9 to
    20 migrations and is now self-updating.
  - `sharp` linux-x64 native binary installed explicitly so the diagram
    test suite can load on CI runners.
  - `middleware/src/index.ts` `prefer-const` false-positive on an
    intentional forward reference suppressed with a documented disable.
- Middleware test suite cleared of stale workshop-vs-public drift: back
  to 2168 passing / 0 failing (7 tests carry `it.skip()` with TODO
  comments documenting root cause — tracked separately for follow-up
  if/when operationally relevant).

---

## [0.1.0] — 2026-05-11

Initial public release of Omadia — *An Agentic OS*.

### Added

- Middleware kernel with plugin runtime, capability registry, and
  scope-locked sub-agent tools.
- Web UI (`web-ui/`) for operator onboarding, plugin install via ZIP upload,
  and chat sessions.
- Reference plugins: `harness-diagrams`, `harness-memory`, and the
  `agent-reference-maximum` / `agent-seo-analyst` boilerplates.
- Docker Compose deployment recipe.
- AGENTS.md + four-file documentation set
  (`docs/README.md`, `docs/middleware-agent-handoff.md`,
  `docs/CHANGELOG.md`, `docs/security-architecture.md`).

### Notes

- Licence: MIT.
- The full pre-release development history is preserved in the maintainer's
  internal repository and is not part of the public git history.

[Unreleased]: https://github.com/byte5ai/omadia/compare/v0.142.2...HEAD
[0.142.2]: https://github.com/byte5ai/omadia/compare/v0.142.1...v0.142.2
[0.142.1]: https://github.com/byte5ai/omadia/compare/v0.142.0...v0.142.1
[0.142.0]: https://github.com/byte5ai/omadia/compare/v0.141.0...v0.142.0
[0.141.0]: https://github.com/byte5ai/omadia/compare/v0.140.3...v0.141.0
[0.140.3]: https://github.com/byte5ai/omadia/compare/v0.140.2...v0.140.3
[0.140.2]: https://github.com/byte5ai/omadia/compare/v0.140.1...v0.140.2
[0.140.1]: https://github.com/byte5ai/omadia/compare/v0.140.0...v0.140.1
[0.140.0]: https://github.com/byte5ai/omadia/compare/v0.139.1...v0.140.0
[0.139.1]: https://github.com/byte5ai/omadia/compare/v0.139.0...v0.139.1
[0.139.0]: https://github.com/byte5ai/omadia/compare/v0.138.2...v0.139.0
[0.138.2]: https://github.com/byte5ai/omadia/compare/v0.138.1...v0.138.2
[0.138.1]: https://github.com/byte5ai/omadia/compare/v0.138.0...v0.138.1
[0.138.0]: https://github.com/byte5ai/omadia/compare/v0.137.5...v0.138.0
[0.137.5]: https://github.com/byte5ai/omadia/compare/v0.137.4...v0.137.5
[0.137.4]: https://github.com/byte5ai/omadia/compare/v0.137.3...v0.137.4
[0.137.3]: https://github.com/byte5ai/omadia/compare/v0.137.2...v0.137.3
[0.137.2]: https://github.com/byte5ai/omadia/compare/v0.137.1...v0.137.2
[0.137.1]: https://github.com/byte5ai/omadia/compare/v0.137.0...v0.137.1
[0.137.0]: https://github.com/byte5ai/omadia/compare/v0.136.2...v0.137.0
[0.136.2]: https://github.com/byte5ai/omadia/compare/v0.136.1...v0.136.2
[0.136.1]: https://github.com/byte5ai/omadia/compare/v0.136.0...v0.136.1
[0.136.0]: https://github.com/byte5ai/omadia/compare/v0.135.0...v0.136.0
[0.135.0]: https://github.com/byte5ai/omadia/compare/v0.134.3...v0.135.0
[0.134.3]: https://github.com/byte5ai/omadia/compare/v0.134.2...v0.134.3
[0.134.2]: https://github.com/byte5ai/omadia/compare/v0.134.1...v0.134.2
[0.134.1]: https://github.com/byte5ai/omadia/compare/v0.134.0...v0.134.1
[0.134.0]: https://github.com/byte5ai/omadia/compare/v0.133.0...v0.134.0
[0.133.0]: https://github.com/byte5ai/omadia/compare/v0.132.0...v0.133.0
[0.132.0]: https://github.com/byte5ai/omadia/compare/v0.131.0...v0.132.0
[0.131.0]: https://github.com/byte5ai/omadia/compare/v0.130.0...v0.131.0
[0.130.0]: https://github.com/byte5ai/omadia/compare/v0.129.0...v0.130.0
[0.129.0]: https://github.com/byte5ai/omadia/compare/v0.128.0...v0.129.0
[0.128.0]: https://github.com/byte5ai/omadia/compare/v0.127.0...v0.128.0
[0.127.0]: https://github.com/byte5ai/omadia/compare/v0.126.1...v0.127.0
[0.126.1]: https://github.com/byte5ai/omadia/compare/v0.126.0...v0.126.1
[0.126.0]: https://github.com/byte5ai/omadia/compare/v0.125.0...v0.126.0
[0.125.0]: https://github.com/byte5ai/omadia/compare/v0.124.0...v0.125.0
[0.124.0]: https://github.com/byte5ai/omadia/compare/v0.123.0...v0.124.0
[0.123.0]: https://github.com/byte5ai/omadia/compare/v0.122.0...v0.123.0
[0.122.0]: https://github.com/byte5ai/omadia/compare/v0.121.0...v0.122.0
[0.121.0]: https://github.com/byte5ai/omadia/compare/v0.120.0...v0.121.0
[0.120.0]: https://github.com/byte5ai/omadia/compare/v0.119.0...v0.120.0
[0.119.0]: https://github.com/byte5ai/omadia/compare/v0.118.0...v0.119.0
[0.118.0]: https://github.com/byte5ai/omadia/compare/v0.117.1...v0.118.0
[0.117.1]: https://github.com/byte5ai/omadia/compare/v0.117.0...v0.117.1
[0.117.0]: https://github.com/byte5ai/omadia/compare/v0.116.0...v0.117.0
[0.116.0]: https://github.com/byte5ai/omadia/compare/v0.115.3...v0.116.0
[0.115.3]: https://github.com/byte5ai/omadia/compare/v0.115.2...v0.115.3
[0.115.2]: https://github.com/byte5ai/omadia/compare/v0.115.1...v0.115.2
[0.115.1]: https://github.com/byte5ai/omadia/compare/v0.115.0...v0.115.1
[0.115.0]: https://github.com/byte5ai/omadia/compare/v0.114.0...v0.115.0
[0.114.0]: https://github.com/byte5ai/omadia/compare/v0.113.1...v0.114.0
[0.113.1]: https://github.com/byte5ai/omadia/compare/v0.113.0...v0.113.1
[0.113.0]: https://github.com/byte5ai/omadia/compare/v0.112.0...v0.113.0
[0.112.0]: https://github.com/byte5ai/omadia/compare/v0.111.0...v0.112.0
[0.111.0]: https://github.com/byte5ai/omadia/compare/v0.110.0...v0.111.0
[0.110.0]: https://github.com/byte5ai/omadia/compare/v0.109.0...v0.110.0
[0.109.0]: https://github.com/byte5ai/omadia/compare/v0.108.0...v0.109.0
[0.108.0]: https://github.com/byte5ai/omadia/compare/v0.107.0...v0.108.0
[0.107.0]: https://github.com/byte5ai/omadia/compare/v0.106.0...v0.107.0
[0.106.0]: https://github.com/byte5ai/omadia/compare/v0.105.0...v0.106.0
[0.105.0]: https://github.com/byte5ai/omadia/compare/v0.104.0...v0.105.0
[0.104.0]: https://github.com/byte5ai/omadia/compare/v0.103.0...v0.104.0
[0.103.0]: https://github.com/byte5ai/omadia/compare/v0.102.0...v0.103.0
[0.102.0]: https://github.com/byte5ai/omadia/compare/v0.101.0...v0.102.0
[0.101.0]: https://github.com/byte5ai/omadia/compare/v0.100.0...v0.101.0
[0.100.0]: https://github.com/byte5ai/omadia/compare/v0.99.0...v0.100.0
[0.99.0]: https://github.com/byte5ai/omadia/compare/v0.98.4...v0.99.0
[0.98.4]: https://github.com/byte5ai/omadia/compare/v0.98.3...v0.98.4
[0.98.3]: https://github.com/byte5ai/omadia/compare/v0.98.2...v0.98.3
[0.98.2]: https://github.com/byte5ai/omadia/compare/v0.98.1...v0.98.2
[0.98.1]: https://github.com/byte5ai/omadia/compare/v0.98.0...v0.98.1
[0.98.0]: https://github.com/byte5ai/omadia/compare/v0.97.0...v0.98.0
[0.97.0]: https://github.com/byte5ai/omadia/compare/v0.96.1...v0.97.0
[0.96.1]: https://github.com/byte5ai/omadia/compare/v0.96.0...v0.96.1
[0.96.0]: https://github.com/byte5ai/omadia/compare/v0.95.1...v0.96.0
[0.95.1]: https://github.com/byte5ai/omadia/compare/v0.95.0...v0.95.1
[0.95.0]: https://github.com/byte5ai/omadia/compare/v0.94.0...v0.95.0
[0.94.0]: https://github.com/byte5ai/omadia/compare/v0.93.0...v0.94.0
[0.93.0]: https://github.com/byte5ai/omadia/compare/v0.92.0...v0.93.0
[0.92.0]: https://github.com/byte5ai/omadia/compare/v0.91.0...v0.92.0
[0.91.0]: https://github.com/byte5ai/omadia/compare/v0.90.1...v0.91.0
[0.90.1]: https://github.com/byte5ai/omadia/compare/v0.90.0...v0.90.1
[0.90.0]: https://github.com/byte5ai/omadia/compare/v0.89.0...v0.90.0
[0.89.0]: https://github.com/byte5ai/omadia/compare/v0.88.0...v0.89.0
[0.88.0]: https://github.com/byte5ai/omadia/compare/v0.87.0...v0.88.0
[0.87.0]: https://github.com/byte5ai/omadia/compare/v0.86.0...v0.87.0
[0.86.0]: https://github.com/byte5ai/omadia/compare/v0.85.0...v0.86.0
[0.85.0]: https://github.com/byte5ai/omadia/compare/v0.84.0...v0.85.0
[0.84.0]: https://github.com/byte5ai/omadia/compare/v0.83.0...v0.84.0
[0.83.0]: https://github.com/byte5ai/omadia/compare/v0.82.0...v0.83.0
[0.82.0]: https://github.com/byte5ai/omadia/compare/v0.81.2...v0.82.0
[0.81.2]: https://github.com/byte5ai/omadia/compare/v0.81.1...v0.81.2
[0.81.1]: https://github.com/byte5ai/omadia/compare/v0.81.0...v0.81.1
[0.81.0]: https://github.com/byte5ai/omadia/compare/v0.80.0...v0.81.0
[0.80.0]: https://github.com/byte5ai/omadia/compare/v0.79.3...v0.80.0
[0.79.3]: https://github.com/byte5ai/omadia/compare/v0.79.2...v0.79.3
[0.79.2]: https://github.com/byte5ai/omadia/compare/v0.79.1...v0.79.2
[0.79.1]: https://github.com/byte5ai/omadia/compare/v0.79.0...v0.79.1
[0.79.0]: https://github.com/byte5ai/omadia/compare/v0.78.0...v0.79.0
[0.78.0]: https://github.com/byte5ai/omadia/compare/v0.77.0...v0.78.0
[0.77.0]: https://github.com/byte5ai/omadia/compare/v0.76.0...v0.77.0
[0.76.0]: https://github.com/byte5ai/omadia/compare/v0.75.0...v0.76.0
[0.75.0]: https://github.com/byte5ai/omadia/compare/v0.74.2...v0.75.0
[0.74.2]: https://github.com/byte5ai/omadia/compare/v0.74.1...v0.74.2
[0.74.1]: https://github.com/byte5ai/omadia/compare/v0.74.0...v0.74.1
[0.74.0]: https://github.com/byte5ai/omadia/compare/v0.73.0...v0.74.0
[0.73.0]: https://github.com/byte5ai/omadia/compare/v0.72.0...v0.73.0
[0.72.0]: https://github.com/byte5ai/omadia/compare/v0.71.2...v0.72.0
[0.71.2]: https://github.com/byte5ai/omadia/compare/v0.71.1...v0.71.2
[0.71.1]: https://github.com/byte5ai/omadia/compare/v0.71.0...v0.71.1
[0.71.0]: https://github.com/byte5ai/omadia/compare/v0.70.2...v0.71.0
[0.70.2]: https://github.com/byte5ai/omadia/compare/v0.70.1...v0.70.2
[0.70.1]: https://github.com/byte5ai/omadia/compare/v0.70.0...v0.70.1
[0.70.0]: https://github.com/byte5ai/omadia/compare/v0.69.0...v0.70.0
[0.69.0]: https://github.com/byte5ai/omadia/compare/v0.68.5...v0.69.0
[0.68.5]: https://github.com/byte5ai/omadia/compare/v0.68.4...v0.68.5
[0.68.4]: https://github.com/byte5ai/omadia/compare/v0.68.3...v0.68.4
[0.68.3]: https://github.com/byte5ai/omadia/compare/v0.68.2...v0.68.3
[0.68.2]: https://github.com/byte5ai/omadia/compare/v0.68.1...v0.68.2
[0.68.1]: https://github.com/byte5ai/omadia/compare/v0.68.0...v0.68.1
[0.68.0]: https://github.com/byte5ai/omadia/compare/v0.67.2...v0.68.0
[0.67.2]: https://github.com/byte5ai/omadia/compare/v0.67.1...v0.67.2
[0.67.1]: https://github.com/byte5ai/omadia/compare/v0.67.0...v0.67.1
[0.67.0]: https://github.com/byte5ai/omadia/compare/v0.66.0...v0.67.0
[0.66.0]: https://github.com/byte5ai/omadia/compare/v0.65.0...v0.66.0
[0.65.0]: https://github.com/byte5ai/omadia/compare/v0.64.0...v0.65.0
[0.64.0]: https://github.com/byte5ai/omadia/compare/v0.63.0...v0.64.0
[0.63.0]: https://github.com/byte5ai/omadia/compare/v0.62.1...v0.63.0
[0.62.1]: https://github.com/byte5ai/omadia/compare/v0.62.0...v0.62.1
[0.62.0]: https://github.com/byte5ai/omadia/compare/v0.61.0...v0.62.0
[0.61.0]: https://github.com/byte5ai/omadia/compare/v0.60.0...v0.61.0
[0.60.0]: https://github.com/byte5ai/omadia/compare/v0.59.2...v0.60.0
[0.59.2]: https://github.com/byte5ai/omadia/compare/v0.59.1...v0.59.2
[0.59.1]: https://github.com/byte5ai/omadia/compare/v0.59.0...v0.59.1
[0.59.0]: https://github.com/byte5ai/omadia/compare/v0.58.3...v0.59.0
[0.58.3]: https://github.com/byte5ai/omadia/compare/v0.58.2...v0.58.3
[0.58.2]: https://github.com/byte5ai/omadia/compare/v0.58.1...v0.58.2
[0.58.1]: https://github.com/byte5ai/omadia/compare/v0.58.0...v0.58.1
[0.58.0]: https://github.com/byte5ai/omadia/compare/v0.57.1...v0.58.0
[0.57.1]: https://github.com/byte5ai/omadia/compare/v0.57.0...v0.57.1
[0.57.0]: https://github.com/byte5ai/omadia/compare/v0.56.0...v0.57.0
[0.56.0]: https://github.com/byte5ai/omadia/compare/v0.55.3...v0.56.0
[0.55.3]: https://github.com/byte5ai/omadia/compare/v0.55.2...v0.55.3
[0.55.2]: https://github.com/byte5ai/omadia/compare/v0.55.1...v0.55.2
[0.55.1]: https://github.com/byte5ai/omadia/compare/v0.55.0...v0.55.1
[0.55.0]: https://github.com/byte5ai/omadia/compare/v0.54.0...v0.55.0
[0.54.0]: https://github.com/byte5ai/omadia/compare/v0.53.0...v0.54.0
[0.53.0]: https://github.com/byte5ai/omadia/compare/v0.52.3...v0.53.0
[0.52.3]: https://github.com/byte5ai/omadia/compare/v0.52.2...v0.52.3
[0.52.2]: https://github.com/byte5ai/omadia/compare/v0.52.1...v0.52.2
[0.52.1]: https://github.com/byte5ai/omadia/compare/v0.52.0...v0.52.1
[0.52.0]: https://github.com/byte5ai/omadia/compare/v0.51.0...v0.52.0
[0.51.0]: https://github.com/byte5ai/omadia/compare/v0.50.1...v0.51.0
[0.50.1]: https://github.com/byte5ai/omadia/compare/v0.50.0...v0.50.1
[0.50.0]: https://github.com/byte5ai/omadia/compare/v0.49.0...v0.50.0
[0.49.0]: https://github.com/byte5ai/omadia/compare/v0.48.0...v0.49.0
[0.48.0]: https://github.com/byte5ai/omadia/compare/v0.47.0...v0.48.0
[0.47.0]: https://github.com/byte5ai/omadia/compare/v0.46.1...v0.47.0
[0.46.1]: https://github.com/byte5ai/omadia/compare/v0.46.0...v0.46.1
[0.46.0]: https://github.com/byte5ai/omadia/compare/v0.45.0...v0.46.0
[0.45.0]: https://github.com/byte5ai/omadia/compare/v0.44.0...v0.45.0
[0.44.0]: https://github.com/byte5ai/omadia/compare/v0.43.1...v0.44.0
[0.43.1]: https://github.com/byte5ai/omadia/compare/v0.43.0...v0.43.1
[0.43.0]: https://github.com/byte5ai/omadia/compare/v0.42.0...v0.43.0
[0.42.0]: https://github.com/byte5ai/omadia/compare/v0.41.0...v0.42.0
[0.41.0]: https://github.com/byte5ai/omadia/compare/v0.40.0...v0.41.0
[0.40.0]: https://github.com/byte5ai/omadia/compare/v0.39.0...v0.40.0
[0.39.0]: https://github.com/byte5ai/omadia/compare/v0.38.0...v0.39.0
[0.38.0]: https://github.com/byte5ai/omadia/compare/v0.37.3...v0.38.0
[0.37.3]: https://github.com/byte5ai/omadia/compare/v0.37.2...v0.37.3
[0.37.2]: https://github.com/byte5ai/omadia/compare/v0.37.1...v0.37.2
[0.37.1]: https://github.com/byte5ai/omadia/compare/v0.37.0...v0.37.1
[0.37.0]: https://github.com/byte5ai/omadia/compare/v0.36.0...v0.37.0
[0.36.0]: https://github.com/byte5ai/omadia/compare/v0.35.1...v0.36.0
[0.35.1]: https://github.com/byte5ai/omadia/compare/v0.35.0...v0.35.1
[0.35.0]: https://github.com/byte5ai/omadia/compare/v0.34.0...v0.35.0
[0.34.0]: https://github.com/byte5ai/omadia/compare/v0.33.2...v0.34.0
[0.33.2]: https://github.com/byte5ai/omadia/compare/v0.33.1...v0.33.2
[0.33.1]: https://github.com/byte5ai/omadia/compare/v0.33.0...v0.33.1
[0.33.0]: https://github.com/byte5ai/omadia/compare/v0.32.0...v0.33.0
[0.32.0]: https://github.com/byte5ai/omadia/compare/v0.31.0...v0.32.0
[0.31.0]: https://github.com/byte5ai/omadia/compare/v0.30.0...v0.31.0
[0.30.0]: https://github.com/byte5ai/omadia/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/byte5ai/omadia/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/byte5ai/omadia/compare/v0.27.1...v0.28.0
[0.27.1]: https://github.com/byte5ai/omadia/compare/v0.27.0...v0.27.1
[0.27.0]: https://github.com/byte5ai/omadia/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/byte5ai/omadia/compare/v0.25.2...v0.26.0
[0.25.2]: https://github.com/byte5ai/omadia/compare/v0.25.1...v0.25.2
[0.25.1]: https://github.com/byte5ai/omadia/compare/v0.25.0...v0.25.1
[0.25.0]: https://github.com/byte5ai/omadia/compare/v0.24.1...v0.25.0
[0.24.1]: https://github.com/byte5ai/omadia/compare/v0.24.0...v0.24.1
[0.24.0]: https://github.com/byte5ai/omadia/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/byte5ai/omadia/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/byte5ai/omadia/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/byte5ai/omadia/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/byte5ai/omadia/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/byte5ai/omadia/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/byte5ai/omadia/compare/v0.17.1...v0.18.0
[0.17.1]: https://github.com/byte5ai/omadia/compare/v0.17.0...v0.17.1
[0.17.0]: https://github.com/byte5ai/omadia/compare/v0.16.2...v0.17.0
[0.16.2]: https://github.com/byte5ai/omadia/compare/v0.16.1...v0.16.2
[0.16.1]: https://github.com/byte5ai/omadia/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/byte5ai/omadia/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/byte5ai/omadia/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/byte5ai/omadia/compare/v0.13.2...v0.14.0
[0.13.2]: https://github.com/byte5ai/omadia/compare/v0.13.1...v0.13.2
[0.13.1]: https://github.com/byte5ai/omadia/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/byte5ai/omadia/compare/v0.12.1...v0.13.0
[0.12.1]: https://github.com/byte5ai/omadia/compare/v0.12.0...v0.12.1
[0.12.0]: https://github.com/byte5ai/omadia/compare/v0.11.1...v0.12.0
[0.11.1]: https://github.com/byte5ai/omadia/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/byte5ai/omadia/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/byte5ai/omadia/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/byte5ai/omadia/compare/v0.8.2...v0.9.0
[0.8.2]: https://github.com/byte5ai/omadia/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/byte5ai/omadia/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/byte5ai/omadia/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/byte5ai/omadia/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/byte5ai/omadia/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/byte5ai/omadia/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/byte5ai/omadia/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/byte5ai/omadia/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/byte5ai/omadia/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/byte5ai/omadia/compare/v0.3.8...v0.4.0
[0.3.8]: https://github.com/byte5ai/omadia/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/byte5ai/omadia/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/byte5ai/omadia/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/byte5ai/omadia/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/byte5ai/omadia/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/byte5ai/omadia/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/byte5ai/omadia/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/byte5ai/omadia/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/byte5ai/omadia/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/byte5ai/omadia/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/byte5ai/omadia/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/byte5ai/omadia/releases/tag/v0.1.0
