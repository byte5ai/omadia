# Security Architecture

This document describes the security-relevant design patterns the middleware
relies on. It is intentionally a *pattern* document — not a post-mortem and
not a credential inventory. Operational secrets, hostnames, and account
identifiers belong in your deployment vault, not in this repository.

If you operate Omadia, treat this file as the checklist your deployment must
satisfy.

---

## 1. Credentials never live in agent prompts or YAML config

LLM system prompts are read by every turn and are easy to leak through
debug logs, error traces, or transcripts. Therefore:

- **No bearer tokens, API keys, passwords, OAuth secrets, or database URLs
  in any `agent-config-*.yaml`, plugin `manifest.yaml`, or system prompt
  string.**
- Credentials are loaded from the secrets vault (`middleware/src/secrets/`)
  at boot, mounted into the runtime environment, and only ever passed
  through internal proxy routes.
- Plugin `setup.fields` of type `secret` are persisted encrypted at rest;
  they are never round-tripped to the LLM.

If you discover a credential in an agent prompt during review, treat it as
a leaked credential — rotate it before merging the fix.

## 2. Outbound calls go through internal proxy routes

Agents and sub-agents do not call third-party APIs directly. They call
middleware routes (`/api/internal/<provider>/<resource>`), and the middleware
attaches credentials server-side.

Benefits:

- The credential never enters the LLM context window.
- Rate-limiting, audit logging, and response-shape validation happen in one
  place.
- Rotating a credential is a vault update + middleware redeploy. The agent
  configuration does not change.
- LLM provider keys are the exception to the redeploy: since #1080 a vault
  write to the orchestrator scope drops the kernel provider pool's cached
  client, and removing the Anthropic key revokes the shared host
  `anthropicClient`/`llm` live (falling back to `ANTHROPIC_API_KEY` if set,
  otherwise to an unauthenticated client). After a deletion the kernel pool
  and the orchestrator stop using the key immediately. Two limits remain:
  the shared host client falls back to `ANTHROPIC_API_KEY` when it is set,
  and on installs whose vault key was seeded from that env var at first boot
  it is the same key, so host consumers (plan-runner gate, Teams, builder)
  keep using it until the env var is removed. Sub-agents that
  `DynamicAgentRuntime` has already built keep their captured provider until
  a restart or rebuild. Both limits are recorded as open items in
  `middleware-agent-handoff.md` §13.

Pattern: thin proxy handler → typed client → upstream API. Document the
proxy contract next to the handler, not in the agent prompt.

## 3. Scope-locked sub-agent tools

Sub-agents operate with a `sessionScope` that constrains what they can read
or write. When a sub-agent is constructed it receives a *scoped* lookup
tool (`createGraphLookupTool(scope)`), not the raw graph client. The scope:

- Restricts entity reads to the current tenant / chat / user as appropriate.
- Prevents one user's sub-agent from reading another user's turn history.
- Survives prompt-injection attempts that ask the sub-agent to "use a
  different user id" — the tool simply does not accept an override.

## 3a. Subscription-CLI process boundary (#991, #992, #993)

On the subscription path (`claude-cli` provider, Shape 3) the agent loop does
not run in the middleware. `CliChatAgent` spawns the official `claude` CLI as a
child process and hands it omadia's tools over a per-turn loopback MCP server
(`mcp__omadia__*`). Everything omadia enforces in-process — plugin grants,
audience floor, privacy guard, `sandbox_execute_enabled` — sits in front of
*omadia's* tools. The CLI's own built-in tools (Bash, Edit, Write, Read,
WebFetch, WebSearch, Agent, …) sit behind them, run with the user's OS rights,
and are one prompt injection away from any mail, document or web page the agent
reads. Beta test round 4 demonstrated exactly that: the agent ran
`whoami && hostname` on the tester's Mac on request, with no gate involved.

`--allowedTools mcp__omadia__*` alone was insufficient because it is a
**pre-approval** list, not a restriction: it only says which tools may run
without prompting. It never removed the built-ins, and `--strict-mcp-config`
limits MCP servers only.

**Both** spawn sites carry the gate since #1007. It is defined once, in
`middleware/packages/harness-orchestrator/src/cliSpawnGate.ts`, and applied by
`cliChatAgent.ts` (Shape 3, tools over the loopback server) and
`middleware/src/platform/claudeCliAdapter.ts` (Shape 2, single-shot
completions: session summary, fact extraction, classifier, verifier-judge).
The second site was missed by #991 and was the more exposed of the two: its
prompts are assembled from end-user chat text and uploaded documents, and the
read-only built-ins never prompt for permission, so injected text could read
host files and return them inside a summary omadia persists. It also loaded
the operator's `settings.json` (hence `hooks`) and their MCP servers. It now
uses the same flags plus an mcp-config declaring no servers, since it serves no
tools and therefore pre-approves nothing.

The gate, asserted by `test/cliBridge/cliSpawnGate.test.ts` and
`test/cliBridge/cliChatAgent.test.ts`:

