# Agents are virtual employees: direct, unadulterated interaction

> **Status: DRAFT for owner sign-off.** This document implements nothing. It fixes the
> product invariants every agent in omadia must satisfy, measures where `main` violates
> them, and cuts the work into issues. The companion spec
> [`native-facilitators`](../2043-native-facilitators/spec.md) builds on it.
>
> **Measured against** kernel `origin/main` @ `f727a83c`, `omadia-channel-teams` @
> `e1aacfc`, `omadia-ui` and `omadia-ui-mobile` at their `origin/main` of 2026-11-18.
> Reviewed adversarially by a second model family (Codex) on 2026-11-18; its findings are
> incorporated. §10 lists what is still unverified.

## 1. Why this exists

**The target picture, from the view of our non-technical customers:** omadia extends your
professional team with virtual employees. We have done our job when the employees of our
customers tell us that in daily work they sometimes forget these are agents and not
simply remote colleagues: agents that come across like the colleagues they would wish
for, in skills, quality of work, pace, and pleasant collaboration (communication,
emotion), without asking for a salary every month.

This is a deliberate and transparent **humanisation**, the way cars got faces and started
talking to their drivers. Users always know they work with an AI agent; omadia never
claims otherwise and never builds deep fakes. But the agents should feel as human as
possible in the best sense, because that is where acceptance is highest and friction
lowest. Collaboration must be pleasant, productive and personally beneficial for the
customer's employees, ideally fun. If they do not experience it that way, they will
sooner or later boycott omadia, and the customer will question its use. Users should see
it as a strength of omadia that its agents feel like ideal human remote colleagues who
make their work much easier and more pleasant.

Two consequences hold for every section below:
- Every design choice is judged by whether it makes an agent feel more or less like a
  real colleague. Hidden machinery, borrowed identities, mediated answers and inconsistent
  personalities all break that feeling.
- "Forgetting they are agents" describes the quality of the experience, never deception.
  Agents never claim to be human, and the AI disclosure of EU AI Act Art. 50
  (`docs/ai-act-transparency.md`) stays as the law requires, in the most discreet form the
  channel offers (§5.14).

omadia is a **team-first** AI OS, and a native orchestrator contradicts that by
construction. An orchestrator is the single-assistant paradigm: one entity stands between
every person and every capability, mediates every request, and concentrates access to
every connected system in one place. In a team, work is done by distinct colleagues with
distinct roles, rights and accountability, and everyone can see who did what. omadia
therefore has no orchestrator as a product concept, neither as an agent nor as a hidden
layer that decides or answers.

The beta test made the cost concrete. A user built a "Strategist" specialist in the Agent
Builder and worked with it. Its answers felt off. Investigation showed the Strategist was
never called; the orchestrator had answered in its place and let the user believe they
were working with the Strategist. #332 documented the same failure ("gatekeeper drift")
and added transparency and a Direct Line on top of the orchestrator, but kept the
orchestrator as the owner of every turn. That is the model this spec replaces.

The owner's requirement:

> omadia must always treat and design agents as virtual remote employees. When I write to
> an agent through a channel, it must be guaranteed that I interact with exactly this
> agent, directly and unadulterated, and that it uses its given capabilities, skills,
> access rights, memories and personality traits: no more and no less.

## 2. Terms

The binding definitions of agent, archetype, plugin (capability and archetype plugin),
capability, skill, channel, consultation, speaker, management layer, discretion, trigger
and every other term used here are in [`docs/terminology.md`](../../docs/terminology.md).
They apply to the whole omadia project; this spec uses them with exactly those meanings.

There is no orchestrator agent. An installation has one or more agents and the
management layer. "Orchestrator" survives only as a code name of the agent runtime
package and disappears from the product surface (§5.9).

## 3. Invariants (normative)

**INV-1 Direct addressing.** Every agent is directly addressable in every channel where it
is deployed: through its own channel identity where the platform supports one, and
through explicit selection elsewhere (web chat, desktop and mobile UI, public API). A
turn addressed to agent A is executed in A's envelope. Which agent answers is decided
deterministically, never by a model. Once A is fixed, A's internal helpers (model router,
fast lane, mode selection, sub-agent helpers, presentation helper) may run under A's model
policy and grants; they choose a model, a tool, a mode or a data path, never a different
speaker. Deterministic, model-free pre-processing (authentication, privacy shield,
routing, rate limits) is allowed.

**INV-2 Exact capability envelope ("no more, no less").** A answers with exactly its own
configured identity, instructions, personality, boundaries, model policy, skills,
capability grants and memory scope, capped by the audience's rights.
- *No more:* no capability A was not granted, no global plugin configuration A does not
  have, no other agent's memory, no other agent answering in A's place, no access
  obtained by asking a colleague.
- *No less:* no path answers for A while skipping A's persona, boundaries, answer size or
  AI disclosure. Deterministic answer paths (for example the fast path) render under A's
  identity and settings.

**INV-3 No impersonation.** An agent only ever speaks as itself. No mechanism switches an
agent's name or identity per turn. Another agent's words reach a user only as that
agent's own delivered contribution (INV-5). The guarantee has two parts with different
strength, stated honestly:
- *Structural (guaranteed):* who a message is from is decided by routing and stamped by
  the harness; no model output can change the speaker.
- *Textual (guarded):* what an agent's text claims about identity is checked by a
  mandatory identity guard before the text is published (§5.5). The guard is fail-closed
  and independent of the fact verifier's mode, and its coverage is defined by tests; it is
  a strong guard, not a proof.

**INV-4 Deterministic attribution.** Every user-visible message carries its speaker
(agent id, display name, avatar; or `system`), stamped by the harness from the routing
decision, never from model output. It is always in the structured answer; it is shown to
people the natural way: through the agent's own bot or account, or the name and avatar a
chat UI shows anyway. A text name line appears only where the speaker would otherwise be
unclear: a channel without per-agent identity in a conversation where more than one
agent speaks, or the first answer after the speaker changed (§5.14).

**INV-5 Visible collaboration only.** Agents may work together only as colleagues:
- Consultation is off by default and configured per agent and per pair of agents.
- A consulted agent B answers with its own identity, instructions, skills and model. Its
  data access is limited to what both A and B may access, capped by the audience: a
  consultation adds a colleague's skill and judgement, never access (§5.4).
- B's contribution reaches the user attributed to B, delivered by the harness from B's
  output. The consulting agent cannot suppress or reword it.
- A's own text may refer to B only through the harness-provided reference to B's
  delivered block; free-text quotes of B are refused by the identity guard.
- The user can always address B directly instead.

**INV-6 No hidden intermediary.** Above the agents there is only the management layer,
and it is not an agent: it has no persona, runs no model conversation with users, never
writes answer content and never uses a model to decide which agent answers. Its notices
carry the speaker `system`. An agent that serves unaddressed traffic is an ordinary named
agent chosen by the operator and shown as itself.

**INV-7 Fail loud.** If the addressed agent cannot serve a turn (disabled, deleted, missing
grant, error, quota), the user gets a `system` notice that names the agent and the
reason. No silent substitute, no silent fallback.

**INV-8 Least privilege by default.** No agent holds a capability it was not explicitly
granted. Installing a plugin attaches it to no agent. No installation ships an agent with
access to every connected system: whoever reaches such an agent holds the master key to
every third-party system behind it. An operator who wants an agent with broad rights
creates one deliberately; the product shows every agent's reach (§5.7).

**INV-9 Discretion.** Like an ideal colleague, an agent always knows whom it may tell
what, and how much. Every piece of information an agent holds or obtains carries the
context it came from; it may flow only to recipients who are all allowed to know it, in
the permitted level of detail. This holds for every path information can take: answers
to people, memory, capability and interface calls, and communication with other agents
(§5.11).

**INV-10 Proactive, but bounded.** An agent that notices something or has something
important to say speaks up without being asked, like a good colleague. It decides itself,
within harness procedures and without bothering users, whether to wait for an event or to
wake itself at a time. Every such trigger has a deadline, limits and a budget that the
deterministic harness enforces, so no trigger can ever run on blindly (§5.12).

**INV-11 Deterministic first.** Whatever the deterministic harness can do, it does:
faster, cheaper, more reliable and uncritical for data protection. A model runs only where
judgement, language or open-ended reasoning is needed. Data from a source system reaches
the user through a side channel past the model; the agent coordinates and receives a
status. When the agent itself needs data, it gets exactly that data, masked by the
privacy shield where required. This holds for every part of omadia (§5.13).

## 4. Measured ground truth on `main`

