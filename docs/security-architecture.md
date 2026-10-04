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

The answer verifier is never installed on this path: `buildOrchestratorForAgent`
returns the `CliChatAgent` bundle before the `VerifierService` wrap, so a
subscription-CLI chat turn has no verifier egress at all. The reverse case is
covered by §6e — the verifier plugin's OWN model may be the `claude-cli`
completion provider (Shape 2), and its requests are masked before
`llm.complete` like on any other provider.

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
- **Web routine delivery writes into an unowned chat (#1071, accepted gap).**
  A routine created from the browser chat delivers its runs into the chat
  named by the creating turn: `conversationRef.sessionId` is the `sessionId`
  of that authenticated `/api/chat` request, taken from the request body and
  checked only for syntax (`validateConversationRef`), not for existence or
  ownership. Chat sessions have no per-user owner anywhere in the codebase —
  `GET /api/chat/sessions` lists every session to every authenticated user,
  and `PUT`/`DELETE` and chat turns accept any id — so this is not a new
  class of access. What #1071 adds is its *shape*: user A, knowing user B's
  chat id, can create a routine that writes into B's chat on a schedule,
  under the server-trusted "Scheduled routine" badge (the `proactive` marker
  is kept only from the server copy, so B cannot tell it from a routine of
  B's own), and B can neither see, pause nor delete that routine, because
  routine management is owner-scoped (#1025, above). The principal side is
  unchanged: identity comes from the session only, `canTargetOthers` stays
  `false`, the #1016 turn-owner guard applies, and the target never comes
  from model or tool input. Accepted for #1071 because closing it needs an
  owner model for chat sessions, which is a separate change. Follow-up
  (handoff §13, "Web-Routine-Zustellung"): stamp an owner on each chat
  session and check it in `GET`/`PUT`/`DELETE` and in
  `validateConversationRef`; have `validateConversationRef` check that the
  chat exists. (A routine whose chat was deleted is paused on its next fire,
  before the agent turn runs — `ProactiveTargetGoneError`.)
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

Apart from the bundled plugins that ship inside the image, a plugin is installed
as a ZIP package: uploaded through the operator UI, produced by the Builder, or
downloaded from a registry configured in `REGISTRY_URLS`. Nothing is discovered
from a public package manager. Integrity rests on SHA-256 pinning, and there is
**no publisher signature and no trust root**:

- **Registry downloads.** `RegistryClient.fetchPackage`
  (`src/plugins/registryClient.ts`) checks the downloaded bytes against the
  SHA-256 the registry's index lists (`registry.sha256_mismatch`), fetches only
  from the registry's own host and port (`registry.host_mismatch`) and follows
  no redirect. The index comes from the same registry, so the hash proves the
  bytes are the ones that registry publishes, nothing about who built them.
  Downloads are pinned to the registry's host and port, not its scheme
  (`assertHostPinned` compares `URL.host`). The client accepts an `http://`
  registry, whose index and hashes then travel in clear, and an `https://`
  registry's index can list an `http://` download URL on the same host, which
  is then fetched in clear with the registry's bearer token attached when one
  is configured. Configure `https://` and make sure the index lists `https://`
  download URLs. Pinning the whole origin is open
  (`middleware-agent-handoff.md` §13).
- **Uploads and Builder installs.** `PackageUploadService`
  (`src/plugins/packageUploadService.ts`) hashes the ZIP at ingest. The hash names the package and keys the scan
  verdict below; nothing compares it with a published value, and the service
  lists a remote signature check as out of scope.
- **No signature anywhere.** The catalog reports `signed: false` and
  `signed_by: null` for every plugin (`manifestLoader.ts`, `routes/store.ts`),
  whatever the manifest says, and the store page shows "unsigned". What the
  operator trusts is the registry and the ZIP they chose. Publisher-signed
  packages are a roadmap item (`middleware-agent-handoff.md` §13).

This keeps the supply chain explicit:

- The operator chooses which artefacts run.
- A plugin manifest declares its `permissions` (memory, graph, network,
  filesystem). The runtime gates its `PluginContext` accessors (`ctx.http`,
  `ctx.memory`, the scratch directory, …) on that declaration
  (`src/platform/pluginContext.ts`). A plugin runs as trusted JavaScript in the
  middleware process, so the declaration does not sandbox the global `fetch`,
  `node:fs` or any other Node API.
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
- Installed plugin code never comes from npm at runtime. A package may bundle
  its own `node_modules`. Whatever it does not bundle, its peer dependencies and
  `@omadia/plugin-api` included, resolves from the image's `node_modules`
  through a link at the packages root (`ensureHostNodeModulesLink`,
  `src/plugins/uploadedPackageStore.ts`), so the ZIP's hash covers only what
  the ZIP contains. A Builder ZIP bundles no `node_modules` at all (the
  boilerplate's `scripts/build-zip.mjs`). omadia itself runs npm, or code that
  npm installed, in these places, none of which installs a plugin:
  - The Builder's build template (`ensureBuildTemplate`,
    `src/plugins/builder/buildTemplate.ts`) installs the boilerplate's
    dependencies plus `BUILD_TIME_ONLY_DEPS` by semver range, without a
    lockfile, under the data directory on first boot and whenever that list
    changes. A Builder preview loads the draft plugin in-process against that
    template's `node_modules` (`src/plugins/builder/previewRuntime.ts`), so
    those packages run inside the middleware during a preview, and every
    Builder build runs `npx tsc` from the template (`scripts/build-zip.mjs`).
  - The operator-triggered vendor-CLI install
    (`src/platform/cliInstallService.ts`) installs a package whose name comes
    from a fixed allowlist.
  - An MCP server whose start command uses `npx`. The MCP catalog
    (`src/services/mcpRegistryClient.ts`) writes `npx -y -- <package>` for a
    server published on npm when the operator imports it, and the stdio
    transport runs that command whenever omadia connects to the server, so npm
    resolves the package at that moment.
- Write confirmation is a connector feature. The preview, confirm and draft flow
  of ADR-0005 runs in the write-capable connector plugins that implement it; the
  core inserts no confirmation step before a tool runs. The core's write
  contract, `writeCapabilities` (`@omadia/plugin-api`), adds none either, and a
  write tool without the annotation counts as read-only. On the public MCP
  endpoint, a caller-supplied idempotency key gives a declared write tool
  process-local deduplication while its record is cached (15 minutes,
  `DEFAULT_IDEMPOTENCY_TTL_MS`; eviction target 1,000 records,
  `DEFAULT_IDEMPOTENCY_MAX_ENTRIES`, and a call still running inside its window
  is never evicted, so the store can briefly hold more; a failed call is not
  cached), and the MCP client makes a single attempt for that call
  (`toolIdempotency.ts`, `ToolDispatchService`). A restart, a second instance
  or an expired or evicted record executes the write again, so the key is a
  retry-safety mitigation and does not make a write run at most once
  (`src/mcp/README.md`, Idempotency). Without a key, the MCP client may retry
  the call once after a transport failure. On the chat path a verifier
  re-entry replays every external call the first run recorded and executes
  none of them again (a sub-agent whose data the shield interned runs again,
  with its own calls replayed, §7c); a turn without that replay ledger keeps
  the same single retry, so an MCP write whose reply was lost can run twice.
  Conductor human steps treat an absent or malformed response as approval
  unless the step sets `human.strictApproval` (§7a).

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

## 4a. Third-party npm dependencies: audit gate, Dependabot scope, the desktop runtime

Plugins are operator-curated (§4); the npm dependencies of the kernel, the
web-ui and the desktop shell are not, so they rest on automated controls and on
one rule about what counts as a runtime.

- **Audit gate.** The `audit (high+critical block)` job in
  `.github/workflows/ci.yml` runs `npm audit --audit-level=high` in every
  directory that has its own `package.json` and `package-lock.json`:
  `desktop`, `middleware` and `web-ui`. Before it audits, every leg runs
  `.github/scripts/audit-scope.test.mjs`, which fails when a lockfile directory
  git tracks is missing from the matrix, or a leg names a directory without
  one. The root `package-lock.json` is an empty stub with no
  `package.json` beside it and is not a leg. Each leg reports its own
  `audit (high+critical block) (<dir>)` status context, and each has to be a
  required check on `main`: a context that is not required reports findings
  but blocks nothing. An admin adds a new leg's context to `main`'s required
  checks only after the PR that adds the leg is on `main`: a required context
  that never reports blocks every open PR, and a PR's checks run on its merge
  with `main`, which has no such leg before then.
- **A registry error is not a result.** The audit step gives the npm registry
  three attempts and then fails the leg. Only the repository variable
  `AUDIT_ALLOW_REGISTRY_OUTAGE`, set by an admin for a confirmed upstream
  outage, downgrades that to a warning (§11). It is a GitHub Actions variable,
  not an application setting, so it does not belong in
  `middleware/.env.example`. Every run archives its report as the
  `npm-audit-<dir>` workflow artifact.
- **Dependabot** has an npm block for every audited directory (`/desktop`,
  `/middleware`, `/web-ui`); a new package directory gets one together with its
  audit leg. GitHub's repository-level alerting is not counted on as a
  backstop: the audit gate and the weekly version updates are the controls,
  which is why every audit leg has to be a required check.
- **`electron` is a runtime, not a build tool.** It sits in the desktop's
  `devDependencies` because electron-builder packages the installed binary, but
  the app runs on it and the supervisor starts the kernel and the web-ui under
  its Node (`ELECTRON_RUN_AS_NODE`, `desktop/src/supervisor.ts`). Its
  advisories count like production ones, its majors are never ignored in
  Dependabot (Electron only patches its three newest majors), and the desktop's
  `@types/node` follows Electron's embedded Node (Node 24 for Electron 44), not
  the Node 22 of the server image. The release build's "Verify native modules
  load under the Electron ABI" step is the check that the middleware's native
  modules still load under that Node.
- **Two Node majors run the same kernel.** The server images, development and
  CI run the kernel and the web-ui on Node 22; the desktop app runs the same
  builds on Electron's embedded Node, Node 24 since Electron 44, because no
  Electron line that still gets security fixes embeds Node 22. `engines` in
  `middleware/package.json` (an install gate through `engine-strict` in
  `middleware/.npmrc`) and `middleware/scripts/check-node-version.mjs` pin the
  toolchain that installs, builds and tests the kernel to Node 22, the desktop
  release build included. The desktop runtime passes through neither, so
  `engines` does not list Node 24. Plain Node 24 does not stand in for it
  either: Electron's Node is built against BoringSSL, and its `node:crypto`
  offers a fraction of Node's ciphers, hashes and curves. On Electron's Node
  the kernel is checked only by that native-module step and by starting a
  built app; no CI job runs its test suite there yet
  (`docs/middleware-agent-handoff.md` §13).
- **Windows update signatures.** electron-builder writes a `publisherName` into
  the Windows app's `app-update.yml`; the release build reads it from the
  certificate that signs the installer (Azure Trusted Signing), and
  electron-updater refuses a downloaded update that is not Authenticode-signed
  under that name. Apps installed from builds before electron-builder 26 carry
  no `publisherName` and take their next update unchecked; every update after
  that is checked.
- **macOS update floor.** electron-builder writes no macOS minimum into
  `latest-mac.yml`, so `desktop/scripts/merge-mac-update-feed.mjs` adds
  `minimumSystemVersion` to the merged feed. It is the Darwin kernel version
  (`22.0.0` for macOS 13, Electron 44's minimum), because electron-updater
  compares it with `os.release()`; a product version such as `13.0` fails its
  semver parse and lets every Mac update. Macs below the floor are not offered
  the update and keep the version they run. `desktop/buildResources/afterPack.js`
  fails every mac build whose packaged `LSMinimumSystemVersion` does not match
  the floor, so an Electron major that raises the minimum cannot reach Macs it
  does not start on.
- **A held-back Mac is told, not reported current.** electron-updater answers
  a feed above the OS floor with the same `update-not-available` event, and
  the same feed version, as a current install. `desktop/src/updateHoldBack.ts`
  tells the two apart: the user learns which macOS the release needs and that
  updates, security fixes included, stop until the OS is updated — once per
  floor at startup, and on every "Check for Updates…". Those Macs stay on an
  Electron 37 build, a runtime without further Electron security fixes; an
  OS update is the only remedy. Only builds that carry the handler can say
  this, so a raised floor ships its message first, in a release the held-back
  OS can still install (for macOS 13: v0.167.9 through v0.167.14, the last
  release built on Electron 37).

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

## 5a. Office exports: formula cells carry no caller-supplied value

`create_xlsx` (`@omadia/plugin-office`) writes descriptor formulas into the
workbook verbatim, and omadia evaluates none of them: exceljs only serialises,
and no formula engine is installed. The rule that follows is that whatever a
formula cell displays must come from the application that computes it, never
from the descriptor.

- **No cached value.** `FormulaCellSchema` has no `result` field, and Zod
  strips one a caller sends anyway. `renderXlsx` is exported, so it does not
  rely on the schema. exceljs decides what a cell is from the shape of the
  value: any object with a truthy `formula` or `sharedFormula` is a formula,
  with its `result` as the cached value, and `{ text, hyperlink }` is an
  external link. The renderer therefore takes only text, numbers, booleans,
  `null` and `{ formula }` rebuilt from a non-empty formula string as a cell
  value (`cellValueOf`, which reads only a row's own keys; a date column turns
  its text into a date), and writes `{ formula }` again when it sets the cell.
  Any other cell value, a column header that is not text (exceljs writes
  headers like cell values) and a computed-column formula that is not text
  fail with `OfficeRenderError` before exceljs sees them. A direct caller that
  gets past the type therefore gets an error, never a `<v>` next to an `<f>`,
  a link, or a formula the policy below has not read.
- **Recalculation on open.** A workbook with at least one formula sets
  `calcPr fullCalcOnLoad="1"`. Clients that do not calculate (previews, Excel's
  Protected View, `data_only` readers) show the cell empty, which is the
  intended failure mode.
- **Formulas stay inside the workbook.** The client recalculates on open, and
  Excel, LibreOffice and Google Sheets each have functions that reach outside
  the file. `formulaPolicy.ts` checks every formula in two layers, so that a
  way out nobody has listed still fails closed:
  - *Allowlist.* A formula may only call Excel's own worksheet functions by
    their English names (`formulaFunctions.ts`, Microsoft's alphabetical
    catalogue as of 2026-09-30), less the refused ones below. Everything else
    is refused: `_xll.`/`_xludf.` add-in and user-defined functions in any
    position, Excel 4 macro functions such as `EVALUATE`, other applications'
    functions, localised names, calls through LET or LAMBDA names, and every
    function Excel adds later until it has been reviewed (`IMPORTTEXT` and
    `IMPORTCSV`, which read local files and URLs, were such additions). A
    function passed as a value (`_xleta.NAME`) is checked like a call. A bare
    name that is not called is checked against the refused names only. What
    it could still reach is a function the user's own Excel has loaded (a
    VBA macro or add-in passed by a guessed name), and an export cannot
    supply one.
  - *Refused by name, called or not:* `WEBSERVICE`, `FILTERXML`, `IMAGE`,
    Google Sheets' `IMPORTDATA`, `IMPORTXML`, `IMPORTHTML`, `IMPORTFEED` and
    `IMPORTRANGE`, `IMPORTTEXT` and `IMPORTCSV`, the vendor services
    `STOCKHISTORY`, `TRANSLATE`, `DETECTLANGUAGE`, `GOOGLEFINANCE` and
    `GOOGLETRANSLATE`, the `CUBE…` functions, `HYPERLINK`, `RTD`, `CALL`,
    `REGISTER`, `REGISTER.ID` and LibreOffice's `DDE`. A DDE reference
    (`app|topic!item`) and a reference to another file (`[n]…`,
    `[book.xlsx]…`, a `\` outside quotes, or a quoted name containing
    `\ / [ ]`) are refused as well. `INDIRECT` and `__xludf.DUMMYFUNCTION` are
    refused whatever their argument, because they turn text into a reference
    or a formula, and that text can be assembled from cell values where no
    lexical check sees it.

  A computed column is checked once as a template. Its `{row}` placeholder may
  only follow a column letter or stand alone, so a row number cannot complete a
  function name. `renderXlsx` throws `OfficeUnsafeFormulaError` before any byte
  is written, so nothing is stored or delivered. The check is lexical: string
  literals are skipped and an unterminated quote fails closed.

  A lexical check only holds if it reads the text the application reads, so
  it starts there (`formulaText.ts`). A formula is refused if it contains a
  character the file would not carry as written (exceljs's XML encoder drops
  most control characters, XML turns a carriage return into a line feed and
  cannot hold an unpaired surrogate, U+FFFE or U+FFFF) or `_x` followed by a
  hexadecimal digit, the file format's `_xHHHH_` escape, which a reader
  decodes. The input schema refuses the same text before any dataset is
  resolved, and the renderer checks it again. Outside quotes, a formula may
  only use the grammar's own characters (letters, digits, the plain space and
  the operators, on one line), and names are read by Excel's grammar
  ([MS-XLSX] 2.2.2), so the check splits names exactly where the application
  does. The `{row}` check reads only the characters just before each
  placeholder, so checking a template takes time linear in its length.
- **Dataset rows cannot become formulas.** Rows behind a `datasetId` go through
  `normalizeCell` (`officeTool.ts`), which passes primitives and JSON-stringifies
  every object and array, so a system of record cannot inject a formula or a
  cached value. The dataset guarantees elsewhere in this document (the
  `query_dataset` table in §6b) and in the orchestrator prompt are unchanged:
  `create_xlsx` still resolves those rows server-side, and they never pass
  through the model.
- **No server-side engine, by decision.** HyperFormula is GPL/commercial and
  excluded. Evaluation with an MIT engine is a roadmap item
  (`middleware-agent-handoff.md` §13). Any engine would have to match Excel's
  semantics exactly, because a wrong `<v>` under omadia's name is the defect
  this section closes.

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
| `read_attachment` on the uploaded file (intern-exempt: its result reaches the model as returned) | nothing — refused with an `Error:` that points to `query_dataset` (§6f) |
| any reader without the key | `[verschlüsselt — Schlüssel nicht verfügbar]`, never garbage, never a throw |

The chat-attachment ingest applies the same rule (`detectTabularFormat`): a
table becomes a dataset or is refused (`[attachment-not-ingested]`), and is
never inlined into the prompt as `[attachment-content]` text, with prompt
masking on or off.

Two things this rests on: (1) `query_dataset` is **not** intern-exempt
(`privacyInternPolicy.ts`) — the day it becomes exempt, the "behind the shield"
branch above is a leak; the test `datasetCellCrypto.test.ts` pins the reveal
condition to the presence of the turn's privacy handle, which is the same
signal the orchestrator uses to intern — and when that interning THROWS, the
orchestrator withholds this tool's rows, as it withholds every tool's result
it could not intern (`dispatchTool`, `internFailedNotice`; `query_dataset`
keeps its own notice): the rows carry cleartext precisely because interning
was expected.
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

### 6c. Tool errors: thrown text withheld, returned text redacted (#1105, #1097)

A tool result that is control flow — the `Error:` tool-error convention, or the
MCP connect prompt the kernel produced — is not interned, so the model can read
the hint and self-correct. Not interned is not unchecked: a tool error is not
sanitized text. An ORM echoes the row it failed on, a driver the bound
parameters, a remote MCP server whatever its error body quotes. Every seam that
hands a tool result to a model therefore routes a tool error through one helper,
`toolErrorRedaction.ts` (`@omadia/orchestrator`), and the policy follows where
the text came from, not its shape:

| Carrier | What the model reads | Receipt entry (`toolErrors`) |
|---|---|---|
| A handler **threw** | The withheld notice: ``Error: tool `<name>` failed with <ErrorClass> (code <code>) [ref <ref>] …`` — class name and a sanitised code (`describeThrownError`, `@omadia/plugin-api`), never the message; it also says the outcome is unknown and not to repeat a call that changes data | `thrown` / `withheld` |
| A handler **returned** an `Error:` string | The text after the prefix, run through the provider's `redactToolErrorText`: the C0 identity types (e-mail, IBAN, phone, address, id number — not `date` or `amount`, which are hints), the operator deny-list (#760) and C1, each span replaced irreversibly by `[masked:<type>]`. **Withheld** whole instead when the text is exception-shaped (a record echo as JSON, as a Python dict, or as a JavaScript object or `Map` the way `util.inspect`, `console.log` and `%o` print it; a record printed with keyword fields — a Python dataclass, a Kotlin data class or Lombok `toString`, a Java record or `Map` — or with positional values, one of them quoted (`Record(42, 'Jane Doe', …)`), or with Go's bare `Key:value` fields; a personal field such as `name=`, `email=` or `phone=` printed as a bare `key=value` pair outside a record; a stack trace; a Postgres `DETAIL:` line, a `Failing row contains (…)` or a `Key (…)=(…)` detail), longer than 4096 characters, or the provider cannot check it | `returned` / `redacted` (with span types) or `withheld` |
| The MCP **connect prompt** (`🔒 The MCP server "…`) that `McpManager.handleFailure` produced **in the same dispatch** | Byte-identical: its connect URL and `<mcp-auth-required>` block must survive. Recognised by per-dispatch provenance, never by its prefix: any other text that starts like the prompt is tool data and is interned | `mcp_auth_prompt` / `passed` |

The seams, each applying the helper after the operator bypass and before
interning, and for an intern-exempt tool before the exemption (the exemption
covers the tool's result, not its error):

- `Orchestrator.dispatchTool` — the one choke point for both chat loops, the
  streaming slots and the Direct-Line relay. It never rejects: a thrown error
  resolves as the notice, also with the dispatch deadline disabled. The loops'
  own rejection handlers are backstops that build the same notice.
- `Orchestrator.dispatchToolDeadlined` and `Orchestrator.guardReplayResult`
  (the returned carrier on the chat path and on MCP input replay).
- `ToolDispatchService` (loopback and public dispatcher): `thrownResult` for a
  throw — the same withheld notice, no longer an interned dataset — and
  `afterDispatch` for a returned error. The handler itself runs with the
  dispatch's privacy handle as the ambient `turnContext.privacyHandle`
  (`runHandlerInPrivacyScope`, `handlerPrivacyScope.ts`), so the sub-agent
  seam below applies beneath this dispatcher too.
- `LocalSubAgent.dispatch`: both carriers, under whichever handle its domain
  tool was dispatched with. An inner tool throw becomes an `is_error` tool
  result the sub-agent can answer around, instead of aborting the sub-agent.
  The call may have taken effect before it threw (a write commits, then its
  response times out), so the notice says the outcome is unknown, and the
  sub-agent refuses an identical repeat (same tool, same canonical input) for
  the rest of the run, with or without a privacy provider
  (`subAgentUnknownOutcome.ts`). That covers a tool whose wrapper caught the
  exception and returned the withheld notice, too (the tool bridges,
  `toolErrorFromException`): `isWithheldToolErrorNotice` recognises it by
  shape, so a tool that imitates the shape only blocks its own repeat. A
  different input still runs, and so does a retry after an ordinary returned
  `Error:` hint. Since the replay ledger (§7c) the same refusal holds for the
  whole request in the orchestrator's buffered and streaming tool loops and
  in a subscription-CLI sub-agent's loopback dispatch (the request's
  `turnContext.toolReplayLedger`, any seam), except for a kernel tool known to
  be read-only; it answers with the same notice.

**Per entry point.** What reaches a model provider depends on where the call
came in:

| Entry point | Handle a sub-agent's model loop runs under | Tool errors on any model wire |
|---|---|---|
| Chat turn (`Orchestrator`, privacy provider installed) | The turn's handle, inherited through `turnContext` | Withheld or redacted at every seam, receipted |
| Public MCP endpoint (`/api/v1/mcp`) | The call's fail-closed gate, as its nested handle `forNestedCalls()` | Withheld for the sub-agent's model (the gate redacts nothing); the API caller gets a masked result, a dispatcher notice for a throw, or a refusal for a returned `Error:` text |
| Loopback MCP for the subscription CLI | None (§3a, #1087) | Raw — see Residuals |
| Any path without a privacy provider | None | Raw (parity) |

On the public endpoint the gate's nested handle interns a sub-agent's inner
tool results through the same fail-closed masking and keeps the operator
bypass off. Its masking never satisfies the endpoint's `masked()` check — that
signal stays about the call's own result — but a failure inside the sub-agent
discards the call (`maskingFailed()`). No tool runs there without a handle: a
call with no provider installed is refused while masking is required, the
endpoint refuses a dispatcher that cannot receive the gate (no `withPrivacy`)
before dispatch, and the wired dispatcher runs no handler without one
(`requirePrivacyHandle`). `test/publicMcp/publicMcpSubAgentPrivacy.test.ts`
drives a real `LocalSubAgent` through the production wiring and asserts on
what its provider receives.

The kernel's own refusals from `dispatchToolInner` (tool unavailable, not
granted, unknown tool) name only the tool and its plugin; they are exempted by
per-dispatch provenance, never by their shape, so a provider that cannot
redact does not blind the model to its own plumbing.

**Connect-prompt provenance.** The connect prompt is exempted the same way.
Each seam opens an `McpAuthPromptMint` (`mcp/mcpAuthPromptMint.ts`) around one
dispatch: a chat-path tool call, an MCP input replay, a `ToolDispatchService`
call, a sub-agent's tool call. `McpManager.handleFailure` records the exact
prompt it returns into the open dispatch's mint and every mint around it (a
sub-agent's tool call is part of the parent's dispatch; sibling dispatches
never share one), and the seam asks `isGuardedControlFlowResult(result, mint)`:
the `Error:` prefix, or a result equal byte for byte to a prompt recorded in
that dispatch. A remote server can
put the prefix at the start of a text block (`renderToolResult` passes those
through verbatim); it cannot write the mint, and a result equal to a recorded
prompt carries nothing the prompt did not. Any other text that starts like the
prompt is tool data and is interned, and `guardControlFlowResult`, if handed
one anyway, applies the returned-error policy. The mint has its own
`AsyncLocalStorage` rather than a turn-context field: the standalone
dispatcher runs outside a turn, and the skill-binding and plugin `ctx.mcp`
paths re-scope the turn context with a rebuilt store.

**Producers.** The in-tree wrappers that returned `Error: ${err.message}` keep
only text they write themselves (typed quota/auth/config errors, a provider's
or renderer's HTTP status, kernel refusals, a schema miss on the model's own
input) and return the withheld notice for any other exception through
`toolErrorFromException` (`@omadia/plugin-api`): the three platform tool
bridges (`bridgedToolError`), web search, diagrams, discussion, transcription,
`manage_routine`, `query_dataset`, the long-running task handlers and
`createDomainTool`. The last one matters because `subAgentResultV4` hands a
sub-agent's final text to the parent unchanged once the sub-agent interned a
dataset. A typed error is not authored text just because the plugin defines
its class: the web-search providers and the Kroki client used to fold a
caught transport exception and an upstream response body (Kroki quotes the
diagram source back) into the message. Both now ride on `cause` and `body`,
and the two tools build their result from the provider id or diagram kind and
the HTTP status alone, never from the message, logging the error with its
cause and body under the result's ref. The seam is the backstop for every
producer that still returns exception text: external plugins, the office
plugin, remote MCP error bodies. It does not catch a name in running prose
without C1, which is why a wrapper must not forward foreign text in the first
place.

**Diagnostics.** The full error — message, stack, cause — is logged once, at
error level, under the notice's `ref`: the turn's correlation id on the chat
and sub-agent paths (#641 — the id a degraded turn shows as
`<turn-incomplete ref="…">`), the caller's request id on the dispatcher path
when it sent one, otherwise a fresh `err_…` token. The server log is the only
place the driver text can be recovered. Receipt entries are PII-free by
contract: tool name, carrier, outcome, byte count, masked span types.

**Provider pairing.** `redactToolErrorText` and `recordToolError` are optional
members of `PrivacyGuardService` (`@omadia/plugin-api` 1.20.0). The bundled
`@omadia/plugin-privacy-guard` implements both from 0.6.0 on, together with
the verifier's members (§6e). The plugin is not on the Hub, and a ZIP that
claims its id is refused (`package.id_conflict_bundled`) unless the operator
set `PLUGIN_ALLOW_BUNDLED_ID_OVERRIDE=1`. A provider without the redactor is
therefore an older copy someone put in place of the bundled one on purpose,
or another `privacy.redact@1` provider. It makes the kernel withhold every
returned `Error:` text (fail closed) and log `does not implement
redactToolErrorText` once per process. The public MCP gate
(`createFailClosedPrivacyGate`) answers `redactToolErrorText` with `withheld`,
so a returned error is refused as unmasked content by `assertMaskingCrossed`,
while a thrown error's notice is dispatcher-authored (`origin: 'dispatcher'`)
and served. Its nested handle gives a domain tool's sub-agent the same answer,
so that sub-agent's model reads the withheld notice, never a redacted hint,
and no per-turn detector state builds up for a request that is never
finalized.

**Residuals.**

- Parity: without a privacy provider nothing is masked, tool results included,
  so thrown and returned error text reaches the model raw — on the public MCP
  endpoint too, but only when an operator set
  `PUBLIC_MCP_ALLOW_WITHOUT_PRIVACY_MASKING`. The same holds for a returned
  error of a plugin, tool or MCP server the operator set to bypass; a thrown
  message is withheld even under bypass. The intern-exempt self tools
  (`privacyInternPolicy.ts`) get no such pass: their errors are redacted or
  withheld like any tool's.
- On the public MCP endpoint a sub-agent cannot correct itself from an inner
  error hint, since the gate withholds that text, and the endpoint has no
  sub-agent dataset bridge: the sub-agent's answer is interned again as data.
- A plugin tool that asks a model itself through `ctx.llm` sends its request
  as it built it, on every entry point: the accessor consults no privacy
  handle. Only the tool's result crosses the shield (handoff §13).
- The subscription-CLI path has no Privacy Shield at all (§3a, #1087): its
  loopback dispatcher runs without a privacy handle, so both carriers pass raw
  there.
- C0 detects no names; C1 does when it is configured. Without C1 a returned
  error keeps a name that stands in running prose, or in a record the
  classifier does not recognise as one: positional fields
  (`Partner(42, 'Jane Doe')`, Go's `%v`) or `name=…` pairs outside any
  record. A record echo in one of the shapes in the table is withheld whole.
- An identical repeat (same tool, same canonical input) of a call that ended
  in an exception is refused within a request — by `LocalSubAgent` per run,
  and by the request's ledger in the parent chat loops and in a
  subscription-CLI sub-agent's loopback dispatch (§7c). The subscription-CLI
  chat agent itself runs no orchestrator turn and refuses nothing, two
  identical calls in the same parallel batch both run, and no loop blocks a
  repeat with another input, or one after a returned failure whose outcome
  is just as unknown (an MCP request timeout). Tools carry no
  write-capability metadata; running a write at most once needs it, together
  with an idempotency key (handoff §13).
- A connect prompt produced by a sub-agent's tool call passes the parent seam
  as control flow only when the sub-agent's answer repeats it byte for byte.
  Any other answer takes the ordinary sub-agent path: interned, or bridged
  with the datasets the sub-agent interned. On the interned path a Connect
  block inside a paraphrased answer does not reach the final answer the chat
  UI scans for it.
- Two server-side sinks read the raw result before the seam:
  `captureRawToolResult` (routine templates) and the MCP → Knowledge-Graph
  ingest (#459), which stores a value-free byte count for a non-JSON error
  unless the server is bypassed.
- The run-trace `error` channel for turn-level failures is outside this policy.
- One sub-agent failure can produce two receipt entries, one from the
  sub-agent's seam and one from the parent's.

The predicate every seam consults, `isGuardedControlFlowResult`
(`toolErrorRedaction.ts`), is **anchored**: the `Error:` prefix, or a whole
result equal to a connect prompt minted in that dispatch. It never matches a
substring, so a marker planted in one cell cannot unmask a multi-row result
such as a decrypted `query_dataset` page (§6b). `isControlFlowToolResult`
(`@omadia/plugin-api`) still classifies by prefix alone, and no seam decides
with it; the privacy guard uses it only to flag a rendered one-cell dataset as
a failure. The shape classifier has **no** control-flow exemption — verbs
re-classify derived datasets, so one would turn `filter` + `select` into a
cleartext channel.

### 6d. `agents.privacy_profile` is not a Privacy Shield control (#978)

`agents.privacy_profile` (`'strict' | 'default'`, CHECK since migration `0001`) is written by the operator API (`POST` / `PATCH /api/v1/operator/agents`) and `scripts/agents-apply.ts`, and reported by `GET /api/v1/operator/agents`, `GET /api/v1/operator/agents/enabled`, `POST /api/v1/operator/agents/resolve-channel` and the Agent Builder graph (`agentNode()` in `routes/agentBuilder.ts`; contract field `AgentNode.privacyProfile` in `@omadia/plugin-api`). No runtime path reads it: `AgentRuntimeConfig` has no posture field, `buildForAgent` does not forward the value, and nothing branches on `'strict'`. What masks a turn is the `privacy.redact@1` provider, reached through the late-bound `OrchestratorDeps.privacyGuard` lookup that the registry passes unchanged into every agent's build, plus the tool-name-only exemptions in `privacyInternPolicy.ts`; neither receives the agent's profile. `strict` therefore behaves exactly like `default`, including for the first-boot fallback agent that `registry/onboarding.ts` seeds as `strict`: a `strict` value in the table, the API or the UI is not evidence that an agent's traffic is masked.

Since #978 a change to the value is a metadata `update` (registry row refreshed, live orchestrator kept), not a `rebuild`; the web UI no longer offers a toggle and labels the value "(not enforced)"; migration `0061` records the status as a column comment. Making `strict` enforce anything is a security decision that must update this section: the posture has to reach `AgentRuntimeConfig`, survive the sub-agent boundary (`turnContext.privacyHandle` in `localSubAgent.ts` / `toolDispatchService.ts`), go back into `runtimeChangeReasons` in `applyDiff.ts`, and it changes behaviour for the seeded fallback agent without operator action (open decision: `docs/middleware-agent-handoff.md` §13).

### 6e. The answer verifier's model requests run under the turn's privacy view

The answer verifier (`verifier@1`, wrapped around the orchestrator by
`VerifierService` whenever the bundle is published) sends model requests
AFTER the turn produced its answer: one claim extraction and one
evidence-judge request per soft claim (two on a confirmed contradiction). In
`enforce` mode it may re-enter the turn — a borderline resample, a correction
retry (§7c) — and each re-entry is a pass of its own whose answer is verified
the same way. The requests used to run outside the turn's privacy scope, on
the restored answer, with raw knowledge-graph evidence, after the receipt had
been written. They are now bound to the privacy handle of the pass whose
answer they check:

- **Hand-over instead of finalize.** Before every pass it runs (first run,
  borderline resample, correction retry — on `chat()` and on the stream), the
  wrapper calls `markPrivacyFinalizeHeld(input)`. The pass then does not
  finalize: it returns without a receipt and hands a
  `PrivacyEgressContinuation` (`harness-orchestrator/src/privacyEgress.ts`)
  over, keyed on the caller's input object (one-shot mark, weak maps). All
  three finalize sites hand over — buffered `runTurn`, streaming `done`,
  streaming Direct Line. Every verifier request about a pass's answer goes
  through that pass's continuation, and every pass that handed over is
  finalized exactly once, after them (`EgressLedger` on `chat()`,
  `StreamPasses` on the stream; also on errors, abandoned re-entries and
  early client exits). That drops the pass's surrogate map, dataset store and
  C1 cache, and its receipt covers the pass and the verifier's requests about
  it, with the model attribution captured at hand-over. A pass that throws,
  or whose stream ends before `done` (an `error`, a client that leaves —
  also during the stream's prelude, at the `onBeforeTurn` annotations, after
  an MCP input-card replay put its result into the turn's privacy state),
  hands nothing over: the orchestrator finalizes it itself
  (`closeUndeliveredPass`), clears the turn's auth context and keeps its
  receipt like any other pass's — it used to drop it. A request has one
  hash-chained `turn_receipts` row: the pass writes it when the request
  cannot be re-entered; otherwise every pass's receipt — a pass that threw,
  was abandoned or was cut off by the client included — is merged into the
  request's one row, written once when the verifier is done with the request
  (`requestReceipts.ts`, §7c). Every pass with a receipt offers to own that
  row, and the earliest pass owns it — in pass order, not in the order the
  passes are finalized: the first run whenever it had a receipt, also when
  its continuation is finalized after a re-entry; otherwise the earliest
  re-entry that had one, so a request whose only receipt is a failed or
  abandoned re-entry's still gets its row.
- **What the verifier sees.** The extractor gets the turn's WIRE view, as the
  turn recorded it (`TurnContextValue.wireView`): the prompt exactly as the
  turn's model received it — normalised (an MCP input-card reply is its label,
  never the envelope with the values the user typed for a third-party server)
  and masked under the turn's `mask_user_prompt` policy (as written when the
  operator left it off — the turn's own model saw the same) — and the answer as
  the model wrote it, before restore. The request is admitted through the view
  (`admitWireView`, one verifier request in the receipt) but never masked a
  second time, which would read the turn's placeholders as new values. The
  pipeline's own `userMessage` (server-side checks; the extraction prompt when
  no shield is installed) is the same normalised text, never the envelope.
  A server-rendered v4 answer (`answerSource: 'privacy-render'`, real values
  the model never saw), a Direct Line relay and the privacy refusal are never
  verified (`verifierGate`; what `enforce` delivers instead is in §7c). The
  extraction window and the verbatim guard (§7c) apply to the wire answer,
  the text the model saw. Claims come back with placeholders and are
  restored server-side (`harness-verifier/src/claimRestore.ts`); an amount or
  date the model parsed from a placeholder is re-read from the real literal
  it stands for, never compared as the placeholder's value. A claim that
  does not map back onto the answer the user was shown never reaches a
  checker — one whose span cut through a placeholder, an amount or date no
  single real literal can be tied to, and a date or graph-id claim whose
  check would then read the whole restored sentence — and it is not dropped
  without a trace: the extraction reports it as the `claims_not_restored`
  coverage gap, so such an answer is never `approved` (§7c). The
  deterministic re-query and the graph lookup run on real values and never
  leave the process.
- **Evidence is projected regardless of the flag.** The judge's claim,
  context and knowledge-graph evidence are projected in ONE call per request
  through the turn's surrogate map (`projectVerifierText`): identity-shaped C0
  spans, the operator deny-list, the C1 detector when wired, the node's display
  name and free-text fields (`EvidenceSnippet.identityValues`, deny-by-default
  like the v4 classifier), and the turn's known real values. Dates and amounts
  stay, as in a v4 digest. Node ids never leave the process (an ingested
  record's id can embed an external key or a channel user id): the request
  names each snippet by a handle minted for that request (`ev-1`, `ev-2`, …),
  the handle the judge cites is resolved to its snippet server-side (a handle
  the request did not print resolves to nothing), and a node id or a string
  record key (`id=…`) that the evidence text repeats is always replaced like a
  display name. Numeric record keys stay, as in a v4 digest. One map means the
  same person is the same placeholder in claim and evidence, so the judge can
  still verify. A real value that equals a surrogate minted earlier in the
  turn blocks the request.
  Evidence is capped (3 snippets × 1200 chars) and the C1 timeout/degrade
  latch applies as for the prompt. Because a contradiction judged on
  placeholders can be an artefact of the substitution, it is reported as
  `unverified`, never as a contradiction: it buys no correction retry, and
  `enforce` withholds the answer as unconfirmed (§7c).
- **Fail closed.** A blocked mask or projection sends nothing: a blocked
  extraction request rejects, so the verdict is `unavailable` /
  `extractor_error`, never an empty extraction; a blocked judge request
  leaves its claim `unverified` with `cause: 'check_failed'`. With a shield
  installed but no continuation handed back, the wrapper does not verify at
  all (`verifierGate`; `enforce` withholds the answer as `unavailable` /
  `privacy_shield`). A provider without `projectVerifierText` blocks every
  judge request. One without `countUnresolvedSurrogates` reports no
  placeholders, so the check under **Correction retry** never keeps a second
  answer back. The bundled privacy guard implements both from 0.6.0 on.
- **Correction retry.** The hint carries no verifier evidence, with or
  without a shield (§7c): it names the contradicted claims, the turn's own
  tool names and call ids and fixed text — no truth values, no value-bearing
  detail (`Δ=…`, the judge's rationale). The claims are cut from the restored
  answer, so they can hold real values: when the contradicted pass's policy
  would still alter the hint (`maskWouldAlter`, a preview that adds nothing
  to the receipt), the retry is withheld (badge `failed`). A hint that passes
  is masked once, by the retry's own pass, like its prompt
  (`wireExtraSystemHint`) — never twice with different maps. A second answer
  that still carries unresolved placeholders (`countUnresolvedSurrogates` —
  the model reworded one and restore could not map it back) never replaces
  the first: a retry answer is then not even judged, and a blocked re-sample
  taken over a borderline first answer is not shown, whether the retry then
  ran, failed or was withheld. The verdict stays the one the earlier passes
  earned (`failed`), and `enforce` withholds a contradicted answer (§7c).
  Restore only maps a placeholder's exact string back, so the check also
  compares dates and amounts by value (`valueLiterals.ts`): a date placeholder
  written as ISO, slashed, unpadded or with a written month (six locales), or
  an amount placeholder regrouped or given a scale word ("Tsd.", "k", "T€",
  "Mio."), still counts. A date or amount literal whose value cannot be read
  matches every placeholder of its kind (fail closed). Open (handoff §13):
  spelled-out numbers and dates without a year are not read, and minting
  compares strings, so a real date or amount can get a placeholder of the
  same value in another spelling — the request then carries that value, and
  the check flags the restored real value, which only withholds a second
  answer.
- **Receipt.** Verifier spans are booked in `PrivacyReceipt.verifierEgress`
  (request count + span types), never in `maskedPromptSpans`; a turn whose
  only privacy-relevant event was the verifier still gets a receipt. Merged
  over a request's passes, the request counts add up and the span types are
  united (`mergePrivacyReceipts`). On streaming turns `done` is held until
  the inner stream has drained (steering and turn-auth cleanup run first)
  and the verifier finished — in `enforce` until every pass was finalized —
  then goes out with the receipt, followed by the `verifier` event.

Callers: every `bundle.agent` caller goes through the wrapper — chat routes,
channel adapters, the scheduler (`scheduleWorker.ts`) and conductor steps
(`realStepEffects.ts`, `builderAgent.ts`). The subscription-CLI chat runtime
is never wrapped (§3a); the verifier's own provider may be `claude-cli`, which
receives the same masked text. Deliberately unchanged: `verifier_contradictions`
stores claim text, claimed and truth values restored to real values
(server-side, same trust zone as the session log); prompt masking stays
default-off, so the extraction request carries the raw prompt when the
operator chose so. Why a continuation and not the in-turn snapshot used for
fact extraction: the judge masks evidence fetched after the turn with the
live detectors and the same map, and only an unfinalized turn still has both.

Tests: `middleware/test/verifierServicePrivacyEgress.test.ts` and
`verifierServiceStreamPrivacyEgress.test.ts` (every pass of both modes
verified through its own view and finalized once, one receipt row per
request — a pass that threw or that the client left included — the privacy
refusal and the screening quarantine released in `enforce`),
`orchestratorPrivacyEgress.test.ts` and `verifierReentryRecords.test.ts` (a
pass that throws or is cut off keeps its receipt: its own row, or the
request's without taking it), `verifierPrivacyEgressEndToEnd.test.ts`,
`verifierCorrectionHintPrivacy.test.ts` (a hint the masking would alter is
not sent; one that passes is masked once, by the retry),
`verifierPipeline.test.ts` (a claim that does not restore is a coverage
gap), `verifierEvidenceHandles.test.ts` and
`privacyVerifierProjection.test.ts`.

### 6f. What the shield masks, and what reaches the model as it is

For omadia's own model requests, the Privacy Shield works through the turn's
privacy handle and, for the memory jobs that run outside a turn, through a
job-scoped mask (see "Memory jobs" below), and nowhere else (the public MCP
endpoint has a gate of its own, `createFailClosedPrivacyGate`, §6c). When a `privacy.redact@1` provider
is active, the orchestrator mints that handle for each turn
(`buildPrivacyHandle`, before the inbound screening gate) and threads it
through `turnContext` to the model requests of the turn's own call tree, the
agent's model loop and its sub-agents (`LocalSubAgent`, a domain tool's
sub-agent). The answer verifier's requests about the turn's answer go
through the same handle, which the turn hands over to them (§6e). In those
requests, and only there, the shield acts on four kinds of text:

- **Tool results, under `guarded` (the default).** A tool's result is interned
  into the turn's dataset store and the model gets an identity-free digest in
  its place (`internToolResultV4`). The results that skip this step are
  listed further down.
- **Tool errors, independent of `mask_user_prompt`.** For a tool that is not
  bypassed, intern-exempt tools included, a returned `Error:` text is redacted
  (or withheld whole) and a thrown one is withheld (§6c). A returned error of a
  plugin, tool or MCP server the operator set to bypass reaches the model as
  returned; a thrown error is withheld even under bypass (§6c, residuals). The
  seams check the bypass before they look for an `Error:` text, and
  `Orchestrator.dispatchTool`, `LocalSubAgent` and `ToolDispatchService` look
  for it in an intern-exempt tool's result before they hand that result over
  (`guardReplayResult`, the MCP input replay, checks the bypass only).
  `withholdThrownToolError` withholds a thrown message for every tool.
- **Replayed answers, independent of `mask_user_prompt`.** Every assistant
  answer a channel replays in `priorTurns` goes through
  `maskReplayedAnswer` before it reaches the turn's model
  (`maskPriorTurnsForWire`): the identity shapes of the C0 baseline (e-mail,
  IBAN, phone, address, ID number), the operator's deny-list and names when
  the C1 detector is configured, through the turn's prompt map, so the final
  answer gets the real values back. Dates and amounts stay, as in a v4
  digest. The spans count on the receipt as the turn's own
  (`maskedPromptSpans`). It fails closed like prompt masking (below): a
  failing C1 falls back to C0, and a detection failure or a surviving value
  blocks the turn (`PromptMaskBlockedError`).
- **Prompt text, only while `mask_user_prompt` is on.** The setting is off by
  default. While it is on, the user's message, document text inlined at
  upload, the user messages a channel replays in `priorTurns`, live steering text, a direct-line relay's
  payload and a verifier correction hint are masked in the turn's own model
  requests through the turn's prompt map (`maskPromptForWire`): the C0
  baseline and the operator's deny-list, plus names when the C1 detector is
  configured. The turn's model and persona routing, its card routing, fact
  extraction and the memory-excerpt pass read that wire text, so they follow
  the setting too. While it is off, all of this reaches the model as typed.
  Masking fails closed only where the C0 baseline cannot run: if C0
  detection or the deny-list fails, or a detected span survives
  substitution, the guard reports `blocked` and the request is not sent
  unmasked (`PromptMaskBlockedError`: the turn answers with a privacy
  notice, a direct-line (#specialist) turn included, a fact-extraction pass
  is skipped and a verifier re-entry is abandoned, §7c). If the configured
  C1 detector fails, C1 stays off for the rest of the turn and masking falls
  back to the C0 baseline (`c1DetectorFor`, logged as `promptMaskDegraded`),
  so names only C1 detects reach the model unmasked. Restoring real values
  in the final answer and in what is persisted is best-effort: a restore
  that throws is logged and leaves the surrogates in place
  (`restorePromptForPersistence`).

The verifier's evidence-judge requests are projected through the turn's map
whatever `mask_user_prompt` says (§6e). The subscription-CLI path has no
shield at all (§3a), and without an active privacy-guard provider nothing is
interned or masked (§6c, residuals).

**Memory jobs, independent of `mask_user_prompt`.** The memory jobs of
`@omadia/orchestrator-extras` send stored text, which holds real values,
through that plugin's own provider, and with a privacy-guard provider active
they mask it whatever `mask_user_prompt` says
(`harness-orchestrator-extras/src/jobPrivacy.ts`; the plugin declares
`turnContext@1` and `privacyRedact@1` under `optional_requires`). Two routes:

- **Inside a turn.** The recall relevance judge (`recallRelevanceJudge.ts`)
  and the session briefing (`sessionBriefing.ts`, `sessionSummaryGenerator.ts`)
  run while the orchestrator assembles the turn's context. They read the
  turn's handle from the kernel's `turnContext` service and mask their request
  through `maskReplayedAnswer`, never through the flag-gated `maskUserPrompt`:
  the identity shapes of the C0 baseline, the deny-list and C1 through the
  turn's prompt map, counted on the receipt as the turn's own
  (`maskedPromptSpans`). The briefing restores its summary through the same
  map before it stores it.
- **Outside a turn.** Topic-cluster naming (`topicClustering.ts`), the
  inconsistency detector (`inconsistencyDetector.ts`, which runs
  fire-and-forget after a memory write, possibly after the writing turn
  finalized its map) and the topic detector the Teams channel calls before a
  turn (`topicDetector.ts`) open one scope per run with `openStoredTextScope`
  (`@omadia/plugin-api` 1.25.0, privacy-guard 0.8.0, `storedTextScope.ts`):
  the same detectors through the run's own surrogate map, which restores the
  cluster name and description and the inconsistency summary before they are
  stored. No receipt books these spans; each call logs
  `storedTextMask job=… spans=…`. The judge and the briefing take this route
  too when no turn is active.

Both routes fail closed: anything but `masked` skips the job's model call. The
judge then keeps every candidate the cheaper recall legs found, the briefing
writes no summary, a cluster gets its numbered fallback name, the
inconsistency pass leaves the memory unchecked for the next sweep, and the
topic detector asks the user. A privacy provider without `openStoredTextScope`
(or a turn handle without `maskReplayedAnswer`) skips the job's model call the
same way. Only a host with no privacy-guard provider sends the stored text as
stored. The capture filter's significance score and the embeddings below are
not covered.

Replayed answers are masked whatever `mask_user_prompt` says because an
answer rendered by `v4_render_answer` carries real values (`maskedValues`,
`answerSource: 'privacy-render'`) its model never saw, and the Teams and
Telegram channel plugins build `priorTurns` from the answers they delivered.
A privacy provider without `maskReplayedAnswer` (it arrived with
`@omadia/plugin-api` 1.23.0 and privacy-guard 0.7.0) masks a replayed answer
through `maskUserPrompt`, so with masking off it hands those values to the
model on the next turn in `priorTurns`. Recalled context, the knowledge-graph recall and the session tail, goes
through `maskReplayedAnswer` as well, whatever `mask_user_prompt` says: the
session log behind it stores each answer with its real values restored, so
a recalled answer would otherwise hand them to the model two turns later. A user message a channel replays still
follows `mask_user_prompt`.

These tool results skip the digest:

- **Intern-exempt tools.** `INTERN_EXEMPT_TOOLS`
  (`harness-orchestrator/src/privacyInternPolicy.ts`, pinned by
  `test/privacyInternPolicy.test.ts`) lists `memory`, the stored-process tools
  `query_processes`, `run_stored_process`, `write_process` and `edit_process`,
  then `suggest_follow_ups`, `ask_user_choice` and `read_attachment`. The model
  gets their results as the tool returned them. `read_attachment` returns the
  extracted text of an uploaded document. A table (CSV or XLSX, recognised by
  `detectTabularFormat`, the rule the chat-attachment ingest applies) it
  refuses with an `Error:` that points the model to `query_dataset`, so the
  cells the dataset import of that file scanned and encrypted (§6b) do not
  reach the model through it. `mask_user_prompt` does not reach the tool:
  that setting masks prompt text, and a tool result is not prompt text.
- **Operator bypass.** A plugin set to `bypass`, a tool on its `per_tool`
  list, or a tool of an MCP server the operator flagged `privacyBypass`
  (`mcpPrivacyBypass.ts`; set through the agent builder's MCP server route,
  loaded by `services/mcpGrantPolicy.ts` and checked first by the bypass
  resolver) passes the raw result and records the tool on the receipt. The
  bypass applies even when recording it throws, and the receipt itself is
  persisted best-effort (§7b). A sub-agent that read a bypassed result and
  interned no dataset hands its answer up raw as well.
  `OMADIA_PRIVACY_FORCE_GUARDED=true` switches all three off for the result
  the model gets, and for the MCP-to-knowledge-graph ingestion
  (`Orchestrator.dispatchTool`, epic #459) as well: every seam that reads a
  server's `privacyBypass` flag, the ingestion included, decides through
  `isMcpServerBypassInForce`, which routes the flag through
  `resolveEffectivePrivacyMode`. A server flagged `kgIngest` stores a
  value-free note of the result's shape (`mcpObservationDigest`) as the
  memory's `rationale` (`createMemorableKnowledge`). Only while its bypass is
  in force, so with `privacyBypass` set and the clamp off, it stores up to
  8,000 characters of each raw result instead, which later turns can recall
  into prompt context, the memory jobs send, masked, to their provider and an
  embedding provider embeds (below). The public MCP endpoint applies no bypass
  (`createFailClosedPrivacyGate` pins `checkBypass` off).
- **Control flow.** A returned `Error:` text and an MCP connect prompt are not
  interned; §6c says how they are redacted or withheld. An MCP input-required
  sentinel minted by the same dispatch passes unchanged. It holds a random id,
  the server and tool name and at most eight field names, never a value (#570).

A result whose interning fails does not reach the model. When
`internToolResultV4` throws, every seam that interns
(`Orchestrator.dispatchToolDeadlined`, `LocalSubAgent`,
`ToolDispatchService.afterDispatch` and the MCP input replay,
`guardReplayResult`) logs a warning and hands the model the kernel's notice
(`internFailedNotice`, `privacyInternPolicy.ts`) instead, on a first run and
on a verifier re-entry's replay alike. `query_dataset` keeps its own wording,
because its page carries decrypted cell values (§6b) and repeating a page read
is safe. The public MCP endpoint discards such a result
(`createFailClosedPrivacyGate`, `src/mcp/publicMcpPrivacy.ts`) and serves no
intern-exempt tool at all (`isPubliclyServableTool`). Tests:
`test/orchestrator/internFailureFailsClosed.test.ts`,
`test/toolReplaySeams.test.ts` and `test/publicMcp/publicMcpPrivacyGate.test.ts`.

**The inbound screener and the significance scorer get the turn's masked
text.** Neither runs in the turn's call tree, so the handle does not reach
their requests; the kernel hands them text the handle already masked.

- **Inbound security screening (#579).** Under the default security posture
  `auto` (`DEFAULT_SECURITY_POSTURE_POLICY`, `@omadia/channel-sdk`), and under
  `strict`, `screenInboundTurn` (`harness-orchestrator/src/orchestrator.ts`)
  screens every turn that carries an attachment, after the turn minted its
  privacy handle, in `runTurn` and `chatStream` alike. The payload
  (`bundleProvenance`, `renderScreeningPayload`) holds the user's message,
  each user message the channel replays in `priorTurns` and the attachments'
  names and media types, never a replayed answer. `screeningBundleForWire`
  masks the messages and the attachment names through the turn's map with
  `maskPromptForWire`, as the turn's model call masks its prompt: the screener
  sees the model's surrogates, the messages follow `mask_user_prompt` as they
  do for the model, and a media type goes as declared. A `blocked` mask fails
  the turn closed with the privacy refusal before the screener is called,
  through the exit a blocked model call takes. `LlmScreener`
  (`securityScreener.ts`) sends the payload to the agent's own provider and
  model, or `HttpProxyScreener` to the operator's `security_screen_url`. A
  turn without an attachment sends nothing, and the posture `dangerous`
  (`security_posture` in the orchestrator plugin's settings) switches
  screening off. The audit record keeps the raw source tags on the server.
- **Turn scoring.** At the default `capture_level`, `normal`
  (`DEFAULT_CAPTURE_LEVEL`, `harness-orchestrator-extras/src/plugin.ts`), the
  capture filter of `@omadia/orchestrator-extras` sends each turn the session
  log stores to that plugin's own provider for a significance score
  (`captureFilter.ts`, `significanceScorer.ts`). For a turn under a privacy
  handle the orchestrator hands the row its masked view
  (`TurnIngest.maskedView`): the user message as the model received it and
  the answer as the model wrote it, the texts the fact extraction gets, never
  the restored answer. A direct-line turn's specialist answer is masked like
  a replayed answer, whatever `mask_user_prompt` says.
  `CaptureFilteringKnowledgeGraph` strips the view before the turn is stored,
  and an empty view (its masking was `blocked`) skips the scorer.
  `capture_level: minimal` switches the scorer off.

Tests: `test/securityPosture579.test.ts`,
`test/orchestrator/promptMaskPipeline.test.ts` and `test/captureFilter.test.ts`.

**Every other model call sends its text as it is.** A model request that runs
neither under the turn's handle nor through a memory job's mask reaches its
provider as its caller built it, with prompt masking on or off: `mask_user_prompt` reaches none of the texts
below (the embedded recall query in the last entry aside), and the shield
masks text only, so it reads no image block. In-tree these are:

- **Operator backfill and the scratch-promotion reaper.** The significance
  backfill an operator starts over stored turns (`bulkPromotion.ts`) and the
  scratch-promotion reaper (`scratchPromotionReaper.ts`) score stored text,
  which holds real values, with the turn scorer through the own provider of
  `@omadia/orchestrator-extras`. The plugin's other memory jobs mask what they
  send (see "Memory jobs" above).
- **Plugin requests through `ctx.llm`.** A plugin that holds the `llm`
  permission sends its `ctx.llm` requests itself, and the accessor
  (`createLlmAccessor`, `src/platform/pluginContext.ts`) consults no privacy
  handle, so a request reaches the provider as the plugin built it (§6c,
  residuals). In-tree, the canvas composer sends the user's message, or the
  serialised UI action, to its composition model before the turn starts
  (`composeSkeleton`, `omadia-ui-orchestrator/src/composition.ts`). The
  plan-runner's planning gate and planner send the user's message from the
  `onBeforeTurn` hook, which fires before the turn masks anything
  (`harness-plugin-plan-runner/src/gate.ts`, `materializer.ts`). A tool that
  fetches data and asks a model about it sends that data the same way, and
  only the tool's result crosses the shield.
- **Images.** Images the user attaches go into the turn's own request to a
  model with image input as base64 blocks (`buildUserContent`,
  `harness-orchestrator/src/orchestrator.ts`), and a verifier re-entry sends
  the first run's image blocks again (§7c).
- **Embeddings.** With the OpenAI-compatible embedding adapter
  (`@omadia/embedding-adapter-openai`, default endpoint
  `https://api.openai.com`), stored turns and memories, a raw MCP result the
  ingestion above stored included, are embedded at that provider as stored,
  real values included (`neonKnowledgeGraph.ts`). Only the recall query is
  the turn's wire text (`retrievePriorContext`), so it alone follows
  `mask_user_prompt`. The memory jobs above mask what they send to a model,
  not what they embed: the inconsistency detector embeds the memory it
  checks, and the Teams topic detector the messages it compares, as stored.
  The Ollama sidecar and the local adapter embed in-tenant.

Masking these calls is open, embeddings included (`middleware-agent-handoff.md`
§13).

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

What the chain cannot show is a receipt that was never written. Appending is
best-effort, because the user's answer outranks the audit row
(`src/receipts/store.ts`). A failed insert is logged and counted in the process
(`persistFailures`, `turnReceiptCounters()`), and no endpoint reports that
count yet. A receipt whose `finalize()` throws is logged and dropped. A turn
that throws, or whose stream ends before `done`, is still finalized and keeps
its receipt (`closeUndeliveredPass`, §6e), and a verifier request writes one
row for all of its passes (§7c). Nothing is retried. `seq` is assigned inside
the insert transaction, so a missing receipt leaves no sequence gap and the
chain verifier reports green without it. The receipts are also Postgres-only:
on the in-memory backend no store is wired and nothing is persisted.

## 7c. Answer-verifier verdicts and badges are evidence-bound

The answer verifier (`@omadia/verifier`, wrapped by `VerifierService` in
`@omadia/orchestrator`) puts a trust signal on a turn: a verdict, and from it
a badge. A badge that says "verified" is a statement about the answer, so it
may only follow from claims the verifier actually checked. Five paths check
nothing: the answer carries no trigger signal, the extractor fails, the
extractor returns no claims, no extracted claim fits a checker, or the
pipeline itself throws. None of them is a pass.

The verifier is opt-in. `VERIFIER_ENABLED` (`verifier_enabled`) is off by
default, and the plugin publishes `verifier@1` only once it is switched on and
an API key for its model provider and a knowledge graph are available
(`harness-verifier/src/plugin.ts`); without the capability the bare
orchestrator is the chat agent (`buildOrchestrator.ts`). `VERIFIER_MODE`
defaults to `shadow`, which records verdicts and never withholds or changes an
answer. The subscription-CLI runtime and routines are never verified (below).

**Invariant.** `approved` ⇒ the claim extraction reported no coverage gap,
and every extracted claim was checked and is `verified`, at least one. No
coverage gap means: the extraction model read the whole answer, its claim
list stayed below the request limit, every `record_claims` call in its
response was read, and every claim it returned quotes the answer in full
(case and whitespace aside) and is short enough to check (`MAX_CLAIM_CHARS`,
300 characters); no claim is shortened to fit. The `approved` variant's claim
list is typed non-empty (`NonEmptyClaimVerdicts`), the pipeline's aggregate
returns `skipped` for an empty list, and whatever the pipeline did not check
stays in the verdict as `unverified` (`cause: 'not_checked'`) instead of
being dropped: a claim no checker takes, a claim over the cap, and a
`coverage_gap` entry for each part of the answer the extraction did not
cover. A badge other than `unverified` /
`unavailable` needs a check that settled a claim (`hasVerificationEvidence`):
a confirmed claim for `verified` / `partial` / `corrected`, a contradicted one
for `failed`; `verified` and `corrected` need every claim confirmed. What the
invariant cannot cover — a claim the model never lists — is stated below.

| Verdict status | Meaning | Summary badge | Connector badge | Web chat chip |
|---|---|---|---|---|
| `approved` | no coverage gap, every claim checked and verified | `verified` | verified | green |
| `approved_with_disclaimer`, ≥ 1 claim verified | none contradicted, ≥ 1 unconfirmed, not checked, or part of the answer not covered | `partial` | partial | amber |
| `approved_with_disclaimer`, no claim verified | none contradicted, nothing confirmed | `unverified`; `unavailable` when every check that ran failed | none | neutral |
| `blocked` | ≥ 1 claim contradicted | `failed` | failed | red |
| retry after `blocked`, every claim verified | correction confirmed | `corrected` | corrected | blue |
| retry after `blocked`, some claims verified, none contradicted | correction confirmed in part | `partial` | partial | amber |
| `skipped` — `no_trigger`, `no_claims`, `no_checkable_claims`, `incomplete_coverage` | ran, nothing checkable | `unverified` | none | neutral "not verified" |
| `unavailable` — `extractor_error`, `pipeline_error` | could not run, or the pipeline returned no usable verdict | `unavailable` | none | neutral "unavailable" |
| `unavailable` — `privacy_shield` | `enforce` only: an answer the verifier may not see behind Privacy Shield — one the shield rendered, or a pass without a privacy view — was never sent to it (below) | `unavailable` | none | neutral "unavailable" |

- **The trigger patterns decide whether an answer is checked at all.**
  `shouldTriggerVerifier` (`harness-verifier/src/triggerRouter.ts`) hands an
  answer to the claim extractor only when one of its regular expressions
  matches somewhere in the answer's text. They look for a euro amount (`€` or
  `EUR` next to a number), an accounting reference (`INV`, `SO`, `PO`, `RECH`,
  `MOVE`, `BILL`, `RG` or `CR` followed by at least two digits), a date
  written `yyyy-mm-dd` or `dd.mm.yyyy`, a percentage with one to three digits
  before the decimal mark, a number followed by an hour or day unit (`Stunde`
  or `Stunden`, `Std`, `h`, `Tag` or `Tage`, `Urlaubstag` or `Urlaubstage`,
  `Arbeitstag` or `Arbeitstage`), and an aggregate keyword (`summe`, `gesamt`,
  `total`, `saldo`, `offen`, `fällig` or `faellig`, `ausstehend`,
  `durchschnitt`, `anzahl`, `insgesamt`) in an answer that also holds a number
  of three or more digits anywhere. These are pattern matches, not a reading
  of the figures: the keyword and the number need not belong together, so
  `Total: $500` is checked. Any other answer gets no extraction, whatever
  figures it holds in other formats: another currency (`USD 50,000`, `$500`),
  an English-format date (`October 2, 2026`) or a small count
  (`3 unpaid invoices`). On such an
  answer only the checks that need no extraction run (failure replay, tool
  postconditions and missing knowledge-graph citations,
  `verifierPipeline.ts`); any of them blocks it, and otherwise the verdict is
  `skipped` / `no_trigger`. `enforce` releases a `no_trigger` verdict, so such
  an answer goes out unchecked, and `shadow` records it as `skipped`.
- **A failed extraction is not an empty one.** `ClaimExtractor.extract`
  rejects when the LLM call fails, the response was cut off at the token
  limit (`finishReason: 'max_tokens'` — the claims array may parse but is not
  the whole answer), the response carries no usable `record_claims` call
  (none, or any one of them without a `claims` array), or an entry breaks the
  `record_claims` schema (no text, unknown type or source); the pipeline maps
  the rejection to `unavailable` / `extractor_error`. It resolves no claims
  and no gap only when the model reported none, which is `skipped` /
  `no_claims`; when none of the claims it returned is in the answer, the
  result carries a coverage gap, and without any other finding the verdict
  is `skipped` / `incomplete_coverage` (below). No extraction failure comes
  back as an empty or partial result, so an outage never reads as a clean
  run.
- **Coverage is explicit.** An extraction that covers only part of the
  answer says so. The extractor sends the model the first 6000 characters of
  the answer (`EXTRACTION_WINDOW_CHARS`) and asks for at most
  `VERIFIER_MAX_CLAIMS + 1` claims; its result names what it did not cover
  (`ClaimExtraction.gaps`): `answer_beyond_window` for a longer answer;
  `claim_list_full` when the model's list reached that limit — a model that
  keeps to the limit may have left claims out, so a full list never passes
  for a complete one, while an answer with exactly `VERIFIER_MAX_CLAIMS`
  claims still gets its whole list; `claims_not_in_answer` when the model
  returned a well-formed claim that is not in the answer;
  `claims_too_long` when it returned a claim that quotes the answer but is
  longer than a check takes; and, behind a Privacy Shield,
  `claims_not_restored` when a claim does not map back onto the answer the
  user was shown (§6e). The pipeline adds one `not_checked` verdict
  over a synthetic `coverage_gap` claim per gap, so
  such an answer is `approved_with_disclaimer` / `partial` at best. When
  nothing in the covered part could be checked, the verdict is `skipped` with
  reason `incomplete_coverage` rather than `no_claims`, which would say more
  than was looked at. The summary counts the entries as `uncoveredCount`, and
  the web chat's tooltip says the verifier did not check all of the answer.
- **The verbatim guard reports what it keeps out.** A claim must quote the
  answer: the guard compares case-insensitively and lets any run of whitespace
  match any other (a line break the model writes as a space, a non-breaking
  space written as a plain one), and the claim then carries the answer's own
  span. A claim that quotes nothing — a paraphrase, or a subject stitched in
  from elsewhere in the sentence — never reaches a checker, since a check on
  text the answer does not hold proves nothing about the answer. Dropping it
  silently would let the rest verifying make the answer `approved`, so the
  part of the answer it stood for is reported as the `claims_not_in_answer`
  gap. The guard matches the whole claim, never a prefix of it: a claim cut to
  a length before the match would be checked on its head while its tail — in
  the answer or not — went unchecked. A claim that quotes the answer but is
  longer than a check takes (`MAX_CLAIM_CHARS`, 300 characters; the tool
  schema asks for 1-200) is not cut to fit either; it is kept from the
  checkers and reported as the `claims_too_long` gap. Likewise every
  `record_claims` call in the response is read: a model that splits its list
  over several calls gets every part checked, where reading only the first
  call would leave the rest unchecked without a trace.
- **What no check can see.** The verifier checks the claims its extraction
  model lists. A claim the model leaves out of a list that stays below the
  request limit leaves no trace in the response, so `approved` / `verified`
  says that every claim the extraction found was confirmed and nothing marks
  the extraction as incomplete — not that the answer holds no further claim.
  How reliably the model lists every claim is a property of the model and
  its prompt (which asks for every claim, in order); the golden-set eval
  (`middleware/test/golden/`) runs the real extractor over known answers and
  fails when the pinned model stops finding a claim that decides the verdict.
- **A claim nobody checked still counts.** A claim no checker accepts (an
  amount, id, date or aggregate whose source is neither Odoo nor the graph)
  and a claim beyond the per-answer cap (`VERIFIER_MAX_CLAIMS`, applied by
  the pipeline) stay in the verdict as `not_checked`. An answer checked only
  in part is therefore `approved_with_disclaimer` / `partial`, and the
  summary reports them, with the coverage entries, as `uncheckedCount`.
- **A failed check is not evidence.** The deterministic re-query and the
  evidence judge mark a claim they could not check `unverified` with
  `cause: 'check_failed'`. A verdict in which every check that ran failed
  that way is badged `unavailable`; one whose claims all stayed unconfirmed
  for any other reason is `unverified`, never `partial`.
- **An injected verdict is held to its claims.** The pipeline is injected
  (`verifier@1`), so `VerifierService` binds the verdict it returns to its
  claims (`bindVerdictToClaims`) before it retries, resamples, stores or
  streams anything on it, and `summarise` binds again where the summary
  leaves for the stream. A status is never higher than its claims earn: an
  `approved` over an unconfirmed claim is `approved_with_disclaimer`, over a
  contradicted one `blocked`, and a status is never raised above the one
  reported. `approved`, `approved_with_disclaimer` or `blocked` over zero
  claims, an unknown status, entries that are not claim verdicts, and a
  `skipped` / `unavailable` reason outside the closed codes are
  `unavailable` / `pipeline_error`; the raw value goes to the operator log
  (JSON-escaped, cut short), never onto the stream. A latency that is not a
  duration is 0. The built-in pipeline's verdicts pass unchanged.
- **Badges are derived under the evidence gate, not from the status alone.**
  `badgeFor` (`verifierService.ts`) checks `hasVerificationEvidence()` and
  gives `verified` only when every claim was confirmed, so even a verdict
  that bypassed the binding cannot earn more. A correction retry earns
  `corrected` only when the retry's own verdict confirmed every claim; a
  retry that confirmed only some — the rest unconfirmed, not checked or not
  covered — is `partial`, as the same verdict is on a first pass.
- **`toSemanticAnswer` is the single connector badge gate.** It forwards a
  badge only when `verifierSummaryHasEvidence()` holds, the badge is in the
  unchanged wire union `verified | partial | corrected | failed`
  (`SemanticAnswer.verifier`) and the summary's counts back it (`verified`
  and `corrected` need every claim confirmed). `verifierSummaryHasEvidence()`
  also needs counts that can describe one claim list — nonnegative integers
  with `uncoveredCount ≤ uncheckedCount ≤ unverifiedCount` and
  `contradictionCount + unverifiedCount ≤ claimCount` (absent optional counts
  are 0) — so a summary from a foreign `ChatAgent` cannot buy a badge with
  counts that contradict each other. Connectors (Teams card, Telegram) need
  no change: a turn without evidence renders no chip there.
- **The stream event carries every state.** The trailing `verifier` event is
  forwarded verbatim by `/api/chat/stream` and by the public API-key stream
  (in `enforce` mode `done.verifier` carries the same summary, see below),
  so its `status` / `badge` can be `skipped` / `unverified` and
  `unavailable`. Its `reason` is a closed code set, never an error message:
  the message stays in the log line where the failure is caught. The web chat
  renders the event as a footer chip (`web-ui/app/_components/chat/VerifierBadge.tsx`),
  green only for a `verified` summary whose every claim was confirmed, blue
  `corrected` under the same condition, never stronger than the summary's
  counts back (a `verified` or `corrected` badge whose counts back only part
  of the answer shows as partly verified), and applies the same rules to a
  summary restored from local storage — a summary with a missing count, or
  counts that contradict each other, gets a neutral chip.
- **A resample needs something a second sample could change.**
  `isBorderlineVerdict` holds only for an `approved_with_disclaimer` that
  confirmed at least one claim and left another one unconfirmed after a
  check. `skipped` / `unavailable`, a verdict that confirmed nothing and one
  whose only doubt is `not_checked` claims never buy a resample — it is a
  second paid orchestrator turn.
- **Telemetry keeps the distinction.** `verifier_verdicts.status` stores
  `skipped` / `unavailable` as their own values (free `TEXT` column), so a
  calibration query no longer counts an outage as a clean turn, and
  `verifier_verdicts.reason` (knowledge-graph migration 0034) holds their
  closed reason code, so it can tell a `skipped` answer `enforce` delivers
  (`no_trigger`, `no_claims`) from one it withholds. The row carries the
  bound verdict, and `unverified_count` is counted from its claims, never
  inferred from its status. `shadow` writes no row for an answer the
  verifier may not see behind the shield (it logs `verification skipped`
  instead). No code in the repository reads the table.

Tests: `middleware/test/verifierPipelineStates.test.ts` (including the
production `ClaimExtractor` over a failing, a truncated and a malformed LLM
response, and answers checked only in part),
`middleware/test/verifierExtractionCoverage.test.ts` (the production
extractor and pipeline over a model that keeps to the claim limit: an answer
longer than the window, and one with more claims than the cap),
`middleware/test/verifierExtractionVerbatim.test.ts` (claims whose text
differs from the answer — whitespace drift, a stitched subject — and a list
split over several `record_claims` calls, through the extractor, pipeline,
badge and service),
`middleware/test/verifierExtractionLongClaim.test.ts` (claims longer than a
check takes — one whose tail is not in the answer, one the answer holds word
for word, and the exact length limit — through the same stages),
`middleware/test/verifierClaimExtractorFailure.test.ts`,
`middleware/test/verifierVerdictBinding.test.ts` (injected verdicts whose
status, reason or latency their claims do not back, through the service into
the stream summary and the stored row),
`middleware/test/verifierStoreStates.test.ts`,
`middleware/test/verifierServiceStates.test.ts`,
`middleware/test/verifierServiceResample.test.ts`,
`middleware/test/verifierDeterministicChecker.test.ts`,
`middleware/test/verifierEvidenceJudge.test.ts`,
`middleware/test/semanticAnswerGates.test.ts`,
`middleware/test/channelApi/chatRouterVerifierStates.test.ts`,
`web-ui/app/_lib/__tests__/verifierBadge.test.ts` and
`web-ui/app/_components/chat/__tests__/VerifierBadge.test.tsx`.

### `enforce` is a delivery gate, not a badge

`VERIFIER_MODE=shadow` observes; `enforce` decides whether the user sees an
answer. The wrapper releases an answer only when its bound verdict is
`approved`, or `skipped` because no trigger pattern matched the answer or the
extraction listed no claim in it (`no_trigger`, `no_claims`), and an answer
released on either reason goes out unchecked (`verdictReleasesAnswer` in
`harness-orchestrator/src/verifierDelivery.ts`). That includes an answer whose
figures are all in formats the trigger patterns do not cover (above). Every
other verdict withholds
it; the gate fails closed: `blocked`, `approved_with_disclaimer` (a claim not
confirmed, not checked or not covered), `skipped` with `no_checkable_claims` /
`incomplete_coverage`, and `unavailable`. A withheld answer is replaced by a
localized notice (`composeVerifierBlockedText`, `@omadia/channel-sdk`) marked
`answerSource: 'verifier-blocked'` + `answerIsError: true`. The summary keeps
the badge its verdict earns (a withheld, partly confirmed answer is `partial`,
not `failed`), so the evidence rules above hold for withheld answers too.

- **Stream: no content before the verdict.** `enforcedVerifiedStream` passes
  a closed allowlist of events while the verdict is pending
  (`passesBeforeVerdict`: iteration, routing, persona, tool progress,
  heartbeat, token and usage counters, and `steer_applied`, which echoes the
  user's own steering message) — none carries model or tool output.
  Everything else is held, including any event type added later:
  `text_delta`, `tool_use`, `tool_result`, the sub-agent events
  (`sub_iteration` with its parent call), `nudge` (nudge text derived from
  tool results), `turn_annotation` (plan, recall and knowledge-graph
  payloads), `surface_*` and `done`. A released turn's held events go out
  in order, `done` with `verifier` — except its text deltas: the answer goes
  out as one `text_delta` carrying `done.answer` (without the disclosure
  block) right before `done` (`releasedTurn`) — the same text, and for a
  rendered answer a card released (below) the same real values, that `done`
  hands the same client anyway. The verdict is about
  `done.answer`, and the streamed deltas can say more: the orchestrator
  streams each model response live and may then discard it and run the
  model again (an unmet sub-agent obligation, a file it announced but did
  not build), so a discarded response is in the deltas but never in
  `done.answer`. A withheld turn's held events never go out. The client gets
  one `text_delta` (the notice, without the disclosure block) and a `done`
  rebuilt from an allowlist of identity and telemetry fields: attachments,
  files, follow-ups, masked values, the delegated answer, cards and excerpts
  are dropped. A turn that ends in an `error` releases nothing it held.
- **Released without a verdict, on both paths.** A turn that carries a
  choice card, an MCP input form, a slot picker or an OAuth consent prompt, a
  degraded turn whose answer is the server's turn-incomplete notice, the
  server's privacy refusal (`PROMPT_MASK_BLOCKED_ANSWER`) and inbound
  screening quarantine (`SECURITY_QUARANTINE_NOTICE`) — turns whose model
  never ran; the disclosure block a first turn folds in is set aside to
  recognise them — and a bare `NO_REPLY` (the sentinel as the whole answer:
  a notice would break the agent's deliberate silence) —
  `releasesWithoutVerification`. Only the server notices and `NO_REPLY` are
  sure to state no fact. A card asks the user for
  input, but it rides on whatever answer its turn produced, and that answer
  goes out unchecked — without a verdict, without a badge, with the tool
  output, surfaces and canvas skeleton the turn held. The exemption is
  checked before the privacy gate below, so on such a turn an answer the
  shield rendered goes out unchecked as well. A choice card or an MCP
  input form ends the turn at the tool call, so its answer is the text the
  model wrote before it. Three cards also ride on the `done` of a complete
  answer: `pendingSlotCard` whenever `find_free_slots` queued slots,
  `pendingOAuthConsent` whenever any calendar tool of the turn hit
  `consent_required`, and `pendingUserChoice` when the card-router pass
  (`maybeRouteCardsFromText`, for providers without interleaved tool use)
  attaches a choice card to an answer of 40 characters or more. Narrowing
  the card exemption is an open point (handoff §13). On the stream these
  turns carry the text of their own `done.answer` like a released turn, and
  a bare `NO_REPLY` releases its `done` alone, without the tool traffic that
  led to it. An answer that only ends with the sentinel on its own line is
  verified like any answer: it states whatever precedes it — `isNoReply`
  accepts that form so Teams, Telegram and `/api/chat` stay silent, but no
  stream consumer drops it. `shadow` keeps its narrower rule (choice card
  and degraded turn only).
- **Never verified: what the verifier may not see.** An answer with
  `answerSource: 'privacy-render'` holds real values the shield kept from
  the turn's model, and behind a shield a pass that handed over no privacy
  view (a Direct Line relay) leaves nothing the verifier may read (§6e).
  Neither reaches the pipeline (`verifierGate`): `enforce` records
  `unavailable` with reason `privacy_shield` and withholds the answer, on
  both paths and for every answer it would verify — the first answer, a
  borderline resample and a correction retry; `shadow` records no verdict.
  A degraded turn whose answer the shield had already rendered is a real
  answer, not the turn-incomplete notice, so it is not exempt and is
  withheld the same way; its `done` keeps `degraded` and `committedTools`,
  so the turn still reports its failure. With Privacy Shield v4 rendering
  active, `enforce` therefore delivers a rendered answer, a rendered tool
  error or sign-in prompt included, only on a turn that also carries an
  input card: the card exemption (above) runs first and releases that turn
  unchecked (`releasesWithoutVerification` before `verifierGate`, in
  `VerifierService.chat` and in `enforcedVerifiedStream`).
- **Re-entries.** `VerifierService.chat` runs at most one correction retry for
  a contradiction (`VERIFIER_MAX_RETRIES`, default 1: 0 switches it off, and
  the schema's maximum of 2 still runs one) and a borderline resample
  (`verifier_resample_on_borderline`, default on); the stream runs the
  correction retry too, at most once and not on canvas turns, and holds it
  like the first run. Both deliver the notice when the final verdict does not
  release the answer. No re-entry executes an external call the first run
  recorded again: each one is replayed. A sub-agent whose data the shield
  interned runs again, and its own calls are replayed in turn (next
  subsection).
- **One gate for every consumer.** The kernel route, channel dispatch (Teams,
  Telegram), the public API-key stream and the canvas composer all resolve
  the same wrapped chat agent. Canvas surfaces synthesised from tool results
  are held with those results. The canvas skeleton is model output as well
  (the composer model writes its headings, labels and text from the user's
  request — sent through the plugin's LLM accessor before the turn starts,
  outside the turn's prompt masking; open, handoff §13), so the composer
  holds it while its base declares
  `ChatAgent.holdsContentUntilVerdict` (an enabled `enforce` wrapper): it
  goes out right before a released turn's first surface, or its `done`, and
  never with a withheld or failed turn
  (`omadia-ui-orchestrator/src/verdictHold.ts`). A withheld turn counts as
  `ok` for the operator health signal and the API-key audit: it is a policy
  decision, not a failure — unless it is also degraded (it threw after a
  tool committed), which both still record as a failure.
- **Not covered — by design or still open:**
  - the subscription-CLI runtime (`claude-cli` provider): `buildOrchestrator`
    returns the CLI chat agent before the verifier wrapper, so `VERIFIER_MODE`
    has no effect on CLI-backed agents;
  - proactive routines: the routine runner calls `runTurn` on the raw
    orchestrator, so routine output is neither verified nor gated;
  - persistence: the turn is written (session log, knowledge-graph turn
    node, a possible auto-promoted memory) before `done` — inside the turn
    when no re-entry can follow, otherwise right after the verdict, for the
    pass whose verdict decided (commit-on-delivery, next subsection) — so a
    withheld answer is stored and can reach a later turn's context; the gate
    acts on delivery only;
  - what a released turn carries besides its answer is not checked itself:
    the verdict is about `done.answer`, and tool output, sub-agent traffic,
    nudges, annotations, surfaces and the canvas skeleton's own text go out
    because of that verdict, not their own;
  - a turn that carries an input card goes out without any verdict, the
    answer the card rides on included (above);
  - LLM-free canvas actions and refreshes (a deterministic action or a
    refresh recipe runs the tool directly) involve no model answer and no
    verifier;
  - latency: no answer text arrives before the turn and its verification have
    finished, and on the canvas no skeleton either (its first paint waits for
    the verdict). The kernel route keeps sending heartbeats; the public
    API-key stream and the canvas get only the live events above, so a turn
    without tool calls is silent until the verdict.

Tests: `middleware/test/verifierServiceEnforceStream.test.ts` (what a consumer
holds when the verifier is asked; release, withhold and fail-closed verdicts;
control-flow terminals, `NO_REPLY` and its trailing form; answers Privacy
Shield rendered, degraded or not; failed turns; disclosure and locale;
observer forwarding; `shadow` unchanged),
`middleware/test/verifierServiceEnforceRelease.test.ts` (the released text is
`done.answer`, never a discarded response's deltas),
`middleware/test/uiOrchestratorVerifierEnforce.test.ts` (the canvas skeleton),
`middleware/test/verifierServiceEnforceChat.test.ts` (including rendered
first answers, resamples and retries),
`middleware/test/verifierBlockedText.test.ts`,
`middleware/test/channelApi/chatRouterVerifierEnforce.test.ts` (the public
API-key wire), `middleware/test/chatSessionsMirrorVerifier.test.ts`,
`web-ui/app/_lib/__tests__/chatStreamEvents.test.ts` and
`web-ui/app/_components/chat/__tests__/VerifierBlockedNotice.test.tsx`.

### A re-entry re-generates the answer and replays the first run's calls

A borderline resample and a correction retry used to be complete new turns:
the model was asked again and every tool it called ran again, so a write the
first run had made ran twice for one user request — three times when a
resample turned up a contradiction and the retry followed. The invariant now
is scoped to those re-entries: **a verifier re-entry executes no write** — a
call the request's first run made comes back from the request's ledger (a
sub-agent that interned data behind the shield or ran a bypassed tool runs
again, its own calls replayed: "Sub-agents under Privacy Shield" below), any
other call runs only when it is one of the kernel's reads — on every path a
re-entry takes (`chat()`, the stream, channel dispatch) and in every loop
beneath it (the orchestrator's tool loops, `LocalSubAgent`, a
subscription-CLI sub-agent's loopback dispatch), the dataset import of the
request's uploads included.
Below the ledger nothing re-sends a call while the ledger is bound: every
seam runs its handler sending each call once, so the MCP transport does not
repeat a call after a transient failure ("Below the ledger", further down).
What the ledger does not cover is listed under "What the ledger does NOT
guarantee". A re-entry also sends the model nothing the first run's privacy
rules would have kept from it: its correction hint carries no verifier
evidence and crosses the wire masked like the user's message (§6e), and a
replayed result the shield cannot intern again is withheld, never sent raw.

- **The replay ledger.** `VerifierService` binds a per-request
  `ToolReplayLedger` (`harness-orchestrator/src/toolReplayLedger.ts`) to the
  turn input before the first run, whenever the request can be re-entered
  (`verifierReentry.ts`). It travels through `turnContext.toolReplayLedger` to
  every seam that runs a handler — `Orchestrator.dispatchToolDeadlined`,
  `LocalSubAgent.dispatch`, `ToolDispatchService.invoke` — and each seam asks
  it before the handler runs. The first run records every outcome under
  (seam, tool name, canonical input): the raw result the turn used (recorded
  after the dispatch-deadline firewall, so a late result the turn discarded
  is never handed to a re-entry) or the exception the handler threw. Each
  re-entry starts with `beginReentry()` and reads the outcomes back through
  per-key cursors, so N identical first-run calls replay N outcomes in order
  and a resample followed by a retry replays the first run twice.
- **Same results, this pass's shield.** A replayed result goes through the
  re-entry's own Privacy Shield pass: interned again under the re-entry's
  privacy handle (withheld when that interning fails, as in a first run —
  below), a returned `Error:` text redacted again, a thrown handler
  replayed as the same rejection and withheld again — the raw error text
  never reaches the model. A replayed memory read re-arms the Fresh-Check
  gate; a domain tool's replay re-emits its sub-agent's inner tool events, so
  the trace and the postconditions the verifier reads match the first run;
  and what a replayed tool attached in the first run (a diagram, a generated
  file — handed over through its attachment sink, which a replay does not
  fill) is handed back with it, so a delivered retry carries the same file,
  built once.
- **Uploads are ingested once.** Before the model runs, a turn reads the
  request's uploads, and a tabular one (CSV, XLSX) is imported as a dataset —
  `ingestAttachments` → `importTabularDataset` →
  `KnowledgeGraph.ingestDataset`, an insert with no dedupe. That happens
  outside tool dispatch, so the ledger keeps it separately
  (`ToolReplayLedger.ingestAttachmentsOnce`): the first run's ingestion — the
  extracted text and `[dataset-imported]` blocks before masking, the image
  blocks — goes to every re-entry; the text is masked through the
  re-entry's own prompt map, the image blocks go to the provider as they
  are, as in the first run (the shield masks text only; handoff §13). The
  file is fetched and imported once, and a re-entry's model sees the dataset
  ids the replayed first-run results refer to. A re-entry that
  finds no first-run ingestion to reuse is abandoned before the model runs.
  The ingestion is single-flight: a pass that asks while the first import is
  still running awaits that import instead of starting another.
- **The correction hint is wire content.** The retry's hint quotes the
  contradicted claims, and claims are cut from the answer after the #361
  restore — they can hold the real values the prompt mask kept from the
  model. So the orchestrator masks a caller's `extraSystemHint` through the
  pass's prompt map like the user's message (`wireExtraSystemHint`, both
  paths): the same surrogates, restored in the delivered answer; its masked
  spans on the pass's receipt and so on the request's merged receipt
  (`maskedPromptSpans`); and failure-closed — a re-entry whose prompt cannot
  be masked is abandoned instead of answered with the privacy error, and the
  first answer's verdict decides. The kernel's fresh-check text is not
  masked. Behind a shield the verifier does not send a hint the contradicted
  pass's masking would alter at all (§6e), so a hint is masked once, by the
  retry's own pass.
- **No verifier evidence in the hint.** The checks fetch their evidence with
  the verifier's own access, not with the grants of the user whose turn they
  check: the graph evidence fetcher looks entities up tenant-wide by model
  and name (`res.partner` and `hr.employee` name probes included), the
  deterministic checker re-queries Odoo through the verifier plugin's reader.
  The hint goes to that user's turn model, so `buildCorrectionPrompt` puts
  nothing of it there — no `truth`, no `detail`, not a postcondition's schema
  issues (read off the tool's raw output). It names the claims (the answer's
  own words), the call ids of the turn's own trace and fixed instructions;
  the retry corrects from the turn's own tool results, which it replays, or
  says that a claim could not be confirmed. Evidence content stays with the
  verifier: its judge model and the `verifier_contradictions` table (operator
  database; no route reads it). The retrieval itself stays tenant-wide
  (handoff §13).
- **What may run, what ends the re-entry.** A call the first run did not make
  runs only when the orchestrator knows its tool cannot change data — the
  kernel's `query_knowledge_graph`, `query_dataset`, `read_attachment`,
  `find_free_slots`, the chat roster and a memory `view`. Every plugin, MCP,
  domain and sub-agent tool counts as a write: the plugin contract has no
  read-only declaration, and a missing `writeCapabilities` is not one (the
  sandbox `execute` tool ships none on purpose). Such a miss is refused with a
  neutral, PII-free notice and marks the re-entry abandoned. The buffered and
  the streaming tool loop stop after the batch (post-batch fail-fast), a
  `LocalSubAgent` stops after its batch, and the one authoritative check at
  the end of `runTurnCore` (and on the stream's terminal event) catches what
  a direct-line dispatch or a sub-agent folded into an answer. An abandoned
  resample keeps the first answer; an abandoned retry withholds it with the
  `failed` badge. A recorded MCP input sentinel or connect prompt is not
  replayable (its provenance exists only in the dispatch that produced it),
  and a re-entry of an MCP input-card answer is abandoned before the parked,
  take-once call could run again. So is a re-entry whose prompt cannot be
  masked, and one with no first-run upload ingestion to reuse (above); the
  log names the reason (`REENTRY_ABANDONED`, `describeAbandonment`).
- **Sub-agents under Privacy Shield.** A sub-agent's answer is prose over the
  datasets it interned in the first run's privacy scope, which ended with
  that run. When a domain-tool dispatch bridged such datasets, or ran a
  bypassed inner tool, a re-entry re-runs the sub-agent: its model is asked
  again, every inner call it repeats is replayed at the `subagent:<name>`
  seam and interned in the re-entry's scope, and an inner call the first run
  did not make abandons the re-entry. Any other domain-tool result — and every
  result without a privacy guard — is replayed as it is.
- **One request, one record — the delivered one.** A re-entry fires no
  per-call turn hook (`onBeforeTurn`, `onAfterToolCall`), ingests no replayed
  MCP result into the Knowledge Graph and records no bypass again. Its run
  trace keeps every replayed call, flagged `replayed`. The request's record
  is written once, for the answer the user got (commit-on-delivery,
  `requestTurnRecord.ts`): while a request ledger is bound, no pass — the
  first run included — writes its session-log row or fires `onAfterTurn`;
  each offers the row to `ledger.turnRecord` and notes its answer, and the
  verifier commits the pass it delivers, or for a withheld answer the pass
  its final verdict was about. The commit writes that pass's row with the
  entities of every pass, inside that pass's turn scope (usage attribution,
  identity), then fact extraction and auto-promotion over it, then the
  request's `onAfterTurn` in the first run's hook context;
  `onVerifierBlocked` waits for the commit, so it still follows
  `onAfterTurn`. The stream's `done.turnId` names the committed row, which
  is what save-as-memory promotes. Before, the first run wrote its row as
  soon as it ended, so a delivered retry left the contradicted first answer
  in the session log, the next turn's context and the extracted facts. A
  re-entry no longer sees its own request's first answer in its history.
  Every pass's privacy receipt goes to the ledger (`requestReceipts.ts`) —
  behind a shield once the verifier is done with that pass, so it covers the
  verifier's requests about it (§6e). The delivered answer carries the merge
  (counts of the largest pass, the verifier's request counts summed, lists
  united), and the request has ONE `turn_receipts` row, written once with
  that merged receipt under the turn id of the first pass that had a
  receipt — first in pass order (the pass number is taken when the pass
  starts), whatever order the passes are finalized in; `done.receiptId`
  names it. An abandoned pass's receipt is merged too — its model saw the
  replayed results — and so is the receipt of a pass that threw or that the
  client left before `done`, which the orchestrator closes itself (§6e).
  Each offers to own the row like any pass. Neither takes it from a first
  run that had a receipt; a request whose only receipt is theirs still gets
  its row (the first run had no shield activity, and a retry read live and
  was then abandoned), and so does a request whose first run threw.
- **Detached work keeps out of the request.** A long-running task's runner
  (`<tool>_start`, e.g. a deferred sub-agent) keeps working after the turn —
  in `enforce` also while the verifier re-enters the request — so it starts
  under `runDetachedFromRequestLedger` with a turn-local ledger of its own:
  its inner calls execute, only an identical repeat of a call whose outcome
  is unknown is refused, within the task. Inheriting the request's ledger,
  every call it made after `beginReentry()` was refused as a miss (failing
  the task and abandoning the running re-entry) or handed a first-run
  result, and the request's raw results stayed alive with the runner.
- **No repeat of an unknown outcome.** Every turn carries a ledger — a
  turn-local one that keeps no results when no verifier bound one. A call
  whose handler threw, or whose wrapper returned the withheld exception
  notice, may have taken effect; an identical repeat within the request
  (same tool, same canonical input, at any seam) is refused unless the tool
  is a kernel read. That closes the repeat in the orchestrator's own loops
  and in a subscription-CLI sub-agent's loopback dispatch; `LocalSubAgent`'s
  own per-run refusal (§6c) stays.
- **The operator switch.** `verifier_resample_on_borderline` (seeded from
  `VERIFIER_RESAMPLE_ON_BORDERLINE`, default `true`) turns the borderline
  resample off.
- **One ledger per request; failures logged without content.** A request's
  ledger is bound to the request's own input object, and an input that
  already carries another ledger is refused (`bindToolReplayLedger` throws):
  two requests sharing one input object would replay each other's tool
  results. A resample re-binds the request's own ledger. A re-entry that
  threw is logged with the run id, the error's class and a closed code
  (`reentryFailureLine`, `reentry_turn_failed`), never with the error's
  message, which can quote a tool's or a provider's output.

What the ledger does NOT guarantee: it lives in one process for one request.
A new message, a retried HTTP call or another middleware instance runs its
tools again, and a canvas turn is not retried on the stream. Inputs must
match exactly after key ordering, so a re-sampled model that phrases a write
differently is abandoned rather than matched loosely. A turn without a
verifier still runs two identical SUCCESSFUL calls twice (first-run behaviour
is unchanged), and a subscription-CLI sub-agent's obligation re-prompt (a
second CLI spawn inside one request) is only told, not prevented, not to
repeat a write that succeeded. Below the ledger, for a first run and a
replay alike:

- **MCP transport retry.** The MCP client retries a call once after a
  transient transport failure (`mcp/mcpClient.ts`, `MCP_CALL_MAX_ATTEMPTS`),
  and a transient failure cannot tell "never executed" from "executed, reply
  lost". It makes one attempt only under an exactly-once idempotency scope
  (`ToolDispatchService`, for a write-capable tool dispatched with an
  idempotency key — today the public MCP endpoint's `_meta.idempotencyKey`)
  or while a request ledger is bound: every seam — the orchestrator's
  dispatch, `LocalSubAgent`, `ToolDispatchService`, the MCP input-card
  replay — runs its handler through `runHandlerAtMostOnce`
  (`toolReplayLedger.ts`), which publishes `sendsEachCallOnce`
  (`toolIdempotency.ts`). That signal has its own AsyncLocalStorage, so the
  turn-context re-scopes of the skill-binding and plugin `ctx.mcp` paths keep
  it; a long-running task's runner started inside the request inherits it.
  A lost reply then reaches the model as the MCP error. A turn without a
  request ledger — `shadow`, a disabled verifier, `enforce` with no re-entry
  allowed, a canvas stream — keeps the one retry (#542), so there an MCP
  write whose reply was lost can still run twice (handoff §13).
- **Interning failures fail closed.** When interning a tool result under the
  shield throws (`internToolResultV4`), every seam that interns — the
  orchestrator's dispatch, `LocalSubAgent`, `ToolDispatchService`, the MCP
  input-card replay — hands the model the kernel's notice instead
  (`internFailedNotice`, `privacyInternPolicy.ts`: the call ran, its result
  was withheld, do not call it again for the result; `query_dataset` keeps
  its own wording), on a replay as on a first run. The raw result used to go
  to the model, so on a re-entry a result the first run had interned could
  reach the model raw, and from its answer the verifier's claim extractor.

The correction hint is masked with the same detectors as the user's message,
so a value no detector recognises reaches the model as it does in the
message; with prompt masking off (the default) nothing is masked, but the
hint still carries no verifier evidence. The open points are in handoff §13.

Tests: `middleware/test/toolReplayLedger.test.ts`,
`middleware/test/toolReplaySeams.test.ts` (the standalone dispatcher with and
without an ambient ledger, the MCP input-card and direct-line aborts),
`middleware/test/verifierServiceWriteSafety.test.ts` (resample, chained
resample and retry, abandoned re-entries, read-only misses, thrown and
returned errors replayed through the shield),
`middleware/test/verifierStreamRetry.test.ts`,
`middleware/test/verifierReentryRecords.test.ts` (trace flag, hooks, session
log, the one receipt row, Knowledge-Graph ingestion),
`middleware/test/verifierDeliveredTurnRecord.test.ts` (the delivered pass's
row, facts, `onAfterTurn` and `done.turnId`; withheld and abandoned
re-entries; the pass's turn scope), `middleware/test/requestTurnRecord.test.ts`,
`middleware/test/longRunningTaskReplayLedger.test.ts` (a detached task runner
across a re-entry), `middleware/test/verifierSubAgentReplay.test.ts`,
`middleware/test/verifierResampleKillSwitch.test.ts`,
`middleware/test/orchestrator/parentLoopThrownCallRepeat.test.ts`,
`middleware/test/verifierReentryAttachments.test.ts` (one dataset import
across a resample and a retry on `chat()` and the stream; a re-entry without a
first-run ingestion), `middleware/test/mcpWriteIdempotency.test.ts` and
`toolReplaySeams.test.ts` (no transport re-send while a request ledger is
bound, at every seam), `middleware/test/orchestrator/internFailureFailsClosed.test.ts`
(an uninternable result withheld, on a replay too),
`middleware/test/verifierCorrectionHintPrivacy.test.ts`
(a hint the masking would alter never reaches the wire, on both paths; one
that passes reaches the retry once masked, without evidence),
`middleware/test/correctionPromptEvidence.test.ts` and
`middleware/test/verifierReentryHardening.test.ts` (the failure log line, a
second ledger on one input).

### Evidence judge: a verdict counts only with a citation its request printed

The answer verifier (`@omadia/verifier`) hands every soft claim (names,
qualitative statements) to `EvidenceJudge`: an LLM call that sees the claim and
a bundle of evidence snippets, never the answer, and must reply through the
forced `record_verdict` tool. Each snippet appears in the prompt as
`Evidence #N [nodeId=<ref>, source=…]`, and a `verified` or `contradicted`
verdict has to name the snippet it rests on in `evidence_node_id`. The ref is
the snippet's node id without a Privacy Shield; behind one it is a handle
minted for that one request (`ev-1`, `ev-2`, …), and the node id never leaves
the process (§6e).

That tool input is untrusted model output. The provider interface does not
guarantee schema conformance, so any string can come back as the id. Checking
only that the id is non-empty is not enough: an id that names no snippet would
still yield a `verified` verdict, with its `source` taken from the claim's own
`expectedSource`, and a made-up citation would earn the `verified` badge and
skip the #132 borderline resample. The rules:

- The citable refs are exactly the ones the request printed — the handles of
  the snippets it carried behind a shield (at most three), the node ids
  without one — and the cited ref is checked against them by exact match
  after trimming. Refs are opaque (for example `odoo:hr.employee:7` or
  `ev-2`), so there is no case-folding or prefix matching. Behind a shield a
  node id is therefore never citable, and a handle beyond the snippets the
  request carried is not either.
- A ref outside that set demotes the verdict to `unverified`, the same
  outcome as a missing one. A printed ref resolves server-side to the snippet
  printed under it; nothing falls back to a value derived from the claim: a
  verdict's `source` and `truth` come only from that snippet.
- The contradiction recheck (the second, independent call that must agree
  before a contradiction blocks) is parsed under the same rule, so a recheck
  citing an unknown id does not confirm the contradiction. `check()` resolves
  the snippet again before a recheck is spent, so the rule holds even if the
  parser changes.
- There is no switch to turn the check off. The tool schema already declares
  the id required for `verified` and `contradicted`, and the check's off-state
  is exactly the unearned badge described above.

Trade-off: a genuine contradiction whose citation the model mistypes counts
as an unconfirmed claim, not as a contradiction: `partial` in `shadow`; in
`enforce` the answer is withheld like any answer with an unconfirmed claim,
but no correction retry is bought for it. That is accepted because a
contradiction must point at evidence by contract, and the deterministic
checker (hard claims, anchored Odoo records, the trace cross-check) still
blocks on its own.

Each unknown-ref demotion is logged as `[verifier/judge] evidence_node_id not in
evidence set, downgrading to unverified claim=<id> cited_len=<n>`: the claim id
the extractor assigned (`c_001`, …) and the length of the cited ref, nothing
else. The cited ref itself is never logged. It is model output and can repeat
anything the judge was shown, including claim text and evidence content that
may hold personal data or credentials. It can also carry characters that break
or disguise a log line, such as U+2028/U+2029 line separators, ANSI escape
sequences or bidi overrides, and JSON quoting leaves some of those intact. An
id-shaped value is not echoed either, because a name or a token can look like
an id. The claim text is not logged, and the demoted verdict carries a fixed
reason string, so the cited id goes no further in the verdict.

The check proves that the judge cited a snippet it was shown, not that the
snippet supports the verdict; that remains the judge's call. Asserted by
`test/verifierEvidenceJudge.test.ts` and, behind a shield,
`test/verifierEvidenceHandles.test.ts`.

### Evidence lookup: an entity handle resolves exactly its record

The answer verifier's evidence judge (`EvidenceJudge`) sees only the snippets
`GraphEvidenceFetcher` hands it — never the answer, never the graph itself. So
which node the fetcher picks decides what "verified" means. The claim
extractor attaches entity handles to each claim (`related_entities`:
`odoo:hr.employee:7`, `hr.employee:7`, or a bare model such as
`hr.department`), and the fetcher treats them as follows
(`middleware/packages/harness-verifier/src/graphEvidenceFetcher.ts`,
`entityHandle.ts`):

- **An id-bearing handle names one record.** It is resolved with
  `findEntities({ model, id })` (plugin-api 1.21.0; both backends compare
  `props.id` as a string, so `7` and `'7'` are the same record). The fetcher
  re-checks `props.model`, `props.id` and, for a three-part handle,
  `props.system` on whatever comes back: `knowledgeGraph` is a plugin-provided
  capability, and a provider compiled against the contract before `id` existed
  ignores the option and returns any record of the model. A record that is not
  in the graph contributes nothing; another record of the same model is never
  substituted.
- **A claim that pins a record gets only its pinned records.** No model-wide
  sample and no name search is added, so a claim whose records are all missing
  has no evidence and ends `unverified` — fail closed, never a sibling record
  that happens to verify or contradict it.
- **Search results are labelled.** Only claims without an id get a model sample
  (bare `hr.department`, or the system-qualified `odoo:res.partner`) and the
  capitalised-name search on `res.partner` / `hr.employee`. Those snippets say
  "model sample, not a referenced record" or "name match, not a referenced
  record" in title and content, so the judge — and a stored contradiction that
  falls back to snippet content — can tell a search hit from a resolved record.
- **The judge is bound to the pinned record.** Its prompt states that a snippet
  about another record of a model RELATED pins is a different entity, and
  `EvidenceJudge` enforces it deterministically: a `verified` or `contradicted`
  verdict citing a node of a pinned model with a different id is demoted to
  `unverified`, on the first call and on the contradiction recheck alike.
  Behind a Privacy Shield the judge cites per-request handles; the check runs
  server-side on the node id the cited handle resolves to, so it holds there
  too.
- **`nameContains` is a search, not an identity.** `'7'` matches records 7, 17
  and 70 and every display name containing it. Code that starts from an entity
  handle passes `id`.

The deterministic checker applies the same primitive: `checkGraph` looks an
`odooRecord.id` up by exact id and re-checks the hit (it used to substring-match
the claim value, so "42" was also satisfied by 142 or "Halle 42"). A miss leaves
that claim `unverified` too. The graph is a partial mirror of Odoo master data,
synced periodically, so a record missing from it is not shown to be false; a
`contradicted` verdict would hand the correction retry a "record not found"
together with the instruction not to re-check it, which is wrong for any record
created since the last sync. The substring path for claims without an id (a
document reference or name) is unchanged and still reports a miss as
`contradicted`.

Why a filter on `findEntities` rather than a node-by-id read: two-part handles
(`hr.employee:7`) carry no `system`, so an external-id read of
`odoo:hr.employee:7` would have to guess the namespace. The Neon backend's
private external-id lookup is therefore not the fix for this path and should not
be "rediscovered" as one.

Limits, stated so nobody reads more into "exact id" than it covers:

- `findEntities` returns `OdooEntity` and `ConfluencePage` nodes only. A handle
  in a plugin namespace (`PluginEntity`, e.g. `dataset:…`) never resolves, with
  or without `id`, and such claims get no graph evidence.
- This is an integrity rule for verifier evidence, not an access control.
  `findEntities` returns every match in the graph's tenant and applies no
  per-user, per-chat or per-agent scope.

Tests: `middleware/test/verifierGraphEvidenceFetcher.test.ts` (fetcher and
judge, including a provider that ignores `id`),
`kgFindEntitiesById.test.ts` / `kgFindEntitiesById.pg.test.ts` (the exact-id
contract on both backends, tenant scope on Neon), and the graph cases in
`verifierDeterministicChecker.test.ts`.

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
  first-boot DSN here too. On installs first set up with password
  authentication it names the restricted `omadia_kernel` role and carries
  that role's password; an upgraded install keeps its older passwordless
  DSN, which the new `pg_hba.conf` refuses and the live `DATABASE_URL`
  overrides (§8b).
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
  needed. The server starts with `-c hba_file=<pgdata>/pg_hba.conf`
  (`desktop/src/embeddedDbEngine.ts`, which also runs `initdb` and the
  single-user repairs), so `postgresql.auto.conf` cannot point it
  elsewhere. No rule depends on the
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
- **The kernel vault's copy of the DSN.** The kernel freezes its first-boot
  `DATABASE_URL` into its vault (`database_url`, §8) only when the database
  plugin is first installed. On an install first set up with this version
  that copy carries the kernel role's password, encrypted with `VAULT_KEY`;
  an upgraded install keeps its older passwordless superuser DSN, which the
  new `pg_hba.conf` refuses. On the desktop the live `DATABASE_URL` wins
  (`OMADIA_EMBEDDED_DB=1`), so neither a stale copy nor one left behind by a
  password repair is ever used.

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
privacy-guard's prompt masking and receipt behavior apply identically. That
includes the answer verifier's post-turn model requests: they run under the
turn's own privacy view and are booked on the same receipt (§6e).

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
    backstop behind the event rules above.
  - Every other permission is deny by default too. The request and check
    handlers share one rule (`canGrantPermission`): a permission is granted
    only if it is on `GRANTABLE_PERMISSIONS` and the main frame of one of the
    app's own documents asks, a page on the kernel or web UI origin or the
    bundled wizard (compared by file path). The list holds
    `clipboard-sanitized-write` for the copy buttons. Subframes never get a
    permission, not even on the web UI's origin, where plugin UIs and the
    builder preview run. A same-app popup gets only what the list allows, and
    a foreign page reached by a redirect gets nothing.
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
and `POST /renew`, and so do the checks an open builder event stream runs
with every heartbeat (below). `GET /me` runs the same check, so the UI's
60 s heartbeat notices a revocation within a minute. There is no cache, so a
revocation holds from the next request on, on every replica. An open channel
WebSocket honours it from its next frame once its last check is
`WS_SESSION_FRAME_RECHECK_MS` (5 s) old, and within 60 s while it is idle.
An open builder event stream honours it at its next heartbeat (25 s).

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
that user's open channel WebSockets (§10d) and builder event streams on this
replica at once.

**Open builder event streams.** `GET /api/v1/builder/drafts/:id/events`
(`routes/builderEvents.ts`, `routes/builderEventsSession.ts`) is a
server-sent-events stream that stays open while a draft is on screen.
`requireAuth` checks the session once, when the request arrives. From then on
the stream is bound to that session the way a channel socket is. It ends at
the token's `exp`, and an event due after `exp` is dropped even if the expiry
timer runs late. It ends at once when `announce` reports a revocation of its
owner on this replica. It also ends when `evaluateSessionToken` refuses the
token on a later check (revoked, de-whitelisted, no longer verifying). That
check runs right after the stream opens, which covers a revocation that
landed before the listener existed, and with every 25 s heartbeat, which
covers a revocation made on another replica. After the end the route writes
nothing more, and the bus subscription, the heartbeat, the expiry timer and
the revocation listener are gone. A request without the session cookie or an
`exp` gets a 401 and no stream. A check that fails or misses its 10 s deadline
is an outage, not a verdict: the stream stays open, still bounded by its
`exp`, and the next heartbeat checks again. The browser's `EventSource`
reconnects through `requireAuth` 3 s after a stream ends, so a revoked or
expired session gets its 401 there, and a renewed cookie opens a fresh stream
bound to its own `exp`.

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
- An open builder event stream learns of a revocation made on another
  replica at its next heartbeat check, so up to 25 s of that draft's events
  can still reach it. On the replica that revoked it ends at once. While the
  check cannot run (database unreachable), the stream stays open until its
  `exp` or until a check answers again.
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
  An open builder event stream costs one read when it opens and one per
  heartbeat (25 s).
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
and `middleware/test/auth/liveSocketRevocation.test.ts` (§10d). For open
builder event streams, `middleware/test/builder/builderEventsSession.test.ts`
(expiry, a revocation on this replica and on another, outage, cleanup, on
mocked timers) and `middleware/test/builder/builderEventsRoutes.test.ts`
(the end on a real socket).

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

## 10n. Credential broker egress (#578, #778 S3a)

`CredentialBroker` (`middleware/src/credentials/broker.ts`) stamps a
`service` credential onto an outbound request so the caller never holds the
secret. Its checks (credential, grant, host, method, path) decide whether
the request may leave. Once it has left, the upstream answers, so the
boundary has to cover the response too. S3a hardens both sides before any
agent can reach the broker (#778 S3b wires the agent tool): on the request
side, the caller-header allow-list with undici's own value check, the
GET/HEAD-with-body refusal (`invalid-request`), the declared-host check and
the `pathPrefixes` match on the wire path; on the response side, manual
redirects, the time and size bounds, the secret scrub and sanitized
failures.

- **Redirects are never followed** (`redirect: 'manual'`). A 3xx comes back
  as its status plus a scrubbed `location`. The Fetch spec strips
  `Authorization` on a cross-origin redirect but not custom headers, so a
  followed redirect would carry an `X-Api-Key` to whatever host the upstream
  names. This is the same reasoning as `providerCredentialVerifier.ts`.
- **Time and size are bounded.** One `AbortSignal.timeout` covers headers
  and body (default 20 s, `BROKER_DEFAULT_TIMEOUT_MS`). The body is read as
  a stream under a byte cap (default 1 MiB, `BROKER_DEFAULT_MAX_RESPONSE_BYTES`),
  and the stream is cancelled at the cap rather than drained. The response
  says `truncated: true`. The cap is a memory bound; the agent tool applies
  its own, tighter context bound.
- **The secret is scrubbed from the response**, header values (including
  `location`) and body, in every form it travels in: raw, base64 (what
  `basic-password` sends), URL-encoded (what `query-param` sends) with the
  `+`-for-space and `URLSearchParams` variants and `%XX` hex matched
  case-insensitively, the WHATWG-URL form (below), the JSON-escaped form
  (`\"`, `\\`, `\n`) for an upstream that echoes the request as JSON, and
  the PHP `json_encode` form (Laravel, Symfony) that also escapes `/` as
  `\/`, for the raw secret and for its base64. Echo endpoints and error pages
  that reflect the request otherwise hand the secret straight back. For
  `basic-password` the password segment of `user:pass` is scrubbed on its
  own too. The forms are built from what goes on the **wire**, not only from
  the stored value: undici trims leading and trailing HTTP whitespace from a
  header value, so a secret stored with a copy-paste newline or space leaves
  trimmed, and every base also contributes its trimmed variant; and fetch's
  WHATWG URL parser sends `'` as `%27`, which `encodeURIComponent` leaves
  alone, so that form is built too. When the body
  is truncated, the tail that could hold a prefix of a secret cut by the cap
  is dropped after scrubbing (`brokerResponse.ts`).
- **The 8-character floor.** Secrets (and password segments) shorter than 8
  characters are **not** scrubbed: redacting a short value would shred
  ordinary text and still not be a guarantee. Refusing such a secret at
  creation time is #778 S2's job.
- **Caller headers pass a static allow-list** (`brokerOutbound.ts`):
  `accept`, `accept-language`, `content-type`, `content-language`,
  `if-match`, `if-none-match`, `if-modified-since`, `if-unmodified-since`,
  `idempotency-key`, `user-agent`. Names are compared case-insensitively,
  the credential's own `injectionKey` is always dropped (even when an
  operator declared an allow-listed name such as `User-Agent` as the
  injectionKey), and a value with any character outside tab, 0x20–0x7E and
  0x80–0xFF is dropped. That is undici's own check: CR/LF/NUL could split the
  request, and undici refuses every such value locally, which would fail the
  call after the `once` grant is consumed. There is no `x-*` wildcard. That namespace holds
  `X-HTTP-Method-Override`, `X-Original-URL` and `X-Rewrite-URL`, which
  would bypass `allowedMethods` / `pathPrefixes`, and case variants of the
  injected header, which `Headers` would join into `forged, Bearer <secret>`.
  `accept-encoding` is excluded so the scrub never sees bytes fetch did not
  decode. Dropped header **names** (never values) go on the `allow` audit
  event as `droppedHeaderNames`; the request itself still goes out.
- **A malformed request is refused before any grant is consumed.** A GET or
  HEAD with a body (even an empty one) is denied as `invalid-request` right
  after path normalisation. fetch would reject it locally, after the `once`
  grant was consumed and the `allow` audited, as a misleading
  `upstream-unreachable`. `timeoutMs` must be a positive integer no greater
  than 2^31 - 1 and `maxResponseBytes` a positive safe integer; the
  constructor throws a `RangeError` otherwise, because a NaN or too-large
  timeout would throw (or, at 2^31, fire after 1 ms) after the grant is
  consumed and a NaN cap would remove the memory bound.
- **`pathPrefixes` hold for the path that goes on the wire.** The path
  check used to run on `path.posix.normalize` output, but fetch re-parses
  the URL with the WHATWG parser, which also resolves percent-encoded dot
  segments (`%2e%2e`, `.%2E`, `%2e.`), reads `\` as `/` and strips tab, LF
  and CR. So `/v1/messages/%2e%2e/%2e%2e/admin/users` passed the check for
  `/v1/messages` and left as `GET /admin/users` with the secret attached,
  while the `allow` audit recorded the unresolved path. (This predates S3a;
  the slice closes it because it owns the URL builder.) Now
  `normalizePathForMatch` refuses a backslash in the path and any C0
  control or DEL as `path-not-allowed`, and the broker resolves the path
  exactly as fetch will (`resolveWirePath`, an absolute
  `new URL('https://' + host + path)`, never a relative resolution that a
  `/\evil.example.com` path could re-target), matches `pathPrefixes`
  against that, audits it and sends it. The checked, audited and sent path
  are one string, and all of it happens before a `once` grant is consumed.
  A declared host that is not a plain `host[:port]` (userinfo, a path, an
  invalid port) is denied as `invalid-broker-declaration` at the same step.
  An encoded slash (`group%2Fproject`, GitLab-style IDs) is deliberately
  **not** refused. The declared prefix goes through the same two steps
  (`path.posix.normalize`, then the WHATWG serialiser), so a prefix with a
  space, a non-ASCII character or a brace (`/drive/My Files`, `/v1/über`,
  `/api/{tenant}`) matches its percent-encoded wire form instead of
  refusing every request. A prefix that serialising would widen or rewrite
  (a percent-encoded dot segment, `?`, `#`, `\`, a control character)
  matches nothing.
- **Failures are sanitized.** A timeout is denied as `upstream-timeout`,
  anything else as `upstream-unreachable`. The thrown `BrokerDenialError`
  carries no `cause`, no URL and no upstream message, because for
  `query-param` the URL is the secret. Both reasons count in
  `brokerMetrics.ts` and toward the denial-streak alert, whose message
  therefore reads "refusing every request or its upstream is failing";
  `byReason` tells the two apart. A failed dispatch writes **two** audit
  events, in this order: `allow` (just before the secret leaves) and then
  `deny` with the upstream reason. An audit sink must read the pair as "the
  secret left, no usable answer came back", not as a contradiction.

**Known residuals.** Vendor headers such as `Notion-Version` need a
per-credential `allowedHeaders` (a schema change, #778 S2/S3b). An upstream
(or a proxy in front of it) that decodes `%2F` and then normalises the path
again can still be walked out of a prefix with `..%2F`; the broker cannot
see that server-side decoding, and refusing `%2F` would break encoded IDs.
Operators should declare the narrowest prefix the upstream API allows. The scrub
does not cover other transformations of the secret, such as JSON `\u`
escapes, partial URL encodings (e.g. `/` left unencoded), base64 of the
password segment alone, or hashes. Upstream `set-cookie` passes through
(the scrub only redacts secret forms): the request side drops `Cookie` as
ambient authority, but a session cookie the upstream issues reaches the
caller; S3b decides whether to drop it. `upstream-timeout` /
`upstream-unreachable` are thrown after the secret has left, so the S3b
agent tool must present them as "sent, outcome unknown", not as a refusal,
or a non-idempotent POST gets retried blindly. The default fetch is plain `globalThis.fetch`, not
`guardedOutboundFetch`: the destination host is operator-declared and must
match exactly, and operators may broker to intranet hosts on purpose.
These and the other S2/S3b preconditions (the unenforced
`credential:broker:use` gate, the unsalted `fingerprintSecret`) are tracked
in `docs/middleware-agent-handoff.md` §13.

Tests: `middleware/test/credentialBrokerEgress.test.ts` (a real local HTTP
upstream: echo in every encoding, a cross-origin 302, a trickling upstream,
a 50 MB body, forged headers, a secret-bearing fetch error),
`middleware/test/credentialBrokerEgressRequest.test.ts` (whitespace-padded
secrets, a `'` in a query-param secret, header values undici refuses, a
GET/HEAD body against a `once` grant, an allow-listed injectionKey),
`middleware/test/credentialBrokerWirePath.test.ts` (percent-encoded,
backslash and control-character traversal against a `once` grant; the
audited path equals the path the upstream received),
`middleware/test/credentialBrokerOutbound.test.ts` (the header-filter rules)
and `middleware/test/credentialBrokerResponse.test.ts` (forms, the floor, the
cap straddle).

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
- [ ] A graph lookup that starts from an entity handle (`model:id`,
      `system:model:id`) passes the id as `findEntities({ id })` and re-checks
      the returned node's model and id; it never feeds the id to `nameContains`
      and never falls back to a model-wide or name search for that record
      (§7c).
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
- [ ] A new consumer of `VerifierVerdict` or `VerifierResultSummary` shows
      `verified`, `partial` or `corrected` only when a check settled a claim:
      `hasVerificationEvidence()` for a verdict, `verifierSummaryHasEvidence()`
      for a summary (a contradicted claim for `blocked`, otherwise
      `claimCount - contradictionCount - unverifiedCount > 0`), and green or
      `corrected` only when every claim was confirmed. `skipped`,
      `unavailable` and verdicts whose claims all stayed unconfirmed never map
      to a green badge, and a verifier `reason` stays a closed code (§7c). A
      verdict from the injected pipeline is bound to its claims
      (`bindVerdictToClaims`) before anything acts on it. A summary is
      untrusted input: a gate never reads a missing count as 0 and backs no
      badge with counts that contradict each other.
- [ ] A verifier stage that cannot do its work (a failed LLM call, a model
      response it cannot read, cut off at the token limit or with an entry
      that breaks the schema) never returns an empty or partial result: claim
      extraction rejects, so the pipeline reports `unavailable`, and a
      per-claim checker marks that claim `unverified` with
      `cause: 'check_failed'`. A claim the pipeline does not check stays in
      the verdict as `not_checked` instead of being dropped. None of these may
      look like "nothing to check" or "fully checked" (§7c).
- [ ] A verifier stage that reads only part of its input by design (a text
      window, a limit on how many claims a model may list) reports what it
      left out, and the pipeline keeps it in the verdict as `not_checked`. A
      prompt never tells a model to stop at a limit unless a list that
      reaches the limit is recorded as possibly incomplete. A guard that
      keeps model output from the checkers (the verbatim guard) reports what
      it kept out as a gap instead of dropping it, and matches the whole
      claim: a claim's text is never cut to a length before the guard or a
      check sees it, and a claim too long to check is a gap, not a shortened
      claim. A model response is read in full — every tool call, not the
      first one (§7c).
- [ ] A new `ChatAgent` wrapper or stream consumer releases nothing of an
      `enforce`-mode turn before the verdict: no `text_delta`, tool output,
      surface or `done` — nor content the wrapper adds itself (like the
      canvas skeleton) while its base declares `holdsContentUntilVerdict`.
      An event type added to the live allowlist (`passesBeforeVerdict`)
      carries no model or tool output, and a verdict other than `approved` or
      `skipped` with `no_trigger` / `no_claims` withholds the answer. A
      released turn's text is the text of its `done.answer`, never the deltas
      the model streamed. A new exemption from verification
      (`releasesWithoutVerification`) is limited to turns whose answer states
      no fact; the existing card exemptions already release the answer a
      card rides on unchecked (§7c), so they are not a precedent to widen.
      An answer the verifier may not see — `answerSource: "privacy-render"`,
      or behind a shield a pass that handed over no privacy view — is never
      passed to the verifier pipeline (`verifierGate`); `enforce` withholds
      it. A turn
      marked `answerSource: "verifier-blocked"` is a withheld answer: its
      `answer` is the notice, and nothing of the original answer reaches the
      client (§7c).

- [ ] A change to `CredentialBroker` dispatch keeps `redirect: 'manual'`,
      the timeout signal, the streaming byte cap, the response scrub and the
      caller-header allow-list, and a new allow-list entry is not an `x-*`
      override header (§10n).
- [ ] A change to how `CredentialBroker` builds the outbound URL matches
      `pathPrefixes` on the same path fetch sends (`resolveWirePath`), not
      on a string-level normalisation of the caller's input (§10n).
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
      `embeddedDbAuth.ts`, `embeddedDbOwnership.ts`, `embeddedDbEngine.ts`,
      `embeddedDbEndpoint.ts`) never writes a `trust` rule
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
- [ ] A new model call made after `runTurn` / `chatStream` produced the
      answer (verifier stages, extractors, judges, any post-turn pass) sends
      only what the `PrivacyEgressContinuation` view of the pass whose answer
      it checks holds or returns (the pass's recorded wire view, a
      projection) — never the caller's own input (it may still be an MCP
      input-card envelope) and never text handed to a bare `LlmProvider` —
      and that pass's `finalize` runs after the call, exactly once, also on
      the error path (§6e). A new finalize site in
      the orchestrator hands over when the turn was held. An item such a
      request asks the model to cite (an evidence snippet) is named by a
      handle minted for that request and resolved server-side, never by its
      record or node id (§6e).
- [ ] A new tool-dispatch seam that hands a result to a model opens an
      `McpAuthPromptMint` around the dispatch, decides with
      `isGuardedControlFlowResult(result, mint)`, routes that text through
      `guardControlFlowResult` with the same mint, and never forwards a
      thrown handler exception's message (`withholdThrownToolError`); see
      `toolErrorRedaction.ts` and `mcp/mcpAuthPromptMint.ts` (§6c). No seam
      passes a result because of its prefix alone. A new tool wrapper that
      catches an exception returns `toolErrorFromException(...)`, not
      `Error: ${err.message}`; only text the wrapper authors itself may reach
      the model, and the seam still redacts it. A typed error's message
      counts as authored only when nothing foreign is folded into it: a
      caught exception goes on `cause`, an upstream response body on a
      separate field, and the wrapper builds its result from typed fields
      (status, provider id), not from the message.
- [ ] A host that runs tool handlers outside a chat turn makes its privacy
      handle the ambient `turnContext.privacyHandle` while a handler runs
      (`runHandlerInPrivacyScope`, as `ToolDispatchService` does), so nothing
      beneath the handler — a sub-agent's model loop above all — calls a model
      without the guard; a host that requires masking runs no handler without
      a handle (`requirePrivacyHandle`). A new `turnContext.run(...)` re-scope
      on that path carries `privacyHandle` over (§6c).
- [ ] A new cell or value path in `@omadia/plugin-office` stores no
      caller-supplied formula result (formula cells are `{ formula }` only),
      passes no caller-supplied object to exceljs, header included (exceljs
      reads any object by its shape, §5a; a formula cell is rebuilt as
      `{ formula }`; `office-cell-values.test.ts` pins it), and runs every
      formula through the formula policy (`formulaPolicy.ts`, §5a:
      `assertFormulaStaysInWorkbook` for a cell,
      `assertComputedColumnStaysInWorkbook` for a template). A function added
      to `formulaFunctions.ts` has been checked to compute only over the
      workbook. An exceljs upgrade re-checks which characters its XML encoder
      changes against `formulaText.ts`. `office-formulas.test.ts` pins all of it, with rejected-formula
      rows for every refused function family and reference form.
- [ ] A new directory with its own `package.json` + `package-lock.json` is a
      leg of the `audit (high+critical block)` matrix and has an npm block in
      `.github/dependabot.yml` (§4a). `audit-scope.test.mjs` catches a missing
      matrix leg; the Dependabot block is on the reviewer. Its `(<dir>)`
      status context becomes a required check on `main` after the merge, not
      before: an admin adds it only once the PR that adds the leg is on
      `main`, because a required context that never reports blocks every open
      PR. The PR records that admin step as an open point (handoff §13).
- [ ] An Electron major bump in `desktop/` moves `@types/node` to Electron's
      embedded Node major in the same PR. Before it merges, a `desktop-apps.yml`
      dispatch build of the PR branch (throwaway tag) has passed on all four
      targets, including "Verify native modules load under the Electron ABI"
      and afterPack's checks of the packaged runtime and the macOS update floor
      (§4a): a push to `main` releases through that same workflow. That build
      has also passed `desktop-upgrade-smoke.yml` (`desktop/README.md`): a fresh
      install and an install over the latest release on macOS, Windows and
      Linux, with `secrets.enc` left byte-identical. The new runtime's
      `safeStorage` has to decrypt the vault key, and a runtime that cannot must
      stop the app, never re-key it. A build is never tried on real data: one
      installed by hand takes no pre-update snapshot (only the updater's
      install preflight does), and its kernel migrations run forward-only.
- [ ] A sentence in the README, `docs/architecture.md`, this document or
      `CITATION.cff` that promises a security property names the control that
      enforces it and that control's default. Words like "signed", "verified",
      "never" and "every" stand only where a check runs on the default path, and
      an opt-in control (`verifier_enabled`, `mask_user_prompt`,
      `human.strictApproval`) is called opt-in (§3a, §4, §6d, §7a,
      `docs/ai-act-transparency.md` §6). A limit the code puts on such a
      property, like an exemption list, a fail-open branch, a replayed chat
      history or a best-effort write, is named where the property is claimed
      (§6f, §7b), and a tool added to `INTERN_EXEMPT_TOOLS` is listed in §6f.
      A claim about what the shield keeps from the model names the model
      requests it masks and the setting each one needs, the memory jobs'
      stored text among them, and then says that every other model call
      sends its text as it is, naming the in-tree ones: the inbound security
      screener, turn scoring, `ctx.llm` calls, images and embeddings (§6f).
      A claim that tool
      errors are redacted or withheld names the tools it skips, bypassed ones
      (§6c residuals, §6f), and a claim that prompt masking
      fails closed says that a failed C1 detector falls back to C0 for the
      rest of the turn (§6f). A claim about the org clamp says that it
      changes the mode selection only, the MCP-to-knowledge-graph ingestion
      included (§6f). A claim about
      what the verifier checks names its trigger patterns and the answers
      `enforce` delivers unchecked, an input-card turn's rendered answer
      included (§7c).
      A claim that a call runs once names the scope the code gives it: one
      request for the verifier's replay ledger, one process and the cache
      window for an idempotency key (§4, §7c).
      `test/docsClaimsGuard.test.ts` keeps the retired claims out and ties the
      defaults and limits the README names to the code; a new public claim
      that rests on a default gets a line there.

- [ ] A new seam that runs a tool handler asks the request's
      `turnContext.toolReplayLedger` before the handler runs and reports the
      outcome after it, the way `Orchestrator.dispatchToolDeadlined`,
      `LocalSubAgent.dispatch` and `ToolDispatchService.invoke` do: replay a
      recorded outcome, refuse a repeat or a miss with the kernel's notice,
      record only what the turn used, and run the handler through
      `runHandlerAtMostOnce` so nothing beneath it is re-sent while a request
      ledger is bound. A seam that interns fails closed when interning throws
      (`internFailedNotice`), never forwards the raw result. It reports
      `readOnly` only for a tool it KNOWS cannot change data — never because
      `writeCapabilities` is missing.
      A new `turnContext.run(...)` re-scope around a handler spreads the
      current context (`{ ...ctx }`), so the ledger survives (§7c). Work that
      outlives the turn — a detached runner, a timer — must NOT keep the
      request's ledger: it starts under `runDetachedFromRequestLedger`.
- [ ] A new caller that re-enters a turn (another sample, another retry)
      binds a `ToolReplayLedger` to the request's own input object before the
      first run (`bindToolReplayLedger` refuses an input that carries another
      ledger), logs a re-entry that threw by error class and closed code
      (`reentryFailureLine`), never by its message, calls
      `beginReentry()` and re-binds before every re-entry (keeping the pass
      number it returns), treats `ToolReplayAbortError` as "keep the first
      answer", commits `ledger.turnRecord` for the pass it delivers — on
      every exit path, the first pass when it delivers nothing — commits
      `ledger.receipts` once and releases the binding when the request is
      over (`verifierReentry.ts`). A re-entry without a ledger runs every tool
      again; a request that never commits its record loses its session-log
      row.
- [ ] A new place that writes a turn's record (session-log row, fact
      extraction, auto-promotion, `onAfterTurn`) goes through
      `TurnRecordWriter` (`recordRow`, `offerRow`) and
      `Orchestrator.afterTurn`, so a pass a verifier may re-enter offers it
      instead of writing it (commit-on-delivery, §7c); a signal that must
      follow the request's `onAfterTurn` waits for the commit
      (`afterRequestRecord`).
- [ ] A new turn step outside tool dispatch that changes data (like the
      upload import in `ingestAttachments`) runs once per request: a verifier
      re-entry gets the first run's outcome from the request's ledger
      (`ToolReplayLedger.ingestAttachmentsOnce`) or is abandoned — it never
      performs the step a second time (§7c).
- [ ] Text a caller hands a turn for its system prompt (`extraSystemHint`)
      reaches the model only through `wireExtraSystemHint`, which masks it
      through the turn's prompt map and fails closed. A correction hint or
      any other text built from a verifier verdict carries the claims only —
      never `truth`, `detail` or other evidence the verifier fetched with its
      own access (§7c).

- [ ] An LLM judge or classifier output that references an input item by id
      resolves that id deterministically against the concrete input set of
      that call. An unknown id yields the conservative verdict, never a
      fallback derived from the claim itself (§7c).

---

*Last reviewed: 2026-10 (§6f: the org clamp covers MCP-to-knowledge-graph ingestion, and intern-exempt tools' errors are redacted or withheld like any tool's; §6c: positional record dumps and personal `key=value` pairs are withheld whole; §6f: the memory jobs mask the stored text they send to their model whatever `mask_user_prompt` says, in a turn through its handle and outside one through `openStoredTextScope`, and masking embeddings stays open; §4a added: npm dependency audit scope and the desktop runtime; §7c: answer-verifier verdicts and badges are evidence-bound — a run that checked nothing is `skipped` or `unavailable`, never `approved`, and an answer checked only in part is never `approved`; `enforce` holds every content event until the verdict and withholds what it could not confirm; the evidence judge counts a verdict only with a citation its request printed, and an entity handle with an id resolves exactly its record; a verifier re-entry replays the first run's tool results through a per-request ledger and executes no write, no transport re-sends a call below the bound ledger and a result the shield cannot intern is withheld at every seam, reuses the first run's upload ingestion instead of importing the uploads again, and gets a correction hint that is masked like the user's message and carries no verifier evidence, the `enforce` stream retries a contradiction, a request has one receipt row and one session-log row — the delivered pass's, written once the verifier decided — a detached task runner keeps out of the request's ledger, and no loop repeats a call whose outcome is unknown; §10e added: same-origin return paths; §10f added: self-update control plane, #432; §10g added: the operator front's login gate and its public allowlist; §3b and §10h added: sandbox container limits, operator UI headers and the web-ui image user; §8a added: desktop secret custody; §8b added: embedded Postgres authentication, hardened so a kernel-owned database cannot redirect the shell's superuser sessions; §10i added: desktop renderer trust boundary; §10j added: desktop wizard switches; §10k added: server-side session revocation; §10l added: first-user setup; §10m added: password sign-in rate limiting, its device cookies and its account key; §6e added: the answer verifier's model requests run under the turn's privacy view, and the receipt is finalised after them — per pass, for every resample and retry, with one receipt row per request — owned by its earliest pass with a receipt — that also keeps the receipt of a pass that threw or was cut off (in a stream's prelude too), and a claim that does not map back onto the shown answer is a coverage gap; §6c rewritten: tool errors withheld or redacted at every dispatch seam; the MCP connect prompt passes on per-dispatch provenance, not on its prefix; the public MCP endpoint's privacy gate covers a domain tool's sub-agent, with the guarantee stated per entry point; typed web-search and Kroki errors keep upstream text off their messages, and the provider pairing names privacy guard 0.6.0; keyword-field, Go-style and Postgres detail-line record dumps are withheld whole, and a sub-agent refuses an identical repeat of a call that ended in an exception; §5a added: office formula cells; §4 rewritten: plugin integrity is SHA-256 pinning with no publisher signature, where omadia itself runs npm, and write confirmation is a connector feature; §11: a public security claim names its control and that control's default; §6f added: what reaches the model unmasked under `guarded` (intern-exempt tools, operator bypass, control flow, prompt text); §7b: appending a receipt is best-effort, and the chain cannot show one that was never written; §11: a claim names the limits the code puts on it; §4: registry downloads are pinned to host and port, not scheme, manifest permissions gate the `PluginContext` accessors and sandbox no Node API, unbundled dependencies resolve from the image, Builder previews run the npm-installed template in-process, and an idempotency key on the public MCP endpoint is process-local deduplication with a cache window; §6f: the per-MCP-server bypass, a failed interning withheld at every seam, and a channel's replayed history carrying rendered real values; §7b: a turn that throws or ends before `done` keeps its receipt; §7c: the verifier is named opt-in, with `shadow` as its default mode; §11: a run-once claim names its scope; §6f: images, the model calls plugins make through `ctx.llm` and the memory jobs' requests reach the provider unmasked, with prompt masking on or off; §7c: the trigger patterns decide whether an answer is checked, `enforce` delivers an answer none of them matched unchecked, and a contradiction gets at most one correction retry; §11: a shield or verifier claim names what passes outside it; §6f restructured: the requests the shield masks and the setting each needs, then every model call outside it, the inbound security screener, turn scoring and embeddings included, and the org clamp does not reach MCP-to-knowledge-graph ingestion; §7c: an input-card turn releases a rendered answer unchecked, the trigger patterns are regular-expression matches over the whole answer, and a re-entry runs a shielded sub-agent again with its calls replayed; §4: 1,000 records is the idempotency store's eviction target; §6f: tool errors are redacted or withheld only for tools that are neither intern-exempt nor bypassed, prompt masking blocks a request only when the C0 baseline fails, a failed C1 detector leaves the rest of the turn on C0, and restoring real values is best-effort; §6c: the bypass residual covers bypassed tools and MCP servers; §11: a tool-error or fail-closed claim names what it skips).*
