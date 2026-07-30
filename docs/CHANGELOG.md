# Changelog

All notable changes to omadia are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The canonical, always-current changelog per version is each release's GitHub
Release notes — generated automatically by `.github/workflows/auto-release.yml`
from Conventional Commit messages, no release ships without one. This file is
a periodically-refreshed mirror of the same data (every section from
`[0.2.1]` onward via `.github/scripts/generate-changelog.mjs backfill`), not
auto-committed on every release. Add hand-written notes under
`## [Unreleased]` any time; they carry over verbatim into the next version's
entry. See `CONTRIBUTING.md` § Releases & changelog.

---

## [Unreleased]

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
  [ADR-0006](adr/0006-mcp-client-id-metadata-documents.md).
- Note on issue #546: its premise that the registry "supports only static headers
  with `secretRef`" was incorrect — the provider-agnostic OAuth 2.1 + PKCE stack
  shipped in epic #459 W9. This release is a delta on that stack.

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

[Unreleased]: https://github.com/byte5ai/omadia/compare/v0.54.0...HEAD
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
