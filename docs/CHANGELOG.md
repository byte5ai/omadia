# Changelog

All notable changes to omadia are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

- `@omadia/orchestrator`: migrated the orchestrator and local-sub-agent LLM
  boundary off direct `@anthropic-ai/sdk` calls onto the neutral
  `@omadia/llm-provider` seam. Internal loops still build Anthropic-shaped
  params and read Anthropic-shaped responses; only the boundary call path now
  translates through `llmProviderSeam`, including streaming final-event usage
  telemetry and provider-based retry classification.

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

[Unreleased]: https://github.com/byte5ai/omadia/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/byte5ai/omadia/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/byte5ai/omadia/releases/tag/v0.1.0
