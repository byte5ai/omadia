# Architecture Decision Records

This directory records the significant architecture decisions behind **Omadia**,
an agentic operating system for building and running teams of AI agents across
channels, integrations, and a shared knowledge graph.

We use the [MADR](https://adr.github.io/madr/) format. Each record captures a
single decision: the problem, the options we weighed, what we chose, and the
consequences we accepted. ADRs are immutable once **Accepted** — to change a
decision, write a new ADR and mark the old one **Superseded by …**.

## Why we keep ADRs

- Make the *reasoning* behind the architecture durable, not just the code.
- Give new contributors the "why", not only the "what".
- Avoid re-litigating settled trade-offs.

## Writing a new ADR

1. Copy [`0000-template.md`](0000-template.md) to the next free number:
   `NNNN-short-kebab-title.md`.
2. Fill in Context, Decision Drivers, Considered Options, Decision Outcome,
   and Consequences.
3. Open it as **Proposed**; flip to **Accepted** once agreed.
4. Add a row to the index below.

## Index

| #    | Title                                                              | Status   | Date       |
| ---- | ------------------------------------------------------------------ | -------- | ---------- |
| 0001 | [Plugin distribution via signed ZIP packages](0001-plugin-distribution-via-signed-zip.md) | Accepted | 2026-06-03 |
| 0002 | [MIT license for the open-source core](0002-mit-license-for-oss-core.md) | Accepted | 2026-06-03 |
| 0003 | [Capability-based, multi-provider middleware](0003-capability-based-multi-provider-middleware.md) | Accepted | 2026-06-03 |
| 0004 | [Knowledge graph as the agent memory substrate](0004-knowledge-graph-as-memory-substrate.md) | Accepted | 2026-06-03 |
| 0005 | [Two-phase confirmation for write-capable connectors](0005-two-phase-confirmation-for-writes.md) | Accepted | 2026-06-03 |
| 0006 | [In-context surfacing for background chat streams (no toasts)](0006-in-context-background-stream-surfacing.md) | Accepted | 2026-07-02 |
| 0007 | [Client ID Metadata Documents coexist permanently with manual OAuth clients](0007-mcp-client-id-metadata-documents.md) | Accepted | 2026-07-30 |
| 0008 | [MCP connection lifetime and pooling](0008-mcp-connection-lifetime.md) | Accepted | 2026-08-06 |
| 0009 | [Default TTL for MCP tool-list caching](0009-default-ttl-for-mcp-tool-list-caching.md) | Accepted | 2026-08-15 |
| 0010 | [Adopting the Lume icon + state-as-glyph specs into core](0010-lume-icon-and-state-glyph-adoption.md) | Accepted | 2026-08-17 |
| 0011 | [The root README is a landing page; detail lives in `docs/`](0011-readme-as-landing-page.md) | Accepted | 2026-10-09 |
| 0012 | [Agents are virtual employees; no orchestrator agent](0012-agents-are-virtual-employees.md) | Accepted | 2026-11-19 |
| 0013 | [Speaker stamping, one typed emitter and a fail-closed identity guard](0013-speaker-stamping-and-identity-guard.md) | Accepted | 2026-11-19 |
| 0014 | [Plugins are only the delivery form; one manifest kind per plugin](0014-plugins-are-only-the-delivery-form.md) | Accepted | 2026-11-19 |
| 0015 | [Agent archetypes, delivered by archetype plugins](0015-agent-archetypes-and-archetype-plugins.md) | Accepted | 2026-11-19 |
| 0016 | [Least privilege by default; everything inside one agent's envelope](0016-least-privilege-and-the-agent-envelope.md) | Accepted | 2026-11-19 |
| 0017 | [Model gateway, execution contexts and the plugin sandbox](0017-model-gateway-and-execution-contexts.md) | Accepted | 2026-11-19 |
| 0018 | [Consultation instead of delegation between agents](0018-consultation-instead-of-delegation.md) | Accepted | 2026-11-19 |
| 0019 | [Discretion as information flow control](0019-discretion-as-information-flow-control.md) | Accepted | 2026-11-19 |
| 0020 | [Proactive agents through bounded triggers, no heartbeats](0020-proactive-agents-with-bounded-triggers.md) | Accepted | 2026-11-19 |
| 0021 | [Deterministic first, side channels for data, natural chat answers](0021-deterministic-first-side-channels-and-uncluttered-answers.md) | Accepted | 2026-11-19 |
| 0022 | [Native facilitators: an archetype delivered by an archetype plugin](0022-native-facilitators-as-an-archetype-plugin.md) | Accepted | 2026-11-19 |
| 0023 | [Facilitators: moderation working modes, per-facilitator defaults, readiness per channel](0023-facilitator-working-modes-settings-and-channel-readiness.md) | Accepted | 2026-11-20 |
| 0024 | [Facilitation closing procedure, result status and retention](0024-facilitation-closing-procedure-and-result-status.md) | Accepted | 2026-11-20 |
| 0025 | [Facilitation contributions and decisions: electorate, quiet recording, consent, repeats](0025-facilitation-contributions-and-decisions.md) | Accepted | 2026-11-20 |
| 0026 | [Facilitation sessions: linked conversations, binding close and spoken contributions](0026-facilitation-sessions-linked-conversations-and-spoken-contributions.md) | Accepted | 2026-11-20 |
| 0027 | [Agent reactions for quiet recording](0027-agent-reactions-for-quiet-recording.md) | Accepted | 2026-11-20 |
| 0028 | [Channel-triggered workflows start only for the addressed agent](0028-channel-triggered-workflows-start-only-for-the-addressed-agent.md) | Accepted | 2026-11-21 |
| 0029 | [Facilitator acceptance matrix and CI](0029-facilitator-acceptance-matrix-and-ci.md) | Accepted | 2026-11-21 |
| 0030 | [The kernel bounds closing scopes and the deadline wait](0030-kernel-bounds-closing-scopes-and-the-deadline-wait.md) | Accepted | 2026-11-21 |
| 0031 | [Audio meeting source split from the native facilitator epic](0031-audio-meeting-source-split-from-native-facilitators.md) | Accepted | 2026-11-22 |
| 0032 | [The caller of a tool call is named like the author of a message](0032-tool-caller-principal-is-the-conversation-form.md) | Accepted | 2026-11-23 |
| 0033 | [The memory tool protects shared trees by path; rules come only from the seed](0033-memory-tool-protected-trees-and-seeded-rules.md) | Accepted | 2026-11-23 |
| 0034 | [No session-scoped Postgres state on the shared pool; a notification is only a hint](0034-no-session-state-behind-a-transaction-pooler.md) | Accepted | 2026-11-20 |
| 0035 | [Postgres tests are found by their name; CI guards the name and holds a floor](0035-postgres-tests-are-found-by-name-and-held-by-a-floor.md) | Accepted | 2026-11-23 |
| 0036 | [Agent names are not personal data; a human's name vetoes the exemption](0036-agent-names-are-not-personal-data.md) | Accepted | 2026-11-24 |
| 0037 | [Question cards: typed questions out, typed answers in](0037-typed-question-cards-in-the-send-contract.md) | Accepted | 2026-11-19 |
| 0038 | [Conductor operator routes: a malformed id is a 400, an unknown id a 404](0038-conductor-routes-check-id-shape-400-then-404.md) | Accepted | 2026-11-23 |
| 0039 | [Memory access is verified against a hand-written oracle and a canary sweep](0039-memory-access-verified-by-oracle-and-canary-sweep.md) | Accepted | 2026-11-24 |
| 0040 | [Private knowledge stays private: one graph read boundary per turn for every read path](0040-one-graph-read-boundary-per-turn.md) | Accepted | 2026-11-24 |
| 0041 | [Conductor webhooks: context opt-in, bounded retention, signed timestamps, rotation grace](0041-conductor-webhook-hardening.md) | Accepted | 2026-11-24 |
| 0042 | [Conductor event ids belong to the sender; the catalog only suggests](0042-conductor-event-ids-belong-to-the-sender.md) | Accepted | 2026-11-24 |
| 0043 | [Draft previews run agent steps as tool-less turns](0043-draft-previews-run-agent-steps-as-tool-less-turns.md) | Accepted | 2026-11-25 |
| 0044 | [Plugins read the graph only through bounded services](0044-plugins-read-the-graph-through-bounded-services.md) | Accepted | 2026-11-25 |
| 0045 | [A topic is content of every member: cluster per owner set, show only to full readers](0045-a-topic-is-content-of-every-member.md) | Accepted | 2026-11-25 |

### The agent model (0012–0022)

ADRs 0012 to 0022 record one coherent model: agents are virtual employees, the
management layer below them is deterministic, and plugins are only the delivery form.
Their normative detail lives in
[`specs/2042-agents-as-virtual-employees/spec.md`](../../specs/2042-agents-as-virtual-employees/spec.md)
and [`specs/2043-native-facilitators/spec.md`](../../specs/2043-native-facilitators/spec.md);
the binding vocabulary in [`docs/terminology.md`](../terminology.md). Every change to
agents, plugins, channels, models or the kernel conforms to these records. A change that
needs a different direction writes a new ADR that supersedes the affected one; it is
never built against them silently.

> These first records are written *retroactively* — they document decisions that
> were already implemented and proven in the product. New decisions should be
> recorded *before* or *while* they are implemented.