| Flag | What it closes |
|---|---|
| `--tools ""` | Removes the CLI's built-in tool set; only MCP tools remain. Primary lever. |
| `--disallowedTools <CLI_BUILTIN_TOOL_DENYLIST>` | Names every built-in explicitly; the fallback for a CLI that ignores `--tools`. The list is an exported constant so the test asserts the contract, not the intent. |
| `--permission-mode dontAsk` | Anything not pre-approved is denied outright. There is no human at a permission prompt in an omadia chat. |
| `--setting-sources ""` | Loads no user/project/local `settings.json`. Otherwise the host user's `~/.claude` settings apply, including `hooks` (shell commands that run on every tool call) and personal allow rules. Credentials are unaffected: the CLI reads them from `CLAUDE_CONFIG_DIR`, not from settings. |
| `--strict-mcp-config --mcp-config <0600 file>` | Only omadia's loopback server; no MCP servers from the user's own config. |
| `--allowedTools mcp__omadia__*` | Pre-approves omadia's tools so the turn does not stall on a prompt. |
| `--system-prompt <omadia prompt>` | Replaces the CLI's default prompt. With `--append-system-prompt` the model kept Claude Code's identity, treated the CLI toolbox as its own and told users in the omadia chat to "go to omadia" (#992). `composeCliSystemPrompt()` always states the runtime and the only toolset the model has. |
| `--restricted` (#1014, version-gated since OM-85) | Removes the code-running built-ins and WebFetch unless `--tools` names them, ignores user/project/local settings files, and confines the file tools. Additive belt over `--tools ""`. Chosen over `--bare`, which also skips `CLAUDE.md` discovery but reads neither OAuth nor the keychain — it would break the keyless subscription login outright. **Passed only when the installed CLI is ≥ 2.1.248** (`resolveCliVersion()` probes `claude --version`, cached 5 min; `supportsRestrictedFlag()`): older CLIs do not ignore an unknown flag, they exit 1 with `unknown option`, which killed every turn on a 2.1.246 install (OM-85). On every spawn, regardless of version, the env twin `CLAUDE_CODE_RESTRICTED=1` is set — a CLI that knows it gets the same boundary, one that does not ignores the key. **Deliberate trade-off:** an unknown or unparsable version means the flag is left out, i.e. one protective layer fewer (the three layers `--tools ""`, `--disallowedTools`, `dontAsk` still hold), rather than a dead subscription path. A CLI that rejects one of *our* flags surfaces as `CliIncompatibleError` (`code: cli_incompatible`) with the update instruction, not as a failed answer. |
| `cwd` = empty temp dir (#1014) | The CLI **hardcodes** `CLAUDE.md` / `AGENTS.md` discovery and only `--bare` skips it, so no flag closes this. Without a `cwd` the child inherited the middleware process's directory and any `CLAUDE.md` at or above it joined a prompt built from user content. Both sites now spawn in a per-turn temp dir holding nothing but the mcp-config. |
| Binary resolution (#1085) | Every spawn site — chat turn, completion provider, and the CLI sub-agents (`ask_<slug>`, agent builder, preview chat) — resolves the binary through the kernel's `resolveCliBin()` — `<CLI_TOOLS_DIR>/bin/claude` (default `<PLATFORM_DATA_DIR>/cli-tools`) when a runtime install put one there, else the bare name from PATH. Previously they spawned the bare name while the version badge, the login flow and the "Install now" button all used the resolved path, so an operator could install a CLI ≥ 2.1.248 through the UI and every turn kept running the older image binary — including the `--restricted` version probe above, which then dropped the flag against a deployment the UI reported as up to date. The rule is published as the `cliBinaryResolver` kernel service (`optional_requires` in the orchestrator manifest) because `@omadia/orchestrator` cannot import the app layer; kernel-side callers share `src/platform/cliBinary.ts` (`resolveClaudeCliBin()`). Absent, every site falls back to PATH. Resolution runs **per turn / per completion**, so an install takes effect on the next turn rather than the next restart, and the spawn log names the resolved path. Credentials are unaffected either way: both binaries read the same `CLAUDE_CONFIG_DIR`. The candidate must be executable (`X_OK`, which follows symlinks) and is made absolute, because every spawn runs in a temp `cwd` where a relative path would not resolve; otherwise PATH. **Trust consequence:** the install dir is now the binary every turn executes, so its writers — the authenticated `POST /api/v1/admin/cli-backends/:id/install` and anything with write access to the data volume — choose the binary the gate wraps. That route accepts any strict-semver version, so a runtime install below 2.1.248 drops `--restricted` for turns exactly as an old image pin does; the spawn log's `restrictedFlag` shows it. Like any kernel service, `cliBinaryResolver` can be swapped with `ctx.services.replace` by a plugin that declares it under `requires`/`optional_requires` (the #788 gate treats `replace` like `get`); that is no escalation over in-process plugin code, but if such a plugin activates before the orchestrator (which resolves the service once, in `activate()`), it chooses the binary for every chat turn, so a manifest declaring this service deserves review. |
| Env allowlist (#1014) | `buildGatedCliEnv()` passes only `PATH`, `HOME`, `CLAUDE_CONFIG_DIR`, `TMPDIR`, locale/`TZ`, proxy and CA vars, and `USER`/`LOGNAME`. It replaced a deny list that removed credentials and billing switches but passed `NODE_OPTIONS` (which can `--require` arbitrary code into the child) and the whole `CLAUDE_CODE_*` family. The deny list is kept as a second layer, and a test asserts the two never overlap. |

### No Privacy Shield on this path — and chat history is replayed (#1087)

"Privacy guard" in the list above does not mean the CLI child receives masked
data. Only the in-process orchestrator installs a per-turn privacy handle, so on
the subscription-CLI path the live user message,
tool results and — since #1087 — the replayed chat history reach the vendor
unmasked. `CliChatAgent` replays the newest `DEFAULT_CLI_SESSION_TAIL_SIZE` (10)
completed turns of the session into the child's stdin prompt, truncated to 600
characters per question and 1,200 per answer, with role markers neutralised so
replayed text cannot forge a `User:`/`Assistant:` line. For a session whose
earlier turns ran on an API-key provider with Privacy Shield active, those
persisted turns hold RESTORED real values, so up to ten of them now reach the
CLI child raw. This is a deliberate trade-off in line with the UI's notice not
to route personal data through this provider. `maskHistory` already routes the
replay through the turn's privacy handle and becomes effective the moment one is
installed on this path; masking parity is tracked on #1087.

### Why the deny list is generated, not written (#1014)

The first version was hand-collected and missed 40 real tool names, `Tmux`
among them — a terminal, the exact class the gate exists to remove — plus
every `self_hosted_runner_*`, of which `spawn_local` starts local sessions. It
also listed `KillShell` and `BashOutput`, which are **aliases** in 2.1.259, not
canonical names, so those entries may have matched nothing.
`CLI_BUILTIN_TOOL_DENYLIST` is now a superset of the installed binary's own
inventory (2.1.259 ships 78 built-ins plus 105 `mcp__…` names in one array)
and lists all ten declared aliases alongside their canonical names.

Two of those aliases were missed until a review caught them: `RunWorkflow`
(alias of `Workflow`, and its metadata declares `enablesCodeExecution`, so it
was an open code-execution path) and the three MCP-resource short forms
`ListMcpResources` / `ReadMcpResource` / `ReadMcpResourceDir`.

**The drift guard mines the binary and subtracts the deny list, not the other
way round.** Its first version could not detect drift at all: it built its
candidate set out of `CLI_BUILTIN_TOOL_DENYLIST` plus extras that were already
in the deny list, then filtered for names not in the deny list, which is empty
by construction. A reviewer replayed it with `Read` removed, with `WebFetch`
removed and with 40 further names removed, and it stayed green every time — 55
of 100 entries were deletable with nothing going red. The guard now parses the
inventory array and the tool-metadata `aliases:[…]` arrays out of the binary,
subtracts the constant, and fails on any remainder. It also asserts that the
mining found something, so "nothing drifted" can no longer be confused with
"nothing was parsed". Verified by planting omissions: removing `Read`,
`WebFetch`, `Tmux`, `ReadMcpResource` or `RunWorkflow` each turns the suite
red, and restoring them turns it green.

Not every entry is a 2.1.259 tool. The list is deliberately a superset so an
upgrade cannot open a hole between releases; `JavaScript` is one such entry and
is **not** a tool in 2.1.259 — the only `"JavaScript"` strings in the binary
are bundled highlight.js language metadata.

### The gate is verified behaviourally, not just by argv shape (#1017)

Every other assertion here is "we passed the flag", and the incident that
started this was a flag that did not mean what we thought. So
`test/cliBridge/cliGateLiveProbe.test.ts` spawns the real binary with the real
production argv and asks it to run a shell command. Measured on 2.1.259
(2026-09-03), same prompt and model in both runs:

| argv | tools used |
|---|---|
| production gate | none |
| pre-#991 (`--allowedTools` only) | `Bash` |

That settles the open question from #1017 — `--tools ""` does mean "no built-in
tools" in practice, not only in the help text — and the pre-gate argv
reproduces the original OM-81 finding on demand. The probe is opt-in
(`OMADIA_CLI_LIVE_PROBE=1`) because it spends subscription quota.

Two further pieces make the boundary observable and keep omadia's own tools
working across it:

- **Foreign tool marking.** `StreamJsonParser` sets `foreign: true` on every
  `tool_use` event whose name is not `mcp__omadia__*`. The built-ins are
  removed at spawn time; if one ever surfaces anyway it can never read like an
  omadia tool in the trace. CLI sub-agents (`createCliSubAgent`: the builder
  and its preview chat, #1072) never forward such a call to their
  `AskObserver`, because the builder trace cannot mark it; they count it via
  `recordForeignToolCall` (`builder` / `builder-preview`) or, with no counter
  wired, log `[security] FOREIGN`. Their `AskOptions` only shape the text of
  the one post-turn re-prompt and never reach the spawn argv, so they cannot
  widen the gate.
- **Turn context across the process hop (#993).** A tool call on this path
  arrives as an HTTP request from the external process, in a fresh async
  context, so `AsyncLocalStorage` values the channel set around `chat()`
  (today `routineTurnContext`) were undefined inside `dispatch()` and
  `manage_routine` reported "no user context" to a user who was in a channel.
  `LoopbackMcpServer` takes `AsyncLocalStorage.snapshot()` when it is
  constructed — inside the turn, in `CliChatAgent.runLifecycle` — and runs
  every `tools/call` inside that snapshot. The snapshot carries whatever stores
  are active at construction, so a future store needs no change here; a
  `CliChatAgent`-level test guards against hoisting server creation out of the
  turn.

  Two corrections from #1016. The capture now happens at `chat()` /
  `chatStream()` entry, not in the generator body: `runLifecycle` is an async
  generator, so its body runs at the first `.next()` and a snapshot taken there
  belongs to whoever iterated, not to the caller. `chatStream` is therefore a
  plain method returning a generator rather than an `async *` method. And
  restoring a context is not the same as trusting it — `routineTurnContext` is
  entered with `enterWith`, which has no scope exit, so a stale chain can carry
  an older turn's identity. Before #993 that failed closed ("no user context",
  the tool refused); afterwards the same staleness would mean acting as the
  previous principal. `LoopbackMcpServerDeps.assertTurnOwner` restores the
  refusal: it runs inside the restored context immediately before dispatch and
  throws on mismatch.

  That hook is now wired end to end. The implementation cannot default inside
  the orchestrator package, because the store it reads (`routineTurnContext`)
  lives in the application layer, so the chain is: the kernel publishes
  `createRoutineTurnOwnerGuard()` as the service `routineTurnOwnerGuard`
  (`middleware/src/plugins/routines/turnOwnerGuard.ts`); the orchestrator plugin
  **declares** it under `optional_requires:` in its manifest and resolves it
  with `ctx.services.getOptional`; and `buildOrchestratorForAgent` forwards it
  into `CliChatAgent` as `turnOwnerGuard` — the CLI runtime only, since that is
  the one path where a tool call crosses a process boundary. Among the shipped
  channels only the Teams adapter calls `captureRoutineTurn`, so it is the only
  one that installs a context this guard can find stale.

  **#1086 changed what reaches the guard, not what it refuses.** Channels that
  drive their turn through `CoreApi.handleTurnStream` (in-tree: public API,
  canvas) now carry a routine principal the core installed. That producer uses
  `routineTurnContext.run`, so its value ends with the turn and can never be the
  stale one; and it deliberately does not defer to a context belonging to a
  *different* user. Adapters that call the `chatAgent` capability directly
  (Teams, Telegram, Slack, Discord, WhatsApp as of 2026-09) never reach that
  producer. `enterWith` — i.e. `captureRoutineTurn` — remains the only way to
  leak a principal forward, and Teams remains its only caller; because Teams is
  one of the direct-`chatAgent` adapters, the producer's stale-context
  correction never applies to it, and this guard is still the only defence
  against its staleness. Routine ownership is `(tenant, userId)` with
  channel-native ids and no channel component, so a channel moving onto
  `handleTurnStream` must supply ids that cannot collide with another
  channel's (`key:<uuid>` on the public API).

  **The declaration is part of the mechanism, not bookkeeping.** Both
  `services.get` and `services.getOptional` run `assertServiceGranted`, which
  throws `ServiceNotDeclaredError` for a name in none of `requires:`,
  `optional_requires:` or `provides:`. This resolution sits near the top of
  `activate()`, so the first cut of the wiring — a `get` on an undeclared name —
  threw on every boot, `toolPluginRuntime` recorded an activation failure,
  `chatAgent@1` was never published, and every channel declaring
  `requires: ["chatAgent@^1"]` skipped activation. A guard intended to harden
  one dispatch took chat down on every channel instead. `optional_requires` is
  the correct block, and `getOptional` the matching verb, because a host that
  publishes no such service must keep booting with the pre-#1016 behaviour. The
  legacy allowlist table is explicitly not the remedy: its docblock declares it
  a closed, dated set where a new row is a regression.

  The guard compares the restored context's `userId` against the turn's own;
  both are the same channel-native id written by the same adapter, so they agree
  for a turn that owns its context and disagree exactly when the chain is stale.
  Context present but the turn names no owner ⇒ refuse, that being the stale
  shape; mismatch ⇒ refuse; no context ⇒ pass. When this guard landed, that
  last row was narrower than the obvious phrasing: `manage_routine` refused a
  missing context in `create` and `list` only. #1025 closed the rest, so all
  five actions now resolve context and refuse without it. The reason to pass
  is still that throwing would harden every context-free HTTP turn, this
  guard's job being staleness rather than authorization. The refusal names
  neither principal (it reaches the model) and carries a short correlation ref
  that also appears in the server log, so a user's report can be matched to a
  log line without either side naming anyone.

  Reviewer note, two parts. The wiring is pinned by `buildOrchestrator.test.ts`,
  which asserts the constructed `CliChatAgent` carries the guard — the first
  round shipped a correct guard with no caller, so a test on the guard function
  alone does not cover the risk. And the service name exists three times in
  files that cannot import each other (kernel constant, package-side literal,
  manifest entry), so `routineTurnOwnerGuardGrant.test.ts` ties them together;
  drift there would look exactly like the supported "no provider installed"
  state. `pluginServiceGrantCoverage.test.ts` catches the undeclared half
  repo-wide.
- **A routine id is not an authorization (#1025).** `manage_routine` resolved
  the turn context for `create` and `list` but not for `pause`, `resume` and
  `delete`, which passed a bare `args.id` to a runner whose store filtered on
  `WHERE id = $1` alone. Knowing an id was therefore enough to pause, resume
  or delete any tenant's routine. Ids are uuids and `list` is scoped, so an id
  had to leak rather than be enumerated — obscurity, not authorization.

  Three things changed. The scope is a required, discriminated argument on the
  runner (`{ kind: 'channel-user', tenant, userId }` or `{ kind: 'operator' }`)
  rather than an optional `owner?`, because an optional scope is one a caller
  can forget and forgetting it is how this arose; a cross-tenant operation is
  now a greppable `operator` literal instead of an omission. The predicate
  itself lives in the SQL (`AND tenant = $n AND user_id = $n`), so it cannot
  be raced by a read-then-act caller and cannot be bypassed by a caller that
  never supplied a scope. And a scoped miss raises the same
  `RoutineNotFoundError` as a genuinely absent id, so the error channel is not
  an existence oracle.

  Two neighbours were the same class of gap and are fixed with it. The
  smart-card actions in `integration.ts` are a second door onto the same
  mutations and were equally unscoped — the card carries the id, so a replayed
  payload reached pause/resume/trigger/delete for any row. And
  `triggerRoutineNow` delivers into the routine's *own* `conversationRef`, so
  an unscoped trigger let one principal push messages into another tenant's
  conversation on demand. The operator HTTP router stays deliberately
  cross-tenant, stated once as `OPERATOR_SCOPE`. Precisely: it sits behind
  `requireAuth`, which verifies the session JWT and, for Entra sessions, the
  `ADMIN_ALLOWED_EMAILS` whitelist — it checks neither role nor tenant, so
  the gate is "any valid operator session", not "operators-only" as an
  earlier draft of this entry claimed.

  **The card path takes its principal from the channel, or refuses (#1029).**
  Scoping the smart-card handler from the turn context alone would have broken
  all four buttons in production. The Teams adapter dispatches card clicks
  out-of-band — `handleMessage` takes the routine branch and returns before
  `runOrchestratorTurn`, so `captureRoutineTurn` never fires and the context
  is always absent there. #1029 therefore added an `actor` to the contract
  (the tenant and user of the activity behind the click), but as an interim
  kept a fallback chain: explicit `actor`, then the turn context, then
  UNSCOPED as before #1025. That last step meant a missing principal widened
  rights to operator level, for any adapter that did not send `actor`.

  The fallback chain is gone. `handleRoutineAction` scopes by `actor` and by
  nothing else (`routineCardActor.ts`): an absent actor, a blank tenant or
  user id, or anything that is not a pair of strings is refused with
  `RoutineActorRequiredError` before any row is read, and counted by
  `refusedRoutineActionMetrics` with an error-level log naming the action and
  id — expected to stay at zero. The turn context is not consulted either: on
  an out-of-band path a context can only be one that `enterWith` leaked
  forward from an earlier turn (#1016), which would attribute the click to
  whoever spoke last. Blankness is judged on the trimmed value, but the scope
  carries the values verbatim, because they must equal what
  `captureRoutineTurn` filed the routine under. channel-teams sends `actor`
  since 0.26.1; an older adapter gets the refusal on every card button. The
  contract type keeps `actor` optional so 1.x callers still compile — the
  runtime refusal, not the type, is the protection — and plugin-api 2.0 will
  make it required. The capability ref stays `routinesIntegration@1`.

  `{ kind: 'operator' }` now has exactly one producer, the `requireAuth`-gated
  router in `routes/routines.ts`. `routineOperatorScope.test.ts` walks the
  AST of `src/` and fails on a second object literal of that shape, and pins
  that the router is mounted behind `requireAuth` with no path under it on the
  `publicPaths` list — the list `requireAuth` itself consults before it
  enforces anything.

  The card-path tests deliberately do NOT wrap the call in
  `routineTurnContext.run`, except the one proving a captured context does not
  substitute for `actor`. That wrapper is what made the first #1029 suite pass
  while production would have answered "routines are unavailable in this
  session" on every click.

  One ordering bug surfaced while scoping `delete`: the runner unregistered
  the scheduler *before* deleting, so a cross-tenant id silently disarmed
  someone else's cron while the row survived — a routine that still looks
  active in `list` and never fires again, which is harder to notice than a
  deleted row. Unregistration now happens only after the scoped delete
  reports a row was removed.

  Reviewer note: the layer tests stub the store, so they prove the callers
  *pass* a scope, not that the store *uses* it. Measured — with the SQL
  predicate removed from both statements, all 21 layer tests stayed green.
  `routineScoping.test.ts` therefore also drives the real `RoutineStore`
  against a recording pool and follows each `$n` the SQL names into its bound
  value, which is what makes a dropped predicate fail. Planted-omission
  results across `routineScoping.test.ts` and `routineOperatorScope.test.ts`
  (re-measured when the card fallback was removed): tool scope replaced by
  operator 5 red (four behavioural, plus the one-producer scan), store
  predicate dropped 2 red, delete ordering flipped 2 red, card fallback chain
  restored 7 red.
- **Only advertised tools are dispatchable (#1015).** `tools/call` used to
  forward any name into `dispatch()`. The dispatchable set is wider than the
  advertised one — handler-only registrations stay dispatchable but
  unadvertised, and readiness-gated tools are filtered out of the advertised
  list — and since the CLI runs with `--allowedTools mcp__omadia__*`, which
  pre-approves the whole namespace, this handler is the only place that can
  tell them apart. It now rejects an unadvertised name with
  `McpError(MethodNotFound)` before dispatching.
- **Teardown cannot hang a turn (#1015).** The child is killed *before*
  `server.stop()` is awaited, and `stop()` calls `closeAllConnections()` before
  `close()` under a 2s race. Previously `stop()` was awaited first and only
  called `close()`, which waits for live connections: on an abort path the
  child was still running and holding a keep-alive socket, so the await could
  block indefinitely, the kill escalation never ran, and the turn hung holding
  its semaphore permit while a bearer-gated server kept listening.

## 3b. Agent sandbox containers: resource ceilings (#576, #581)

The `execute` tool (#576) runs agent-issued shell commands in a long-lived
Docker container per scope, and `publish` (#581) runs agent-written apps in a
container per version. Both are off by default (`sandbox_execute_enabled`,
`sandbox_publish_enabled`). `profile.egress: false` already becomes
`--network none`. `AgentComputerProfile.maxRunSeconds` bounds one `run()` call
only: its `timeout` kills the wrapper shell, not processes the command left
running in the container. Before this section existed nothing else bounded the
container, so a fork bomb or a runaway allocation competed with the middleware
for the same host.

Every `docker run` for agent code now carries three ceilings:

| Flag | Default | Setup field (orchestrator) | Env variable |
|---|---|---|---|
| `--memory` and `--memory-swap` (same value) | 512 MiB | `sandbox_memory_mb` | `OMADIA_SANDBOX_MEMORY_MB` |
| `--cpus` | 1 | `sandbox_cpus` | `OMADIA_SANDBOX_CPUS` |
| `--pids-limit` | 256 | `sandbox_pids_limit` | `OMADIA_SANDBOX_PIDS_LIMIT` |

- **Resolution per field:** setup field, then env variable, then default
  (`readSandboxResourceLimits()` in the orchestrator's `sandboxLimitsConfig.ts`
  over `resolveSandboxResourceLimits()` in `@omadia/sandbox`). `plugin.ts`
  reads the values once, passes them to both Docker paths and logs the
  effective limits at boot.
- **Fail-closed, no "unlimited".** Docker reads `0` as "no limit" for all three
  flags, and it also starts some positive values with no limit and no error:
  `--cpus` below 0.00001 truncates to a CFS quota of 0, which runc writes as
  `cpu.max max`; `--cpus 1e64` overflows the CLI's int64 nano-CPU count and
  wraps to 0; `--memory` from 2^43 MiB, or rendered as `1e+21m`, overflows
  int64 and is recorded as no limit on arm64. So a value only counts inside
  its field's range (`SANDBOX_RESOURCE_LIMIT_BOUNDS` in `resourceLimits.ts`):
  - memory: a whole number of MiB from 6 (Docker refuses less) to 1048576,
    i.e. 1 TiB, far below the overflow;
  - CPUs: 0.01 (the smallest quota the kernel accepts) to 1024, which only
    keeps the value finite, since Docker refuses more CPUs than the host has;
  - PIDs: a whole number from 1 to 4194304, the most the kernel's `pids.max`
    takes (`PID_MAX_LIMIT`).

  Anything else (0, negative, out of range, empty, junk) counts as unset and
  falls through to the next source, and every accepted value renders as plain
  digits, never in exponent notation. `dockerResourceLimitArgs()` re-validates
  its input, so a hand-built `{ memoryMb: 0 }` or `{ cpus: 1e-7 }` cannot
  reach argv either. A value in range that Docker still refuses (more CPUs
  than the host has, a CPU value with more than nine decimals) makes
  `docker run` fail, which is closed as well.
- **Swap is capped at the memory limit.** With `--memory` alone Docker allows
  the same amount again as swap, so "512 MiB" would have meant up to 1 GiB. It
  also makes raising the limit work: `docker update` refuses a `--memory` above
  a swap ceiling that is not updated in the same call.
- **Existing containers.** Limits are fixed at `docker run`. When a persistent
  sandbox is re-attached, the backend first runs `docker update` with the
  current limits, then `docker start`. That covers containers created before
  the limits existed and containers created under different values. The update
  is best-effort: a refusal is logged (`[sandbox] docker update … failed`) and
  the container keeps the limits it has; the re-attach itself does not fail.
  Publish containers are immutable per version and never re-created, so one
  that predates the limits runs without them until a new version replaces it.
- **One builder.** Both `docker run` sites (`DockerSandboxBackend.runContainer`,
  `DockerPublishRuntime.deploy`) and the update path take their flags from
  `dockerResourceLimitArgs()`.
- **Host caveat.** On a host whose kernel lacks one of the cgroup controllers,
  `docker run` prints a warning and starts the container without that limit
  (exit 0), so an argv assertion cannot notice. The real-Docker test tier
  (`SANDBOX_DOCKER_TEST=1`) checks `docker inspect`, reads the enforced CPU
  quota from `cpu.max` (cgroup v2) and checks that a 700 MB allocation is
  killed; run it once on any new host type.

Tests: `middleware/test/sandbox/resourceLimits.test.ts` (ranges, fallback
order, argv), `middleware/test/sandbox/dockerSandboxLimits.test.ts` (stub tier
for argv and the update-before-start order, real tier for what the daemon and
the kernel applied, including out-of-range values),
`middleware/test/sandbox/sandboxLimitsConfig.test.ts` and
`middleware/test/publish/dockerPublishRuntime.test.ts`.

## 4. Plugin install surface

Plugins are installed as signed ZIPs uploaded through the operator UI, not
discovered from public registries. This keeps the supply chain explicit:

- The operator chooses which artefacts run.
- A plugin manifest declares its `permissions` (memory, graph, network,
  filesystem). The runtime enforces the declaration.
- A plugin's `depends_on` is a soft contract, not an automatic install
  trigger.
- Optionally (issue #453), every ingested package — direct upload, hub
  install, Builder install — is statically scanned by an NVIDIA
  SkillSpector sidecar (`SKILLSPECTOR_URL`, deterministic `--no-llm` mode,
  no outbound calls; the scanner dependency is pinned to an exact upstream
  commit SHA — pin-bump procedure in the sidecar README). The scan is
  **advisory-only in v1**: it runs fire-and-forget after a successful
  ingest, its verdict (severity + findings, cached by ZIP sha256 + scanner
  version in `plugin_verdicts`, migration 0021) decorates the store detail
  page, and a scanner outage degrades to a `scan_failed` verdict — never a
  failed install. With `SKILLSPECTOR_URL` unset no scan is scheduled and no
  verdict row is written. The result pipeline is **fail-closed**: only
  SkillSpector's positively-verified report schema counts as a scan; an
  unrecognized schema is recorded as `scan_failed`, never as a
  `no_signals` all-clear. Entry-point coverage is fail-closed too: upload
  validation rejects a `lifecycle.entry` that resolves below
  `node_modules` or a hidden directory (`package.entry_unscannable` —
  the scanner's directory walk skips those, so the runtime would execute
  code the scan never saw), and as defense in depth the scanner
  force-includes the manifest's entry file in the scan payload when the
  walk skipped it, recording `scan_failed` when coverage cannot be
  guaranteed. Operator acknowledgements persist
  `ack_by`/`ack_at`/`ack_severity` for audit and are cleared automatically
  when a later re-scan worsens the verdict beyond the acked severity;
  turning the verdict into a hard install block is deferred until omadia
  has a role model (same policy gap as skill-verdict suppression, see
  `agentBuilder.ts`).

### Plugin-borne workflow templates (#478)

Plugins may contribute Conductor workflow templates, and the capability is
deliberately data-only:

- **Templates are data, never code.** A plugin declares TemplateManifest
  JSON files under `permissions.templates` (package-relative paths). That
  declaration is the entire capability: there is no runtime template API
  (`pluginContext.ts` gains no `ctx.templates`), nothing from these files is
  ever executed, and no registration endpoint exists — the only ingestion
  path is the plugin package itself.
- **Fail-closed install gate** (`src/plugins/pluginTemplates.ts`, invoked by
  `InstallService.configure()` before any persistent write): `.json` files
  only; the declared path must resolve inside the package root *after
  symlink unwrapping* (a confined-looking path whose file symlinks outside
  the package is rejected); the template id must be namespaced
  `plugin:<pluginId>:<name>` so a plugin can never shadow a bundled or
  user template id; the manifest must pass
  `checkTemplateManifest({ strict: true })` — undeclared concrete refs
  (agents/actions/roles/events/channels) are rejected as
  confusion/exfiltration vectors pointing at install-local entities — and
  every cron trigger value must pass `isValidCron`. Any violation fails the
  install with `install.template_invalid` and the per-template findings.
- **Read-only in the catalog.** Accepted manifests register as
  `source: 'plugin'` entries in the Conductor's composite template catalog;
  PUT/DELETE/submit/approve refuse them (403), and they are unregistered on
  uninstall. Boot re-registers templates of already-installed plugins
  fail-open per template (the fail-closed gate already ran at install time;
  a template problem must not brick boot).
- **Instantiation stays gated.** Plugin templates run through the same
  resolve/instantiate path as every other template, including live
  `KnownRefs` validation — a template referencing entities this install
  lacks fails visibly at mapping time, never silently.

### `ctx.tools.invoke('memory')` runs in the caller's own scope (#909)

`ctx.tools.invoke(name, input)` dispatches straight to a `NativeToolRegistry`
handler and bypasses the per-turn dispatch hooks (privacy guard, telemetry).
For `memory` that handler belongs to the memory provider and is bound to the
undecorated root store, so before #909 any activated plugin could read, write,
rename and delete every Agent's and every plugin's memory, with or without
`permissions.memory`. `invoke('memory', …)` therefore never reaches the
registry handler (`src/platform/pluginContext.ts`):

- A plugin whose manifest declares no `permissions.memory` (no non-empty
  `reads`/`writes`) gets a `ToolInvokePermissionError`. The call is denied,
  not narrowed.
- If no memory store is published, the call throws `'memory' is unavailable`.
  It never falls back to the root-bound handler.
- Otherwise the kernel runs its own `MemoryToolHandler` over
  `createPluginMemoryToolStore` (`src/platform/memoryAccessor.ts`). In that
  view `/memories` is the plugin's `ctx.memory` scope,
  `/memories/orchestrators/<agentSlug>/plugins/<pluginId>/`, with the slug
  read from the turn context on every call (`default` outside a turn). Both
  views share `pluginMemoryScope()` and `normalizeRelPath()`, so they cannot
  disagree. Paths outside `/memories`, `..` and NUL bytes are refused before
  any store call, and store entries outside the scope throw instead of
  leaking. The pre-isolation `/memories/agents/<pluginId>/` tree is a
  read-only fallback for the default Agent only.
- The scope is a string prefix, and every store must treat it literally.
  `PostgresMemoryStore` escapes `%`, `_` and `\` in its `LIKE` prefix scans.
  Plugin ids may contain `_`, and an unescaped `_` would let `@omadi_/x` match
  `@omadia/x`'s tree on a directory rename or delete.
- Only `memory` is routed; every other tool name keeps the registry dispatch.
  A new native tool bound to shared or unscoped state must be routed or denied
  the same way before it is registered.

## 5. Signed artefact URLs

User-visible artefacts (rendered diagrams, attachments, exports) are stored
in object storage and served via HMAC-signed URLs with a short TTL
(default: 3600s). The signing secret is a vault entry, not a config value.

URLs are scoped to a tenant prefix so that bucket browsing does not reveal
other tenants' keys.

**No operator session is required to open one — by design.** The people who
click these links are channel users (Teams, Telegram) who are never logged into
the middleware. Since Epic #470 C6 every plugin route sits behind the kernel's
session gate by default, which made every `/documents/…` and `/diagrams/…`
download answer `auth.missing`. Both routers therefore register with
`auth: 'custom'` — they authenticate each request themselves via the HMAC
signature and expiry, exactly like a presigned S3 URL — beneath the prefixes
`/documents/dl` and `/diagrams/dl`, declared in their manifests'
`permissions.public_paths` (a claim must be at least two segments deep, hence
`/dl`). The prefix is only served session-less once the operator has granted
it (`PUT /api/v1/admin/runtime/installed/:id/public-paths`); until then the
kernel keeps the session gate in front, fail-closed. What the link buys is
what it always bought: whoever holds it can fetch that one object until it
expires; there is no per-tenant or per-session authorisation on top.

## 6. Defence in depth for cached data

The Odoo / external-system response cache and the in-memory conversation
history are convenience layers, not security layers. They:

- Honour the same scope filters as the underlying graph queries.
- Do not extend a credential's lifetime beyond the originating request.
- Are flushed on process restart; they are not a substitute for persistence.

## 6a. Dataset link keys — a deliberate identity handle inside the Privacy Shield

Uploaded CSV/XLSX rows are PII-masked irreversibly at import, and the surrogate a
value receives depends on that file's value set. Two uploads of the same people
therefore share no identity, and the C0 baseline does not detect names at all —
a `Name` column is clear at rest yet masked downstream by the v4 shape
classifier, which then refuses it as a verb key. Cross-file de-duplication was
impossible without letting the model see names.

The resolution is `datasetLinkKey.ts`: every string column gets a companion
`__k_<column>` = `HMAC-SHA256(secret, ownerOmadiaUserId ‖ "\n" ‖ normalize(raw))`,
truncated to 16 hex chars with a guaranteed digit. The model **does** see this
handle in clear — that is the point, and it is a deliberate weakening relative to
"irreversible per file". What keeps it inside the shield:

- **Not invertible, not guess-testable.** Without the process-held secret a key
  neither reveals nor confirms a value. Filters on `__k_*` in `query_dataset`
  are refused server-side, so the model cannot pair a chosen value with its key.
- **Keyed per user, not per tenant.** Datasets are owner-scoped everywhere
  (`queryDatasetRows(datasetId, ownerId)`, route session id, orchestrator
  `resolvedOmadiaUserId` — one id space). A per-user key adds no linkability the
  owner did not already have; a tenant-wide key would. Consequence to keep in
  mind: the user-id string is part of the MAC input, so an identity merge or a
  future dataset-sharing feature de-links older uploads — by design, not by bug.
- **Classification rules untouched.** The key clears as `safe-cleartext` via the
  existing S5 `id` rule; `requireSafe` in the verb engine is unchanged. Masked
  columns are still never keys.
- **Secret lifecycle.** `DATASET_LINK_KEY_SECRET`, or HKDF from `VAULT_KEY`
  (`omadia/dataset-link-key/v1`) when unset. Rotating either re-keys every
  future import; older datasets stop linking with newer ones. No key material
  is ever written to a dataset.
- **Residual.** A pre-existing `query_rows` filter oracle on clear-at-rest
  columns (`contains` on `Name`) can, in principle, associate a probed row with
  its now-stable handle. The handle is worthless outside this user's datasets.

### 6b. Uploaded PII cells: encrypted at rest, cleartext only server-side

Until this change a cell the import scan flagged was **masked irreversibly**
(#430/#727): the surrogate was persisted, the real value gone. That made every
downstream use wrong for the person entitled to the data — a merged contact
list showed `lukas.becker@example.net` in every row (each cell got the first
pseudonym candidate) and the Excel export of it was worthless.

The shield's boundary is the **model**, not the server. Flagged cells are now
stored as `enc1:<base64url(iv ‖ tag ‖ ciphertext)>` — AES-256-GCM under
`HKDF(dataset secret, "omadia/dataset-cell-encryption/v1")`, with the owner id
and column name as AAD, so a ciphertext cannot be replayed into another user's
dataset or another column. Who gets cleartext:

| Reader | Sees |
|---|---|
| `query_dataset` **behind** the Privacy Shield (turn carries a privacy handle ⇒ result is interned) | real values — into the turn store; the model gets a digest, `v4_render_answer`/`create_xlsx` resolve them server-side |
| `query_dataset` **without** a guard (result would reach the model in clear) | re-masked on read, one pseudonym map per page |
| owner's `GET /api/v1/datasets/:id/rows` | real values (it is their data) |
| any reader without the key | `[verschlüsselt — Schlüssel nicht verfügbar]`, never garbage, never a throw |

Two things this rests on: (1) `query_dataset` is **not** intern-exempt
(`privacyInternPolicy.ts`) — the day it becomes exempt, the "behind the shield"
branch above is a leak; the test `datasetCellCrypto.test.ts` pins the reveal
condition to the presence of the turn's privacy handle, which is the same
signal the orchestrator uses to intern — and when that interning THROWS, the
orchestrator withholds this tool's rows instead of falling open to the raw
result as it does for other tools (`dispatchTool`, `QUERY_DATASET_TOOL_NAME`
branch): the rows carry cleartext precisely because interning was expected.
(2) The v4 shape classifier now runs the C0 baseline's identity types (e-mail,
IBAN, phone, address, id number — deliberately not `date`/`amount`, which must
stay filterable) as its one-way `detector` booster: a digits-only phone column
would otherwise clear as an `id` handle, and a small dataset's digest inlines
every value of a safe column. (3) The `[dataset-imported]` fact promises real
values in render/export only when a privacy handle is active in the turn;
without one it says plainly that exports show surrogates.

Unchanged: names (C0 does not detect them) are stored in clear as before;
rows imported before this change hold irreversible surrogates and pass through
untouched. Rotating the secret (or `VAULT_KEY` when no explicit secret is set)
makes existing ciphertexts unreadable — an operational decision to announce, not
a silent `fly secrets set`. Without any secret the import falls back to the old
irreversible masking and says so in the `[dataset-imported]` fact, so the model
does not promise real values in an export it cannot deliver.

### 6c. Control-flow tool results pass the shield unmasked (#1105, #1097)

A tool result that is control flow — the `Error:` tool-error convention, or an
MCP auth prompt — reaches the model verbatim instead of being interned, so the
model can read the hint and self-correct. Four seams apply it, each after the
intern exemption and the operator bypass and before interning:
`Orchestrator.dispatchTool`, `Orchestrator.guardReplayResult`,
`ToolDispatchService.afterDispatch` and `LocalSubAgent.dispatch`. All four call
one predicate, `isControlFlowToolResult` (`@omadia/plugin-api`), which is
**prefix-anchored only**: `Error:` or the exact `🔒 The MCP server "` producer
prefix. It never matches a substring, so a marker planted in one cell cannot
unmask a multi-row result such as a decrypted `query_dataset` page (§6b).
Known limits: remote MCP error
bodies and `Error: ${err.message}` wrappers (`bridgeTool`) pass through as
foreign or unsanitized text, matching the chat path's thrown-error policy; a
passthrough writes no receipt entry. The shape classifier has **no**
control-flow exemption — verbs re-classify derived datasets, so one would turn
`filter` + `select` into a cleartext channel — and `ToolDispatchService`
still masks a thrown exception's message even when it starts with `Error:`.

### 6d. `agents.privacy_profile` is not a Privacy Shield control (#978)

`agents.privacy_profile` (`'strict' | 'default'`, CHECK since migration `0001`) is written by the operator API (`POST` / `PATCH /api/v1/operator/agents`) and `scripts/agents-apply.ts`, and reported by `GET /api/v1/operator/agents`, `GET /api/v1/operator/agents/enabled`, `POST /api/v1/operator/agents/resolve-channel` and the Agent Builder graph (`agentNode()` in `routes/agentBuilder.ts`; contract field `AgentNode.privacyProfile` in `@omadia/plugin-api`). No runtime path reads it: `AgentRuntimeConfig` has no posture field, `buildForAgent` does not forward the value, and nothing branches on `'strict'`. What masks a turn is the `privacy.redact@1` provider, reached through the late-bound `OrchestratorDeps.privacyGuard` lookup that the registry passes unchanged into every agent's build, plus the tool-name-only exemptions in `privacyInternPolicy.ts`; neither receives the agent's profile. `strict` therefore behaves exactly like `default`, including for the first-boot fallback agent that `registry/onboarding.ts` seeds as `strict`: a `strict` value in the table, the API or the UI is not evidence that an agent's traffic is masked.

Since #978 a change to the value is a metadata `update` (registry row refreshed, live orchestrator kept), not a `rebuild`; the web UI no longer offers a toggle and labels the value "(not enforced)"; migration `0061` records the status as a column comment. Making `strict` enforce anything is a security decision that must update this section: the posture has to reach `AgentRuntimeConfig`, survive the sub-agent boundary (`turnContext.privacyHandle` in `localSubAgent.ts` / `toolDispatchService.ts`), go back into `runtimeChangeReasons` in `applyDiff.ts`, and it changes behaviour for the seeded fallback agent without operator action (open decision: `docs/middleware-agent-handoff.md` §13).

## 7. Conductor generic webhooks (#437)

Inbound endpoints (`POST /api/hooks/:endpointId`) and outbound subscriptions
(HMAC-signed deliveries to an operator-supplied URL) are the one place in the
codebase with a deliberately **unauthenticated** ingress route, so the
security model is documented explicitly rather than left to code comments
alone.

**Secret placement.** Both an inbound endpoint's HMAC signing secret and an
outbound subscription's signing secret live in the secret vault under the
`core:conductor` namespace (`webhookEndpointStore.ts` /
`webhookSubscriptionStore.ts`) — the same metadata-in-Postgres /
secret-in-Vault split `DevGithubAppStore` uses for GitHub App credentials.
A secret is returned to the operator **exactly once**, on creation or
rotation; every list/get response omits it. Nothing under
`conductor_webhook_endpoints` or `conductor_webhook_subscriptions` ever
carries a secret column.

**Inbound route auth model.** `POST /api/hooks/:endpointId` has no
`requireAuth` — the per-endpoint HMAC signature (`X-Webhook-Signature:
sha256=<hex>`, computed over the raw, pre-`express.json()` request body) IS
the authentication, verified with a constant-time comparison
(`crypto.timingSafeEqual`). Two invariants the reviewer checklist below
should re-verify on any change to this route:

- **Identical 401 for unknown-endpoint vs. wrong-secret.** The signature is
  checked BEFORE anything about the endpoint (existence, enabled state) is
  trusted; an unknown `endpointId` and a known one with a wrong secret
  answer byte-for-byte the same `401 {"code":"webhook.bad_signature"}` — a
  caller can never use the response to probe which endpoint ids are real.
- **Always 2xx on noise.** Once the signature verifies and the delivery id
  is claimed, every remaining branch (disabled endpoint, malformed JSON, no
  subscribed workflow) answers `2xx`. Only a bad signature (401) or the
  per-endpoint rate limit (429) are non-2xx — so a well-behaved sender's
  retry policy never turns an ignorable delivery into a redelivery storm.

Delivery-id dedupe and the per-endpoint rolling-window rate limit are
enforced atomically in one transaction (`ConductorWebhookEndpointStore.claim`)
before any workflow run starts, closing the gap a correctly-signed sender
minting a fresh delivery id per call would otherwise open.

**Outbound SSRF guard.** Both outbound paths — the run-lifecycle dispatcher
(`webhookDispatcher.ts`) and the ad-hoc `webhook.post` Designer action
(`webhookPostAction.ts`) — route every request through
`conductor/webhookOutbound.ts`, which reuses the existing
`platform/ssrfGuard.ts` mechanism: a literal-IP precheck rejects a private /
loopback / link-local / cloud-metadata target before any DNS lookup, and the
actual request goes through a guarded `undici` `Agent` that re-checks the
resolved address to defend against DNS-rebinding between the precheck and
the connection. A subscription URL is also checked at creation time
(`assertOutboundUrlAllowed`), so an operator gets an immediate 400 rather
than only discovering the block on the first delivery attempt.

## 7b. Tamper-evident receipt chain (#758)

The per-turn receipt record (`turn_receipts`, #757) is hash-chained: each
row's `entry_hash` covers its canonical payload plus the previous row's
hash, appends serialized through a locked stream head. Editing a row breaks
the copy of its hash stored in the next row — the chain visibly breaks for
every later entry. Periodic Ed25519 checkpoints sign the head with a key
held **only** in env/secret-manager (`AUDIT_SIGNING_KEY`) — never in
Postgres, or the DB admin the chain defends against could re-sign a
rewritten chain — optionally anchored to an external append-only file
(`AUDIT_ANCHOR_PATH`) for WORM storage. Threat model: **detection, not
prevention** — wholesale destruction shows as sequence gaps and orphaned
checkpoints; per-row timestamps are anchored by checkpoint cadence, not
per-row. UPDATE on the table is trigger-forbidden as defence in depth;
DELETE stays legal for bounded retention. The operator verify surface
(endpoint, signed export, offline verifier) is #761.

One consequence to state explicitly: because `created_at` sits outside the
hash and DELETE is legal, an admin who drops the trigger could backdate
`created_at` and let the reaper delete a row early — presenting the gap as
legal retention. The mitigation shipped with #761, in the sound direction:
a signature-valid checkpoint at seq S signed at time T proves every row
ABOVE S was created after T, so when the youngest reaped row sits above a
checkpoint younger than the retention window, the verifier flags
`premature_deletion` — a laundering finding, not retention. (The naive
inverse — "a checkpoint covering the row bounds its age" — is deliberately
NOT used: it only upper-bounds creation time and would flag legitimately
old rows on installs that enabled signing late.) Two structural guards
accompany it: the retention reaper deletes chained rows only up to the
greatest checkpointed seq, so a surviving suffix always has a signed
anchor; and the verifier consults the recorded stream head, so a wiped or
tail-truncated table can never report green (`empty_chain_with_history`,
`head_beyond_rows`). Verify surface: `GET /api/v1/operator/provenance/
verify`, signed export + zero-dependency offline verifier — see
`docs/provenance-verification.md`.

## 7a. Conductor approvals: strict semantics, cancellation, and the baton audit (#759)

Three properties of the human-approval gate are security decisions, made
explicit here so a deployment can reason about them:

- **Approval polarity is fail-open by default, opt-in strict per step.** The
  historical contract (kept for compatibility): only an explicit
  `{approved:false}` counts as a rejection — an absent or malformed response
  advances the run as approved. Any human step that gates an irreversible
  action should set `human.strictApproval: true` (designer checkbox), which
  inverts the polarity: only an explicit `{approved:true}` approves. The
  validator flags the dangerous default (`approval_fail_open` warning) when a
  non-strict human step directly gates an action step; it also flags a
  deadline fallback that lands on a normal outgoing path
  (`timeout_equals_approval`) — if that shared path is the approval path, a
  timeout silently approves.
- **Run cancellation is an operator surface, not a bypass.** Cancel never
  skips a gate — it terminates the run. A waiting run's open awaits close as
  `'cancelled'`; a running run stops at the next step boundary (mid-step
  kills are not attempted, keeping the at-least-once effect window bounded to
  one step). The cancel flag columns are deliberately never cleared: they are
  the load-bearing backstop for every cancel race. Run-ended webhook
  notifications are at-least-once — in the narrow expire-vs-cancel race a
  subscriber can see the event twice.
- **Who may approve is decided by role batons — and every baton move is
  audited.** Any authenticated operator can assign any role holder, including
  themselves; in the current single-role system ('admin' until roles split,
  `src/auth/sessionJwt.ts`) a permission gate on that route would gate
  nothing, so the control with teeth is the audit trail: every add/remove
  lands in `admin_audit` as `conductor.role_holders_change` with actor,
  role, and the resulting holder set.
  <!-- TODO(roles-split): when user roles split beyond 'admin', add a
       permission gate on POST/DELETE /roles/:key/holders (four-eyes or
       admin-only) — the audit trail alone stops being sufficient the moment
       non-admin operators exist. -->
- **Role batons now also decide who RECEIVES targeted reports (#330 B3).**
  The `targetedSend` kernel service resolves `role:<key>` addressees through
  the SAME holder registry the executor uses for approvals (one instance,
  exposed from `wireConductor` — "who may approve" and "who gets the report"
  cannot drift). That widens the blast radius of the unaudited-but-logged
  self-assignment above: assigning yourself a role means receiving every
  report addressed to it. The compensating controls are the same baton audit
  trail plus the delivery report itself (holders, `partial`, per-holder
  outcomes are all named — no silent recipient). Principal resolution is
  kernel-only by construction: channel plugins receive one already-resolved
  user per delivery and can neither enumerate nor widen a role. The
  `targetedSend` / `conversationRosters` / `conversationEvents` services are
  deny-by-default like every kernel service, and `conversationEvents` is
  published subscribe-only — emitting membership events (e.g. the
  Facilitator's `bot_added` handshake trigger) stays a channel-adapter
  privilege on the CoreApi, so a granted agent plugin cannot spoof an
  invitation.
- **Proactive group posting is conversation-scoped (#330 C3b).** The
  `conversationSend` service (deny-by-default) lets a granted agent plugin
  post INTO a group — but only into conversations the calling agent holds an
  ephemeral attachment for (its own auto-bound facilitation, the same rows
  the reaper disposes of). Everything else — foreign conversations, guessed
  thread ids, operator-bound chats — is a named `not_permitted` outcome, and
  without a database the scope authority is absent and the service **fails
  closed**. The channel-side provider registries enforce first-registrant
  ownership per channel type, so a second plugin can neither hijack the
  delivery path nor speak through another channel's identity.

## 8. What lives in the vault

At a minimum, your deployment vault holds:

- Database connection string(s). On the desktop app the kernel keeps its
  first-boot DSN here too; it names the restricted `omadia_kernel` role and
  carries that role's password (§8b).
- Object-storage access key + secret.
- HMAC signing secret for diagram URLs.
- Upstream API tokens (one per integration).
- LLM provider key(s).
- Any tenant-/customer-specific secrets passed via `setup.fields` of type
  `secret`.

Nothing from this list should appear in `git grep` output of this repository.
If it does, that is a bug — file an issue and rotate.

## 8a. Desktop secret custody (`desktop/src/secrets.ts`)

The desktop app has no deployment vault. It generates the kernel's master keys
itself and hands them to the kernel as env vars on every spawn:

- `VAULT_KEY` opens the kernel vault `platform-data/vault.enc.json` (session
  signing key, skill-manifest signing key, plugin secrets) and is the HKDF root
  for dataset link keys and cell encryption when no explicit secret is set
  (§6a, §6b).
- `CREDENTIAL_KEYCHAIN_KEY` encrypts the credential keychain rows in the
  database, a separate trust domain.
- The provider API keys entered in the setup wizard.

The same file holds the embedded Postgres passwords (§8b): the bootstrap
superuser's never leaves the shell, the kernel role's reaches the kernel only
inside `DATABASE_URL`.

All of these live in `secrets.enc` in the data folder, encrypted at rest with
Electron `safeStorage` (Keychain on macOS, DPAPI on Windows, Secret Service on
Linux). A packaged build refuses to write it in plaintext. Only an unpackaged
dev run may, with a warning, and such a dev blob stays readable once OS
encryption becomes available.

**Replacing this file with new keys loses the data.** With a different
`VAULT_KEY` the kernel fails at boot on its own vault, and every §6a/§6b
ciphertext becomes unreadable. A different `CREDENTIAL_KEYCHAIN_KEY` does the
same to stored credentials. The recovery key the app shows is `VAULT_KEY`
itself, and it is display-only: there is no import path yet (handoff §13). The
rules, in the Electron-free `secretsBlob.ts` and `secretsStore.ts`:

- **Only ENOENT creates keys.** Every other failure throws
  `SecretsUnreadableError` and writes nothing. The stages are: unreadable
  (`read`), keychain refused (`decrypt`), no OS encryption in a packaged build
  (`encryption-unavailable`), not JSON (`parse`), and wrong fields (`shape`,
  where both keys must base64-decode to 32 bytes, the kernel's own check, and
  the database passwords, when present, must be 64 hex characters). Boot
  then stops at a dialog with advice for the failed stage
  (`secretsRecovery.ts`) and without "Re-run setup". A refused keychain is
  presented as "the file is most likely intact; allow access", never as
  "restore or delete".
- **The failure text never quotes the file.** The error's reason goes to the
  log, the setup wizard and the dialog's support details. V8's JSON
  `SyntaxError` quotes about ten characters on each side of the error, which
  for a damaged file is a fragment of a key. So a `parse` failure reports only
  `not valid JSON`, plus the position when V8 gives one, and the
  `SyntaxError` is not attached as the error's `cause`.
- **Every rewrite is backup, temp file, rename.** `secrets.enc` is first copied
  to `secrets.enc.bak`, with mode 0600 set explicitly, and a failed copy aborts
  the rewrite. The new bytes go to `secrets.enc.tmp-<pid>-<uuid>` (exclusive
  create, fsync), and a rename replaces the file. Leftover temp files are swept
  after a successful read, never next to an unreadable file.
- **Write before cache, re-read before rewrite.** A key reaches the kernel only
  after it is on disk. A change re-reads the file it replaces, so a file that
  became unreadable is surfaced, not overwritten.
- **The cache belongs to one path.** When setup switches the data folder, an
  existing `secrets.enc` there is adopted. Only a missing one receives the keys
  already handed out, so the recovery key shown during setup stays the key in
  use. A file that appears between the ENOENT read and the write is left alone
  (`SecretsConflictError`).

**Backups and their limits:**

- `.bak` is one generation and sits next to the file, also inside a
  cloud-synced data folder (only snapshots move to `userData`).
- The pre-update snapshot (`updater.ts` → `dbSnapshot.ts`) copies `pgdata/`
  and puts `secrets.enc` beside it as `<snapshot>.secrets.enc` (mode 0600).
  Pruning removes both, and a failing secrets copy aborts the update like a
  failing database copy.
- `.bak` and the snapshot copy are encrypted with the same keychain item as the
  live file. They protect against a damaged or rewritten file, not against a
  lost keychain entry or a move to another machine.
- **Documented gap:** `platform-data/` (the kernel vault `vault.enc.json`,
  `installed.json`) is not part of the pre-update snapshot. Restoring `pgdata`
  plus `secrets.enc` brings back the database and the keys for its
  ciphertexts, not the kernel vault as it was at that time.

**Starting over** is a manual step: move the whole data folder aside, or pick a
different, empty folder in setup. Deleting only `secrets.enc` produces new keys
next to the old kernel vault, which the kernel then cannot open.

## 8b. Desktop embedded Postgres: SCRAM passwords and a restricted kernel role

The desktop app runs its own PostgreSQL 17 cluster (`desktop/src/embeddedDb.ts`).
It used to be initialised with `initdb -A trust`: any local process, under any
OS user, that reached the loopback port could log in as the bootstrap superuser
without a password, and the kernel's own `DATABASE_URL` named that superuser,
which can run `COPY ... TO PROGRAM` as the desktop user.
`desktop/src/embeddedDbAuth.ts` replaces that:

- **Two roles, random SCRAM passwords.** `omadia`, the bootstrap superuser, is
  used only by the shell (provisioning, extensions). `omadia_kernel` is what
  the kernel connects as: it owns the `omadia` database and everything in it,
  so the kernel's own migrations run unchanged, but it is `NOSUPERUSER
  NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`. Both passwords are 32
  random bytes (hex) in `secrets.enc` (§8a). The superuser's never leaves the
  shell process. The kernel's reaches the kernel only inside `DATABASE_URL`,
  under the same same-user environment boundary as `VAULT_KEY` (an accepted v1
  limitation, `desktop/README.md`). Passwords reach the server as SCRAM
  verifiers, so a failing `ALTER ROLE` cannot put one in the server log, which
  the shell copies into its own.
- **The shell owns `pg_hba.conf`.** Rules for exactly those two roles, all
  `scram-sha-256`, no `trust`. The file is rewritten (temp file, rename)
  whenever it differs, and only while the server is stopped, so a running
  server never holds rules the shell did not write and no reload is ever
  needed. The server starts with `-c hba_file=<pgdata>/pg_hba.conf`, so
  `postgresql.auto.conf` cannot point it elsewhere. No rule depends on the
  client's OS identity (no `peer`, no `trust`): without the password, nobody
  gets in.
- **A private endpoint on macOS and Linux** (`desktop/src/embeddedDbEndpoint.ts`).
  The server listens only on a Unix socket, `listen_addresses` empty, in
  `<userData>/pg-socket`: created `0700`, checked to be a plain directory owned
  by the desktop user, socket `0700` as well. The kernel's `DATABASE_URL` names
  that directory as its host. Another OS user can neither connect nor put a
  listener of their own where the shell and the kernel connect, so there is no
  port to squat while the server is stopped. A socket path too long for
  `sun_path`, or a directory that cannot be made private, moves the socket to a
  fresh private directory under the OS temp folder, per start; never into the
  chosen data folder, which may be cloud-synced. Windows keeps `127.0.0.1`.
- **The shell trusts a server only after it has proven itself.** Readiness is
  read from the server's own `postmaster.pid`: the process the shell spawned,
  the expected port and socket directory or address, status `ready`. That
  sends no credentials, and an authentication error is never taken as "up".
  Every shell connection accepts SCRAM-SHA-256 and nothing else
  (`desktop/src/scramOnlyConnect.ts`): a cleartext or MD5 request, a SASL offer
  without SCRAM, or an AuthenticationOk without a completed exchange is refused
  before a password is sent, and pg's server-signature check makes the server
  prove it holds the role's verifier. The first login after every start is the
  superuser's and must report this cluster's `data_directory` before the kernel
  password is offered. Before provisioning, before the verification and before
  the DSN is handed to the kernel, the shell confirms again that its server
  still runs and still holds the endpoint.
- **Residual risk on Windows.** The loopback port is free while the server is
  stopped (between port selection and start, and during a single-user repair).
  Another local user who binds it there fails the boot but learns no password
  and is never taken for the server. The kernel's pools use a stock pg client,
  though: if the server stops while the kernel runs and another user binds the
  port before the kernel reconnects, that listener could ask the kernel for its
  password in cleartext. A SCRAM-only client for the kernel's pools (or a
  socket on Windows) is the open follow-up
  (`docs/middleware-agent-handoff.md` §13).
- **Extensions are created by the shell.** pgvector's control file is not
  `trusted`, so a non-superuser cannot `CREATE EXTENSION vector`. The shell
  creates `vector` and `pg_trgm` as superuser, and the kernel's own
  `CREATE EXTENSION IF NOT EXISTS` then short-circuits before its privilege
  check. An engine without pgvector's files (an unstaged dev tree) is logged
  and tolerated.
- **Ordering that prevents a lockout.** New passwords are written to
  `secrets.enc` and read back before the cluster is created or touched. On a
  cluster from the trust era the superuser password is set first, and only
  then does `pg_hba.conf` require passwords. The kernel password is set last,
  after its database, the extensions and the ownership transfer, so an
  interrupted run leaves a kernel that cannot log in, and the next start
  repeats it.
- **Password changes without a listener.** Whenever the superuser password
  cannot be set over an authenticated connection, the shell sets it in
  PostgreSQL's single-user mode (`postgres --single`) with the server stopped:
  no port is open and no pg_hba.conf is consulted, and the session is the
  bootstrap superuser by definition. That covers the trust-era migration, which
  runs before the updated app ever starts the server, and a cluster that
  refuses the stored password (a lost or regenerated `secrets.enc`, a `pgdata`
  snapshot restored without its secrets copy): stop, single-user
  `ALTER ROLE`, start. Both are logged at warn level. There is no moment in
  which the running server accepts a connection without a password; a lost
  secrets file still does not lock the local database for good.
- **Trust-era ownership.** Everything the old kernel created as superuser is
  moved to `omadia_kernel` one kind at a time (schemas, relations, sequences,
  types, routines; extension members stay), because Postgres refuses
  `REASSIGN OWNED` for the bootstrap superuser
  (`desktop/src/embeddedDbOwnership.ts`).
- **Superuser sessions treat the database as untrusted.** `omadia_kernel` owns
  the `omadia` database, so it can set a per-database `search_path` and create
  objects in schemas it controls (for example a function whose name a shell
  statement would otherwise call unqualified). Every connection the shell opens
  therefore pins `search_path = pg_catalog, pg_temp` as a startup option, which
  outranks any `ALTER DATABASE`/`ALTER ROLE ... SET`, and the ownership
  transfer both schema-qualifies its calls (`pg_catalog.format`) and pins its
  own search_path (`desktop/src/embeddedDbOwnership.ts`). A statement the shell
  runs there as the superuser cannot be redirected onto an object the owner
  planted.
- **Verification fails closed.** Every start ends with a check against the
  running server: a random wrong password must be refused (`28P01`) for both
  roles, and the kernel role must hold none of the privileged attributes and be
  a member of no role — a membership (say in a predefined role such as
  `pg_execute_server_program`) would restore a capability without setting an
  attribute. Otherwise the start fails, the server is stopped and no DSN is
  handed out. The two refused attempts appear in the log as `FATAL`; that is
  the check.
- **Rollback.** A build from before this change connects without a password
  and cannot open a migrated cluster. The pre-update snapshot (§8a), taken
  before the new version first starts, is the way back.
- **The kernel vault's copy of the DSN.** The kernel froze its first-boot
  `DATABASE_URL` into its vault (`database_url`, §8), so that copy now carries
  the kernel role's password, encrypted with `VAULT_KEY`. On the desktop the
  live `DATABASE_URL` wins (`OMADIA_EMBEDDED_DB=1`), so a copy left stale by a
  password repair is never used.

Tests: `desktop/test/embeddedDbAuth.test.mts` (orderings and fail-closed paths
against a simulated cluster, including that every server start happens on the
shell's rules, that the ownership transfer schema-qualifies its calls and pins
its own search_path, and that a kernel role carrying a role membership is
refused), `desktop/test/embeddedDbIdentity.test.mts` (the superuser login and
its data-directory check come before any kernel password, a server reporting
another data directory or refusing SCRAM stops the start, and the server is
re-confirmed before provisioning and verification),
`desktop/test/scramOnlyConnect.test.mts` (a listener on loopback that asks for
cleartext, MD5, no SCRAM, no authentication at all, or forges the final
signature gets no password and is refused),
`desktop/test/embeddedDbEndpoint.test.mts` (the private socket directory, its
fallback, the server command line and the `postmaster.pid` check),
`desktop/test/embeddedDb.integration.test.mts` (the real engine:
passwordless and wrong-password clients refused, on macOS and Linux no TCP
listener and an owner-only socket directory, no `COPY ... TO PROGRAM` for the
kernel role, the trust-era migration including ownership, the single-user
repair, and a kernel that redirects the database `search_path` and plants a
shadow function still contained after migration; the desktop-apps workflow runs
it with pgvector staged) and `desktop/test/secrets.test.mts` (persistence and
read-back).

## 9. API-key authentication (`@omadia/api-key-auth`, issues #438 / #439)

API keys are omadia's **second authentication method**, alongside the
human-bound `omadia_session` cookie. A server-to-server caller (the driving
use case is a Laravel/PHP integration) has no human behind it and no cookie
to present; it authenticates with a bearer key instead.

**Where the code lives.** All of it — mint/hash/verify, the key store, the
per-key rate limiter, the usage audit log, and the mountable `requireApiKey`
Express middleware — lives in the workspace package
`middleware/packages/harness-api-key-auth` (`@omadia/api-key-auth`). Issue
#438 shipped these inside the `@omadia/channel-api` plugin; issue #439 moved
them out so the kernel can use them too. The kernel must never import a
channel plugin, and a plugin cannot import kernel source, so a shared package
is the only home that lets both consume the same implementation. **There is
exactly one implementation of the credential** — a second one, however small,
is how a security-critical primitive quietly diverges.

**Mounting it.** Any Express route, kernel or plugin, can apply
`requireApiKey({ apiKeys, rateLimiter, auditLog, scope })`. It attaches an
`ApiKeyPrincipal` to `req.apiKey` and deliberately does **not** populate
`req.session`: a `SessionClaims` value means "a human logged in", and its
`role` is hard-typed `'admin'`, so synthesizing one for a machine would make
every downstream session-reading route silently treat a key as an operator.
A route has to opt in to machine callers by reading `req.apiKey`.

**Scopes (issue #439).** Every key carries a scope set — `<resource>:<action>`
strings, or the global `*`. `requireApiKey` answers `403 forbidden` when the
key lacks the scope the route declares. Matching is exact; there are no
prefix wildcards (`chat:*`), because a prefix matcher invites the "I thought
that didn't cover delete" mistake scopes exist to prevent. A key persisted
before scopes existed has **no** `scopes` field at all and is normalized to
`['chat:write']` — precisely the one capability it had when it was minted.
Defaulting such keys to `*` would also keep them working, and would silently
widen every existing key to whatever scoped surface lands next; that is a
privilege escalation delivered by an upgrade, so it is not what we do.

**Malformed persisted scopes deny, they do not default.** `normalizeScopes`
distinguishes *absent* from *malformed*. Absent (`scopes === undefined`, the
genuine pre-#439 record) → the legacy default above. Present but not an
array, or an array containing anything that is not a valid scope string
(`"memory:read"` stored as a bare string, `["Chat:Write"]` with the wrong
case, `[]`) → the **empty** scope set: the key still authenticates, and every
`hasScope` check on it fails closed, so it is authorized for nothing. This
matters because a malformed field is at least as likely to be a key an
operator deliberately restricted *away* from chat as it is to be corruption,
and falling back to a capability grant in that case hands the key exactly the
access the operator removed. Partially-valid arrays deny too rather than
silently narrowing to the valid subset — a record we cannot read faithfully
is a record we must not guess at. Each such case emits a
`[api-key-auth] malformed persisted scopes` warning so an operator can see
why a key stopped working.

**Session-gate exemption stays narrow.** `POST /api/public/v1/chat` is the
only API-key route exempted from the session middleware
(`middleware/src/auth/publicPaths.ts`). Mounting `requireApiKey` on a new
route requires adding that route to `publicPaths.ts` — add the narrowest
regex that covers the one route, never a prefix that also catches its
siblings. Note that omission from `publicPaths.ts` is *necessary but not
sufficient* for a plugin-contributed router to be authenticated; see the
admin-keys discussion immediately below for why. `POST /api/public/v1/chat`
remains the first and only ingress this app exposes that is **not** cookie-
or provider-JWT-gated.

**Key administration (`/api/public/v1/admin/keys`) — kernel-published
`ctx.operatorAuth`, in addition to the broad `/api` session gate.**
`middleware/src/index.ts` mounts `app.use('/api', requireAuth,
createChatRouter(...))` (the OB-106 hotfix) early in server boot, well
before `pluginRouteRegistry.mountAll(app)` runs later in the same boot
sequence. Express evaluates middleware in mount order for the whole `/api`
prefix regardless of which router ultimately answers a given path, so
`requireAuth` already runs in front of every `/api/*` request — including
plugin-mounted routes — unless that specific path is listed in
`middleware/src/auth/publicPaths.ts`'s exemption list. `/api/public/v1/admin/keys`
was never added to that list (only `.../chat` was, deliberately), so it was
already covered by this session gate, the same mechanism that protects
every other channel's non-exempted routes (see `publicPaths.ts`'s own doc
comment). An earlier revision of this document instead described the admin
routes as reachable by any anonymous caller; that was wrong — it read
`core.registerRouter` (`middleware/src/channels/routeRegistry.ts`, which
does only gate on the channel's active/inactive state) as the sole gate in
front of the router, without accounting for the broad `/api` mount that
Express already applies ahead of it. A minimal reproduction mirroring the
real mount order (real `createRequireAuth` + `publicPaths`, same mount
sequence as `index.ts`) confirms an anonymous request to
`/api/public/v1/admin/keys` gets `401 {code:'auth.missing'}` from that gate
before ever reaching the plugin router.

That coverage is real, but it depends on an *implicit* invariant: the
broad `/api` mount happening to run before this plugin's router is mounted,
and this path happening not to be added to `publicPaths.ts`. Either one is
easy to break by accident in a future refactor — reordering mounts, moving
this plugin behind a different prefix, or a well-meaning future PR adding
`/api/public/v1/admin` to the exemption list by pattern-matching too
broadly against the neighboring `/chat` entry. None of that would raise an
error; the admin surface would just quietly stop being gated. So the fix
below adds an *explicit* check inside the plugin itself, so the guarantee
travels with the router regardless of where or in what order it gets
mounted — and publishes a reusable accessor so future plugins that need an
admin surface don't have to rely on the same mount-order coincidence.

The real fix: `PluginContext` now exposes an optional `ctx.operatorAuth`
(`OperatorAuthAccessor`, `middleware/packages/plugin-api/src/pluginContext.ts`),
published by the kernel (`middleware/src/auth/operatorAuthAccessor.ts`) and
wired into every plugin-context factory
(`middleware/src/platform/pluginContext.ts`, threaded through
`ToolPluginRuntime`, `DynamicAgentRuntime`, and `DefaultChannelRegistry`).
`hasValidSession(cookieHeader)` reuses `evaluateSessionToken` — the EXACT
SAME session-verification logic `requireAuth` runs (same cookie name, same
signing key, same Entra-whitelist rule) — extracted into
`middleware/src/auth/requireAuth.ts` so there is exactly one code path that
decides session validity, never two that can drift apart.
`adminKeysRouter.ts` applies this as router-level middleware ahead of every
route: missing/invalid session → `401` (same `{code, message}` shape as
`requireAuth`); `ctx.operatorAuth` itself unavailable (an older host that
never wired it) → `503`, so the router **fails closed** rather than
silently mounting unauthenticated. See `adminKeysRouter.test.ts`'s
"operator-session auth" and "fails closed" test blocks for the coverage
that was missing before this fix.

**Credential model — per-key service identity.** Each API key *is* its own
identity, not a delegate for a human end-user: `ChannelUserRef{ kind:
'custom', id: 'key:<keyId>' }`. Every action traces to exactly one key;
there is no impersonation trust boundary to design or police, and no
"act on behalf of a user" surface in v1.

**Storage — vault-backed, hash-only-at-rest.** Keys are minted as
`omk_<32 random bytes, base64url>` (`apiKeyToken.ts`). The plaintext is
returned to the operator exactly once, at creation time, and is never
persisted; only its sha256 hex digest is written to this plugin's own
`ctx.secrets` vault namespace (`apiKeyStore.ts`, one vault entry per key —
no DB migration for v1). Hashing is deliberately unsalted: the key itself
is a 256-bit high-entropy random value, not a low-entropy human-chosen
secret, so there is no dictionary/rainbow-table surface for a salt to
defend against — the same reasoning applies to GitHub PATs and Stripe API
keys, which are also hashed unsalted.

**Verification — constant-time.** `verify()` walks every stored,
non-revoked key and compares each one's hash against the presented token's
hash with `crypto.timingSafeEqual`, deliberately without an early return on
the first match, so total work (and the timing signal) never depends on
which key, if any, matched.

**Rate limiting — fixed-window, per key, in-memory and per-process.** Each
key gets its own in-memory fixed-window counter (`rateLimiter.ts`, 60s
window, capacity = `rateLimitPerMinute` set at key-creation time). This
state lives in a single Node process's memory only — it is **not** shared
across multiple replicas/instances of this app, and a restart clears every
counter. If this app is ever run with more than one replica behind a load
balancer, each replica enforces the limit independently, so the effective
ceiling for a key is `rateLimitPerMinute × replica count`, not the
configured value. This is an accepted v1 trade-off, same bar as the
`TokenBucket` in `httpAccessor.ts` elsewhere in this codebase — "good enough
to stop a runaway caller", not a precise distributed quota. A shared/
distributed limiter (e.g. Redis-backed) was explicitly considered and
declined for v1; revisit only if multi-replica deployment of this app
becomes real.

**Revocation.** `POST /api/public/v1/admin/keys/:id/revoke` sets
`revokedAt` on the key's vault record (idempotent — revoking an
already-revoked key is a no-op that returns its unchanged view). `verify()`
skips any record with `revokedAt` set, so a revoked key starts failing
immediately on its very next call — no propagation delay, no cache to
invalidate.

**Usage audit.** Every call that gets *past key verification* — i.e. every
authenticated call, regardless of what happens next — is recorded as one
entry (`auditLog.ts`) with a status reflecting the real outcome: `ok`,
`rate_limited`, `forbidden` (scope check failed), `invalid_request`, or
`error` (the handler failed). `requireApiKey` records the outcomes it
produces itself; the route handler records its own via
`req.apiKey.audit(...)`, because only the handler knows whether the work
succeeded. Unauthenticated calls (missing/invalid/revoked key) are not
audited here — they never got the caller identity that makes an audit
entry meaningful.

**PII masking.** Chat turns from this ingress go through the exact same
`CoreApi.handleTurnStream` dispatch as every other channel (Teams,
Telegram, Omadia UI) — no second, parallel response path — so
privacy-guard's prompt masking and receipt behavior apply identically.

**Operator deny-lists and the miss-report queue (#760).** Operators can add
literal terms and vetted regex patterns (`custom_terms` / `custom_patterns`
on the privacy plugin) to the masking layer; operator regexes are vetted at
config time (syntax + escalating pathological probes over letters, digits,
mixed and unicode input) AND bounded at runtime — a pattern that blows its
per-turn budget throws, which the service converts into a BLOCKED turn
(fail-closed; no auto-disable, because skipping the pattern on later turns
would be fail-open for exactly the values it protects). Values a detector
missed have a human path back: `privacy_miss_reports` stores the reported
term **as the reporter typed it** — a deliberate act on an auth-gated
operator surface, disclosed in the intake UI, and exactly what the reviewer
needs to build the deny-list rule.

## 10. Operator surfaces vs. dev endpoints (`/api/dev`, issue #669)

Everything under `/api` is gated by one line in `middleware/src/index.ts`:

```ts
app.use('/api', requireAuth, createChatRouter({ … }));   // OB-106
```

It runs for **every** `/api/*` request, whichever router ultimately answers it.
The only way past it is an entry in `middleware/src/auth/publicPaths.ts`, and
every entry there is a surface that is unauthenticated until its own handler
says otherwise.

`/api/dev/*` used to hold such an entry, added whenever
`DEV_ENDPOINTS_ENABLED=true`. That made a single boolean the difference between
"operator only" and "anyone who knows the path" for:

- `GET /api/dev/graph/*` — raw knowledge-graph browsing (sessions, turns,
  neighbours, memories, plans)
- `/api/dev/memory/*` — the memory-store browser contributed by the memory plugin
- three `POST` routes that **triggered destructive knowledge-graph maintenance
  sweeps** (decay/rotation, GC eviction, access flush)

Confirmed empirically against a deployment under our control: uncredentialed
`GET`s returned `200` with real payloads.

**What holds now:**

1. There is no `/api/dev` entry in `publicPaths`, and `publicPaths()` takes no
   configuration — there is nothing left to flip. Every `/api/dev/*` request
   needs an operator session, exactly like `/api/v1/admin/*`.
2. The **operator** surfaces were never dev scaffolding and no longer live
   behind the flag. They mount unconditionally under the authenticated admin
   prefix (`middleware/src/routes/graphRouterMounts.ts`):

   | Surface | Path | Mounted when |
   |---|---|---|
   | KG lifecycle admin | `/api/v1/admin/kg-lifecycle` | `graphLifecycle@1` is published |
   | KG per-agent priorities | `/api/v1/admin/kg-priorities` | `agentPriorities@1` is published |
   | Plugin domains (read-only) | `/api/admin/domains` | always |

   `DEV_ENDPOINTS_ENABLED` is not an input to `mountKnowledgeGraphAdmin` — its
   deps type has no field to carry it, so the separation is a type, not a
   convention.
3. `DEV_ENDPOINTS_LOOPBACK_ONLY=true` (optional, default off) additionally
   refuses any `/api/dev` request that did not arrive over a loopback socket.
   It reads `req.socket.remoteAddress`, never `X-Forwarded-For` — `trust proxy`
   is on, so a guard on `req.ip` would be defeated by a header. Leave it off in
   containerised setups, where the Next.js server proxies from a container
   address. The password sign-in limiter (§10m) keys clients on the same rule:
   the socket peer by default, and a forwarded address only from a configured
   number of trusted hops counted from the right or from a header the edge
   sets, never `req.ip`.

**Operating guidance.** `DEV_ENDPOINTS_ENABLED` is dev scaffolding: leave it off
on deployed environments. It is no longer a security boundary on its own — but
it is still extra attack surface, and on any middleware build **older than this
change** it is unsafe on any internet-reachable deployment, with no mitigation
short of turning it off or blocking `/api/dev` upstream.

Tests: `middleware/test/devEndpoints/` (one no-credentials case per route,
including all three destructive `POST`s, plus the negative control that
restores the old allowlist entry and requires the surface to go open again).
`bash middleware/test/devEndpoints/mutation-check.sh` breaks each guard in
source and requires the suite to go red.

---

## 10a. A tenant-scoped check may not authorise a table-wide statement (OM-98, Cato-Audit Runde 5)

The knowledge graph keeps every tenant in the SAME physical tables —
`graph_nodes` and `processes` carry a `tenant_id` **column**, not a schema or a
database per tenant (`middleware/packages/harness-knowledge-graph-neon/src/migrations/0001_graph_init.sql`).
Any `ALTER TABLE … DROP COLUMN` on them is therefore a cross-tenant statement,
whoever triggered it.

The non-destructive vector-column rebuild (the OM-98 "reactivate a provider
stuck behind a width mismatch" path) checked its precondition with
`WHERE tenant_id = $1` and executed without one. A tenant that had never
embedded anything read as *empty*, and that verdict authorised dropping every
other tenant's embeddings. Two properties now hold instead, and both are the
general rule, not a one-off patch:

1. **The precondition is scoped like the statement it guards.** The emptiness
   probe is table-wide, with no `tenant_id` predicate
   (`vectorCorpusEmptiness.ts`, `vectorColumnCatalog.ts::hasAnyVectorTableWide`).
2. **The precondition is re-taken where the statement runs.** It is evaluated
   inside the DDL transaction, after
   `LOCK TABLE … IN SHARE ROW EXCLUSIVE MODE` — the advisory lock the run holds
   does not exclude `embeddingBackfill`, which writes vectors without taking it,
   so a check in its own transaction was a second race rather than a fix for
   the first. A probe that cannot be taken refuses as `emptiness-unknown`,
   which is deliberately NOT `corpus-not-empty`: a lock timeout must not read
   as "your corpus is populated, confirm the discard".

Serialisation follows the same scoping rule. The rebuild holds a **global**
advisory lock (`LOCK_NS_COLUMN_REBUILD`, key `vector-column-migration`) in
addition to the tenant-scoped registry lock, because two tenants holding two
different tenant keys could otherwise rewrite the same physical column at once.
A hand-written migration in the `0005_turn_embeddings_768.sql` style takes
neither lock — run it with the middleware stopped.

Tests: `middleware/test/embeddingColumnMigrationGuard.test.ts` (fake driver:
the scoped and table-wide probes answer differently on purpose, so a regression
changes the verdict rather than staying green) and
`middleware/test/embeddingModelGateMigrationGuards.pg.test.ts` (real Postgres:
an empty tenant beside a populated neighbour, and the global lock).

---

## 10b. Session renewal and its absolute cap (#965)

The admin UI session is a stateless HS512 JWT (`omadia_session`) with a 4h
window. `POST /api/v1/auth/renew` lets an operator extend it explicitly
("I'm still here" on the expiry warning) instead of signing in again. A
renewal chain that never ends would let a stolen cookie live forever, so the
route is built around a few rules.

**Absolute cap from the original sign-in.** Every token carries an
`auth_time` claim: the moment of the real login. Renewal re-signs the same
claims with `auth_time` carried over, so `iat` moves and `auth_time` does
not. The new `exp` is `min(now + 4h, auth_time + cap)`, and once `now` or
the current `exp` reaches `auth_time + cap` the route answers 401
`auth.renew_expired`. The cap is `AUTH_SESSION_MAX_LIFETIME_HOURS` (default
12, zod-bounded to 4..168 at boot; below the 4h login window it would be
meaningless). Tokens minted before #965 have no `auth_time`, and
`verifySession` substitutes `iat`: those tokens came from a real login, so
`iat` is their first-login moment. A legacy token therefore gets the same cap
as a new one, never an unbounded one.

**Renewal requires a currently valid session.** The route sits under the
public `/api/v1/auth/*` prefix (`auth/publicPaths.ts`) because it
authenticates itself: it calls `evaluateSessionToken`, the same single code
path `requireAuth` and `ctx.operatorAuth` use, whitelist gate and
server-side revocation (§10k) included. An expired cookie gets 401
`auth.invalid`, a revoked one 401 `auth.revoked`; either can only be replaced
by a login. A failed revocation lookup answers 503 `auth.unavailable`.

**The principal is re-checked on every renewal, fail closed.**

- The session's provider must still be active in the registry.
- The `users` row (`provider`, `sub`) must exist and be `active`. This covers
  local users and Entra users alike (the OIDC callback upserts Entra rows, and
  admins can disable them).
- That row must still vouch for the session: the same row (`uid`) at the same
  session version (`sv`), §10k. With the guard wired the evaluation above has
  already refused a revoked session; this re-check on the row the step reads
  anyway keeps harnesses without the guard honest.
- OIDC sessions are re-validated at the IdP through
  `OidcProvider.revalidateSession`. For Entra that redeems the refresh token
  kept in the vault (`RefreshStore`), then checks that the new id_token
  carries the same `oid` and email and that the email is still whitelisted. A
  400/401 from the token endpoint (`invalid_grant`, disabled account, revoked
  grant) is a denial: 401 `auth.renew_denied`, and the dead token is
  forgotten. A network error, 5xx or 429 is an outage: 502
  `auth.renew_idp_unavailable`. Both refuse the renewal. We fail closed on an
  outage too, because a sign-in fails during an IdP outage as well, so no
  path gets worse. An OIDC provider that cannot re-validate is refused.

**Every renewal is audited, and the audit comes first.** One
`admin_audit` row per renewal (`auth.session_renew`; `actor.id` is the users
uuid, `before`/`after` carry the old and new `exp` and `auth_time`). The row
is written before the cookie is set. If the write fails, the error reaches
Express as a 500 and no renewed cookie leaves the server.

**Logout ends the session on the server.** The marker is
`users.session_version` (§10k); sign-out, an admin password reset and disabling
the account move it, and deleting the row ends the sessions outright.
`POST /logout` moves the user's version, so every copy of every session of
that user is refused from the next request on, and cannot renew, because
`/renew` runs the same evaluation. It also forgets the user's Entra refresh token, which ends the
IdP side of the renewal chain. Both happen only when the presented cookie is
itself still current: a revoked copy reaching the public `/logout` route gets
its own cookie cleared and changes nothing server-side.

Re-signing carries `sv` and `sid` over together with `auth_time`: a renewed
token belongs to the same sign-in of the same account version, so a later
sign-out or reset ends it like the original. `uid` is the id of the row the
renewal just verified: the same id for a token that names one, and the first
one for a token minted before the claim existed (§10k).

**A renewal extends the cookie, not an open WebSocket.** A channel socket
stays bound to the token that opened it and is closed with 4401 at that
token's `exp` (§10d). The client reconnects with its renewed cookie. Because
renewal never moves the session version, a renewal does not close the sockets
opened before it.

**Residual risks (accepted, documented).**

- Renewal only runs on an explicit click. Activity-based silent renewal is
  deliberately not implemented.

Two earlier residuals are closed by the session version (§10k): a cookie
copied before logout no longer stays valid for the rest of its window or
renews up to the cap, and a copy of an *old* Entra cookie can no longer
redeem the refresh token of the user's *next* sign-in (the refresh token is
still keyed by email, but that old cookie is refused before any IdP call).
Revocation's own residuals are listed in §10k.

Tests: `middleware/test/auth/renewRoute.test.ts` (every refusal path, cap,
legacy `iat` fallback, audit-before-cookie, logout forget, revoked and stale
`sv` refusals), `middleware/test/auth/entraProviderRevalidate.test.ts`
(denial vs. outage classification).

---

## 10c. Credential asks: identity from the session, owner-only approval (#778 S1, D2)

A credential ask asks the owner of a `personal` credential to let someone else
use it, and approving one mints a real credential grant. Until #778 S1 the
mounted `/api/v1/admin/credential-asks` router
(`middleware/src/routes/credentialAsks.ts`) took every identity from the
client: `requesterUserId` and `ownerUserId` on create, `?owner` on `/pending`,
`?requester` on `/mine`, `resolvedBy` on approve/deny. It never compared the
caller with the ask's owner. Any logged-in session could file an ask in
someone else's name, read another user's inbox, and approve an ask it did not
own. The rules below replace that.

1. **The caller comes from `req.session.omadia_user_id`, and only from
   there.** Every handler uses `user:<omadia_user_id>` as the caller. There
   is no `sub`/`email` fallback: `auth/sessionIdentity.ts` documents those
   claims as a different namespace (MCP tokens), and the other owner checks on
   this server (`datasets.ts`, `skillPromotion.ts`) compare against
   `omadia_user_id` too. A session without it, or with a blank one, gets 401
   `auth.required`.
2. **Client-supplied caller identity is rejected, not ignored.**
   `requesterUserId` (create, cancel), `resolvedBy` (approve, deny), `?owner`
   (`/pending`) and `?requester` (`/mine`) answer 400
   `credential_ask.identity_from_session`. A pre-S1 client fails loudly
   instead of quietly acting as a different principal than it meant to.
3. **The owner is derived from the credential.** Both stores address the ask
   to the credential's own `owner`, canonicalised (`resolveAskOwner` in
   `credentials/asks.ts`). An `ownerUserId` in the body is only a cross-check;
   naming anyone else answers 400 `credential_ask.owner_mismatch`. A requester
   can therefore never route an ask, and the right to approve it, to a
   principal of their choosing.
4. **Approve and deny are owner-only, with no break-glass (D2).** An unknown
   ask answers 404; a session that is not `ask.owner` answers 403
   `credential_ask.forbidden`. No operator or admin override exists, by
   maintainer decision. `ask.owner` is fixed when the ask is created
   (migration 0043) and no code path updates it, so reading it before the
   atomic claim cannot race.
5. **Askability is checked under a row lock, in both stores.** An ask must
   target a live `personal` credential owned by a `user`
   (`assertAskableCredential`, shared by the in-memory and Postgres stores so
   the rule cannot drift again; before S1 the Postgres store relied on the
   foreign key alone and accepted `service` and revoked credentials).
   `PostgresCredentialAskStore.createAsk` reads the credential with
   `SELECT kind, owner_kind, owner_ref, revoked_at … FOR SHARE` in the same
   transaction as the `INSERT`, so a revoke cannot slip between the check
   and the insert. A non-uuid credential id is `unknown_credential`, not a
   raw `22P02` 500.
6. **Approve re-checks the credential.** Under the same `FOR SHARE` lock,
   approve re-runs the askability check. When the credential has been revoked
   since the ask was made, the ask is closed as `expired` and no grant is
   minted; the route answers 409 `credential_ask.not_actionable`.
   `revokeCredential` is a single `UPDATE credentials` that never touches
   `credential_asks`, so the two lock orders cannot deadlock.
7. **Role-owned personal credentials are no longer askable.** Approval is
   bound to the session principal, which is always a user. An ask addressed
   to a `role` owner could never be answered by anyone, so creating one is
   refused as `not_askable`.

Two consequences follow. A credential-creation surface must store a personal
credential's owner as `user:<omadia_user_id>`, or nobody can ever approve an
ask against it. And the approve-time re-check compares askability, not
ownership: a pending ask created before S1 with a client-forged owner is not
closed by it. No production code path creates credentials today (nothing in
`middleware/src` calls `createCredential`), so such a row can only come from an
out-of-band insert.

Tests: `middleware/test/credentialAskRoutes.test.ts` (live `app.listen(0)`
with a session stub: 401, `identity_from_session`, the non-owner approve/deny
403 with no grant minted, 409 after revocation), `credentialAsks.test.ts`
(in-memory store and the shared helpers) and
`postgresCredentialAskStore.pg.test.ts` (real Postgres: service, revoked and
owner-mismatch refusals, approve after revocation mints no grant).

---

## 10d. WebSocket upgrade authentication (#746 W1-1)

`WebSocketRegistry` (`middleware/src/channels/webSocketRegistry.ts`) is the
process's only `upgrade` listener. It routes each upgrade through a
path → route table, and every route authenticates **before** the handshake:
a rejected peer gets a raw status line and a destroyed socket, never a `101`,
so no WebSocket is ever allocated for it. An unregistered path is `404`.

- **Channel routes** (`register`, reached by plugins only through
  `CoreApi.registerWebSocket`) authenticate with `requireAuth`'s own
  `evaluateSessionToken`: same signing key, same Entra-whitelist gate, same
  server-side revocation guard (§10k), same status mapping
  (`auth.not_whitelisted` → 403, a revoked session → 401 plus one log line,
  a failed revocation lookup → 503, anything else → 401). A
  deactivated channel answers `503`, and the active flag is checked again
  after the async cookie verification, so a deactivation during that window
  cannot leak a socket past `deactivateChannel`. The upgrade is not the last
  check: the socket lives no longer than its session (see "Session lifetime
  after the upgrade" below).
- **Kernel routes** (`registerKernel`) bring their own authenticator. They
  are a kernel-only capability and are deliberately not on `CoreApi`, so no
  plugin can opt out of the session cookie. The authenticator's verdict maps
  to `401`/`403`. A throw, a result that is not a result, or a missed
  deadline (`authTimeoutMs`, default 10 s) is an infrastructure failure, not
  a verdict on the credential. It answers `503` and is logged at error level
  with the stack, so a key-store outage cannot read as "credential rejected".
  All of these fail closed.
- **The status line is fixed.** The reason phrase comes from a constant
  table (`middleware/src/channels/webSocketUpgradeAuth.ts`, which also holds
  the deadline and the 503 mapping). An authenticator's `message` only reaches the server log, and there
  it is JSON-quoted, so a CR/LF in it can neither inject a response header
  nor forge a log line.
- **Frame caps are explicit.** Channel routes share `CHANNEL_WS_MAX_PAYLOAD_BYTES`
  (32 MiB, below `ws`'s 100 MiB default). Every kernel route must set its own
  `maxPayload`. Caps are bounded to `2^31 − 1` because `ws` stores
  `maxPayload | 0`, and 2^31 or more would silently mean "unlimited". An
  oversized frame closes that one socket with `1009`. Every accepted socket
  has an `'error'` listener, so a hostile frame cannot raise an uncaught
  exception.

**Session lifetime after the upgrade.** A channel socket stays authorised
exactly as long as the session that opened it.
`middleware/src/channels/channelSessionLifetime.ts` owns every accepted
channel socket:

- **Expiry.** The registry keeps the token and its `exp` for each socket. The
  plugin handler never gets the token: it gets the claims (with `expiresAt`),
  and the session cookie is stripped from `socket.request.headers`. At `exp`
  the socket is closed with **4401** `session expired`. A token without `exp`,
  or one that expired between the upgrade check and the handshake, is closed
  with 4401 before the handler runs. A frame that arrives after `exp`, and a
  frame the handler sends after it (turn output, a notification push), is
  dropped even when the timer runs late: `exp` is wall-clock time, and the
  wall clock decides.
- **Revocation on this replica.** A route that revokes calls
  `SessionRevocation.announce` (§10k). The registry listens and closes that
  user's sockets at once with **4403** `session revoked`.
  `WebSocketRegistry.closeSessions(match)` is the same lever for any other
  kernel path. An announcement that lands while an upgrade is still being
  checked finds no socket yet. The registry notes the revocation count before
  that check, and if this user was revoked in between, `accept` closes the
  socket with 4403 before the handler runs. It keeps the last 256
  announcements for this. When more arrived during one upgrade's check, it
  cannot rule out that this user's was among them. It then closes with
  **1013** `session unverified`, also before the handler runs, and the
  client's reconnect gets a check of its own. The registry never hands such a
  socket over to be checked at its first frame, because a handler's
  connection-time work and its pushes need no frame.
- **Revocation on every replica: the next frame.** The announcement is
  process-local, so the guarantee across replicas (and for a revocation made
  directly in SQL) is a check per inbound frame. A frame reaches the handler
  only on a verdict whose check started at most `WS_SESSION_FRAME_RECHECK_MS`
  (env, default 5 s, 0 = every frame) before the frame arrived. The upgrade's
  own check counts. With an older verdict the frame waits, and so does every
  frame behind it, in order, while `evaluateSessionToken` (the verdict path
  HTTP uses) runs again. The socket stops reading meanwhile, so the wait is
  TCP backpressure, not a growing buffer. A revoked session closes with 4403
  `session revoked`, a de-whitelisted Entra identity with 4403 `session
  forbidden`, a token that no longer verifies with 4401, and the waiting
  frames are dropped. So no frame that arrives more than
  `WS_SESSION_FRAME_RECHECK_MS` after a revocation made elsewhere is
  handled: it waits for a check that sees the revocation, and the socket
  closes. When a check started and when a frame arrived are both read from a
  monotonic clock (`performance.now`), so stepping the wall clock back (NTP,
  a VM resume) cannot stretch a verdict past that bound.
- **Idle sockets.** Every `WS_SESSION_RECHECK_MS` (60 s, the admin UI's
  heartbeat cadence) one sweep runs the same check for every live socket.
  That bounds what a socket that sends nothing still receives, such as
  notification pushes: within 60 s of a revocation on another replica.
- **No verdict, no frame.** A failed account lookup (`auth.unavailable`), a
  check that throws and a check that misses its deadline
  (`WS_SESSION_CHECK_TIMEOUT_MS`, 10 s) are outages, not verdicts. The socket
  stays open, still bounded by its `exp`, and answers pings again as soon as
  the check has given up. The frames that waited on that check never reach
  `onMessage`. They go to the handler's `onRefusedMessage`, the WebSocket
  twin of HTTP's 503: the canvas answers a refused turn with `turn_error`
  `session check unavailable, try again`, honours a refused `turn_abort`
  (stopping needs no authorisation),
  and closes with `1013` instead of acking a refused `handshake_select`, so
  the client reconnects through a fresh upgrade check. An outage also ends
  the grace of the verdict before it, so the next frame checks again. A
  refusal that arrives after the deadline still closes the socket. The sweep
  and the frames share one check per socket, and a check is never started a
  second time while one runs.
- **After the close.** No further frame reaches the handler and its sends are
  dropped, even while the peer is still acknowledging the close. The
  handler's `onClose` fires at once: the canvas channel aborts the turn still
  running for that socket and starts nothing that was queued behind it.

The two close codes follow what the client should do next, not the HTTP
status: an expired session can be replaced by a renewal the client may already
hold (4401, like 401), a revoked one only by a new sign-in (4403, although the
revoked cookie itself gets 401 `auth.revoked` on HTTP). Channel deactivation
still closes with `1001`.

**Re-authentication and reconnect.** A socket is bound to the token that
opened it. `POST /api/v1/auth/renew` extends the cookie, never an open socket,
and renewal never moves the session version, so the re-check keeps finding
the pre-renew token current until its own `exp`. `handshake_ack` carries that
moment as `sessionExpiresAt`. The canvas client warns the user before it
(renewal stays an explicit click, §10b). On 4401 it reconnects with whatever
cookie is current: a renewed cookie opens a new socket with a new expiry, a
401 on that upgrade means signing in again. On 4403 it stops.
`@omadia/canvas-core` 0.2.0 implements this: 4401 reports `unauthenticated`,
4403 reports `forbidden`, and neither enters the backoff loop. Only the host's
next `connect()`, after it renewed or signed in, opens a socket again; a
canvas switch in between only records which canvas that `connect()` resumes,
since a reopen with the ended cookie is refused before the upgrade and looks
like a network drop to the client. A cookie provider (`cookie: () => string`)
supplies the current cookie on every connect. A 1013 is no verdict on the
cookie, so the client simply reconnects in its normal backoff.

Kernel routes get none of this. Their principal is opaque to the registry, so
a kernel route whose credential can expire or be revoked must close its own
sockets. The satellite tunnel's credential (API key plus signed challenge) and
its revocation of live sockets are owned by W1-2.

Tests: `middleware/test/webSocketRegistry.test.ts` (exact statuses, per-route
auth and caps, collisions, deactivation),
`middleware/test/webSocketRegistryHardening.test.ts` (503 on throw, deadline
and junk result, raw status-line bytes, bounds including
`channelSessionRecheckMs`, `channelFrameRecheckMs` and
`channelSessionCheckTimeoutMs`, the deactivate-during-auth race),
`middleware/test/webSocketRegistrySession.test.ts` (expiry close, tokens
without `exp` or expired during the upgrade, claims without the token,
`closeSessions`, announced and swept revocation, whitelist withdrawal, an
outage withholds frames but keeps the socket, no timer or re-check after a
close or a deactivation), `middleware/test/webSocketRegistryFrameGate.test.ts`
(a revocation on another replica stops the next frame and the frames queued
behind its check, a revocation announced during the upgrade closes before the
handler runs, more announcements than are kept close with 1013 before the
handler runs and the reconnect works, a failed or hung lookup withholds frames
while the socket stays open and answers pings, a bound of 0 checks every
frame), `middleware/test/channelSessionTracker.test.ts` (exactly at `exp`, a
late timer for inbound and outbound frames, the setTimeout ceiling, verdict
mapping, one check at a time),
`middleware/test/channelSessionFrameGate.test.ts` (the frame bound and its
default, order, backpressure, outage and deadline, a late refusal, the
upgrade window and its overflow, a wall clock stepped back),
`middleware/test/auth/liveSocketRevocation.test.ts` (through
the real routes: renewal keeps the socket, sign-out and disable close it),
`middleware/test/uiChannelWebSocket.test.ts` (`sessionExpiresAt` in the ack,
abort on close), `middleware/test/uiChannelSessionRefusal.test.ts` (what the
canvas does with a refused frame), `middleware/test/uiChannelSessionGate.test.ts`
(the canvas on a real registry: a turn after a revocation elsewhere never
starts, a turn during an outage gets `turn_error` while the socket stays) and
`middleware/packages/canvas-core/test/canvasSocketSession.test.ts` plus
`canvasSocket.test.ts` (the client's close-code policy, including a canvas
switch after the session ended).

---

## 10e. Post-login return URLs are same-origin paths only

`/login` and `/setup` read a `?return=` value and navigate to it. A visitor
who is already signed in is forwarded at once (`router.replace`). A password
login and the first-admin setup end in `window.location.href = …`. The value
also rides along on the hop from `/login` to `/setup`, and it goes into the
OIDC start link (`/bot-api/v1/auth/login/<id>/start?return=…`). It comes from
the URL, so whoever writes the link chooses it, and the navigation happens
right after the operator typed a password.

**Producers.** The app writes `?return=` in four places, always from the
browser's own location: `web-ui/proxy.ts` (unauthenticated request),
`_lib/api.ts` (a 401 in the browser), `_lib/authRedirect.ts` (a 401 during a
server render) and `SessionWatcher` ("sign in again"). All four send the
current page's path (`pathname`, plus `search` where they have it), never an
absolute URL.

**The rule.** Both pages pass the value through `sanitiseReturnPath`
(`web-ui/app/_lib/returnPath.ts`). Anything that fails becomes `/`.

1. At most 2048 characters, starting with exactly one `/`. `//host` is
   protocol-relative, and the WHATWG parser reads `\` as `/` in http(s)
   URLs, so `/\host` is the same thing.
2. No C0 control character and no DEL. The parser drops TAB, LF and CR
   before it parses, so `/<TAB>/host` becomes `//host`.
3. Parse against a fixed base (`http://omadia.invalid`) and require the
   result to stay on that base's origin. The base is a constant rather than
   `window.location.origin`. After rules 1 and 2 the verdict is the same for
   every http(s) origin, so the server render (no `window`) and the browser
   agree, and the OIDC link hydrates with the href the server sent.
4. Hand out only `pathname + search + hash`, and only if that passes rules 1
   and 2 again. Dot segments collapse: `/..//host` stays on the base origin
   but normalises to the path `//host`, which is protocol-relative once it is
   used as a link.
5. `/login` and `/setup` (also with a query, a fragment or a trailing slash)
   become `/`, so a signed-in visitor cannot be sent back into the login page.

A backslash further into the value stays. In the path the parser turns it
into `/`, and in the query it is a literal character that `location.search`
keeps, so the producers above can forward one.

**Server side.** The middleware checks the value again for the OIDC round
trip (`sanitiseReturnPath` in `middleware/src/routes/auth.ts`). It applies
rules 1 and 2 without the length cap and returns `null` (drop the value)
instead of `/`. It does not normalise, because its own redirects cannot leave
the origin: the OIDC callback redirects to `publicBaseUrl + path`, and the
back-compat `GET /api/v1/auth/login` puts the value into the web UI's
`/login?return=`, where the rules above run. The web UI's proxy sends 401s
straight to `/login`, so that back-compat route only serves old bookmarks and
hand-made links. The password login never sends `return` to the server.

**Desktop shell.** The desktop app loads the web UI from
`http://127.0.0.1:<port>` (`desktop/src/supervisor.ts`) in a window with no
address bar, so a return value that left the origin would replace the app
window itself without showing it. The shell's navigation fence (§10i) is a
second layer, not a replacement: it keeps navigations the web UI starts on
the app's loopback origins and opens other web targets in the system
browser, but it lets server redirects between web URLs through, because the
in-window OIDC sign-in needs them. For the OIDC callback's redirect this
check is the only layer.

**Not covered here.** Absolute redirect targets that the server supplies,
such as the IdP end-session URL behind sign-out (`idpLogout.url` in
`web-ui/app/_components/AuthBadge.tsx`), are a separate trust boundary. They
come from provider configuration, not from the address bar.

Tests: `web-ui/app/_lib/__tests__/returnPath.test.ts` (off-origin forms,
normalisation, the "never resolves off-origin" invariant over several real
origins, the auth-page guard), `returnPath.node.test.ts` (no `window`), the
page tests `web-ui/app/login/__tests__/page.test.tsx` and
`web-ui/app/setup/__tests__/page.test.tsx` (every navigation sink with a
crafted value), and `middleware/test/auth/returnPath.test.ts` (both server
routes and the OIDC callback).

---

## 10f. Self-update control plane: the Engine proxy is host root, reachability is the boundary (#432)

The optional overlay `docker-compose.update.yaml` gives exactly one component
Docker Engine access. An update travels this chain: operator session →
`POST /api/v1/admin/update` (type-to-confirm, release tags only) → middleware →
updater (`http://updater:8090`: shared bearer token, release tags only,
protected services) → `docker-socket-proxy` (on `omadia-control` only) →
`/var/run/docker.sock` (mounted read-only, into the proxy alone).

1. **The proxy is host root to whoever reaches it.**
   `tecnativa/docker-socket-proxy` has no authentication. Its section flags
   match URL prefixes, and `CONTAINERS=1` + `POST=1` admit every method under
   `/containers`. That covers creating a privileged container with host bind
   mounts (root on the host once it starts), reading and writing any
   container's files through `/containers/{id}/archive` (secrets on the
   middleware's data volume included), and creating exec instances (`EXEC=0`
   only blocks `/exec/{id}/start`). `VOLUMES=0` restricts the `/volumes` API,
   not bind mounts. The flags therefore limit what a compromised *updater* can
   do; they cannot make the proxy safe to reach. All 27 flags of the pinned
   image are set explicitly, and only `CONTAINERS`, `IMAGES`, `NETWORKS`,
   `POST` and `PING` are on. `EVENTS` and `VERSION` default to on in the image
   and are off here.
2. **Reachability is the boundary.** The proxy joins one network,
   `omadia-control`, and the updater is the only other member. Three
   properties keep everything on `omadia` (middleware, web-ui, postgres, every
   overlay sidecar) away from it:
   - Docker's embedded DNS answers `docker-socket-proxy` only to containers
     that share a network with it.
   - `internal: true` gives the network no route off the host and no
     published ports.
   - `com.docker.network.bridge.inhibit_ipv4` leaves the bridge without a
     host-side address. The host then has no route into the subnet and cannot
     forward traffic from another network to the proxy. IPv6 is switched off
     on the network explicitly, so a daemon-wide IPv6 default cannot add a
     second path.

   The third property is there because isolation between networks is
   otherwise a firewall feature of the runtime. A stock Linux dockerd
   (verified on 29.8 with iptables) drops that traffic anyway. OrbStack
   (verified on 29.4) forwards it: without `inhibit_ipv4`, a container on
   `omadia` reached the proxy by IP address even though the name did not
   resolve. With it, that path is closed on both runtimes. Every engine tested
   accepts the option (20.10, 24, 27, 29).
3. **Control-plane services live on internal networks, never on `omadia`.**
   The updater is the only service on both networks, because the middleware
   calls it (`OMADIA_UPDATER_URL`) and its health gate calls the middleware
   (`UPDATER_HEALTH_URL`). Never attach an application service to
   `omadia-control`: whatever joins it can drive the Engine. The same rule
   applies to any later overlay with Engine access; the planned dev-runner
   daemon (`docs/dev-platform/w1-manifest.json`) stays off `omadia` the same
   way.

**Why the network and not only the token.** The updater's guards (bearer
token, release-tag check, protected services) live in the updater's own HTTP
handler, and a direct call to the proxy never passes through them. Plugins run
in the middleware process, and a plugin's egress allow-list is no boundary for
internal hostnames. `permissions.network.outbound` accepts any host string
(`$config.*` entries resolve to whatever the operator entered), and the
static allow-list modes of `ctx.http` trust named hosts without the SSRF guard
(`platform/httpAccessor.ts`). While the proxy sat on `omadia`, a manifest that
named `docker-socket-proxy` got an HTTP client that could drive the Engine, no
code-execution bug needed. Now the name does not resolve from the middleware,
and the address does not route.

**Residual risk, by design.**

- A compromised updater is host root. It holds the only route to the proxy,
  and the flags only trim what it can send.
- The middleware holds the updater token (`OMADIA_UPDATER_TOKEN`), and so does
  all code running in the middleware process, in-process plugins included.
  With it they can read `/status` and start an update to any release tag,
  including an older release. `routes/adminUpdate.ts` only refuses the release
  that is already running, and the sidecar's `TAG_RE` checks the tag's shape;
  neither compares the target with the running version. They cannot pick an
  image repository, touch `postgres`, the updater or the proxy, or send any
  other Engine call. A not-older-than-running gate is on the roadmap
  (`docs/middleware-agent-handoff.md` §13).
- Nor can they relay a request through the updater. Apart from the release
  tag, the only middleware-written input the updater acts on is the `/health`
  answer during the gate, and the health probe never follows a redirect
  (`sidecars/updater/src/health.mjs`). A 3xx counts as not healthy and is
  noted once in the step trail; its `Location`, for example
  `http://docker-socket-proxy:2375/…`, is never requested. Before this, the
  probe used fetch's default `redirect: 'follow'`, and a middleware answering
  with such a redirect made the updater send GET requests onto
  `omadia-control`.
- `NETWORKS=1` stays on. `recreate.mjs` attaches a container's second and
  later networks only after stop + remove, so turning it off would strand a
  half-recreated middleware, and its rollback, on any stack that puts the
  middleware on more than one network.

**Assumptions.** The Docker daemon enforces all of the above. It was verified
on stock dockerd and on OrbStack, not on rootless Docker, Podman or Docker
Desktop, and a host firewall that rewrites Docker's chains can change it.
Operators check their own host with the check in `docs/upgrading.md`. It
first proves that the updater reaches the proxy by name and by address, then
probes the same name and address from the middleware and the web-ui. It counts
only a failed lookup (`ENOTFOUND`) or a refused, unroutable or timed-out
connection as blocked, and reports any other error as `INCONCLUSIVE` with a
non-zero exit, never as a pass. The Fly.io engine has no proxy and no socket;
it calls the Machines API with app-scoped deploy tokens, so this section does
not apply there.

Tests: `middleware/test/composeUpdateOverlay.test.ts` reads every
`docker-compose*.yaml` at the repo root. It asserts the network membership (as
the union compose builds when it merges files), the control network's
`internal`, `inhibit_ipv4` and IPv6 settings, the socket mount, the absence of
ports and `network_mode` on the proxy, and the full flag list of the pinned
image. CI also renders the merged overlay with
`docker compose -f docker-compose.yaml -f docker-compose.update.yaml config --quiet`,
which catches merge errors that a per-file parse cannot see.
`middleware/sidecars/updater/test/health.test.mjs` answers the health probe
with 301, 302, 303, 307 and 308 redirects to a stand-in Engine endpoint and
asserts that the gate stays closed and the stand-in receives no request.

---

## 10g. The operator front's login gate (`web-ui/proxy.ts`) and its public allowlist

The Next.js operator front (`web-ui/`) puts a login gate in front of every
page and every `/bot-api/*` call: `web-ui/proxy.ts`, Next 16's `proxy.ts`
convention. A request passes only with an `omadia_session` cookie whose JWT
has not expired. Anything else gets `302 /login?return=<path>`, and a stale
cookie is deleted on the way. The gate decodes the token and never verifies
its signature. It spares the operator a page that 401s on every call, but it
is not the authorization boundary: the middleware's `requireAuth` (§10)
verifies every `/api/*` call itself, including the ones proxied through
`/bot-api/*`.

`isPublicPath` is the only way past the gate without a session. Each entry
has its own reason:

| Path | Why it needs no session |
|---|---|
| `/login`, `/setup` | The sign-in page and the first-user wizard. |
| `/bot-api/v1/auth/*` | Sign-in, sign-out, OIDC callback, provider list. The middleware lists `/api/v1/auth` as public too (`auth/publicPaths.ts`). |
| `/_next/*` | Framework assets and dev tooling. |
| `/health`, `/favicon.ico` | Fly health checks must answer before anyone has signed in. |
| `/p/*` | Plugin UI iframed by Teams Tabs, where only a Teams SSO token exists. The plugin handler runs its own auth. |
| `/.well-known/omadia-ui`, `/pairing-discovery` | The pairing descriptor (#293), see below. |

**Pairing discovery.** A desktop client that knows only the operator URL
fetches `/.well-known/omadia-ui` before it has signed in. The descriptor is
what tells it where to sign in (`auth.loginStartUrl`) and where to connect
(`wsUrl`). Next runs the proxy before the `next.config.ts` rewrite to the
`/pairing-discovery` handler, so the gate sees the canonical path; the
handler path is reachable directly as well. Both are exempt by exact match,
defined once in `web-ui/app/_lib/pairingDiscoveryPaths.ts`, which the
rewrite imports too. The exemption is safe because the descriptor is
non-confidential by construction:

- the middleware serves a descriptor of the same shape without
  authentication, at the same path, mounted outside the `/api` requireAuth
  line (`buildPairingDescriptor` in `middleware/src/pairing/discovery.ts`);
- its provider list (id, display name, kind) is already public through
  `/bot-api/v1/auth/providers`;
- the `wsUrl` it hands out leads to the canvas WebSocket, which
  authenticates every upgrade before the `101` (§10d). Knowing the URL
  grants nothing.

The descriptor must therefore never carry a secret or session material: no
token, no key, no per-user data. On split deployments the middleware is not
publicly reachable, so this route is where `OMADIA_UI_INSTANCE_NAME` and
`OMADIA_UI_PUBLIC_WS_URL` become visible from the internet. Both are
non-secret by design, since a client needs them to connect. The handler
echoes the caller's `x-forwarded-host`/`host` into `wsUrl` and
`loginStartUrl`. Every answer carries `Cache-Control: no-store`, so a shared
cache in front of the web-ui may not keep one caller's reflected host and
hand it to the next; `force-dynamic` only turns off Next's own caching. Each
cookie-less request costs one server-side read of the provider list, the
same read `/bot-api/v1/auth/providers` already allows without a session.
That read has a 5-second deadline, so a middleware that accepts the
connection and never replies cannot hold discovery requests open.

**An unread provider list is an error, not `none`.** The pairing protocol
defines `auth.mode: 'none'` as "this host accepts unauthenticated connects"
(`PairingAuth` in `middleware/src/pairing/discovery.ts`). When the handler
cannot determine the providers (the middleware is unreachable, misses the
deadline, answers with an error status, or sends no provider list), it
answers `503` with `Retry-After` and `{ code: 'pairing.auth_unavailable' }`
instead of a descriptor. Reporting `none` there would tell a client during
an outage that no sign-in is needed. Nothing would be bypassed, since
`requireAuth` and the canvas upgrade (§10d) check the session themselves,
but the client would be sent down the wrong path. `none` remains the answer
only for a provider list the middleware returned empty, which is how the
middleware's own `buildPairingDescriptor` reads that state.

**Rules for the allowlist.**

1. Exact match. A prefix only where every path under it is public by
   design or authenticates itself (`/_next/`, `/p/`, `/bot-api/v1/auth/`).
   `/pairing-discovery/x` and `/.well-known/omadia-uix` stay gated.
2. A new exemption needs a case in `web-ui/app/__tests__/proxy.test.ts` and
   a row in the table above.
3. An exemption lifts only this gate. A path proxied to the middleware under
   `/api` still needs its own entry in `middleware/src/auth/publicPaths.ts`
   (§10).

Tests: `web-ui/app/__tests__/proxy.test.ts` (both discovery paths pass
without a cookie and leave an expired one alone; operator routes and
near-miss paths redirect; the older exemptions and a fresh session pass) and
`web-ui/app/pairing-discovery/__tests__/route.test.ts` (the handler answers
JSON without a cookie and sends none upstream; an unreachable, stalled,
failing or malformed upstream yields `503`, never `auth.mode: 'none'`; every
answer is `no-store`).

---

## 10h. Operator UI response headers and image user (web-ui)

Every operator page of the web-ui answers with:

| Header | Value |
|---|---|
| `Content-Security-Policy` | `frame-ancestors 'none'; object-src 'none'; base-uri 'none'` |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |

- **Set at request time.** `web-ui/proxy.ts` applies them from
  `web-ui/app/_lib/securityHeaders.ts` on every response it returns. They are
  deliberately not in `next.config.ts` `headers()`: Next freezes that into the
  build, the same trap that once baked the compose hostname into `rewrites()`,
  so an override set on a published image would do nothing.
- **`UI_FRAME_ANCESTORS`** (env of the web-ui process) is for deployments that
  embed operator pages, e.g.
  `'self' https://teams.microsoft.com https://*.teams.microsoft.com`. It
  replaces `'none'` in `frame-ancestors`, and `X-Frame-Options` is then left
  out because it cannot express an allowlist. Only CSP source expressions are
  accepted. A value containing `;`, `,`, a quoted keyword other than `'self'`
  or `'none'`, or a control character is ignored with a warning in the web-ui
  log, and the default stays in force. An explicit `'none'` equals the
  default.
- **`/p`, `/p/*`, `/bot-api` and `/bot-api/*` are left untouched**
  (segment-exact, so `/bot-apix` is an operator route). These route handlers
  stream middleware responses, and several of those are documents that are
  framed: plugin UIs (`PluginUiFrame`, and Teams tabs load `/p/*`
  cross-origin), the store's admin panel (`/bot-api<admin_ui_path>`) and the
  builder preview (`/bot-api/v1/builder/.../preview/ui-route/...`). The
  middleware sets their CSP, nosniff and Referrer-Policy itself
  (`pluginUiStatic.ts`, `withIframeSafeHeaders` in `harness-ui-helpers`,
  `builderPreview.ts`). Next copies proxy response headers onto the outgoing
  response before the route handler runs, and its `send-response` does not
  replace a header that is already there, so a header set by the proxy would
  override the middleware's `frame-ancestors` and break those iframes.
  Response headers on `/bot-api/*` stay the middleware's responsibility.
- **Why `'none'` breaks nothing shipped.** No operator page is framed by
  another operator page; the three iframe hosts in the web-ui load `/p/*` or
  `/bot-api/*`. The Teams channel plugin's tabs (`hub`, `tab-config` and the
  configured `contentUrl`s) all resolve under `/p/*`, and the desktop shell
  loads the UI as a top-level page (`loadURL`). Checked against a prebuilt
  image: `/login` is refused inside a cross-origin frame by default and shown
  with a matching `UI_FRAME_ANCESTORS`, and a plugin iframe inside
  `/plugin-ui/<id>` still renders.
- **No script or style policy yet.** The App Router emits inline flight and
  hydration scripts and components carry inline `style` attributes, so a
  `script-src` needs `'unsafe-inline'` or a per-request nonce, which forces
  every page into dynamic rendering. `object-src` and `base-uri` are locked
  down because the operator UI renders no `<object>`, `<embed>` or `<base>`.
- **The image runs unprivileged.** The web-ui image's runtime stage ends in
  `USER node` (uid 1000) and copies the build with `--chown=node:node`, so
  `.next/` stays writable. The middleware image drops root in its entrypoint
  via gosu because it has to chown a mounted volume first; the web-ui mounts
  none, so a plain `USER` is enough. If a volume is ever mounted into it,
  handle its ownership the way the middleware image does.

Tests: `web-ui/app/_lib/__tests__/securityHeaders.test.ts` (header table,
exemption, override parsing), `web-ui/app/_lib/__tests__/proxySecurityHeaders.test.ts`
(the headers on what `proxy()` returns, and the override read per request) and
`web-ui/scripts/__tests__/runtimeImageUser.test.ts` (runtime stage `USER`).

## 10i. Desktop shell: the renderer bridge is origin- and phase-gated

The desktop app (`desktop/`) shows everything in one `BrowserWindow` with one
preload: the bundled first-run wizard and loading screen (`file:`), the
loopback web UI after boot, and whatever a server redirect lands the window on
(an IdP page during an in-window OIDC/Entra sign-in).
`webPreferences.preload` is fixed per webContents, so a preload per phase
would need a second window. Three layers keep the setup channels with the
wizard, above all the recovery-key export, which returns the vault master key
(`VAULT_KEY`):

- **Main decides every call from the sender frame** (`desktop/src/ipcSender.ts`,
  wired in `ipc.ts`). Each channel is registered through `guardedHandle` /
  `guardedOn` with exactly one surface. `event.senderFrame` is read
  synchronously on entry, because Electron answers null for it once the frame
  has navigated. A frame that is null, destroyed, detached or unreadable is
  refused, and so is any subframe.
  - Setup channels (`testLlmKey`, `chooseDataDir`, `exportRecoveryKey`,
    `complete`) answer only when two things hold. The frame URL must be the
    bundled `dist/renderer/wizard.html`, compared as a file path against the
    install (`fileURLToPath`, dot segments resolved, case-insensitive on
    Windows). And the window navigator must show the `wizard` view, so the key
    is out of reach once setup is over. The path rule matters on its own: the
    navigator claims a view before its page has loaded, so the previous
    document can still be on screen while `view === 'wizard'`.
  - UI pings (`uiReady`, `uiLocale`) answer only the main frame at the running
    web UI's exact origin, and nothing while no web UI serves.
  - A refused invoke rejects with a fixed message; a refused event is dropped.
    Both are logged without the URL's query or hash. Setup refusals log at warn
    with the expected and the actual page, so a path mismatch in a packaged
    build is diagnosable. UI refusals (routine after a stop or restart) log at
    info.
- **The preload exposes only the loaded document's surface**
  (`desktop/src/bridgeSurface.ts`, `preload.ts`). The wizard gets the setup
  methods and the boot stream, the loading screen the boot stream, the web UI
  only `uiReady` and `setUiLocale`, and any other document no `window.omadia`
  at all. This layer carries weight of its own: third-party plugin UIs run in
  same-origin iframes of the web UI and can reach the bridge through
  `window.parent.omadia`. Such a call leaves through the parent's bridge, so
  Electron reports the MAIN frame with the web UI's origin, and no frame check
  can tell it apart from the web UI. **The `app` surface must never carry a
  method that returns or writes a secret.** The unused `getState` channel is
  gone. `bridgeSurface.ts` is inlined into the sandboxed preload and stays
  import-free; a test asserts the bundle requires nothing but `electron`.
- **Navigation is fenced** (`navigationPolicy.ts`, `navigationGuards.ts`,
  installed for every webContents and its session from
  `app.on('web-contents-created')` before the window exists). Each way a
  page can reach a new document has its own rule:
  - `will-navigate` (main frame: links, `window.location`, form posts): the
    current document decides. From the web UI, the kernel or a bundled page,
    the window stays on the app's own loopback origins (web UI and kernel).
    Any other `http(s)` target is prevented and handed to the system browser.
    Every other scheme is refused, `file:` included. From a foreign page (an
    IdP reached by a redirect), `http(s)` targets stay in the window so the
    IdP's own form posts and hops work; script, data and file targets are
    still refused.
  - `will-frame-navigate` (subframes: plugin UIs, the builder preview,
    anything a page embeds): any web page may load, as in a browser, and so
    may what the browser renders in the page itself (`about:`, `data:`,
    `blob:`). A custom scheme or `file:` is refused. Subframes never get the
    bridge; the preload runs in main frames only.
  - `will-redirect` (server redirects, any frame): web targets pass, so the
    in-window sign-in keeps working. A redirect to any other scheme cancels
    the navigation.
  - `setWindowOpenHandler` decides by target. A same-app popup (attachment,
    preview, download) opens as a sandboxed, context-isolated child without a
    preload. Electron merges only security-related webPreferences from the
    parent into such a child, never the preload, so the explicit flags are
    belt and braces. `about:blank` and an empty `window.open()` are refused,
    because Electron gives such a child the parent's webPreferences, preload
    included. Any other web target is refused in the app and opened in the
    system browser; any other scheme is just refused.
    Chromium's implicit `noopener` already applies to `target="_blank"`, so a
    missing `rel` attribute on such a link adds nothing here.
  - The session never grants Electron's `openExternal` permission. Electron
    asks for it before it hands a non-web URL to the OS protocol handler,
    from any frame and after any redirect, and without a handler it grants
    every request. Any frame could otherwise launch an installed app's
    scheme (`ms-settings:`, `search-ms:`, …) without a prompt. This is the
    backstop behind the event rules above. Every other permission keeps
    Electron's no-handler answer, which grants it to every frame without the
    app asking: camera and microphone, clipboard read, notifications and the
    rest, for plugin iframes, same-app popups and a foreign page reached by
    a redirect alike. Narrowing that to a deny-by-default allowlist per
    requesting origin and frame is an open follow-up
    (`docs/middleware-agent-handoff.md` §13, "Desktop-Shell: Trust-Boundary
    Renderer → Main").
  - So only vetted `http:`/`https:` URLs reach the OS. The shell passes
    nothing else to `shell.openExternal`, and no page can make Electron hand
    over anything else. The logs carry the target's origin or scheme, never
    the query (OAuth codes, `id_token_hint`).

Accepted residual: server redirects between web URLs are deliberately not
guarded, so the in-window OIDC/Entra sign-in keeps working (kernel 302 to the
IdP, the IdP's own steps, the callback on the kernel origin). A foreign
document reached that way, or by a navigation from such a document, can be
shown in the window. It gets no bridge, every handler refuses it, and the
rules above still keep it from reaching the OS. The IdP end-session hop after
a sign-out starts from the web UI, so it now opens in the system browser,
which has its own cookie store.

Main → renderer pushes (`bootProgress`, `bootLog`) are not sender-checked:
every boot path loads a bundled page first and streams only while it is up,
and the navigation fence keeps foreign documents off screen meanwhile.

Tests: `desktop/test/ipcSender.test.mts` (the rules, synthetic frames),
`ipcRegistration.test.mts` (every channel driven through the real
`registerIpc`, nothing written on a refusal), `bridgeSurface.test.mts`
(surfaces, what the preload really exposes, the sandbox-safe bundle),
`navigationPolicy.test.mts` (including: every URL the kernel sends the window
back to is trusted) and `navigationGuards.test.mts` (every path: main frame,
subframes, redirects, popups, and the session's `openExternal` refusal).

---

## 10j. Desktop shell: a wizard switch changes the kernel or does not exist

The first-run wizard is where a desktop user decides what the local install
does with their data, so a switch there has to be enforced, not just recorded.
Until 2026-09-30 it offered three (attachments on the local disk, semantic
memory, diagrams through a hosted service); `setup.json` stored them and
`Supervisor.kernelEnv()` never read them, so every choice booted the same
stack. The rule now:

- **Every switch maps to kernel env the supervisor sets on each boot**
  (`desktop/src/capabilities.ts` → `capabilityKernelEnv`, spread last in
  `kernelEnv()`). The switch owns its keys: `withoutCapabilityEnv` drops an
  inherited value first, so a switched-off capability cannot come back through
  the launch environment.
- **The kernel reports whether it took, and the supervisor checks.** After the
  kernel answers `/health`, `confirmCapabilities` judges the reported state
  against the switch (`attachmentReadiness`) and logs a warning on a mismatch.
  The report carries the backend only, never a path or a bucket, because
  `/health` is unauthenticated.
- **main persists only parsed switches.** `complete` refuses a selection whose
  shape it does not know (`Invalid capability selection.`) and writes the
  parsed fields, never the renderer's object; `readSetup()` rebuilds the
  selection from the file and drops keys older builds wrote.
- **A capability nothing can switch on is not offered.** Semantic memory needs
  its model fetched from the admin UI (an operator session the shell does not
  have), and diagrams need a Kroki server and S3 storage a desktop install does
  not ship. The wizard names where each is set up instead.

**Attachments** is the one switch today. On, it sets `ATTACHMENT_STORE_DIR` to
`<data folder>/attachments`, and the kernel publishes a filesystem store as its
`tigrisStore` service when no S3 bucket is configured
(`middleware/src/platform/attachmentStore.ts`; S3 keeps precedence).
`/health` reports `attachments.store` as `s3`, `filesystem` or `none`. The
store (`filesystemObjectStore.ts`) keeps keys out of paths entirely. A storage
key is caller data (`read_attachment` takes one from the model), and an S3
bucket answers a hostile key with a harmless 404, whereas a directory joined
with it would read or overwrite anything the process can reach. So each object
lives under the SHA-256 of its key, which confines every key to the directory
by construction. The directory is created 0700 and objects are written 0600
via temp file and rename. An unusable directory degrades to no store, with the
reason in the boot log, instead of failing the boot. Accepted limits: nothing
expires objects (S3 buckets get a 90-day lifecycle rule), and one directory
serves one instance.

Tests: `desktop/test/supervisorKernelEnv.test.mts` (the switch decides the env,
inherited values included; the readiness check runs after the kernel is
healthy and before the web UI), `capabilities.test.mts`,
`wizardConfig.test.mts` (every offered checkbox reaches the payload),
`setupState.test.mts`, `ipcRegistration.test.mts`, and
`middleware/test/filesystemObjectStore.test.ts` (traversal keys stay inside the
store), `attachmentStore.test.ts` (selection, the `/health` projection, the
composition-root wiring).

---

## 10k. Server-side session revocation

The admin session is a stateless JWT (§10b), so on its own the server cannot
end one early. A per-user marker in the `users` table does:
`users.session_version` (auth migration `0003_users_session_version.sql`,
`INTEGER NOT NULL DEFAULT 0`). An integer on purpose, not a "revoked before"
timestamp: `iat` has second granularity, so a timestamp marker either refuses
a sign-in made in the same second as the sign-out or accepts a token minted
just before it.

**What a token carries.** Every sign-in mints `sv` (the row's
`session_version` at that moment), `uid` (the row's id) and `sid` (a random id
for this sign-in). Renewal carries `sv` and `sid` over, like `auth_time`, and
sets `uid` to the row it verified. The
password path takes `sv` and `uid` from the same read that checked the
password (`PasswordAuthSuccess.account`), so a reset that lands after that
check still ends the new session; the OIDC callback takes them from the row it
upserts (and refuses to mint for a disabled row), `/setup` from the row it
creates. Tokens minted before these claims existed carry none of them: they
read as version 0, which is where every existing row starts, so the upgrade
signs nobody out, and they age out at the absolute cap (§10b). Without `uid`
such a token is tied to its row by its sign-in time (`auth_time`) instead. The
row it was minted for existed at that moment, so a row created in a later
second is a re-creation and does not vouch for it. Its first renewal stamps
the id of the row that renewal verified, and from then on the id decides.

**Where it is checked.** `evaluateSessionToken` (`auth/requireAuth.ts`), after
the signature and the whitelist gate, asks `SessionRevocationGuard.check`
(`auth/sessionRevocation.ts`): one point read of `(provider, sub)` on the
`users_provider_user_unique` index. The session stands only while the row
exists, is `active`, is the row the token was minted for (`uid`, or for a
token without one, a row created no later than its sign-in second) and still
has the token's `sv`. Every consumer inherits the check through that
one function: `requireAuth` (all of `/api`, including plugin routes with
`auth: 'session'`), `ctx.operatorAuth.hasValidSession`, the channel WebSocket
upgrade, the frame and idle-socket re-checks of open channel sockets (§10d)
and `POST /renew`. `GET /me` runs the same check, so the UI's
60 s heartbeat notices a revocation within a minute. There is no cache, so a
revocation holds from the next request on, on every replica. An open channel
WebSocket honours it from its next frame once its last check is
`WS_SESSION_FRAME_RECHECK_MS` (5 s) old, and within 60 s while it is idle.

**What ends sessions.**

| Event | Mechanism | Scope |
|---|---|---|
| `POST /api/v1/auth/logout` | `session_version + 1` | every session of that user, every device |
| Admin password reset | `session_version + 1` in the same UPDATE as the new hash | every session of that user |
| Admin disables the user | `session_version + 1` in the same UPDATE as the status; a later re-enable does not revive old cookies | every session of that user |
| Admin deletes the user | the row is gone; a re-created row has a new id, so `uid` keeps old cookies dead even though it starts at version 0 again (a token without `uid`: the re-created row is younger than its sign-in) | every session of that user |
| Signing-key rotation (`sessionSigningKey.ts`) | every signature fails | every session of every user |

The bump is `UserStore.update(id, { revokeSessions: true })`, always relative
to the stored value, and always in the same statement as the change that
causes it, so a password or status change and its revocation never land
apart. Routes that revoke also call `SessionRevocation.announce`, which closes
that user's open channel WebSockets on this replica at once (§10d).

**Status mapping.** Revoked → 401 `auth.revoked` (a raw 401 on a WebSocket
upgrade, logged once, because that cookie outlived a sign-out or a reset). A
failed lookup is an outage, not a verdict on the credential: 503
`auth.unavailable`, a raw 503 on a WebSocket upgrade, a refused frame on an
open channel WebSocket that stays open (§10d), and `false` from
`hasValidSession`, which never throws. The web UI bounces to /login only on a
401 and the SessionWatcher keeps its state on a 503, so a database blip does
not sign operators out.

**A stale cookie cannot sign anyone out.** `/api/v1/auth/*` is public, so a
revoked copy of a cookie can still reach `/logout`. It gets its own cookie
cleared and nothing else: the bump and the Entra refresh-token forget only
happen when the presented cookie still passes the check. Otherwise a copied
cookie could sign its owner out of every fresh session, again and again, until
its own `exp`.

**No Postgres, no check.** Without `graphPool` there is no `users` table and no
login route (the auth router answers 503). The guard then stays unattached and
passes every signature-valid session, and the boot log says so.

**Residual risks (accepted, documented).**

- Sign-out is per user, not per device. Signing out in one browser ends the
  sessions on every other device as well. That includes a canvas client: its
  socket is closed with 4403, and `@omadia/canvas-core` 0.2.0 then stops and
  reports `forbidden` until the user signs in again (older clients keep
  reconnecting into the raw 401 an expired cookie produces). A per-device
  sign-out would need a denylist keyed by `sid`.
- The builder's SSE stream (`GET /drafts/:id/events`) still authenticates
  once, when it opens, and stays open after a revocation. Channel WebSockets
  no longer do: they close at once on the replica that revoked, and on every
  other before their next frame is handled or within the 60 s sweep while idle
  (§10d). The stream can use the same levers: `SessionRevocation.onRevoked`
  for this replica and a periodic `check` for the rest, since the
  announcement is process-local.
- A channel WebSocket frame may ride on a verdict up to
  `WS_SESSION_FRAME_RECHECK_MS` (5 s) old, so a revocation made on another
  replica in that window can still let one burst of frames through. HTTP has
  no such window. Setting the variable to 0 checks every frame, at one point
  read per frame. Server pushes to a socket that sends nothing are bounded by
  the 60 s sweep instead.
- A token minted before the claims existed has no `uid` until its first
  renewal. Until then it is tied to its row by sign-in time, in whole
  seconds, with `created_at` from the database clock and `auth_time` from the
  server's. A row deleted and re-created within the second of that sign-in
  would still vouch for it, and skew between the two clocks shifts that
  boundary. The reverse case is a legacy token whose row was created in the
  second of its own sign-in (`/setup`, an OIDC first sign-in): with the
  database clock ahead it may be refused, and signing in again replaces it.
- Every authenticated request, WebSocket upgrade and `hasValidSession` call
  costs one point read on the shared pool, and so does every live channel
  WebSocket once per sweep (60 s) and at most once per
  `WS_SESSION_FRAME_RECHECK_MS` while it sends frames. If that ever shows up
  in latency, the follow-up is a short TTL cache that `announce` invalidates.
  Its TTL then adds to every bound named here: "immediately" means "within
  that TTL" across replicas, and a WebSocket frame may ride on a verdict up to
  that TTL plus `WS_SESSION_FRAME_RECHECK_MS` old.
- An admin who resets their own password is signed out too (the UI bounces to
  /login), consistent with "a reset ends every session of that user".

Tests: `middleware/test/auth/sessionRevocation.test.ts` (guard, status
mapping, outage path, `ctx.operatorAuth`, a token without `uid` against a
re-created row),
`middleware/test/auth/logoutRevokesSession.test.ts` (sign-in → copy cookie →
sign-out → the copy gets 401 on `/api`, `/me` and `/renew`; stale-cookie
logout; OIDC callback), `middleware/test/auth/userStoreSessionVersion.test.ts`
and `.pg.test.ts` (the SQL and the migration against real Postgres, and a
legacy cookie that gets 401 once its row is deleted and re-created),
`middleware/test/auth/renewRoute.test.ts` (renewal binds a legacy token by
id and refuses one whose row was re-created),
`middleware/test/auth/adminUsersRoute.test.ts` (reset, disable, re-enable,
delete), `middleware/test/webSocketRegistry.test.ts` (401/503 on upgrade) and,
for sockets that are already open, `middleware/test/webSocketRegistrySession.test.ts`
and `middleware/test/auth/liveSocketRevocation.test.ts` (§10d).

---

## 10l. First-user setup: one admin, atomically, with operator consent

A fresh install has no operator, so the first-user wizard
(`POST /api/v1/auth/setup`, `middleware/src/routes/authSetup.ts`) cannot sit
behind a session. It lives under the public `/api/v1/auth/*` prefix
(`auth/publicPaths.ts`) and authorises itself. On an install whose wizard is
still open it is the most valuable endpoint the server has: whoever completes
it becomes the admin. Two things therefore have to hold. Only the operator may
complete it, and it must produce exactly one admin no matter how many requests
race.

**Operator consent: the setup token.** The handler's first step, before the
body is read, is a constant-time comparison (SHA-256 of both sides,
`timingSafeEqual`) of the `setup_token` body field against the token for this
boot (`auth/setupToken.ts`). A miss is 403 `auth.setup_token_invalid` and a
log line with the socket peer. Putting it first means an unauthorised caller
cannot make the server validate a body, run argon2id or wait on the table lock
below. The token comes from one of two places:

- `ADMIN_SETUP_TOKEN` (16 to 512 characters, enforced at boot; an empty value
  counts as unset). It is never echoed to the log.
- Otherwise a generated 24-byte base64url token. It is stored set-if-absent in
  `platform_settings` (`auth.setup_token`), so every replica and every restart
  serves the same token until setup completes. It is printed once per boot
  ("setup token: …") and deleted in the transaction that creates the first
  admin. A boot that finds setup already done clears any leftover. If the
  store is unreachable the token is replica-local, and the log says so. The
  wizard stays gated either way.

The token is transported in the body only. A header copy would be a second
spelling of the same credential with no caller that needs it.

**The one exemption is the desktop app.** Its supervisor
(`desktop/src/supervisor.ts`) spawns the kernel with
`OMADIA_DESKTOP_EMBEDDED=true` and `HOST=127.0.0.1`. Only that combination
opens the wizard without a token: the flag plus a literal loopback bind
address, where the kernel is reachable from this machine alone. Either half
alone still needs the token. A loopback bind behind a same-host reverse proxy
is public, and the flag on a `::` bind is a misconfiguration. The decision is
made at boot from configuration. It never reads `Host`, `X-Forwarded-For` or
`PUBLIC_BASE_URL`. Behind a proxy every request can look local, and a check
that a header can satisfy is decoration (the same reasoning as §10's loopback
gate for `/api/dev`). The docker-compose stack publishes its ports on
127.0.0.1 only, but the kernel inside the container binds `::` and cannot see
how its port is published, so compose installs get a token too.

**One predicate for discovery and handler.** `resolveSetupState` returns
`available`, `disabled_at_boot`, `no_local_provider` or `locked`. It is the
only source for `GET /providers.setup_required` and for the handler's fast
path (410 `auth.setup_disabled` / `auth.setup_no_local_provider` /
`auth.setup_locked`). The boot-time `setupAllowed` flag used to be read by
`/providers` alone. A users table emptied after boot, which only direct SQL
can do because admins cannot delete themselves, then advertised "no setup"
while `/setup` still minted an admin. Now the wizard stays closed until a
restart re-evaluates it. The predicate counts users before it reads the flag,
so an install that has users answers `locked` whatever its boot decided, as it
always did. `disabled_at_boot` only covers a table that is empty now but was
not at boot, the one case a restart changes.

**Exactly one admin: `UserStore.createFirstAdmin`.** The old handler ran
`count()` and then a plain INSERT on different pool connections, with an
argon2 hash (tens of ms) in between. N parallel requests all saw 0: distinct
emails produced N admins with N sessions, and the same email produced a
unique violation that surfaced as a 500. `INSERT … WHERE NOT EXISTS` would not
have fixed it, because under READ COMMITTED each statement's NOT EXISTS runs
against a snapshot without the other's uncommitted row. The store now does,
in one transaction on one connection:

1. `SET LOCAL lock_timeout = '2000ms'` (reverts at COMMIT/ROLLBACK, so the
   pooled connection comes back clean);
2. `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`. This lock conflicts with
   itself and with the ROW EXCLUSIVE lock every INSERT/UPDATE/DELETE takes, so
   it also waits for writers that do not go through this method: the OIDC
   first-sign-in upsert and the admin-UI create. Plain SELECTs are not
   blocked, so `/providers` and sign-in lookups keep working. It is never
   ACCESS EXCLUSIVE;
3. `SELECT COUNT(*)`, which gets a fresh snapshot after the lock and so sees
   every committed writer. If the table is not empty, ROLLBACK and report
   `not_empty` (410 `auth.setup_locked`);
4. INSERT the user, INSERT the `admin_audit` row `auth.first_admin_create`
   (actor = the new admin for the wizard, NULL for the env seed), DELETE the
   persisted setup token, then COMMIT.

The password is hashed before the transaction, so the lock is held for
milliseconds. A wait past 2 s throws 55P03 (`isLockTimeout`), which the
handler answers with 409 `auth.setup_in_progress`: something is holding a
conflicting lock far longer than a first-admin transaction ever does, and a
retry is the right move. The `ADMIN_BOOTSTRAP_*` env seed goes through the
same method, so two replicas booting together seed one admin and the loser
logs a skip.

**Residual risks (accepted, documented).**

- The generated token sits in the middleware log, and log retention keeps it.
  It is single-use in effect: the wizard locks with the first admin and the
  row is deleted then. Operators who object set `ADMIN_SETUP_TOKEN`.
- Anyone who can read the logs or the database can complete setup first.
  Both already imply control of the deployment.
- A token holder can still make the server run argon2 once per request. The
  hash takes a slot of the sign-in limiter's global capacity (§10m), so
  parallel requests cannot run more argon2 at once than
  `AUTH_LOGIN_MAX_INFLIGHT` allows (503 `auth.busy` beyond it). Token guesses
  are not counted per client: the token is compared before anything else, and
  a generated one carries 192 bits. The token keeps unauthorised callers out.
- A desktop kernel on loopback accepts the wizard from any local process.
  That is the desktop trust model: the local user is the operator.

Tests: `middleware/test/auth/setupRoute.test.ts` (token order, one predicate,
409/410 mapping), `middleware/test/auth/setupToken.test.ts` (policy including
both exemption halves, constant-time match, boot wiring),
`middleware/test/auth/userStoreFirstAdmin.test.ts` (statement sequence without
Postgres), and against real Postgres
`middleware/test/auth/userStoreFirstAdmin.pg.test.ts` (N-way race, same-email
race, uncommitted-OIDC seam, lock timeout, audit row, shared token store) and
`middleware/test/auth/setupRouteConcurrency.pg.test.ts` (N parallel HTTP
requests → one 200, the rest 410).

---

## 10m. Password sign-in rate limiting

`POST /api/v1/auth/login/:providerId` sits under the public `/api/v1/auth/*`
prefix, and every well-formed attempt costs a full argon2id verification
(19 MiB, t=2), an unknown email included (the dummy-hash path). Nothing used to
count attempts: anyone who could reach the route could guess passwords online
without limit and drive unbounded argon2 work. The route now runs every attempt
through `auth/loginRateLimiter.ts` (wired in `routes/authLogin.ts`) before
`provider.verify` is called.

**Three kinds of client key.** Every attempt names its client, and the kind
of key decides which layers apply:

- `device`: the browser carries a genuine device cookie for this account,
  minted by a password sign-in to it that checked its current password (see
  below), so it is one of the browsers that have signed in to the account.
- `address`: an address a trusted proxy or edge vouched for
  (`AUTH_LOGIN_CLIENT_ADDRESS=xff:<n>` or `header:<name>`). That is one
  client, or one NAT.
- `shared`: the TCP peer, under the default `socket` policy or as the
  fallback of the other two. In every shipped topology it is a proxy that all
  browsers behind it share: the web-ui container in compose, web-ui's or the
  edge's address on Fly and Render, loopback on the desktop.

**Three layers, checked in this order.**

1. **Client** (`address` keys only): a CPU brake per client address. A leaky
   bucket of failures, a burst of 100, then one failure every 6 s (100 per
   10 min). Full → 429 `auth.rate_limited`, each Retry-After at most 15 s. A
   sender that keeps the bucket full takes every step as it opens, so whoever
   shares its address waits for as long as it keeps going. For one address
   that is the price of sharing a NAT with the sender. For a `shared` key it
   would let any anonymous sender lock out every browser of the deployment,
   so a shared key skips this layer. A `device` key skips it too: it only ever
   sees its own account, where the account layer is stricter.
2. **Account**: per (account, client) *pair*, every kind, the guessing
   defence. Five free failures, then each further attempt waits
   1 s × 2^(failures − 5) after the last failure, capped at 2 minutes (429
   `auth.rate_limited`). A success clears the pair, and a pair is forgotten
   30 minutes after its last failure. The account is the typed address,
   folded at least as coarsely as the users table matches it (*The account
   key* below), so no other spelling of an address opens a second budget.
   One client therefore gets about 30 guesses per hour against one account.
   All `device` keys of one account count as one client here, the account's
   known browsers: a second device id buys no second budget.
3. **Global**: process-wide argon2 capacity. At most `AUTH_LOGIN_MAX_INFLIGHT`
   (default 4) verifications at once, and a leaky bucket of admitted attempts
   that drains 300 per minute (so Retry-After stays at 1 s). Attempts without
   a device cookie may hold 3 of the 4 slots and fill the bucket to 240. The
   last slot and the last 60 are headroom that only `device` attempts can
   take, so however hard unknown browsers push, a known browser finds room.
   What one account's known browsers can take of that headroom is what
   their one pair admits: five attempts, then one per wait, however many
   device cookies they hold. Over the limit → 503 `auth.busy`: server
   saturation, not client misbehaviour. Only attempts the first two layers
   admitted consume it, so a flood of cheap refusals cannot turn into a
   deployment-wide 503.

A refused attempt never reaches `verify`. There is no argon2 work, and no
answer that tells a right password from a wrong one while the pair is blocked.
A refusal never sets a cookie. It carries `Retry-After` and `retry_after_s`,
and the login page turns both codes into a localized "wait N seconds" message.

**Counting at admission.** An admitted attempt is pending on its client and its
pair until it settles, and a pending attempt counts as a failure. N parallel
requests cannot all pass the check before the first verdict lands, and once a
pair's free budget is spent it gets one attempt at a time. Anything but a
successful sign-in is a failure, a `verify` that throws included. The global
slot is released in a `finally`.

**The account key.** The users table matches a sign-in by
`LOWER(email) = LOWER($input)` under the database's collation, and Postgres
lower-cases differently from JavaScript. On the shipped databases (libc
en_US.UTF-8, the builtin C.UTF-8 provider) `LOWER()` turns a capital dotted
İ (U+0130) into a plain i and every capital sigma into σ, where
`toLowerCase()` gives an i with a combining dot and, at the end of a word, ς.
A key built with `toLowerCase()` would give each such spelling of an address
a budget of its own, 2^k of them for an address with k i's. The key
(`loginAccountKey` in `auth/loginAccount.ts`) folds further than any
`LOWER()`: compatibility decomposition (NFKD), combining marks dropped, lower
case, then the dotless ı and the final ς folded to i and σ. Every spelling
the users table treats as one account is one key. A unit test checks that
against the `LOWER()` variants collations apply (libc, builtin, ICU, Turkish,
Lithuanian, C), and `loginAccountFold.pg.test.ts` against Postgres itself.
Coarser is safe:
accounts whose addresses fold together only share their limiter state (a
residual risk below). `LocalPasswordProvider` holds the other end: an attempt
signs in only to an account whose stored address folds to the key it was
counted under. Whatever a collation or a newer Unicode version matches beyond
the fold therefore cannot sign in on a budget of its own.

**Lockout-DoS.** A per-account lock is a gift to an attacker. A few wrong
passwords lock the real operator out, and on a single-admin install the unlock
path (an admin session) is exactly what the attack denies. Three mechanisms
answer it, and the two paragraphs after them say what they leave open.

- *The pair key.* The backoff is per (account, client), so a client only ever
  slows down its own attempts on an account.
- *No client brake on a shared key.* Under `socket` the middleware sees one
  address for every browser behind the web-ui `/bot-api` proxy. Were that
  address braked as one client, an anonymous sender could fill it with 100
  failures on made-up emails and then take each 6-second step as it opened.
  Every browser without a device cookie would get 429 for as long as the
  sender kept going. A shared key therefore meets only the account and global
  layers. What bounds a sender there is the global capacity, and exhausting
  it is a sustained argon2 load that answers 503, not a cheap lock.
- *The device cookie.* A browser that has signed in to an account carries a
  device cookie (`omadia_login_device`, `auth/loginDeviceCookie.ts` and
  `auth/loginDevices.ts`, the OWASP device-cookie pattern). For that account
  the limiter counts it among the account's known browsers (kind `device`)
  instead of keying it by the address. The known browsers of an account
  share one pair of their own and the reserved headroom in the global
  capacity, so no other client's guesses or floods turn them away, however
  many addresses they come from. Only their own failures, and genuine
  overload by other known browsers, can.
  - Only a successful password sign-in mints one, with a fresh id, once per
    sign-in, and so does the first-user wizard, which sets the password. A
    session alone does not: `GET /me` and `/renew` set none. Holding one
    therefore takes the account's password. The cookie survives logout.
  - It is bound to the account the sign-in VERIFIED, never to the address as
    typed: to that account's stored address and to the password that
    sign-in checked. It lives one year and is HttpOnly, SameSite=Lax, Path=/
    and Secure behind TLS, like the session cookie.
  - The value is `v3.<id>.<exp>.<ep>.<tag>`. `ep` fingerprints the credential
    epoch the sign-in checked: SHA-256 over the users row id and the password
    hash the provider compared the password with (`AuthSuccess.credentialEpoch`;
    for the wizard, the row and hash it just wrote). Never an epoch read after
    that comparison: a reset that lands while a sign-in with the old password
    is being verified would otherwise bind that sign-in's cookie to the new
    password, which it never proved. The session the same sign-in mints is
    bound the same way: its `sv` comes from the row the password was checked
    against (§10k), so such a reset ends that session too. `tag` is an
    HMAC-SHA256 over the
    account's device key (its stored address with ASCII letters lower-cased,
    `loginDeviceAccountKey`), the id, the expiry and `ep`. The tag and
    fingerprint keys are derived from the session signing key, one per
    purpose. The device key is a separate identity from the limiter's
    account key: that one lumps spellings of different accounts together on
    purpose, and one account's cookie would then count for another. `v2`
    cookies, bound to the address as typed, no longer read.
  - A request counts as a known browser when the address it names has the
    cookie's device key, and the users-table lookup of that key lands on an
    active row whose epoch is the one the cookie was minted under. The
    device key lower-cases ASCII letters only, so that lookup lands where
    the lookup of the typed address lands (a residual risk below names the
    collations where a capital I is the exception). A spelling that differs
    from the stored address beyond ASCII case names no known browser and
    falls back to the address key.
  - Revocation needs no per-device state. A password reset writes a new hash
    (argon2 salts are random), so every cookie minted before it is stale,
    and so is the cookie of a sign-in still being verified against the old
    hash when the reset lands: only a sign-in that checked the new password
    mints a current one. A disabled account has no epoch while it stays
    disabled, a deleted one has none, and a re-created one gets a new row
    id. A stale cookie is an unknown browser and falls back to the address
    key. The admin routes that create, reset, disable, re-enable or delete
    an account drop its cached epoch, so this process stops honouring the
    old one at once.
  - Checking the epoch is a users-table lookup. It runs only for a cookie
    whose tag checks out, one at a time per device key, and is cached per
    device key for 10 seconds, so a stream of requests carrying one stale
    cookie is not a stream of queries, however many arrive at once. A failed
    lookup counts the browser as unknown and is logged at most once a
    minute; it never fails a sign-in.
  - It authenticates nothing: it only picks a rate-limit bucket. A forged,
    expired, foreign or stale cookie falls back to the address key.
  - Rotating the session signing key revokes every device cookie at once,
    because their keys are derived from it. It also ends every session. The
    key is the vault entry `core:auth/session_signing_key`; the middleware
    generates a new one at start when the entry is missing. There is no
    tooling for that yet (handoff §13).

*What stays open.* Clients that share a key share its pairs. Under `socket`,
any sender that reaches the middleware through web-ui arrives on the shared
address. It can fail on one account once per 2-minute wait and keep that
account's pair shut for every browser without a device cookie for it, such as
a first sign-in on a new browser or one whose cookies were cleared. Nothing that runs before argon2 can tell that browser from the
sender. The ways out are a browser that has been signed in to the account, an
admin's password reset or re-enable (`routes/adminUsers.ts` clears every pair
of that account), a restart, or a client address that tells clients apart
(`xff:<n>` or `header:<name>` below; the shipped Fly configuration sets one).

The known browsers of an account share their pair too. Whoever holds a
current device cookie for it can make the account's other known browsers
wait, one wrong guess per 2-minute wait. Getting one takes a successful
password sign-in to the account, so that is someone who knows its password.
However many cookies such a holder collects, they are one budget. A password
reset makes them stale, a sign-in that was still checking the old password
when the reset landed gets only a stale one, and a session from before the
reset gets no new one. Re-enabling an account without a reset lets its
earlier cookies count again, which gives their holders nothing: each of them
signed in with that same, unchanged password. Reset the password to end them
for good.

**The client key under `trust proxy`.** `app.set('trust proxy', true)` makes
`req.ip` the left-most `X-Forwarded-For` entry, which the client writes. The
limiter never reads `req.ip` (the same rule as §10's loopback gate).
`AUTH_LOGIN_CLIENT_ADDRESS` (`auth/clientAddress.ts`) chooses the key:

- `socket` (default): the TCP peer, which cannot be forged, and always a
  `shared` key. It is the right choice when nothing in front of the web-ui
  adds the client's address: the desktop app, and the compose stack reached
  directly. The web-ui proxy forwards the browser's `X-Forwarded-For`
  verbatim, and Next.js 16 fills it in with the socket peer only when it is
  absent (`x-forwarded-for ??= …`). A forged value and a real one are
  indistinguishable there, which is why that hop is not trusted on its own.
- `xff:<n>`: the n-th entry counted from the **right**, the address the
  outermost of n trusted proxies that each append the client's address saw.
  Entries further left are never read, so a forged left-most value does not
  change the bucket (tested). Fewer than n entries fall back to the socket
  (shared). It fits a compose stack behind a reverse proxy that appends on
  every request (Caddy and Traefik by default, nginx with
  `$proxy_add_x_forwarded_for`): `xff:1`, provided nothing reaches web-ui
  around that proxy. A wrong n on a path without that many honest hops lets a
  client pick its own key, and then only the global layer is left against
  guessing (*A key the client can choose* below).
- `header:<name>`: a header a trusted edge sets and overwrites. It must hold
  exactly one address. **On Fly.io this is the setting:
  `header:Fly-Client-IP`**, and `fly/middleware.fly.toml` sets it. Fly
  documents the right-most `X-Forwarded-For` entry as the app's own shared or
  dedicated IP address, so `xff:1` would give every client the same key
  there. It documents `Fly-Client-IP` as the client's address as its proxy
  saw it, but not whether the proxy replaces a value the client sent. A
  probe on 2026-10-01 says it does. `debug.fly.dev`, a public Fly app that
  echoes the request headers it receives, was sent a made-up
  `Fly-Client-IP` over HTTP/1.1 and HTTP/2: as one value, as a list, as two
  header lines and with a lower-case name. Every time the app received one
  such header, holding the sender's real address, while a made-up
  `X-Forwarded-For` arrived unchanged in the left-most place. That is
  observed behaviour, not a documented guarantee, and no omadia deployment
  has been probed end to end yet (handoff §13). web-ui reaches the
  middleware over `.internal` without another proxy hop (`fly/deploy.sh`)
  and forwards the header, so the direct and the proxied path both carry
  it. **That holds only while web-ui's `MIDDLEWARE_URL` stays on
  `.internal`.** A `.flycast` address would route web-ui's requests
  through Fly Proxy, which would most likely set the header to the address
  it accepted the connection from: web-ui's own. Every browser behind
  web-ui would then arrive as one vouched address, and the client layer
  would brake them as one client: a single sender failing on made-up
  emails could hold every one of them without a device cookie at 429.
  Behind Cloudflare use `header:CF-Connecting-IP`, but only if the app
  cannot be reached around Cloudflare.

Whatever the policy yields must parse as an IP address once a port, IPv6
brackets and the `::ffff:` prefix are stripped, or the socket peer is used, so
junk can neither mint free keys nor reach the log. IPv6 clients are keyed by a
prefix `AUTH_LOGIN_IPV6_PREFIX` bits long (32..64, default 64): a single host
controls its whole /64 and could otherwise rotate through 2^64 budgets. A /64
per key still leaves the holder of an allocation many keys: a /56 is 256 of
them and a /48 65,536, and tunnel brokers hand out /48s for free. Each key
opens with its own client burst. 56 or 48 folds such an allocation into one
key, but also lumps together unrelated clients that share one (a carrier, a
hosting provider's range). The global reserve keeps known browsers safe from a
key-rich sender either way.

**A key the client can choose.** A wrong `xff:<n>`, a header the edge passes
through instead of overwriting, or a path that reaches web-ui or the
middleware around the trusted hop lets a client name its own address: any
valid IP it makes up, a new one for every attempt if it likes. Each new key
is a fresh client bucket and a fresh pair with five free failures, so neither
the client nor the account layer slows it down. Against one account only the
global layer is left. It lets attempts without a device cookie through at up
to 300 a minute per process, after a first burst of 240, where one client
with a fixed key gets about 30 an hour. On Fly that is what a forgeable
`Fly-Client-IP` would mean; the probe above found the edge overwriting it.
`socket` cannot fail this way and is the safe choice when unsure.

**Observability.** The first refusal of a (scope, client) per minute, and of
the global scope per minute overall, writes one log line
(`[auth] login refused (<scope> limit) client=<key> retry_after_s=<n>`) and one
`admin_audit` row (`auth.login_rate_limited`, system actor, target
`login-client:<key>` or `login:capacity`). Neither contains the account that
was tried. It is per episode rather than per request, so a refusal flood cannot
become a log or database write flood.

**Other argon2 on the public prefix.** The first-user wizard's hash takes a
global slot through `acquireSlot()`, from the share of browsers without a
device cookie (503 `auth.busy` when none is free, §10l).
Its setup token is compared before anything else and is not counted per
client. An over-long password (more than 1024 characters) is refused as
`invalid_credentials` before the users-table lookup: argon2's pre-hash is
linear in the input, and the JSON body limit is 10 MB.

**Configuration.** `AUTH_LOGIN_CLIENT_ADDRESS` (`socket` | `xff:1..8` |
`header:<name>`; a bad value stops the boot with a config error),
`AUTH_LOGIN_IPV6_PREFIX` (32..64, default 64) and `AUTH_LOGIN_MAX_INFLIGHT`
(1..16, default 4; with 1 there is no slot to reserve). Each slot is 19 MiB of
argon2 memory and a libuv threadpool thread (`UV_THREADPOOL_SIZE`, default 4),
so more slots than pool threads only queue. The thresholds of the three layers
and the device reserve are constants in `loginRateLimiter.ts`. The boot logs
`[auth] login rate limiter armed (client address=…, IPv6 prefix=/…, max
in-flight=…)`. A router built without the limiter dependency builds its own
with the defaults, so a forgotten wiring cannot switch it off.

**Residual risks (accepted, documented).**

- **In-memory and per process.** A restart clears every counter. With N
  middleware replicas each one enforces its own limits, so every ceiling is N
  times the configured value. It is the same accepted trade-off as the API-key
  limiter (§9). The shipped Fly deployment (`fly/deploy.sh`) runs one
  middleware machine. A shared limiter (Redis or Postgres) is on the roadmap
  for when the middleware runs more than one replica.
- **A restart is the out-of-band unlock.** If the only admin is slowed down and
  has no device cookie, restarting the middleware (the Fly machine, the compose
  service, or quitting the desktop app) clears all limiter state. It needs no
  admin session.
- **A shared pair.** Clients on one key share its pairs: under `socket` every
  browser behind the web-ui proxy, under `xff`/`header` a NAT, on the desktop
  app every local sign-in (`127.0.0.1`). A sender that keeps failing on one
  account, one wrong guess per 2-minute wait, keeps that pair shut for
  browsers without a device cookie for the account. Known browsers are
  unaffected, and so is every other account. A real fix needs per-browser
  attribution through web-ui, which its Next.js proxy cannot give: it cannot
  see the browser's socket address when a header is present. A mistyping
  desktop user meets the same backoff (2 minutes at most) and has a device
  cookie after the first successful sign-in.
- **A shared client address under `xff`/`header`.** Behind one NAT, a sender
  that keeps the address's client bucket full makes colleagues without a
  device cookie wait for as long as it keeps going. It has to sit behind that
  NAT to do so.
- **Global saturation.** A sender that keeps more than 300 admitted attempts
  per minute coming makes other browsers without a device cookie answer 503
  while it keeps going. It can do that from the shared key alone, which has
  no client brake, or from many addresses: a few in the first minute, since
  each opens with a burst of 100, then about 30 at 10 per minute each. It
  pays with a sustained argon2 load the caps bound, and known browsers keep
  their headroom: device cookies count only while their account's password
  is current, and one account's cookies share one pair, so a pile of them
  cannot take it either.
- **A current device cookie is one more client, never more.** Whoever holds
  one for an account (it takes a sign-in with the account's password)
  shares the account's known-browser pair. While it keeps failing, the
  owner's known browsers wait too (2 minutes at most per wait), and it gets
  one budget per account however many cookies it collected. A password reset
  makes every earlier cookie stale, also the one a sign-in with the old
  password gets while the reset lands, and only a sign-in that checked the
  new password mints another.
  Re-enabling an account without a reset lets its earlier cookies count
  again, all of them minted with that unchanged password. Rotating the
  session signing key ends all device cookies and all sessions at once.
- **Accounts that fold together share their limiter state.** Two accounts
  whose addresses differ only in what the account key folds away (accents,
  compatibility forms, a combining dot, a dotless ı) share every pair, the
  known-browser pair included: failures on one count against the other, and
  a known browser of one can make the other's known browsers wait. Real
  addresses rarely differ like that, and it shrinks the guessing budget
  rather than growing it. The same goes for a collation that lower-cases a
  capital I its own way (Turkish and Azerbaijani make it the dotless ı,
  Lithuanian adds a dot before an accent above): there the lookup of an
  address's device key (with a plain i) can land on another account of the
  same fold than the typed address does. The shipped databases use none of
  them.
- **Distributed guessing.** The account layer is per (account, client). An
  attacker with many client keys (a botnet, an IPv6 allocation under
  `xff`/`header`) gets a budget per key, and the global layer is the
  ceiling. A client that can choose its key (*A key the client can choose*
  above) is the extreme case, with a fresh budget for every attempt. A
  per-account ceiling across all clients would bring back the lockout-DoS
  the pair key avoids.
- **Key-table pressure.** Each map holds at most 10,000 keys, least recently
  used out first. An attacker cycling random emails evicts older pairs and
  weakens the pair layer for those accounts. The client and global layers are
  unaffected.
- **Password-setting paths accept longer passwords than sign-in does.** The
  wizard and the admin user forms enforce a minimum only, so a password over
  1024 characters set there could not sign in.

Tests: `middleware/test/auth/loginRateLimiter.test.ts` (every layer with a fake
clock, the pinned client semantics, counting at admission, a global budget that
refusals leave alone, the report flag, memory bounds, sweep, `clearAccount`),
`middleware/test/auth/loginRateLimiterFairness.test.ts` (a sender on the shared
key never refuses another account's attempt while it keeps going, and the
global capacity is what bounds it; device keys skip the client layer, and
all device ids of one account share one pair and take at most its free
budget of the reserve; many client keys fill the capacity for unknown
browsers while a device-keyed attempt still gets in; the reserved in-flight
slot),
`middleware/test/auth/loginAccount.test.ts` (the account key per character
Postgres folds differently, and against every simulated `LOWER()` over a
corpus of spellings; the device key),
`middleware/test/auth/loginAccountAliases.test.ts` (through the router, over a
table that matches like Postgres: one budget for every spelling of an
address, 2^k spellings included; a sign-in to one account under another
spelling mints no known browser of a second account),
`middleware/test/auth/loginAccountFold.pg.test.ts` (the same against real
Postgres, the real `UserStore` and router, and a reset that lands while a
sign-in is being verified),
`middleware/test/auth/loginDevices.test.ts` (the v3 cookie, the epoch it is
bound to, minting for the verified account under the epoch it checked
without a lookup and checking by device key, a fresh id per sign-in, the
cached single-flight lookup and `forget`, a failing lookup),
`middleware/test/auth/loginDeviceRevocation.test.ts` (through the routers: a
session alone mints no cookie; more device ids buy no more guesses or
capacity; after a reset, a disable or a delete through the admin routes,
earlier cookies are the address key again; a sign-in that checked the old
password while a reset landed gets no cookie that counts),
`middleware/test/auth/clientAddress.test.ts` (policies, the forged left-most
entry, fallbacks and the `shared` flag, Fly's right-most app address, IPv6
prefixes), `middleware/test/auth/loginRoute.test.ts` (429 and 503 with
Retry-After and no cookie, no `verify` while blocked, the always-on default,
address policies through the router, the device cookie on a shared key
including forged, expired, foreign, stale and old-format cookies, one audit
row per episode, the wizard's capacity slot and its device cookie),
`middleware/test/auth/loginLockoutDos.test.ts`
(through the router: one sender cannot stop other users on the shared key; a
device-cookie holder gets in while the capacity for unknown browsers is
exhausted from the shared key or from many IPv6 /64s;
`AUTH_LOGIN_IPV6_PREFIX=48`),
`middleware/test/auth/adminUsersRoute.test.ts` (reset and re-enable unlock
under the account key; create, reset, status change and delete drop the
cached device epoch under the device key),
`middleware/test/auth/localPasswordProvider.test.ts` (the length cap; no
sign-in to an account whose address folds to another key; a success reports
the epoch of the hash it compared, even when a reset lands meanwhile),
`web-ui/app/login/__tests__/page.test.tsx`.

---

## 11. Reviewer checklist

Before merging a PR that touches credentials, prompts, or proxy routes:

- [ ] No new strings matching common token shapes
      (`AKIA…`, `ATATT…`, `sk-…`, `pk_…`, JWT-like).
- [ ] No new hostnames pointing at a specific tenant's infrastructure.
- [ ] Any new `setup.fields` of type `secret` are read through the vault
      adapter, not from `process.env` directly.
- [ ] Any new proxy route validates the response shape before returning it
      to the agent (defends against prompt injection from upstream).
- [ ] Any new sub-agent tool is scope-locked at construction time.
- [ ] A change to either CLI spawn argv keeps the deny gate (`--tools ""`,
      `--disallowedTools`, `--permission-mode dontAsk`, `--setting-sources ""`,
      `--restricted` where the CLI version allows it plus the
      `CLAUDE_CODE_RESTRICTED=1` env twin, `--strict-mcp-config`,
      `--system-prompt`), the empty `cwd`, the env allowlist, and their tests
      (§3a). Both sites build argv from `cliSpawnGate.ts` — a new spawn site
      must use it too, not copy the flags — and pass the resolved CLI version
      into it (OM-85): a new flag that an older CLI may not know needs the same
      version gate, never an unconditional argv entry.
- [ ] A new CLI spawn site resolves its binary through the kernel's
      `resolveCliBin()` rule and probes the version of THAT path, never a bare
      `'claude'` constant (#1085, §3a) — kernel-side via `resolveClaudeCliBin()`,
      inside `@omadia/orchestrator` via an injected resolver. A new
      `createCliSubAgent` call site must pass `resolveCliBinary`; a test in
      `test/cliBinaryResolverGrant.test.ts` fails if it does not. A bare name resolves through PATH, which
      on the shipped image is a different binary from the one the version badge,
      the login flow and the "Install now" button describe — and the mismatch
      surfaces as a silently missing `--restricted`, not as an error.
- [ ] A new CLI version has been run against the deny-list drift guard
      (`cliSpawnGate.test.ts`) **on a machine where that version is installed**,
      and ideally the live probe (`OMADIA_CLI_LIVE_PROBE=1`), before the
      version is rolled out (§3a). The guard skips when no binary is present,
      so ticking this on a machine without the new CLI proves nothing — check
      the test reported the version you are rolling out.
- [ ] No new entry in `auth/publicPaths.ts` unless the route authenticates
      itself, and then only the narrowest regex covering that one route (§10).
- [ ] No new `isPublicPath` exemption in `web-ui/proxy.ts` unless the route
      serves only non-confidential data or authenticates itself; exact match,
      not a prefix, with a case in `web-ui/app/__tests__/proxy.test.ts`. The
      pairing descriptor never gains a secret or session field, and a
      provider list it could not read is a `503`, never `auth.mode: 'none'`
      (§10g).
- [ ] No operator surface is mounted inside a `DEV_ENDPOINTS_ENABLED` block —
      operator routers belong under `/api/v1/admin/*` (§10).
- [ ] A WebSocket route with its own authenticator is registered through
      `WebSocketRegistry.registerKernel` from kernel code only, never exposed on
      `CoreApi`. Plugins always get session-cookie and whitelist auth via
      `CoreApi.registerWebSocket`. The authenticator rejects before the `101`
      (raw 401/403; a throw or missed deadline is a fail-closed 503), and the
      route sets an explicit, bounded `maxPayload` (§10d).
- [ ] A new WebSocket consumer relies on the registry for its session
      lifetime and does not re-implement it: a channel handler caches no
      authorisation beyond its socket, never receives or reconstructs the
      session token, and stops its work in `onClose` (the kernel closes with
      4401 at `exp`, 4403 on revocation and 1013 before the handler runs when
      it cannot trust the upgrade's verdict). A frame that reaches
      `onRefusedMessage` is answered or stops work already running, and never
      starts, reads or changes anything. A new `registerKernel` caller states
      how its own credential's expiry and revocation close its sockets,
      because the registry closes none of them (§10d).
- [ ] A new path that mints or re-mints the session cookie carries
      `auth_time` over (never resets it) and respects the absolute cap; a new
      OIDC provider implements `revalidateSession` or its sessions cannot be
      renewed (§10b).
- [ ] A new path that mints the session cookie stamps `sv` and `uid` from the
      `users` row it verified (a re-mint carries `sv` and `sid` over and takes
      `uid` from the row it re-verified), and a new session consumer decides
      through `evaluateSessionToken` with the `sessions` guard, never
      `verifySession` alone (§10k).
- [ ] A change to a `users` row's credential or status passes
      `revokeSessions: true` in the same `update()` call and announces it via
      `SessionRevocation.announce` (§10k).
- [ ] A new native tool bound to shared/unscoped state (like memory) is routed
      through the caller's scoped accessor in `ctx.tools.invoke`, or denied
      there (§4, #909).
- [ ] An admin route takes the caller identity from
      `req.session.omadia_user_id`, never from the body or the query string,
      and rejects a client-supplied identity field instead of ignoring it
      (§10c, #778).
- [ ] A page or route that navigates to a caller-supplied `return`/`next`
      value passes it through `sanitiseReturnPath` first — in the web UI the
      helper in `web-ui/app/_lib/returnPath.ts`, server-side the one in
      `middleware/src/routes/auth.ts` (exactly one leading `/`, no C0/DEL)
      before the value is appended to `publicBaseUrl`. Appending an unchecked
      value to the bare origin can change the host (§10e). Server-supplied
      absolute targets such as IdP logout URLs are a separate boundary and not
      covered by this.
- [ ] The repository variable `AUDIT_ALLOW_REGISTRY_OUTAGE` is unset. It lets
      the required `audit (high+critical block)` check pass **without** an
      audit result while the npm registry is down; it is an admin-only bypass
      for a confirmed upstream outage and must be removed as soon as the
      registry answers again. A PR merged while it was set has no dependency
      audit and needs one re-run afterwards.
- [ ] A compose change keeps `/var/run/docker.sock` on `docker-socket-proxy`
      only, attaches nothing but `updater` to `omadia-control`, and leaves
      that network `internal` with `inhibit_ipv4` set. A proxy image bump
      re-audits the full flag list. `composeUpdateOverlay.test.ts` stays
      green (§10f).
- [ ] An updater change that reads an answer the middleware writes does not
      follow redirects from it, as the health probe does not
      (`health.test.mjs`, §10f).
- [ ] A new `docker run` (or `docker update`) for agent code takes its limit
      flags from `dockerResourceLimitArgs()` in `@omadia/sandbox`, never its
      own copy, and offers no way to switch a limit off. A new limit field
      gets a range in `SANDBOX_RESOURCE_LIMIT_BOUNDS` that excludes every
      value Docker would apply as no limit, checked on a real daemon (§3b).
- [ ] A new surface that has to be framed lives under `/p/*` or `/bot-api/*`
      and sets its own `frame-ancestors`. The exemption in
      `web-ui/app/_lib/securityHeaders.ts` is not widened, and the operator-UI
      headers are not moved into `next.config.ts` `headers()` (§10h).
- [ ] A change to `desktop/src/secrets.ts` or its `secretsBlob.ts` /
      `secretsStore.ts` core keeps the ENOENT-only creation rule and the
      backup + temp file + rename write (§8a): a read, decrypt, parse or shape
      failure throws `SecretsUnreadableError` and never regenerates keys, a
      key is cached only after its write succeeded, and neither the error's
      reason nor its `cause` quotes the file's content.
- [ ] A change to the desktop's embedded Postgres (`desktop/src/embeddedDb.ts`,
      `embeddedDbAuth.ts`, `embeddedDbOwnership.ts`) never writes a `trust` rule
      or rewrites pg_hba.conf while the server runs (password repairs go through
      single-user mode), keeps the kernel's `DATABASE_URL` on the non-superuser
      `omadia_kernel`, keeps the bootstrap password inside the shell, pins the
      shell's `search_path` (system catalogs first) on every maintenance
      connection and schema-qualifies the ownership transfer, and keeps the
      fail-closed verification (wrong password refused for both roles, the
      kernel role unprivileged and a member of no role) with its tests. The
      shell's connections stay SCRAM-only (`scramOnlyConnect.ts`), readiness
      sends no credentials and never counts an authentication error as "up",
      the superuser login checks `data_directory` before a kernel password goes
      out, and on macOS and Linux the server stays off TCP, its socket in an
      owner-only directory outside the data folder (§8b).
- [ ] A new desktop IPC channel is registered through `guardedHandle` /
      `guardedOn` with an explicit surface, never bare `ipcMain`. The `app`
      surface (the web UI and every plugin iframe in it) gets no method that
      returns or writes a secret. A new bundled page is classified in
      `bridgeSurface.ts` and checked by path in `ipcSender.ts` instead of
      widening the wizard surface. A new window or session stays covered by
      the `web-contents-created` guards, including the session's
      `openExternal` refusal (§10i).
- [ ] A new desktop wizard control changes what the supervisor hands the
      kernel (`capabilityKernelEnv`), the kernel reports on `/health` whether
      it took, and a test pins the wiring. Never a stored-but-unread
      preference (§10j).
- [ ] A store that maps caller-supplied keys onto the filesystem derives the
      path from a digest of the key, never from the key's text (§10j).
- [ ] A path that creates an install's first principal goes through
      `UserStore.createFirstAdmin` (one transaction, table lock, count under
      the lock), never count-then-INSERT. A route that decides whether setup
      is open uses `resolveSetupState`, the predicate `/providers` reports.
      Anything that skips the setup token keys on boot configuration (the
      desktop flag plus a loopback bind), never on a request header or
      `PUBLIC_BASE_URL` (§10l).
- [ ] A kernel service a channel can call takes its principal as an explicit
      argument and refuses when it is missing or blank. It never falls back
      to `{ kind: 'operator' }`, nor to a turn context the call did not run
      in. Cross-tenant routine scope has one producer, the
      `requireAuth`-gated operator router, and `routineOperatorScope.test.ts`
      fails on a second (§3, #1025/#1029).
- [ ] Any public route that checks a password or another guessable secret
      runs through the sign-in limiter (`loginRateLimiter`, §10m), and any
      argon2 work reachable without a session takes a global slot
      (`acquireSlot()`). A client key comes from `clientAddressFor`, never
      from `req.ip`, and a key it marks `shared` (the TCP peer) is never
      braked as if it were one client. A per-account limit keys the
      account at least as coarsely as the users table matches it
      (`loginAccountKey`), never by a JavaScript lower-case of the typed
      value. Anything that earns a browser its own sign-in budget, like the
      device cookie, is bound to the account the sign-in verified (its
      stored address, never the typed one) and to the credentials that
      sign-in checked (never ones read after the check), is issued only by
      a sign-in that proved the password, at most once per sign-in, and
      shares one budget per account however many of it a client holds.

---

*Last reviewed: 2026-10 (§10e added: same-origin return paths; §10f added: self-update control plane, #432; §10g added: the operator front's login gate and its public allowlist; §3b and §10h added: sandbox container limits, operator UI headers and the web-ui image user; §8a added: desktop secret custody; §8b added: embedded Postgres authentication, hardened so a kernel-owned database cannot redirect the shell's superuser sessions; §10i added: desktop renderer trust boundary; §10j added: desktop wizard switches; §10k added: server-side session revocation; §10l added: first-user setup; §10m added: password sign-in rate limiting, its device cookies and its account key).*
