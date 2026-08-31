# Competitive analysis: OpenClaw 2.0 (openclaw/openclaw)

**Date:** 2026-08-31 · **Analyzed revision:** `5e2130f` (repo HEAD at time of analysis, shallow clone) · **Release analyzed:** v2026.8.1 ("OpenClaw 2.0"), released 2026-08-30
**Subject:** <https://github.com/openclaw/openclaw> — open-source personal AI assistant ("EXEC-style agent runtime + Gateway + channels"), MIT, stewarded by the OpenClaw Foundation (501(c)(3))
**Primary sources:** release blog post¹, release notes², docs.openclaw.ai (security³, cloud sessions⁴, maturity scorecard⁵, multi-tenant⁶, formal verification⁷, updating⁸), four strategy blog posts⁹⁻¹², repo checkout, Wikipedia + press for external reception.

> **TL;DR** — OpenClaw 2.0 is the largest release in the project's history:
> 16,000+ merged PRs from 933 contributors (569 first-time), roughly 50 % of
> all PRs ever merged, shipped after a deliberate 7-week pause that broke a
> 106-releases-in-230-days cadence. It is **not** a feature pivot into
> omadia's territory: OpenClaw doubles down on *personal* AI (one trust
> boundary per Gateway, explicitly not multi-tenant), and its 2.0 themes are
> onboarding time-to-value, a first-class browser app, memory, self-learning
> skills, cloud/remote execution, and release-engineering maturity
> (extended-stable channel, public maturity scorecard). The strategic read
> for omadia: OpenClaw validates omadia's roadmap in several places
> (Satellites, dev-platform runners, skills lifecycle), leaves omadia's core
> differentiators untouched (Privacy Shield, verifier, receipts, team
> governance, EU/GDPR), and demonstrates process patterns — doctor-style
> config repair, release channels, public feature-maturity honesty,
> advisory-driven static-analysis regression rules — that omadia should adopt
> **before** its own pilot customers hit the failure modes OpenClaw already
> paid for in public.

---

## 1. Snapshot

| | |
|---|---|
| Release | v2026.8.1 aka "OpenClaw 2.0", 2026-08-30 (CalVer; "2.0" is a marketing name on top) |
| Scale of release | 16,000+ PRs, 933 contributors (569 first-time), ~50 % of all PRs ever merged¹ ² |
| Cadence context | 106 releases in 230 days before; ~7 weeks without a release for 2.0¹ |
| Project traction | 247k stars / 47.7k forks by 2026-03; "4.5 million new claws per week" (Foundation post, 2026-07)¹⁰; Wikipedia: fastest-growing repository in GitHub history |
| Governance | OpenClaw Foundation, 501(c)(3), full-time staff; creator Peter Steinberger joined OpenAI, which funds and staffs "Claw Labs"¹⁰ |
| Partners (Foundation post)¹⁰ | OpenAI (inference, Codex Security), NVIDIA (NemoClaw + OpenShell), Microsoft ("Microsoft Scout" built on OpenClaw), Red Hat, Tencent (security maintainers), University of Michigan (largest donor), Atlassian, Vercel/Cloudflare/Convex/GitHub infra |
| Positioning | "Personal AI that actually does things … your agent, your machine, your rules"; "Switzerland of AI"¹⁰. Explicitly not selling anything¹ |
| Security scope | **One trust boundary per Gateway** — a single operator or mutually trusting team. Adversarial multi-user/multi-tenant explicitly unsupported; per-tenant isolated "cells" via experimental Fleet³ ⁶ |
| Distribution | npm package + native apps (macOS signed/notarized, iOS/Android, Linux AppImage), Docker, ~20 hosting guides⁸ |

External reception context: OpenClaw's history includes serious security
criticism (Cisco-documented malicious third-party skill doing data
exfiltration; China restricted state use in 2026-03, per Wikipedia) and a
public quality crisis around 2026.4.24–2026.4.29 (plugin dependency repair
loops, degraded channels), answered by a public post-mortem⁹ and a structural
"smaller core, LTS, real team" program. 2.0 is the culmination of that
program.

### 1.1 Repository signals (checkout of `openclaw/openclaw` @ `5e2130f`)

Verified against the tree, not the marketing:

