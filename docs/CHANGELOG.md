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