Paths are relative to the kernel repo unless a sister repo is named.

| # | Finding | Violates | Evidence |
|---|---|---|---|
| G1 | The default identity of every agent is "an AI assistant that answers requests by delegating to specialised domain agents". | INV-6 | `middleware/packages/harness-orchestrator/src/orchestrator.ts:2210` |
| G2 | **Builder specialists are hidden plugins.** The Agent Builder ("Build your assistant") generates a plugin of kind `agent` with a persona (`AGENT.md`); at runtime it becomes the tool `query_<short>` of whatever agent it is attached to. No channel can address it. This is the most likely mechanism of the Strategist incident. | INV-1, INV-3 | `middleware/src/plugins/builder/buildPipeline.ts:246-252`; `middleware/assets/boilerplate/agent-pure-llm/manifest.yaml:19`; `middleware/src/plugins/dynamicAgentRuntime.ts:458-463,600` |
| G3 | **DB sub-agents** (`agent_subagents`, Builder canvas node "Sub-Agent") have a name and their own system prompt, but no identity towards users, no channel presence and no own conversation: each call is one self-contained question, and a memory grant resolves to the calling agent's turn-bound scope. | INV-1, INV-5 | `middleware/packages/harness-orchestrator/src/registry/subAgentTools.ts:102,153-157,338`; `middleware/packages/harness-orchestrator/src/localSubAgent.ts:143-146`; `middleware/packages/harness-orchestrator/src/registry/subAgentMemoryTool.ts` |
| G4 | Nothing prevents an agent from answering "as" another agent without calling it: no prompt rule, no harness guard. The fact verifier checks claims against tool traces, not speakers; it is disabled by default and, when enabled, runs in `shadow` mode unless configured otherwise. | INV-3 | `middleware/packages/harness-orchestrator/src/verifierJudge.ts`; `middleware/src/config.ts:684-688` (`VERIFIER_ENABLED … default(false)`, `VERIFIER_MODE … default('shadow')`) |
| G5 | Persona skills swap an agent's identity per turn: a classifier picks a skill whose body replaces the agent's identity, with no call to anyone. The web UI shows "Answering as X". | INV-3 | `middleware/packages/harness-orchestrator/src/personaRouter.ts:1-20`; `web-ui/app/chat/page.tsx:1489-1525` |
| G6 | Direct Line (#332, #445) patches addressing on top of the orchestrator: an unknown `#token` silently falls through to the orchestrator; sticky mode is off by default and held in memory with a 2 h idle TTL; the Claude-CLI path has no Direct Line. | INV-1, INV-7 | `middleware/packages/harness-orchestrator/src/directLineSticky.ts:53,196-198,312-324`; `middleware/src/config.ts:96-99`; `middleware/packages/harness-orchestrator/src/cliChatAgent.ts` |
| G7 | The fast path answers data questions without running the agent: no persona, boundaries, answer size, kernel AI disclosure or Direct Line (#1876, open). Channels that add their own fixed AI chip (Teams) still mark the message as AI, but not as coming from the agent. | INV-2 | #1876; `omadia-channel-teams` `src/teamsCard.ts:1016` |
| G8 | A binding to a disabled agent silently falls back to the default agent (#1880, open). | INV-7 | #1880 |
| G9 | The web chat shows no speaker per message, only the pinned slug; the agent picker shows slugs and only appears with more than one enabled agent. | INV-4 | `web-ui/app/_components/AgentPicker.tsx:107,134-135` |
| G10 | The end-user UIs know no agents: omadia-ui and omadia-ui-mobile talk to one entity "omadia"; the kernel hard-routes canvas turns to one `canvasChatAgent`. | INV-1, INV-4 | omadia-ui `app/src/shared/protocol.ts` (`ClientTurn`), `app/src/renderer/src/App.tsx:981`; kernel `middleware/src/channels/orchestratorDispatcher.ts:142-165` |
| G11 | The desktop UI's architecture has its own orchestrator: a "Tier 2 UI Orchestrator" (small model) receives every canvas turn, decides between local action, UI composition and content, and delegates content to `chatAgent@1` and its sub-agents. | INV-1, INV-6 | omadia-ui `CONCEPT.md` ("Architecture", "Tier 2 — UI Orchestrator") |
| G12 | Consultation attribution is uneven: web chat and Teams render the delegated answer and the consulted footer; Telegram renders neither. | INV-4 | `web-ui/app/_components/chat/AgentsConsultedFooter.tsx`; `omadia-channel-teams` `src/teamsCard.ts:755-776`; `middleware/src/config.ts:93-95` |
| G13 | The default agent is a super-agent by design: first boot attaches every installed plugin to it, and every later kernel install path (Hub install, upload, reinstall, built-ins) attaches each new plugin of any kind to it. It also receives all unbound traffic. | INV-8 | `middleware/packages/harness-orchestrator/src/registry/onboarding.ts:104-129,155-176`; `middleware/src/index.ts:1797-1803` (#1491, #1498); `middleware/packages/harness-orchestrator/src/routing/channelResolver.ts:40` |
| G14 | Agent-to-agent today has two levels: a per-agent switch (`agents.agent_to_agent`) and a per-conversation policy (`agent_channel_policies`, key `(channel_type, channel_key, agent_id)`); the runtime requires both. Neither names a target agent, so neither is a permission for A to consult B. | INV-5 | `middleware/migrations/0058_agent_to_agent.sql:52,83`; `middleware/src/conductor/peerPolicy.ts:105` |
| G15 | The audience floor is inactive unless a provider is configured: without one the guard returns no restriction. | INV-2, INV-5 | `middleware/packages/harness-orchestrator/src/audienceFloorGuard.ts:272` |
| G16 | The product calls every configured agent "Orchestrator" (navigation, create form, chat picker, glossary rule "keep in English"). | INV-6 | `web-ui/messages/GLOSSARY.md`; `web-ui/messages/en.json` (`nav.agentsCluster`, `agentPicker.label`) |
| G18 | Proactivity exists only in pieces, and none of them is bounded: **routines** are user-owned recurring cron jobs (5-field cron, at least 60 s apart, run timeout up to 10 min, 50 active per user) without an end date, a cost cap or a one-shot form, created by an agent only on a user's request; **plugin jobs** (cron or interval) run until the plugin is deactivated, and a failing handler does not stop future ticks; **Conductor workflows** have event, webhook and cron triggers, but operators author them. An agent cannot wake itself or subscribe to an event on its own, and no LLM spend cap was found. | INV-10 | `middleware/src/plugins/routines/routineStore.ts`, `routineRunner.ts:77`, `manageRoutineTool.ts:48-65,118`; `middleware/packages/plugin-api/src/pluginContext.ts:254-274`; `middleware/src/conductor/eventRouter.ts`, `runStore.ts:7` |
| G17 | **What already holds:** per-agent Teams identity (1 agent = 1 Entra app + 1 bot + 1 app package, #860); per-agent identity, persona axes, instructions and avatar (#914, `agent_identities`); per-agent model policy, plugin and MCP grants, memory tree; harness-sourced `agentsConsulted` and `delegatedAnswer` (#332). | | `docs/teams-multi-agent-identities.md`; migrations `0049`-`0063` |

The foundation for virtual employees exists (G17). What is missing is that the agent the
user addresses is the only one who speaks, and that everything else is either an honest
capability or a visible colleague.

## 5. Target model

**Rule for every change in this section:** an existing mechanism is only changed after its
purpose is established; what conflicts with the new concept is adapted, its advantages are
kept. Each row of §5.2 states purpose, conflict and adaptation; an independent regression
audit (Codex, 2026-11-18) checked every change against the code and its history.

### 5.1 One entity: the agent

- `agents` gains `archetype` (default `standard`). The kernel keeps a registry of
  archetypes; `standard` is built in, archetype plugins register further ones (§5.10).
  The companion spec defines `facilitator`.
- An agent owns: identity (`agent_identities`: display name, short and long description,
  avatar, instructions, persona axes, verbosity), capability grants, memory tree, model
  policy, consultation grants, channel identities and bindings.
- Every user-visible answer is produced in the addressed agent's envelope: by its own
  model loop, or by a deterministic step that renders under its identity and settings.

### 5.2 What happens to today's concepts

| Concept today | Target |
|---|---|
| **Agent Builder output** ("Build your assistant", plugin of kind `agent` with persona) | The Builder creates **agents**: an `agents` row with identity and personality, plus, only where needed, a capability plugin the agent holds. A Builder specialist like the Strategist is directly addressable and speaks as itself. |
| **Vendor domain plugins of kind `agent`** (for example HR, accounting) | Become **capability plugins** that may ship **agent templates** (§5.10). The manifest kind `agent` is removed. A team that wants an "HR colleague" creates an agent from the template or by hand and grants it the capability. |
| **DB sub-agents** (`agent_subagents`, `ask_<name>`, Builder canvas node "Sub-Agent") | **Purpose:** helpers of one agent with their own (often cheaper) model, token and step budgets, a skill as prompt and a subset of the agent's tools, without the full conversation; this isolates context and cost (`middleware/packages/harness-orchestrator/src/registry/subAgentTools.ts`). **Conflict:** only where users meet them as a named specialist (the Strategist). **Adaptation:** kept as the agent's **internal helpers** (§5.6): no name or persona towards users, shown in the trace as the agent's own work, tool and memory access a subset of the agent's, the agent's budget covers all helpers, a cheaper model allowed by the agent's policy. The Builder node stays as "helper". A specialist users want to address is created as an agent. |
| **Persona skills** (`agent_persona_skills`, `personaRouter`) | **Purpose:** per turn, a cheap classifier picks the fitting answering mode from short skill descriptions and only then loads the skill body, saving context and a delegation run (`middleware/packages/harness-orchestrator/src/personaRouter.ts`). **Conflict:** the chosen body replaces the agent's identity and the UI says "Answering as X". **Adaptation:** kept as **working modes**: the same selection, but the skill is added beneath the agent's fixed identity, personality and boundaries (it never replaces the system prompt's identity part); the mode is visible in the answer's details and the trace, not in the message; selection runs as the agent's internal helper. |
| **Direct Line** (`#token`, sticky mode) | Removed (owner decision): direct addressing (INV-1) replaces it. Its advantage, a verbatim, attributed answer block the asking agent cannot alter, lives on in `contributions[]` (§5.4); `agentsConsulted` stays as trace summary. |
| **Fast path** (`@omadia/fast-path`) | **Purpose:** simple data questions without the full agent loop (about 15 s and, in one documented case, a sub-agent run of 88,000 input tokens avoided): a fast model plans one read query, the plugin runs it and renders the rows; no model sees the rows; learned plans, a cache and confidence thresholds; any miss falls back to the agent unchanged (`middleware/packages/harness-plugin-fast-path/src/fastPath.ts`, `triageTurn.ts`). It already embodies INV-11. **Conflict:** its answer skips the agent's persona, boundaries and AI disclosure, there is no per-agent switch, and it may use sub-agents' read tools (#1876). **Adaptation:** kept entirely, as the addressed agent's **fast lane**: the agent is fixed first (deterministically); triage, planner, learned plans and cache run as the agent's internal helpers under its model policy, only with its own read tools, with discretion labels on learned plans; the answer renders under its identity with AI disclosure; a miss returns to the same agent; switchable per agent; never for facilitators. Model-written labels and the planner's summary (`middleware/packages/harness-plugin-fast-path/src/planner.ts:85`, accepted by `parseSummary` in `fastPath.ts:200`) are `prose`: they pass the identity guard or are replaced by registered templates; the agent's boundaries and answer preferences apply, including on cache hits (the cache is keyed by agent and its settings version). |
| **Fallback agent** ("Standard Orchestrator") | The special role ends. The operator configures **default agents per human user and channel**, or switches the default off (§5.6). The default agent gets no automatic plugin attachment (INV-8). |
| **Auto-attach of plugins** (`attachAllPlugins`, `attachNewPluginsToFallbackAgent`, `attachToDefaultOrchestrator`) | Removed. A plugin install offers to attach the plugin to agents the operator picks; nothing is attached without that choice. |
| **UI orchestrator** of the desktop UI (`canvasChatAgent`, Tier 2) | **Purpose:** fast layout changes and local operations, early skeletons, targeted data requests and incremental patches while slow content work runs (omadia-ui `CONCEPT.md`). **Conflict:** it receives every canvas turn before any agent and delegates content to sub-agents. **Adaptation:** becomes the selected agent's **presentation helper**: the agent is fixed first; the helper keeps its parallelism (early skeleton, local operations, incremental patches) inside the agent's envelope and identity; content comes from the agent. |
| **Orchestrator** as an agent | Gone. The `Orchestrator` class is the runtime of one agent; registry, router, consultation broker, scheduler and Conductor form the management layer (§5.6). |

### 5.3 Addressing in every channel

| Channel | How the user addresses an agent | Speaker rendering |
|---|---|---|
| Teams | The agent's own bot (#860). | Native: bot name and icon. |
| Telegram, Slack, Discord, WhatsApp, iMessage | One bot or account per agent where the platform allows it. Otherwise explicit selection: a channel-native command or menu (for example `/agent Mira`) that the management layer stores as a binding for this user and conversation, confirmed once by a short `system` message. | Native where one identity per agent exists; otherwise the SDK name line only when the speaker would be unclear (INV-4). |
| Web chat (kernel `web-ui`) | Agent directory with name and avatar; the picker is always shown; the choice stays visible for the whole conversation. | Name and avatar on every message. |
| Desktop and mobile UI (`omadia-ui`, `omadia-ui-mobile`) | Agent selection per conversation; `ClientTurn` carries the agent id; the kernel dispatches per agent instead of the single `canvasChatAgent`. | Name and avatar on every message. |
| Public API | Agent slug required when a conversation starts and fixed for it; a missing or unknown slug, a disabled agent or a slug the API key may not use is refused with a typed error, never routed to another agent. | `speaker` field in the response. |

In a group chat several agents can be present, each through its own identity. Each one
answers only as itself. Bots never see each other's posts (Teams blocks bot-to-bot by
design); agent-to-agent work runs server-side and becomes visible as a consultation or as
each agent's own post (precedent: `middleware/src/conductor/sayService.ts`).

### 5.4 Consultation instead of delegation

**The rule: consulting adds a colleague's skill and judgement, never access.** A
consultation must never let A reach data that A cannot reach itself. Agent A without
access to system X cannot learn anything from X by asking B, who has access to X. Whoever
needs B's access writes to B directly, where B's own rules apply.

**Configuration per agent, default off.**
- Per agent: `consultable` (may other agents consult it at all, default off) and
  `may_consult` (may it consult others at all, default off).
- Directed grants in `agent_consultation_grants (from_agent_id, to_agent_id,
  channel_scope, allowed_capabilities, memory_access, max_calls_per_turn,
  max_calls_per_day, created_by, created_at)`: A may consult B, optionally only in some
  channels; `allowed_capabilities` lists which of B's capabilities B may use while
  answering A (default none: B answers from its instructions, skills and general
  knowledge only); `memory_access` is `none` (default) or `discreet` (B may draw on its
  memory, but only on entries whose origin context allows the flow to A and A's audience
  under §5.11).
- Grants are operator-managed, audited on both agents and revocable; revocation takes
  effect on the next call. Facilitators can neither hold nor be the target of a grant.

**Flow.**
1. A calls the harness tool `consult(agent, request)`. The harness checks the grant, the
   depth (max. 1: B cannot consult further while answering A), a per-turn call budget and
   a timeout. No cycles are possible at depth 1.
2. The harness runs B with B's identity, instructions, skills and model policy, and the
   authenticated turn context of A's turn (principals, channel, audience). B's **data
   access** in this run is the intersection of: the capabilities the grant allows, B's
   own grants, **A's own grants**, and the audience's rights. Anything outside that
   intersection is refused to B in this run exactly as it would be refused to A. On top,
   every piece of information in B's answer must pass the discretion rule of §5.11 for
   the recipients A and A's audience. B writes nothing to its memory from a consultation,
   and B's trace records whom it answered.
3. The harness produces two views of B's output:
   - the **user view**: B's answer after the privacy shield's user-side restoration and a
     second audience check at output time, delivered as B's contribution (step 4);
   - the **model view**: the masked form A's model may see. This is new: today the Direct
     Line path only avoids the leak by skipping its extra model pass when a privacy guard
     is active (`middleware/packages/harness-orchestrator/src/orchestrator.ts:6375-6384`);
     returning a masked view to A is a contract this work implements.
4. **Delivery of B's contribution.** `SemanticAnswer` carries an ordered list
   `contributions: [{ id, speaker, text, status }]` replacing the singular
   `delegatedAnswer`. If B has its own identity present in the conversation (for example
   B's Teams bot is a member), B's contribution is posted by B's identity; otherwise A's
   message carries it with a plain, natural attribution ("Mira: …"), no chips, footers or
   buttons. A may add its own text, attributed
   to A; it cannot remove or rewrite a contribution and refers to it only by its `id`. A
   failed delivery is shown as failed, never dropped.
5. **Audience floor required.** A consultation runs only when the audience floor is
   active for the turn; without an audience provider the harness refuses the consultation
   with a `system` notice. omadia ships an audience provider enabled by default as part of
   this work (G15).
6. Cost and usage of B's run are recorded against B and linked to A's turn.

**One authorization for every agent-to-agent path.** Consultation, Conductor discussions
(`discussion_start`, `say`) and any relay between agents are authorized by the same
directed grants, audience check, facilitator exclusion and budgets. Today the discussion
peer gate combines the per-agent switch and the per-conversation policy
(`middleware/src/conductor/peerPolicy.ts:105`) but names no target agent; both stay, and a
discussion between agents X and Y additionally requires consultation grants in both
directions.

### 5.5 Enforcement in the harness

- **Speaker.** `SemanticAnswer` gains `speaker: { kind: 'agent', agentId, slug,
  displayName, avatarUrl? } | { kind: 'system' }`, set in `toSemanticAnswer` from the
  routing decision. A channel SDK helper `speakerLine()` gives channels without per-agent
  identity a plain-text name line.
- **Single emitter, typed.** Every path that produces user-visible output (model loop, fast
  path, deterministic actions, Conductor `say`, notices, errors) goes through one emitter
  that stamps the speaker. A path that cannot name its speaker cannot emit. Every emission
  declares its type, and the checks follow the type:

  | Type | Content | Checks before publication |
  |---|---|---|
  | `prose` | Model-generated text | Identity guard, deterministic layer and model layer (model layer runs on the masked text) |
  | `template` | A registered template filled with typed engine values | Template id and value types checked deterministically; no model call |
  | `data` | Side-channel data (§5.13) | Discretion and audience checks only; no model call, never seen by a model |
  | `system` | Management-layer notice | Template rules; speaker `system` |
- **Identity guard (mandatory, fail-closed).** Before publication, every `prose` emission
  passes a guard that is independent of the fact verifier and its settings:
  - claims to be human ("I am a person", "not a bot") are blocked like claims to be another
    agent;
  - deterministic checks against the directory of agent names and aliases: the agent
    calling itself by another agent's name, first-person self-identification as another
    agent, attributed quotes or paraphrases of another agent ("X says", "according to X")
    outside a harness consultation reference;
  - a model-based check as a second layer for paraphrases the deterministic layer misses;
  - streaming: text is released in complete sentences; each sentence is checked together
    with all text of the answer so far and published only after it passes, so a claim
    split across chunks is caught before any of it is visible; a guard failure or timeout
    blocks the rest and appends an honest `system` notice, never unguarded text.
- **Prompt assembly.** The compiled system prompt starts from the agent's own identity.
  The default identity text (G1) is replaced by one that states who the agent is, which
  colleagues it may consult, and that it never speaks as another agent.

### 5.6 Management layer and internal work of one agent

- The management layer routes deterministically. **Explicit addressing always wins:** the
  addressed agent's own channel identity (its bot, its mention in a group), an explicit
  selection in the conversation, or the agent slug of an API conversation. Without
  explicit addressing: a binding of the conversation, then the **default-agent table**,
  else a `system` notice. A binding never overrides an explicit address; if the explicitly
  addressed agent may not serve this conversation, the user gets a `system` notice, never
  another agent's answer. It never runs a model to pick an agent.
- **Default-agent table** (operator configuration): entries for (human user, channel),
  (human user), (channel) and the instance, evaluated in exactly this order; the first
  entry that exists wins, including an `off` entry. Each entry
  names an agent or is `off`. `off` means a message that is not addressed to a defined
  agent is never answered by any agent; the sender gets a `system` notice how to reach
  an agent. A fresh installation starts with the instance entry `off` until the operator
  sets defaults. Suggesting a colleague is an agent's own act, done as a
  visible consultation or a visible hint ("Mira knows this better, write to her"), never
  as hidden re-routing.
- An agent may split its own work into internal helper runs (parallel research, long
  documents, sub-agent helpers, model router, fast lane, mode selection, presentation
  helper). Helpers run strictly inside that agent's envelope: same identity, grants and
  memory scope or a subset of them, a model the agent's policy allows (it may be cheaper),
  the agent's budget, nothing added. Their output is the agent's own work and
  appears in its trace. Anything that needs another envelope is a consultation (§5.4).

### 5.7 Reach of an agent

- The agent page and the directory show each agent's reach: every connected system it can
  read or write through its grants, read and write marked separately.
- Granting a capability that gives an agent access to every connected system, or
  designating such an agent as the default, requires an explicit operator confirmation
  and is audited.

### 5.8 Colleague experience

The invariants make an agent honest; these requirements make it a colleague people want
to work with. Each is owned by the agent runtime, not left to a prompt alone.

| Quality | Requirement |
|---|---|
| Consistent personality | The same name, voice and personality in every channel and over time; personality changes only through the operator, never per turn. |
| Continuity | The agent remembers its own past work with a person and a team, within its memory scope and the audience's rights, and refers to it the way a colleague would. |
| Pace | The typing indicator where the channel has one; a short acknowledgement only when work will clearly take longer than a normal answer; a follow-up message when long work finishes instead of a timeout. No progress chatter. |
| Honest limits | When something lies outside its capabilities or rights, the agent says so plainly and names who can help (a colleague agent or a person), instead of guessing. |
| Communication and emotion | Tone, warmth, humour and empathy follow the configured personality and the situation; it reacts to frustration, praise and urgency like a good colleague. It never claims to be human. |
| Team etiquette | In group chats it speaks when addressed or when its role calls for it, never chimes in on every message (#1035 communication profile). |
| Quality | Data from systems reaches people through the side channel and needs no model check. For factual claims in `prose`, the fact verifier is on by default in `shadow` with metrics; each instance moves it to `enforce` once its false-positive rate is acceptable (today it is off by default, `middleware/src/config.ts:684`). The agent says how sure it is when it matters. |

Operators can see per agent how people rate the collaboration, so the target picture of §1
becomes measurable. The signal comes from natural reactions where the channel has them and
from occasional, explicit asks outside answers; answers carry no rating buttons.

### 5.9 Product language

- "Orchestrator" is replaced by "Agent" in all UIs, API descriptions and docs aimed at
  operators and users (`GLOSSARY.md` rule removed; German "Agent", plural "Agenten").
  Code identifiers stay.
- Onboarding and marketing describe agents as virtual employees with a name, a
  personality and clear permissions.

### 5.10 Agents and plugins: the boundary

**Rule of thumb:** if something needs a name, a personality or should be addressable, it
is an agent. If it extends what agents can do, it is a capability plugin. If it adds a new
class of agent to the system, it is an archetype plugin.

**Two classes of plugins, clearly distinguished:**

| | Capability plugin | Archetype plugin |
|---|---|---|
| Adds | Tools, integrations, channels, providers, extensions, UI, skills, agent templates: what agents can do | A new agent archetype: a class of agent the system did not have (today the facilitator; later others) |
| Manifest kind | `integration`, `tool`, `channel`, `provider`, `extension`, `ui`, `skill`, `agent-template` | `archetype` |
| Hub and install | Listed as capabilities; installing attaches it to no agent (INV-8) | Own hub category "agent archetypes"; installing asks for an explicit confirmation that a new kind of agent is added |
| Operator UI | Capability grants on an agent's page | Its own section in the agent directory, where the operator creates agents of that archetype |
| Holds | Only technical state | The process state of its archetype's work (for example facilitations), bound to its agents' processes, with discretion labels and retention; never general conversation memory |

**Archetype contract.** An archetype plugin declares a descriptor the kernel enforces:
what the archetype inherits from the agent model, what it adds, what it deliberately
omits (grants, memory, consultation, default-agent role, fast lane), its role contract
(for the facilitator the neutrality block) and its persona bounds. The kernel stays
responsible for every agent of every archetype: identity and speaker, INV-1 to INV-11,
refusing the omitted grants, discretion, and every model turn (run through the kernel's
agent turn, with model policy, privacy shield, budgets, deadlines and kill switch). An
agent has exactly one archetype, set at creation; it never switches. Uninstalling an
archetype plugin disables its agents and keeps their records; it never converts them to
another archetype.

An **agent template** is something else: a preset of identity, personality and
capabilities for an agent of an existing archetype.

| | Agent | Plugin |
|---|---|---|
| Role | Actor: a virtual colleague who does the work. | Supplier: extends what agents can do. |
| Identity | Name, avatar, personality, speaks to people. | None. Never speaks to people, never addressable. |
| Accountability | Appears in audit as the actor of every action. | Appears as the tool or integration an actor used. |
| Permissions | Holds grants. | Declares what can be granted (capabilities with read/write scopes) and keeps integration credentials in the vault; agents never see secrets. |
| Memory and state | Own memory tree, scoped by audience. | Capability plugins: only technical state (configuration, caches, sync cursors), no memory of conversations. Archetype plugins: additionally the process state of their archetype's work (see below), never general conversation memory. |
| Models | Runs its own model loop under its model policy. | May use a model internally to implement a capability, under the calling agent's model policy, budget, grants and audience, recorded in that agent's trace; returns data to the agent, never text to a person. |
| Origin | Created by the operator, by hand, in the Builder or from a template. | Installed from the hub or uploaded. |

**Plugin kinds after this spec**, capability plugins: `integration` (connection to a third-party system and
its credentials), `tool` (functions agents can call), `channel` (transport to people),
`provider` (models, embeddings, storage), `extension` (kernel extensions without identity,
for example the agent runtime, verifier, fast path, plan runner, memory services; their
service contracts stay), `ui` (extensions of the operator or user UI),
`skill` (skill packs: instructions and knowledge an agent can load; skills can also be
authored, imported or forked in the instance itself, `skills` table, migration `0003`,
`middleware/src/routes/agentBuilder.ts:945,977,1104`; either way a skill is a capability an
agent is granted, never an actor), `agent-template` (a preset of
identity, personality and suggested capabilities that the operator instantiates as an
agent; the template itself never runs). Archetype plugins have the manifest kind `archetype`. The manifest kind `agent` is removed.

**Enforced by the kernel:**
- no plugin is an actor itself: an archetype plugin defines a class whose agents the
  operator creates and the kernel runs; a capability plugin adds abilities. Neither has a
  persona, speaker or identity of its own, and neither registers
  conversation endpoint that answers on its own behalf. Channel plugins transport
  messages for kernel-managed agent identities (for example the Teams bot the kernel
  provisions for an agent) and may expose the endpoints that transport needs; agent
  templates may carry identity and personality as inactive metadata that only the
  operator turns into an agent;
- a capability's result goes to the calling agent as data (structured result, optionally
  text the agent may use); only agents and `system` emit to people (§5.5);
- a capability call runs in the calling agent's envelope: its grants, the audience, its
  model policy and budget; it never widens them;
- a plugin's internal model calls appear in the calling agent's trace and usage.


### 5.11 Discretion: who may learn what, and how much

Employees who never talk to each other are never as effective as a team that shares what
it knows; but every exchange can leak. Confidentiality and discretion are core business
virtues of an ideal colleague, so omadia turns them into mechanics. The memory system
already does this for recall: an agent can only retrieve memory if the current context
allows it (context-memory ACL, `docs/teams-multi-agent-identities.md` §8; migrations
`0050`, `0062`). This section extends the same idea to every flow of information,
including capability and interface calls and agent-to-agent communication.

**Labels.** Every piece of information carries a label, attached where it enters an
agent's turn:

| Source | Label |
|---|---|
| Memory entry, conversation history, summary, knowledge-graph node | Its context tier and key (team, channel, user, members) **plus every label of the information it was written from** (source system, grant, classification), persisted with the entry. |
| Capability or interface result | Source system, the grant used, the principals whose rights allowed the read, and the field classification of the privacy shield (migrations `0065`, `0066`). |
| Message from a person | The conversation context and its members. |
| Contribution of another agent | The labels of everything that agent used to produce it. |
| Instructions and skills | A classification set by the operator (default: public); knowledge-bearing skills carry the labels of their sources. |

**Turn label set.** The harness tracks, per turn, the union of labels of everything read in
that turn. Model output cannot be traced token by token, so every output of the turn
carries the whole set: the strictest label wins. Labels are **persisted transitively**:
whatever a turn writes (memory, history, summary, protocol) keeps the turn's label set,
and reusing it later adds those labels to the new turn. A conversation history therefore
carries the labels of everything that was ever read into it.

**Mask at entry, not at exit.** A label can only be lowered by a named deterministic
transformation: the privacy shield masking classified fields before they reach the model,
or a deterministic aggregate operation. Once unmasked content reached the model, every
paraphrase or conclusion is treated as that content. So the harness masks, before the
model sees anything, every field the turn's audience may not know; and if an egress fails
the flow rule anyway, the output is refused as a whole (or regenerated from permitted
context only), never redacted afterwards.

**Flow rule.** Every egress of a turn is checked against its label set before it happens:

| Egress | Allowed only if |
|---|---|
| Answer or post to people | Every reader of the target conversation may know it (audience floor). |
| Contribution to another agent (consultation, discussion, relay) | The receiving agent's own grants cover it and every reader of the receiving agent's current conversation may know it. |
| Memory write | It is written to a context tier whose readers may all know it (today's write rules of the context-memory ACL). |
| Outbound capability or interface call carrying data (write to CRM, send mail, create ticket) | The target system's declared readership covers it. Operators declare a readership per integration; without a declaration, data from restricted contexts or classified fields is not sent. |

**How much.** A grant (capability grant or consultation grant) carries a disclosure level per
data classification:

| Level | Meaning |
|---|---|
| `full` | The information itself. |
| `redacted` | Classified fields masked by the privacy shield. |
| `aggregate` | Only results of deterministic aggregate operations (counts, sums), never records; never computed by a model. |
| `existence` | Only that a colleague or system knows something, with whom to ask ("Mira can help with this"). |
| `none` | Nothing, not even existence. |

A blocked flow is never silent towards the agent: it receives a structured refusal and
answers honestly that it cannot share this here, without revealing what it withholds.

**Defaults.** The context-memory ACL is on for every agent in mode `members` (recall uses
only knowledge everyone present owns, migration `0062`; today the column defaults to
`off`, migration `0050`); operators may choose `enforce` or `enforce-strict`, never `off`
for an agent with access to classified data; consultation grants default to `none`; integrations without a
declared readership receive no data from restricted contexts. Every blocked and every
allowed cross-context flow is audited with its labels, never with the content.


### 5.12 Proactive work: wakeups and hooks

A virtual colleague who notices something or has something important to say, but only
says it when asked, is worthless. Agents, and facilitators even more, act proactively.
Constant heartbeats are not the answer: they burn resources around the clock. Like a
well-organised person, an agent sets itself exactly the reminders and watches it needs,
for as long as it needs them.

**Three trigger kinds, owned by the agent.** The agent creates them through harness tools,
decided ad hoc from context, requirement and configuration, without asking users:

| Tool | Use |
|---|---|
| `on_event(filter, purpose, context, until, max_fires)` | **Preferred** wherever an event exists: new message in a conversation, member joins, meeting starts or ends, poll answered, calendar event, task finished, integration webhook (for example a new expense report). The harness lists the event sources the agent's channels and capabilities offer. |
| `wake_at(time, purpose, context, until)` | One-shot wakeup, for example "three working days before month end, look at the open expense reports". |
| `wake_every(interval, purpose, context, until, max_runs)` | Recurring only while needed, for example time-keeping every 5 minutes during a meeting. |

Examples: a facilitator in a meeting subscribes to new messages and sets a 5-minute timer
for time-keeping, both ending with the meeting; an agent watching expense reports sets
itself a one-shot wakeup before month end.

**What a firing does: deterministic action first.** Every trigger names its action, and
the harness picks the cheapest one that serves the purpose (INV-11):

| Action | Model call | Examples |
|---|---|---|
| `check` | none | Is the meeting still live? Did anything change since the last firing? Is the expense report still open? |
| `post` | none | Templated message with values from the engine: "5 minutes left for this step", "two contributions are still open", "reminder: your action item is due tomorrow". |
| `deliver` | none | A data action whose result goes through the side channel to the recipients (a list of open expense reports, a status table). |
| `turn` | yes, under the agent's model policy and budget | Only where judgement or language is needed: summarise a stalled discussion, weigh what is worth telling the owner, write a narrative overview around delivered data. |

A trigger may chain them (`check` then `deliver`, and a `turn` only if the check finds
something that needs judgement). Most firings never reach a model.

**Harness guarantees (deterministic, not overridable by any prompt or plugin):**
- **Mandatory deadline.** No trigger without `until`; instance caps bound it (proposed:
  one-shot within 90 days, recurring and hooks within 30 days). A recurring trigger also
  needs `max_runs`. Expired triggers are deleted, not paused.
- **Bound to a context.** Every trigger names its purpose and context (conversation,
  facilitation, meeting, task); it ends automatically when the context ends, whichever
  comes first.
- **Limits.** Minimum interval per kind (proposed: 1 minute during a live meeting,
  15 minutes otherwise); maximum number of active triggers per agent.
- **Budget.** A cost cap per firing and per trigger, and a monthly cap per agent and per
  instance, enforced before each model call. Reaching a cap suspends the trigger and
  sends a `system` notice to the operator; an instance-wide kill switch stops all
  triggers at once.
- **Cheap first.** A firing first runs a deterministic pre-check (anything new since the
  last firing? is the meeting still live? is the condition still open?). No model call
  happens when there is nothing to do.
- **Circuit breaker.** Consecutive failures, or consecutive model turns without any effect,
  pause the trigger; unlike today's plugin jobs, failures never keep a trigger running. A
  model-free check that finds nothing to do yet is a success, not a failure: monitoring
  continues until its deadline or run limit.
- **Durable, once per occurrence.** Triggers survive restarts. Every occurrence has a
  persisted id; it is claimed under a lease and fired at most once. Its effects follow
  delivery classes: droppable effects (reminders, nudges) are never retried after an
  unknown outcome; essential effects are retried until confirmed, accepting a rare
  duplicate (channels give no exactly-once delivery).
- **Same rules as any turn.** A firing runs in the agent's envelope and carries the
  discretion labels of the context it was created in (INV-9); proactive messages go to
  that context's audience, or to an explicit target (for example a reminder a user asked
  the agent to send to a colleague) that is allowed by a recipient grant and passes the
  discretion check for the recipient at send time; they respect the communication
  profile, quiet hours and a rate limit per recipient (#1035).
- **Visible.** Operators see every active trigger per agent with purpose, context,
  deadline and cost so far; a user can ask an agent what it is currently watching for
  them; every creation, firing and end is audited.

**Changes to today's mechanisms:**

| Mechanism today | Change |
|---|---|
| **Routines** (user-owned recurring cron with a prompt, no end date or cost cap) | **Purpose:** a person has an agent do something on a schedule; human owner per tenant, pause, resume, delete, run history, agent assignment, cron calendar semantics, authorised first contact with other people (`middleware/src/plugins/routines/`, #1028, #252). **Adaptation:** become user-requested triggers of this mechanism, **keeping all of that**: the executing agent and the human owner are kept apart, owner rights and controls stay, cron calendar semantics with time zone stay; new are a deadline with a renewal question before it ends, a budget and a pre-check. Output templates (data from the raw tool result, model only for narrative slots) become the default form: `deliver` plus an optional `turn`. |
| **Plugin jobs** (cron or interval until deactivation, failures keep ticking) | **Purpose:** technical maintenance such as syncs; a transient network error must not end a sync for good (`middleware/src/plugins/jobScheduler.ts`). **Adaptation:** stay, and never call a model. Failures back off with bounded recovery probes instead of a permanent pause; successful "nothing changed" runs never count as failures; operators see last run and error state. |
| **Conductor event, webhook and cron triggers** (operator-authored workflows) | Stay for operator-designed processes. Agent hooks use the same event bus (`middleware/src/conductor/eventRouter.ts`); channel and integration plugins publish their events there (plugins emit through `ctx.events.emit`, `middleware/src/platform/pluginContext.ts:1028-1033`, gated by the event catalogue). Model steps of workflows count against the same budgets. |
| **Facilitation pattern's hourly model tick** | Replaced by hooks and deterministic timers of the facilitation engine (native facilitators spec). |
| **Periodic learning and consolidation** (for example the scratch-promotion reaper, `middleware/packages/harness-orchestrator-extras/src/scratchPromotionReaper.ts`) | **Purpose:** important insights become durable knowledge. **Adaptation:** due entries are found deterministically; the classification runs as a bounded batch trigger owned by the agent whose memory it is, with budget and deadline; origin labels are kept, nothing is published as team knowledge by default. |
| **Fixed heartbeats** | None. Nothing in omadia polls a model on a fixed schedule without a context, deadline and pre-check. |


### 5.13 Deterministic first and side channels

Harnesses like Claude Code or OpenClaw route nearly everything through a model. omadia
does not: it combines the best of classic deterministic software and of agents into a
hybrid, progressive agentic OS. The agent is the colleague who decides and coordinates;
the harness does everything that can be done without a model.

**Decision rule, for every component:** before a step uses a model, the design states why a
deterministic path is not enough. Deterministic by default: routing, permissions,
discretion checks, counting and evaluation, scheduling and pre-checks, templated
messages, data retrieval, formatting and rendering, protocol assembly, delivery. Model
only for: understanding free text, judgement, open-ended reasoning, language that has to
fit a situation.

**Side channel for data.** When a user needs data from a source system (ERP, CRM,
knowledge graph, files):
1. The agent decides in its turn which data action runs (or a deterministic recipe it
   owns decides).
2. The harness executes the action under the agent's grants, applies discretion (INV-9)
   and the audience floor, and renders the result into the answer through the side
   channel, under the agent's identity and with AI disclosure.
3. The agent's model receives a status (success, row count, columns, any refusal), not
   the rows.
4. Only if the agent needs the content itself to reason (for example to compare two
   figures), it requests exactly those fields; they reach the model masked by the privacy
   shield where required.

omadia already does this in places: the privacy shield's table render hands real rows to
the canvas sink and gives the model only a shape acknowledgement
(`docs/security-architecture.md`, "canvas-sentinel side channel"); routine output
templates fill data sections from the raw tool result and use the model only for
narrative slots (`middleware/src/plugins/routines/routineOutputTemplate.ts`); the fast
path renders tables without a model. This spec makes the pattern the default for every
channel and every data answer.

**Consequences in this spec:** the facilitation engine computes all state; triggers
prefer `check`, `post` and `deliver` over `turn` (§5.12); the identity guard runs its
deterministic layer first (§5.5); routing and discretion are model-free (§5.6, §5.11).


### 5.14 Natural, uncluttered answers

**The chat is the primary UI.** For now, people work with omadia agents in the chat of
their existing channels (Teams, Slack, Discord, Telegram and others); the omadia UI comes
later. That chat must feel like chatting with a colleague: tidy, precise, on point and
compact. No walls of text, no incomprehensible extra options, no bureaucracy. Answers are
short by default and get longer only when the content needs it or the person asks.

**Channel parity.** Every agent capability is fully usable through plain text in every
supported channel. Rich elements (cards, buttons, polls, tabs) are optional enhancements
where a channel renders them, never the only way to do something. Nothing may work only in
Microsoft Teams.

**Every decoration is justified.** A hard-coded status line, chip, footer or button above or
below an agent's answer exists only with a written justification: a legal requirement, or
a concrete, likely next action whose button saves the user typing. Decorations are declared
in one registry with their justification and the channels that render them; the channel
SDK refuses undeclared decorations, and a test fails when a new one appears without an
entry.

An ideal colleague answers with what matters, not with status lines and buttons. Answers
today already carry too much: in Teams a "✨ AI-generated" chip, a verifier badge, a
system-data chip, "💬 Direkte Antwort von …", a "🔎 Konsultiert: …" footer, "🔽 Kürzer / 🔼
Mehr Details", "💡 Nächste Varianten" and Direct-Line buttons (`omadia-channel-teams`
`src/teamsCard.ts`); most channels (Telegram, for example) cannot show such elements at
all. Answers become long, complex and hard to read, and the colleague feeling breaks.

**Rule:** the message body contains what a good colleague would say. Everything else lives
in the structured answer and in on-demand details (a collapsed "details" view where the
channel has one, the trace in the operator UI, or simply by asking the agent "how do you
know?"). A button or card appears only when it replaces typing for a concrete, likely next
action that the user would otherwise have to type (for example confirming a decision, a
poll), and only in channels that render it. Channels without rich elements get plain,
natural text.

Each existing element keeps its purpose, moved out of the message body:

| Element today | Purpose | Target |
|---|---|---|
| AI disclosure | EU AI Act Art. 50 | Stays as the law requires, in the most discreet form the channel offers. Today the text line appears once per conversation (`middleware/packages/harness-channel-sdk/src/aiDisclosure.ts:249-265`), the structured field on every answer, and Teams adds its own chip to every card. How often channel markers appear becomes an operator setting (#2087); default: today's behaviour until OD-5 is settled. |
| Verifier badge, system-data chip | Show that facts were checked or come from a system | In details; the agent says how sure it is in words when it matters (§5.8). |
| "Konsultiert" footer, "Direkte Antwort von" chip | Tamper-evident attribution (#332) | Contributions of other agents appear with a plain attribution in the text or as that agent's own post (§5.4); the full trace stays in details. |
| "Kürzer / Mehr Details" buttons | Change answer length without retyping | Not on every answer; the user just asks ("kürzer bitte"), the agent's verbosity setting covers the default. |
| "Nächste Varianten" follow-up buttons | Suggest next steps | Only when the agent actually proposes options it expects the user to pick; otherwise the agent offers next steps in words if useful. |
| Direct-Line buttons | Talk to a sub-agent directly | Gone with Direct Line. |
| Speaker name line, mode, consulted agents, verification, privacy receipt | Transparency and audit | Structured fields and details, shown in text only where INV-4 requires it. |

## 6. Acceptance criteria

1. **Strategist regression.** A Builder-created "Strategist" and a second agent exist.
   Addressed through web chat, Teams and the desktop UI, the Strategist's envelope answers
   (trace shows its agent id); the second agent never answers in its place, and the
   Strategist is never reachable as a hidden tool of another agent.
2. **Identity guard.** Scripted model outputs are blocked and replaced by a `system`
   notice in each case: the agent calls itself "the Strategist"; it quotes the Strategist
   without a consultation; it invents a Strategist statement although a real consultation
   happened; the same in German and English; in streaming and non-streaming mode with
   randomised chunk boundaries (including a claim split across chunks); with the guard's
   model layer timing out.
3. **Consultation views.** In a consultation with the privacy shield active, the user view
   of B's block contains the restored values the audience may see, A's model view stays
   masked, and an audience member without the right to a field sees it redacted.
4. **Consultation limits.** Without a grant the call is refused; B cannot consult a third
   agent while answering A; a revoked grant is refused on the next call; no consultation
   runs without an active audience floor; a `discussion_start` between agents without
   mutual grants is refused; two consultations of the same B in one turn produce two
   contributions with distinct ids; a failed delivery is shown as failed.
5. **Speaker everywhere.** The structured answer of every user-visible message in every channel of the §5.3 matrix
   (Teams, Telegram, Slack, Discord, WhatsApp, iMessage, web chat, desktop UI, mobile UI,
   public API) carries a speaker (agent or `system`); a test enumerates every emitter and
   fails on a new one without a speaker.
6. **Envelope.** For one agent, a test checks persona and boundaries in the prompt, every
   granted capability callable, every non-granted capability refused, memory reads limited
   to its own tree, and the fast path rendering under its identity with AI disclosure;
   with the fast path off for that agent, no fast-path answer occurs.
7. **Fail loud.** A message to a disabled agent's binding produces a `system` notice
   naming the agent, never an answer from another agent.
8. **No foreign model before the agent.** An unaddressed message with no default agent
   yields the `system` notice and the turn's LLM usage trace is empty. For an addressed
   turn, every model call in the trace (including fast-path planning and routing) runs in
   the addressed agent's envelope.
9. **No super-agent out of the box.** A fresh installation with five plugins installed has
   no agent holding any of them; installing a sixth plugin attaches it to no agent.
10. **Pace.** A request whose answer takes longer than the channel's acknowledgement
    threshold gets an immediate acknowledgement; work that outlives the channel's reply
    window ends with a follow-up message, never a silent timeout.
11. **Helper envelope.** An internal helper run that calls a capability its agent lacks is
    refused.
12. **Language.** No user- or operator-facing string says "Orchestrator".
13. **No access through a colleague.** Agent A without a grant to system X consults B, who
    has one: B cannot call X in this consultation, does not read its private memory, and
    nothing from X reaches A or the user through B; asking B directly still works under
    B's own rules. Consultation is refused when either agent's `consultable`/`may_consult`
    is off or no grant exists.
14. **Default-agent table.** For (user U, Teams) → agent M, (Teams) → agent N, instance
    `off`: U's unaddressed Teams message goes to M, another user's to N, an unaddressed
    web message gets the `system` notice and no model call.
15. **Plugin boundary.** A plugin manifest declaring a persona or speaker of its own, or
    kind `agent`, is rejected at install; a channel plugin transporting two agents' bots
    and an agent template with a personality load successfully; a capability result never
    reaches a channel without an agent speaker.
16. **Discretion across agents.** Agent B learned in an HR group chat that person P is
    leaving (memory entry with that context). Agent A consults B from a sales chat: B's
    answer contains nothing about it; with disclosure level `existence` it says only that
    HR can help.
17. **Discretion towards systems.** In a 1:1 turn with an HR manager, A reads an HR record
    through its grant and then tries to write a CRM note containing it: the call is
    refused because the CRM's declared readership does not cover the label; A says so
    without quoting the record.
18. **Mask at entry.** In a group with a member lacking the right to a classified field,
    the model never receives that field unmasked, and an answer whose label set still
    exceeds the group's rights is refused as a whole; a test asks the model to paraphrase
    the field and checks that nothing of it reaches the group.
19. **Default on.** A fresh agent has the context-memory ACL in mode `members`; a recall
    in a conversation where someone present does not own the knowledge returns nothing
    of it, and the same recall works when only owners are present.
20. **Bounded triggers.** A trigger without deadline, a recurring trigger without
    `max_runs`, or an interval below the minimum is refused. Over 30 simulated days with a
    scripted model that always fails or always answers, no trigger exceeds its budget, a
    failing trigger pauses after the breaker threshold, and the instance cap is never
    exceeded.
21. **Cheap first.** A timer firing with nothing new since the last firing makes no model
    call (LLM usage trace empty).
22. **Context end.** Ending a meeting ends its message hook and its time-keeping timer in
    the same transaction.
23. **One-shot wakeup.** The expense agent's month-end wakeup fires once, sends its owner
    an overview, and is gone; after a restart in between it fires exactly once.
24. **Proactive discretion.** A proactive message created in an HR context never reaches a
    sales chat, and none goes out during the recipient's quiet hours.
25. **Side channel.** A user asks an agent for the open invoices of a customer: the table
    reaches the user under the agent's identity with AI disclosure, and the model's
    trace contains the status (row count, columns) but none of the rows.
26. **Deterministic firings.** In a 60-minute meeting with a 5-minute time-keeping timer
    and a message hook, the time-keeping posts and reminders cause no model call; model
    calls happen only for summaries and moderation that need language.
27. **Labels persist.** Agent A reads an HR record in a 1:1, the turn is summarised into
    memory; weeks later a consultation or a CRM write that would carry that summary is
    refused, because the summary kept the HR label.
28. **Kept advantages.** The fast lane answers a simple data question without the full
    agent loop, under the agent's identity and with disclosure, and a miss reaches the
    same agent; a sub-agent helper runs on a cheaper model within the agent's budget and
    is never named to the user; a working mode changes the answer's approach but not the
    agent's name or personality; a routine stays pausable by its human owner; a plugin
    sync recovers after a transient network error.
29. **Uncluttered answers.** A normal answer in Teams consists of the text and the AI
    disclosure in its most discreet form, with no status chips, footers or buttons; the
    same answer in Telegram is plain text; the trace, verification and consulted agents
    are reachable in details or by asking.
30. **Channel parity.** Every capability of an agent, including choosing an agent, giving
    a contribution in a facilitation and answering a poll, works through plain text in
    Telegram as well as in Teams; a test drives each through the plain-text path.
31. **Justified decorations.** An undeclared status line or button above or below an
    answer fails the decoration-registry test.
32. **Waiting is not failing.** A trigger whose model-free check finds nothing on five
    firings and an overdue invoice on the sixth still takes its action on the sixth.
33. **Fast lane under the guard.** A planner summary claiming another agent's name or
    contradicting the agent's boundaries is blocked; a cached plan reused after the
    agent's settings changed is re-checked against the new settings.
34. **No claim to be human.** Scripted outputs claiming to be a person ("ich bin Anna aus
    dem Vertrieb, kein Bot") are blocked by the identity guard in German and English.

## 7. Migration and compatibility

There are no customer installations yet (owner, 2026-11-18). The first ones follow
soon, after which a change of this depth would be far harder. This spec therefore builds
the target model directly, **without compatibility layers, deprecation periods or upgrade
paths**. Internal test and demo instances are re-seeded.

- **Migrations:** `agents.archetype` (default `standard`) and the archetype registry; `agent_consultation_grants`;
  dropping Direct Line state. `agent_subagents` and `agent_persona_skills` stay (internal
  helpers, working modes).
- **Removed** (owner decisions, advantages carried over as stated): `#token` Direct Line
  addressing and sticky mode; every auto-attach of plugins; the fallback agent's special
  role and its first-boot seeding; the per-turn identity switch of persona skills (the
  selection stays); the orchestrator default identity text; the Builder's persona-bearing
  plugin output (replaced by agent creation); the fast path's answer outside the agent's
  identity (the fast path itself stays).
- **Kept and repurposed:** `agentsConsulted` stays as trace summary; `delegatedAnswer` is
  replaced by `contributions[]` (§5.4); both existing levels stay (the per-agent switch
  `agents.agent_to_agent` and the per-conversation `agent_channel_policies`, which decide
  whether agents may speak with each other in a chat); a consultation or discussion
  additionally needs the directed consultation grants. All three must allow it.
- **Channel plugins** render `speaker` and consultation blocks in the same release; the
  SDK name line covers channels without native per-agent identity.
- **Onboarding:** a fresh installation starts with no agent holding any capability; the
  first-run flow creates the first agent with an explicit choice of capabilities.
- **Docs:** `docs/middleware-agent-handoff.md`, `docs/architecture.md`,
  `docs/teams-multi-agent-identities.md` and `docs/creating-plugins.md` describe this
  model in the same release.

## 8. Work breakdown

Kernel unless noted. Each item becomes one issue in epic #2042.

1. Speaker on `SemanticAnswer`, single emitter, `system` notices, web chat rendering
   (INV-4, INV-6, INV-7).
2. Identity guard, mandatory and fail-closed, including streaming (INV-3, §5.5).
3. Consultation: per-agent switches and directed grants with allowed capabilities and
   memory access, access = intersection with A's grants, two views, `contributions[]`,
   audience floor required, limits and cost attribution; the same grants authorize
   discussions and relays (INV-5, §5.4).
4. Audience provider enabled by default (G15).
5. Agent Builder creates agents instead of persona-bearing plugins (G2).
6. DB sub-agents as internal helpers: no identity towards users, trace as the agent's own work, budgets under the agent (G3, §5.2).
7. Persona skills as working modes: selection kept, skill added beneath the fixed identity, UI "mode: X" (G5, §5.2).
8. Remove `#token` Direct Line addressing and sticky mode (G6).
9. Plugin model: plugin kinds incl. `agent-template`, manifest kind `agent` removed,
   kernel enforcement of the boundary, capability calls in the caller's envelope (§5.10).
10. Fast path as the agent's fast lane: agent fixed first, triage, planner, learned plans
    and cache as its helpers, answer under its identity with disclosure, per-agent switch
    (#1876, §5.2, §5.13).
11. Fail loud instead of silent fallback (#1880).
12. Least privilege by default: no auto-attach, onboarding without a super-agent, reach
    display and confirmation (INV-8, §5.7).
13. Management layer: deterministic routing without model choice, default-agent table per
    user and channel with `off`, helper runs inside the envelope (INV-6, §5.6).
14. Default identity text and prompt assembly per agent (G1).
15. Agent directory, always-visible agent selection and per-message speaker in web chat;
    "Orchestrator" renamed everywhere (G9, G16).
16. Colleague experience: acknowledgement, progress and follow-up for long work;
    consistent personality across channels; honest limits; collaboration feedback (§5.8).
17. `omadia-ui`: agent selection, `agentId` in the protocol, speaker rendering, Tier-2 UI
    orchestrator becomes the renderer of the agent's answer; kernel per-agent canvas
    dispatch (G10, G11).
18. `omadia-ui-mobile`: agent selection and speaker rendering (G10).
19. `omadia-channel-teams`: `speaker` and `system` notices, consultation blocks with the
    new semantics (G12).
20. Remaining channels (Telegram, Slack, Discord, WhatsApp, iMessage): one identity per
    agent where possible, else the SDK name line; consultation rendering (G12).
21. Discretion: labels at every entry point, turn label set, flow rule at every egress
    (people, agents, memory, outbound calls), disclosure levels per grant, integration
    readership, audit; context-memory ACL on by default (INV-9, §5.11).
22. Proactive triggers: `on_event`, `wake_at`, `wake_every` owned by agents, event-source
    catalogue, mandatory deadline, limits, budgets with kill switch, pre-check, circuit
    breaker, durable exactly-once firing, operator view; routines migrated onto it
    (INV-10, §5.12).
23. Deterministic first: side-channel data delivery for every channel under the agent's
    identity, status to the model, targeted masked fields on request; data actions and
    recipes as agent capabilities; trigger action types `check`, `post`, `deliver`,
    `turn` (INV-11, §5.12, §5.13).
24. Plugin kind `extension` kept without identity; routines keep human ownership,
    controls and calendar semantics; plugin jobs recover with bounded probes; learning
    and consolidation as bounded agent batch triggers (§5.10, §5.12).
25. Chat-first, natural, uncluttered answers (channel parity, decoration registry with
    justification, compact answers by default): status chips, footers, verification and consultation
    markers and default buttons move from the message body into structured fields and
    on-demand details; name lines only where the speaker would be unclear; buttons only
    for a concrete likely next action in channels that render them (§5.14).

## 9. Owner decisions

**Decided by the owner (2026-11-18):**
- omadia is a team-first AI OS; a native orchestrator is incompatible with that by
  construction (§1).
- There is no orchestrator agent. An installation has one or more agents; the
  orchestrator becomes a management layer, not a full agent (§5.6).
- No super-agent as an out-of-the-box default. Whoever reaches such an agent holds the
  master password to every connected third-party system; whoever wants one creates an
  agent with broad rights deliberately (INV-8).
- No compatibility layers: there are no customer installations yet (§7).
- Agents are humanised deliberately and transparently, never deceptively (§1).
- Agents may consult colleagues, configured in detail per agent and default off; a
  consultation never gives an agent access it does not have itself (§5.4).
- Discretion is a core virtue of an ideal colleague: the context rules of the memory
  system extend to every flow of information, including capability and interface calls
  and agent-to-agent communication (INV-9, §5.11).
- Direct Line was a workaround and goes (§5.2).
- Deterministic first: everything the harness can do runs without a model; data reaches
  users through side channels past the model, the agent coordinates and gets a status,
  and gets data itself only targeted and masked. This holds for every part of omadia
  (INV-11, §5.13).
- Nothing existing is thrown out hastily: purpose first, then conflicts, then an adaptation
  that keeps the advantages. Direct Line goes; the fast path, DB sub-agents and persona
  skills stay in adapted form (§5.2).
- Default agents are set per human user and channel, and can be switched off so that no
  message ever reaches an agent that was not exactly defined (§5.6).
- The agent/plugin boundary and plugin kinds of §5.10; skills are capabilities, from
  plugins or authored in the instance.
- Two clearly distinguished plugin classes: capability plugins extend what agents can do;
  archetype plugins add an agent archetype. An agent has exactly one archetype (the native
  default or one added by a plugin, today the facilitator) and never switches (§5.10).
- Agents and facilitators act proactively through agent-owned hooks and wakeups that the
  agent picks itself; every trigger has a deadline, limits and a budget enforced by the
  deterministic harness; hooks are preferred over timers (INV-10, §5.12).

**Open (product governance):**
- OD-5: how often the visible AI disclosure must appear in a conversation (every answer, or
  once per conversation and on speaker change). Owner direction: the minimal form that is
  permissible; if a disclosure on every message is required, it stays switchable by the
  operator with default on. The product provides the setting (#2087); until the question is
  settled the default keeps today's behaviour (text line once per conversation; channel
  markers such as the Teams chip per answer). The structured disclosure field stays on
  every answer unless the operator switches the disclosure off; the form stays as discreet
  as the channel allows (§5.14).

## 10. Not verified

- The rendering of `agentsConsulted`/`delegatedAnswer` in Slack, Discord, WhatsApp and
  iMessage, and whether those plugins can run one identity per agent today.
- Which mechanism the beta "Strategist" used; G2 is the most likely, and the spec closes
  all three (Builder plugin, DB sub-agent, persona skill).
- The omadia-ui findings (G10, G11) were read from its `CONCEPT.md` and protocol, not from
  a running build.

## 11. Related

#332 (delegation transparency, superseded), #445 (Direct Line, removed), #860 (per-agent
Teams identity), #914 (agent identity), #1018 (agent-to-agent in chats), #1035
(communication profile), #1876 (fast path), #1880 (silent fallback), #1888 (`#name`
collisions, gone with Direct Line), #1796 (tool-name collisions; helper tool names must be
collision-free or refused deterministically, #2050), #1777 (Builder persona
only in preview), #575 (audience floor).