- **Scale:** 35,752 tracked files; `src/` alone is ~1.92 M production LOC
  plus ~2.83 M test LOC (**test mass 1.5:1 over production**); 12,239 test
  files repo-wide; 153 extension (plugin) directories; 22 shared packages;
  native apps at ~394 k Swift and ~178 k Kotlin LOC; 644 contributors listed
  in the README; PR numbering at #133982.
- **Policy is executable:** `taxonomy.yaml` (11.6 k lines) is the maturity
  model; QA scenarios (`qa/scenarios/`, 544 YAML) must reference its
  coverage IDs verbatim; the same taxonomy selects CI profiles. Scorecard →
  QA evidence → CI lanes is one linked system, not three documents.
- **Release validation is engineered:** 91 GitHub workflows; a 3-profile
  full-release-validation (beta/stable/full) with content-addressed evidence
  reuse; `RELEASING.md` is 831 lines; nightly install smoke incl. upgrade
  paths from baseline versions; npm releases verified with sigstore
  provenance bound to the exact workflow/builder identity.
- **Supply-chain intake:** pnpm `minimumReleaseAge: 10080` (7-day dependency
  cooldown, strict), `blockExoticSubdeps`, postinstall scripts denied by
  default via an `allowBuilds` allowlist; lockfiles and all security paths
  owned by a dedicated `@openclaw/openclaw-secops` CODEOWNERS team.
- **Notable nuance for §3.4:** OpenClaw does **not** sign plugin artifacts
  either — plugin trust is content-hash integrity + ClawHub verdicts
  (`clean | review-recommended | review-required | blocked`) + provenance
  classes (bundled/official/third-party) + **capability-consent hashing**
  (consent binds to the declared capability surface; an update that widens
  the surface forces fresh consent). The lesson is a trust *pipeline*, not a
  signature.
- **AI-contributor infrastructure as growth engine:** 25 `AGENTS.md` files
  (root file 65 KB, "telegraph style", with an explicit Repair Doctrine and
  Product Doctrine), 49 repo-development skills under `.agents/skills/`,
  named review bots (ClawSweeper), an evidence-demanding PR template, a hard
  cap of 20 open PRs per author, and a CONTRIBUTING section titled "AI/
  Vibe-Coded PRs Welcome" treating AI PRs as first-class. 569 first-time
  contributors in one release is the measurable output of that machinery.

## 2. What 2.0 actually contains (themes, verified against release notes²)

### 2.1 Onboarding & time-to-value (the release's stated origin¹)

- First-run starts from **what is already on the machine**: existing
  ChatGPT/Claude subscriptions, API keys, local models (Ollama, LM Studio,
  managed llama.cpp). Models are verified before saving.
- Configuration was cut or deferred: remaining setup happens **by talking to
  the assistant** after the first conversation ("Custodian" guided onboarding
  with structured option cards).
- Memory imports from Claude Code, Codex and Hermes are offered during
  onboarding.
- The browser app ("Control UI") was rebuilt as the first-class surface:
  measured startup 1.6 s → 575 ms, JS requests 140 → 45 (their own published
  test-harness numbers).

### 2.2 Multiplayer & sessions beyond one machine

- **Shared sessions**: visibility/membership per session, owner assignment,
  participation modes (view / suggest / contribute), creator attribution;
  profiles with avatars and who's-online. Explicitly framed as
  "collaboration controls, **not** hostile-tenant isolation"².
- **Cloud Sessions**⁴: the same session can execute on the Gateway, a paired
  device, or a disposable cloud worker (bundled "Crabbox" provisioner, AWS/
  Hetzner). Model credentials **never leave the Gateway**; work reconciles
  back into a managed worktree; idle workers suspend and are replaced on the
  next message; **warm images** cut cold-start; automatic least-busy device
  placement.
- Team operator roles bound what each teammate's connection can do (again:
  collaboration guardrails, not tenant isolation)².

### 2.3 Memory & continuity

- Sessions and transcripts moved **from loose files into SQLite** (their
  stated security motivation: "the safest filesystem call is the one we do
  not make"¹²; also enables conversation search).
- Conversation search, conversation branches (rewind/fork), durable progress
  cards across web/native.
- **Active Memory / "grounded dreaming"**: model-backed background memory
  consolidation, on by default, promoting *provenance-qualified* material to
  long-term memory, with a "Dream Diary" and explicit disable².
- **Memory ownership**: inspect which sessions contributed a memory, exclude
  sources from admission, `openclaw memory forget` removes derived memory
  while keeping source transcripts².

### 2.4 Skills & self-learning

- **Skill Workshop**¹¹: agent-created or revised skills start as *proposals*
  (`PROPOSAL.md`, inactive) with support files, review states
  (pending/applied/rejected/stale), a board + one-at-a-time review UI, and a
  revision loop. Path rules are deliberately narrow (no absolute paths, no
  traversal, no writes outside the skill).
- **Automatic self-learning** on by default: strong reusable lessons are
  captured; scanner-approved new skills auto-apply; user-authored skill
  changes stay pending².
- History mining: a manual newest-first scan of past sessions proposes
  conservative skill candidates².
- ClawHub distributes skills/plugins with mirrored, commit-pinned artifacts
  and normal safety checks².

### 2.5 Security posture (the part worth studying closely³ ⁷ ¹²)

- **Explicit scope**: one trust boundary per Gateway; a documented "not
  vulnerabilities by design" list; a trust-boundary matrix; a Gateway
  exposure runbook; a "hardened baseline in 60 seconds" config.
- `openclaw security audit [--deep|--fix|--json]`: self-service posture
  audit with structured check IDs (inbound access, tool blast radius, exec
  drift, network exposure, plugin allowlists, policy drift), and a narrow
  `--fix`.
- **Private credential requests**: agents request credentials through masked
  prompts — the value never enters chat or model context; an opt-in proxy
  restricts protected-secret substitution to approved destinations².
- **Approve-once for recurring work**: automation permission granted for an
  *exact operation*, inspectable and revocable, fresh approval on change².
- Shared team credential store (write-only secrets, egress bound to declared
  hosts) and an optional 1Password broker (service-account auth, per-secret
  approval, value-free audit)².
- Plugin trust: capability/source/version/artifact review before install,
  provenance warnings (`--force` for arbitrary executable sources), ClawHub
  security-audit info surfaced pre-install, quarantined releases refused¹²;
  consent is bound to a hash of the declared capability surface and must be
  re-given when an update widens it (no artifact signatures — integrity is
  content-hash based, see §1.1).
- Engineering process: **148-rule OpenGrep rulepack** where each rule is tied
  to a past advisory/report ("a GHSA is evidence about a bug class"), plus
  CodeQL; `fs-safe` root-bounded filesystem primitives; "Proxyline"
  process-global egress routing through a policy-enforcing proxy¹².
- **Formal verification**: TLA+/TLC models for authorization, session
  isolation, tool gating, misconfiguration safety — bounded, explicitly
  caveated (and, at analysis time, the models repo link is dead)⁷.
- Prompt injection documented with numbers: 272K crowdsourced attacks across
  41 scenarios — 0.5 % success for Claude Opus 4.5, 1.0 % Sonnet 4.5, 8.5 %
  Gemini 2.5 Pro; adaptive human attackers >80 % against SOTA defenses.
  Model choice is treated as the first (cheapest) mitigation layer, hard
  enforcement (tool policy, sandboxing, allowlists) for the rest³.

### 2.6 Release engineering & operations

- **Extended-stable channel**¹⁴: monthly long-lived lines at `YYYY.M.33`,
  backported security/reliability fixes bump the patch, supported ≥1 month;
  explicit path toward LTS. `openclaw update --channel extended-stable`.
- **Public maturity scorecard**⁵: full feature inventory scored by coverage/
  quality/completeness with bands (Experimental/Alpha/Beta/Stable/
  "Clawesome"). At analysis time the *overall* score shown is **68 % =
  "Alpha"** with coverage 16 % — published anyway. Goal: >90 % e2e coverage
  for stable features.
- `openclaw doctor --fix` migrations for breaking changes (model refs, plugin
  moves), **safe doctor migrations applied automatically at Gateway
  startup**², dated SDK deprecation gates (2026-09-01) with per-helper
  migration mappings².
- Recoverable backups (scheduled DB snapshots versioned in an operator-owned
  Git repo), SQLite snapshot CLI, config change history with writer labels &
  redaction, `openclaw triage` for sanitized debug handoffs, external
  supervisor mode².
- The "lighter core" program¹³: providers/channels moved out of the core
  dependency path; published effects — npm tarball 43.3 → 17.9 MB (−59 %),
  installed dependency roots 645 → 300, stable cold agent turn 9.8 s → 1.9 s
  (5.1×), warm 4×, peak RSS −15 %. Their stated direction: "keep core small,
  move optional capabilities into plugins, make dependency ownership
  explicit, and **measure the user-visible effects**."
- The cost when this went wrong (2026.4.x)⁹: half-split bundled/external
  plugin states, dependency repair in startup paths, degraded channels —
  public apology, then process change ("too founder-driven" → Foundation +
  team).

### 2.7 Interop & ecosystem surface

- A2A 1.0 channel plugin (authenticated agent-to-agent tasks), MCP servers
  incl. per-requester OAuth for shared servers, node-hosted tools, an
  OpenAI-compatible chat-completions API and "OpenResponses" API,
  `openclaw attach` (give Claude Code temporary access to selected sessions)².
- Docs are a product: 21 languages, per-page "copy as Markdown for LLMs",
  "Open in ChatGPT/Claude" buttons, an embedded docs assistant ("Molty"),
  per-page status labels (e.g. "Status: active")⁴.

## 3. Comparison with omadia

### 3.1 Different animal, same waters

OpenClaw is a *personal* assistant runtime: one human (or one mutually
trusting household/team) per Gateway, breadth across channels/devices/voice/
wearables, self-learning on by default, security via explicit single-boundary
scoping. omadia is an *organizational* agent OS: multiple humans in shared
channels with one governed context, privacy/verification/receipts as
structural guarantees, EU/GDPR posture, operator surface. OpenClaw's 2.0
release **does not move into omadia's lane** — its shared sessions are
explicitly "not tenant isolation", its multi-tenant answer is "run one
isolated instance per tenant" (Fleet cells)⁶ — the same answer omadia gives
today (single-tenant per instance, multi-tenant fork planned post-1.0).

The competitive pressure is indirect but real: Microsoft ("Scout"), NVIDIA
(NemoClaw) and Red Hat are productizing "enterprise-grade Claws"¹⁰ — the
enterprise gap OpenClaw leaves open is being filled by its own partners.
omadia's window for "governed multiplayer agent OS, EU-hosted" is real but
not indefinitely open.

### 3.2 OpenClaw has, omadia lacks (adoption candidates)

1. **Conversation-first onboarding** — reuse what the user already has
   (omadia already ships subscription-CLI + ChatGPT/Claude subscription
   providers, `cliBackendDetector`), but omadia's remaining setup lives in
   admin pages; OpenClaw moves it into the first agent conversation.
   Time-to-first-value as an explicit, measured release theme.
2. **A `doctor`-style repair/migration tool** — omadia has boot-time SQL
   migrations per subsystem and a health-gated rolling updater, but no
   config/state repair command, no startup config-migration pass, and its
   own changelog/version drift shows the gap (144 releases' changelog drift;
   releases v0.142.3–v0.146.x currently stuck as unpublished drafts behind
   the macOS-feed promotion gate).
3. **Release channels + maturity honesty** — 248 tags in ~16 weeks with no
   stable/extended channel is the same cadence-risk OpenClaw paid for in
   2026.4.x. An extended-stable line + a public feature-maturity table
   (omadia's analogue of the scorecard) directly serves pilot customers
   (beta rounds are already producing OM-xx findings).
4. **Memory depth** — omadia's KG is strong on entity/graph structure, but
   conversation continuity is thin (in-memory 10-turn/2 h scope store;
   cross-channel memory is a 1,135-line *proposal*, Phase 13). OpenClaw 2.0
   ships conversation search, branches, provenance-qualified consolidation,
   and per-memory forget. omadia's EU positioning makes "GDPR-grade memory"
   (inspect / exclude / forget with provenance) a natural, differentiating
   follow-on to Phase 13 — OpenClaw provides the UX blueprint.
5. **Skill Workshop review loop** — omadia's skills subsystem (#577) has
   lifecycle, HMAC-signed manifests, scoped sharing — but no
   "agent proposes a skill from work it just did, human reviews, then it
   becomes active" loop. That loop is the bridge between chat and omadia's
   heavier Builder, and it fits omadia's review/receipt culture better than
   OpenClaw's default-on self-learning does.
6. **Masked credential prompts + secret egress binding** — omadia's broker
   (#578) covers grants/asks; OpenClaw adds two concrete mechanics worth
   porting: credential request cards whose values never enter model context,
   and store-level binding of each secret to exact egress hosts (fail-closed
   substitution).
7. **Approve-once permission grants for automations** — exact-operation
   grants with inspection/revocation and re-approval on change; a good fit
   for Routines/Conductor approvals, and it addresses approval fatigue
   before omadia's operators develop OpenClaw's "YOLO mode" habit¹².
8. **Advisory→rule static-analysis pipeline** — every patched advisory
   becomes an OpenGrep/CodeQL rule (148 rules). omadia is small enough to
   start this at near-zero cost; it compounds.
9. **Self-service security audit command** — `omadia security audit --fix`
   over: exposed ports, missing org clamps (`OMADIA_PRIVACY_FORCE_GUARDED`),
   default-on dev fallbacks, plugin registry pinning, API-key scope drift.
   omadia already has the config surface; the audit is the missing bow.
10. **Warm seeds for runners** — omadia-dev-platform provisions per-job
    runners; OpenClaw's warm-image + project-seed pattern (plus
    suspend/replace lifecycle) is the proven latency/cost answer, and the
    Satellites epic (#746) is the omadia-native equivalent of paired
    devices — OpenClaw 2.0 is evidence the pattern works at scale.
11. **Plugin-trust pipeline instead of "signing"** — capability-consent
    hashing (re-consent when an update widens the declared surface — a
    direct upgrade for `pluginServiceGrants` + the install flow), registry
    verdict states (clean → blocked) with refused quarantined downloads,
    provenance classes for install sources, and a 7-day dependency cooldown
    (`minimumReleaseAge`) at intake. Cheaper and more honest than the
    currently claimed-but-absent artifact signatures, and it upgrades
    SkillSpector from advisory-only to a verdict the installer respects.
12. **Package the agent-first process for outsiders** — omadia is already
    developed agent-orchestrated (AGENTS.md, wave pipelines, two-reviewer
    workflows), but that machinery is aimed inward and partly German-only.
    OpenClaw shows the same machinery aimed outward (25 AGENTS.md files,
    repo skills, evidence-demanding PR template, ClawSweeper review bot,
    "AI PRs welcome" policy) converts AI-assisted drive-by contributors at
    scale: 569 first-time contributors in one release. For omadia the
    realistic first audience is integrators/agencies, not hobbyists — but
    the mechanism is the same.

### 3.3 omadia has, OpenClaw lacks

- **Privacy Shield v4** — a data-plane boundary where the LLM never sees raw
  tool results (OpenClaw's model: the model sees everything; mitigation is
  model robustness + tool policy).
- **Answer verification** — claim-checking against run sources with verdicts
  before delivery. No OpenClaw equivalent.
- **Deterministic Office compute** and canvas-grade deterministic UI
  (omadia-ui protocol) vs. OpenClaw's sandboxed HTML widgets.
- **Receipts** — hash-chained turn receipts with Ed25519 checkpoints and an
  offline verifier. OpenClaw has config change history and session
  transcripts, not tamper-evident receipts.
- **Team governance as a first-class product**: org-clamped privacy modes,
  audit log, operator surface, conductor approvals — vs. OpenClaw's explicit
  "collaboration controls, not isolation".
- **EU/GDPR posture** as architecture (self-hosted single-tenant, EU
  providers as plugins, AI-Act transparency docs).

### 3.4 Honest mirror (what OpenClaw's honesty exposes about us)

OpenClaw publishes a maturity scorecard that grades its own product "Alpha,
68 %" and keeps a public "not vulnerabilities by design" list. Against that
standard, omadia's own claim/code gaps (already flagged in
`docs/competitive/qm-2026-08.md` §5.4 and re-verified today) become more
urgent, because trust-positioned products get audited against their own
words:

- README markets "Slack, Teams, Telegram, Discord" — Slack exists as a type
  placeholder, Discord not at all.
- README says "verifiable signed packages" — the registry trust model is
  sha256 + TLS pinning; per-artifact signing is explicitly "not yet"
  (`registryClient.ts`).
- README says "every action carries a receipt … replayable" — the KG run
  trace is best-effort telemetry (#684); the hash-chained receipts (#757) are
  the honest core of that claim and the wording should point at them.
- README/setup docs still describe the retired LLM-key wizard step.

None of these is fatal; all of them are cheap to fix; each one found by a
pilot customer costs more than all four fixes together.

## 4. What NOT to copy

- **Default-on self-learning and memory consolidation** ("grounded
  dreaming", auto-applied scanner-approved skills). Right for a personal
  assistant, wrong for omadia's compliance posture — omadia's equivalents
  must stay proposal→review→receipt.
- **Channel/device breadth** (voice, wearables, meeting bots, 15+ channels).
  That is OpenClaw's consumer moat and 933 contributors pay for it; for
  omadia it would be defocus. Teams/Telegram/WhatsApp depth beats channel
  count.
- **Marketing-first shared sessions**: OpenClaw's multiplayer is bounded by
  its one-trust-boundary model. omadia should deepen roles/audience/receipts
  (the #575 seams) rather than replicate session-sharing mechanics.
- **Their cadence** (106 releases/230 days) without their channel structure —
  omadia is *already* faster (248 tags in ~16 weeks) and already shows the
  symptoms (changelog drift, draft-stuck releases). The lesson is the
  channel structure, not the speed.

## 5. Adoption summary

Filed as adoption candidates (suggested label `from-openclaw`, mirroring
`from-qm`): (1) conversational onboarding + time-to-value metric,
(2) `omadia doctor` config/state repair + startup migration pass,
(3) extended-stable release channel + public feature-maturity table,
(4) conversation search/continuity now, GDPR-grade memory controls with
Phase 13, (5) skill-proposal review loop on top of #577,
(6) masked credential asks + secret egress binding on top of #578,
(7) approve-once automation grants, (8) advisory→OpenGrep rulepack in CI,
(9) `security audit --fix` self-service command, (10) warm seeds +
suspend/replace lifecycle for dev-platform runners / Satellites (#746),
(11) capability-consent hashing + registry verdicts + dependency cooldown,
(12) externalized agent-first contribution machinery.

Items (2) and (3) are operationally urgent (live evidence: draft-stuck
releases, changelog drift, beta-round findings); items (5)–(7) and (11)
sharpen the governance differentiation; the rest compound quietly.

## 6. Method

Analyzed on 2026-08-31: the release blog post and full v2026.8.1 release
notes (highlights + changes read in full; fixes scanned for security
items; the ~34k-line contribution record skipped), six docs.openclaw.ai
pages (security, cloud sessions, maturity scorecard, multi-tenant hosting,
formal verification, updating), six OpenClaw blog posts (2.0, LTS/maturity,
Skill Workshop, lighter core, rough week, Foundation), a full survey of a
shallow clone of `openclaw/openclaw` at `5e2130f` (workspace layout, LOC
and test counts, extension list, skills/memory/security/QA subsystems, CI
workflows, governance files), Wikipedia and press coverage for external
reception. omadia-side facts verified against this repo at the current
checkout (architecture, packages, specs, security seams, CI, release
automation), `byte5ai` org repo metadata (37 `omadia*` repos), GitHub
releases, and the sibling repos `omadia-hub`, `omadia-dev-platform`,
`omadia-ui`, `omadia-proof`. Numbers not independently verifiable (e.g.
"4.5 M new claws per week") are attributed to their source and marked as
claims.

---

¹ <https://openclaw.ai/blog/openclaw-2-accidentally> · ² <https://docs.openclaw.ai/releases/2026.8.1> · ³ <https://docs.openclaw.ai/gateway/security> · ⁴ <https://docs.openclaw.ai/gateway/cloud-sessions> · ⁵ <https://docs.openclaw.ai/maturity/scorecard> · ⁶ <https://docs.openclaw.ai/gateway/multi-tenant-hosting> · ⁷ <https://docs.openclaw.ai/security/formal-verification> · ⁸ <https://docs.openclaw.ai/install/updating> · ⁹ <https://openclaw.ai/blog/openclaw-rough-week> · ¹⁰ <https://openclaw.ai/blog/introducing-openclaw-foundation> · ¹¹ <https://openclaw.ai/blog/openclaw-agent-skill-workshop> · ¹² <https://openclaw.ai/blog/where-openclaw-security-is-heading> · ¹³ <https://openclaw.ai/blog/lighter-core-sharper-claws> · ¹⁴ <https://openclaw.ai/blog/extended-stable-releases-and-maturity-scorecards>
