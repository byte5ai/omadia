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
  (`docs/ai-act-transparency.md`) stays on every answer.

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

| Term | Meaning in this spec |
|---|---|
| **Agent** | A virtual employee: one row in `agents` with its own identity, personality, capabilities, memory, model policy and channel identities. The only entity that speaks to users. **Anything that meets users with a name or a persona is an agent.** |
| **Agent kind** | `standard` (works for users and teams, may pursue their interests) or `facilitator` (impartial moderator, companion spec). |
| **Capability** | Something an agent uses: a plugin toolkit, a native tool, an MCP server, a skill. A capability has no name or persona towards users and never speaks to them. A capability may run an internal model loop (today: some plugins of kind `agent`); its output is tool output of the calling agent. |
| **Consultation** | One agent asking another agent, as a colleague, for a contribution (§5.4). |
| **Speaker** | Who a user-visible message comes from: an agent, or `system` for notices of the management layer. Stamped by the harness. |
| **Audience** | The humans who can read a turn's answer. Their rights cap what any agent may disclose (`audienceFloor`, #575). |
| **Management layer** | The deterministic kernel below the agents: routing, identity, grants, privacy shield, memory scoping, audit, scheduling, Conductor. It is not an agent (§5.6). |

There is no orchestrator agent. An installation has one or more agents and the
management layer. "Orchestrator" survives only as a code name of the agent runtime
package and disappears from the product surface (§5.9).

## 3. Invariants (normative)

**INV-1 Direct addressing.** Every agent is directly addressable in every channel where it
is deployed: through its own channel identity where the platform supports one, and
through explicit selection elsewhere (web chat, desktop and mobile UI, public API). A
turn addressed to agent A is executed in A's envelope. No model other than A's runs
before A to decide how the turn is answered. Deterministic, model-free pre-processing
(authentication, privacy shield, routing, rate limits) is allowed.

**INV-2 Exact capability envelope ("no more, no less").** A answers with exactly its own
configured identity, instructions, personality, boundaries, model policy, skills,
capability grants and memory scope, capped by the audience's rights.
- *No more:* no capability A was not granted, no global plugin configuration A does not
  have, no other agent's memory, no other agent answering in A's place.
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
decision, never from model output. Every channel renders it: through the agent's own bot
where one exists, otherwise as a harness-generated name line.

**INV-5 Visible collaboration only.** Agents may work together only as colleagues:
- A consulted agent B runs in B's envelope (identity, instructions, capabilities,
  memory, model), capped by the audience of the consulting turn; never widened by A.
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

## 4. Measured ground truth on `main`

Paths are relative to the kernel repo unless a sister repo is named.

| # | Finding | Violates | Evidence |
|---|---|---|---|
| G1 | The default identity of every agent is "an AI assistant that answers requests by delegating to specialised domain agents". | INV-6 | `middleware/packages/harness-orchestrator/src/orchestrator.ts:2210` |
| G2 | **Builder specialists are hidden plugins.** The Agent Builder ("Build your assistant") generates a plugin of kind `agent` with a persona (`AGENT.md`); at runtime it becomes the tool `query_<short>` of whatever agent it is attached to. No channel can address it. This is the most likely mechanism of the Strategist incident. | INV-1, INV-3 | `middleware/src/plugins/builder/buildPipeline.ts:246-252`; `middleware/assets/boilerplate/agent-pure-llm/manifest.yaml:19`; `middleware/src/plugins/dynamicAgentRuntime.ts:458-463,600` |
| G3 | **DB sub-agents** (`agent_subagents`, Builder canvas node "Sub-Agent") have a name and their own system prompt, but no identity towards users, no channel presence and no own conversation: each call is one self-contained question, and a memory grant resolves to the calling agent's turn-bound scope. | INV-1, INV-5 | `middleware/packages/harness-orchestrator/src/registry/subAgentTools.ts:102,153-157,338`; `middleware/packages/harness-orchestrator/src/localSubAgent.ts:143-146`; `middleware/packages/harness-orchestrator/src/registry/subAgentMemoryTool.ts` |
| G4 | Nothing prevents an agent from answering "as" another agent without calling it: no prompt rule, no harness guard. The fact verifier checks claims against tool traces, not speakers, and runs in `shadow` mode by default. | INV-3 | `middleware/packages/harness-orchestrator/src/verifierJudge.ts`; `middleware/src/config.ts:688` (`VERIFIER_MODE … default('shadow')`) |
| G5 | Persona skills swap an agent's identity per turn: a classifier picks a skill whose body replaces the agent's identity, with no call to anyone. The web UI shows "Answering as X". | INV-3 | `middleware/packages/harness-orchestrator/src/personaRouter.ts:1-20`; `web-ui/app/chat/page.tsx:1489-1525` |
| G6 | Direct Line (#332, #445) patches addressing on top of the orchestrator: an unknown `#token` silently falls through to the orchestrator; sticky mode is off by default and held in memory with a 2 h idle TTL; the Claude-CLI path has no Direct Line. | INV-1, INV-7 | `middleware/packages/harness-orchestrator/src/directLineSticky.ts:53,196-198,312-324`; `middleware/src/config.ts:96-99`; `middleware/packages/harness-orchestrator/src/cliChatAgent.ts` |
| G7 | The fast path answers data questions without running the agent: no persona, boundaries, answer size, kernel AI disclosure or Direct Line (#1876, open). Channels that add their own fixed AI chip (Teams) still mark the message as AI, but not as coming from the agent. | INV-2 | #1876; `omadia-channel-teams` `src/teamsCard.ts:1016` |
| G8 | A binding to a disabled agent silently falls back to the default agent (#1880, open). | INV-7 | #1880 |
| G9 | The web chat shows no speaker per message, only the pinned slug; the agent picker shows slugs and only appears with more than one enabled agent. | INV-4 | `web-ui/app/_components/AgentPicker.tsx:107,134-135` |
| G10 | The end-user UIs know no agents: omadia-ui and omadia-ui-mobile talk to one entity "omadia"; the kernel hard-routes canvas turns to one `canvasChatAgent`. | INV-1, INV-4 | omadia-ui `app/src/shared/protocol.ts` (`ClientTurn`), `app/src/renderer/src/App.tsx:981`; kernel `middleware/src/channels/orchestratorDispatcher.ts:142-165` |
| G11 | The desktop UI's architecture has its own orchestrator: a "Tier 2 UI Orchestrator" (small model) receives every canvas turn, decides between local action, UI composition and content, and delegates content to `chatAgent@1` and its sub-agents. | INV-1, INV-6 | omadia-ui `CONCEPT.md` ("Architecture", "Tier 2 — UI Orchestrator") |
| G12 | Consultation attribution is uneven: web chat and Teams render the delegated answer and the consulted footer; Telegram renders neither. | INV-4 | `web-ui/app/_components/chat/AgentsConsultedFooter.tsx`; `omadia-channel-teams` `src/teamsCard.ts:755-776`; `middleware/src/config.ts:93-95` |
| G13 | The default agent is a super-agent by design: first boot attaches every installed plugin to it, and every later kernel install path (Hub install, upload, reinstall, built-ins) attaches each new plugin of any kind to it. It also receives all unbound traffic. | INV-8 | `middleware/packages/harness-orchestrator/src/registry/onboarding.ts:104-129,155-176`; `middleware/src/index.ts:1797-1803` (#1491, #1498); `middleware/packages/harness-orchestrator/src/routing/channelResolver.ts:40` |
| G14 | `agent_to_agent` (migration `0058`) is a per-conversation relay switch, not a permission for A to consult B: it has no target agent. | INV-5 | `middleware/migrations/0058_agent_to_agent.sql:52` and its table key `(channel_type, channel_key, agent_id)` |
| G15 | The audience floor is inactive unless a provider is configured: without one the guard returns no restriction. | INV-2, INV-5 | `middleware/packages/harness-orchestrator/src/audienceFloorGuard.ts:272` |
| G16 | The product calls every configured agent "Orchestrator" (navigation, create form, chat picker, glossary rule "keep in English"). | INV-6 | `web-ui/messages/GLOSSARY.md`; `web-ui/messages/en.json` (`nav.agentsCluster`, `agentPicker.label`) |
| G17 | **What already holds:** per-agent Teams identity (1 agent = 1 Entra app + 1 bot + 1 app package, #860); per-agent identity, persona axes, instructions and avatar (#914, `agent_identities`); per-agent model policy, plugin and MCP grants, memory tree; harness-sourced `agentsConsulted` and `delegatedAnswer` (#332). | | `docs/teams-multi-agent-identities.md`; migrations `0049`-`0063` |

The foundation for virtual employees exists (G17). What is missing is that the agent the
user addresses is the only one who speaks, and that everything else is either an honest
capability or a visible colleague.

## 5. Target model

### 5.1 One entity: the agent

- `agents` gains `kind` (`standard` | `facilitator`, default `standard`). The companion
  spec defines `facilitator`.
- An agent owns: identity (`agent_identities`: display name, short and long description,
  avatar, instructions, persona axes, verbosity), capability grants, memory tree, model
  policy, consultation grants, channel identities and bindings.
- Every user-visible answer is produced in the addressed agent's envelope: by its own
  model loop, or by a deterministic step that renders under its identity and settings.

### 5.2 What happens to today's concepts

| Concept today | Target |
|---|---|
| **Agent Builder output** ("Build your assistant", plugin of kind `agent` with persona) | The Builder creates **agents**: an `agents` row with identity and personality, plus, where needed, a capability package the agent holds. A Builder specialist like the Strategist is directly addressable and speaks as itself. |
| **Vendor domain plugins of kind `agent`** (for example HR, accounting) | **Capabilities** (open owner decision **OD-1**, recommendation). Their internal prompts are task instructions, not identities; they carry no name or persona towards users and never appear as "an agent" in the product. A team that wants an "HR colleague" creates an agent holding that capability. |
| **DB sub-agents** (`agent_subagents`, `ask_<name>`, Builder canvas node "Sub-Agent") | Removed. Specialists are created as agents and consulted as colleagues (§5.4). |
| **Persona skills** (`agent_persona_skills` as identity candidates, `personaRouter`) | Removed as identity switch. A skill may shape how an agent works; it never changes who speaks. |
| **Direct Line** (`#token`, sticky mode) | Removed: direct addressing (INV-1) replaces it. `delegatedAnswer` and `agentsConsulted` are kept as the consultation block (§5.4). |
| **Fast path** (`@omadia/fast-path`) | Runs only inside the addressed agent's envelope. Today its planner and router models (`planQuery`, `routeTurn`) run before the agent (`middleware/packages/harness-plugin-fast-path/src/triageTurn.ts:204`); they become internal helper runs of A (A's model policy, boundaries and grants, §5.6) or the fast path is removed. Its answer renders under A's identity, carries the AI disclosure, respects boundaries and answer size, is switchable per agent and never runs for a facilitator. Open owner decision **OD-3** (recommendation: treat #1876 as a bug). |
| **Fallback agent** ("Standard Orchestrator") | The special role ends. Unbound traffic goes to an agent the operator designates as default, shown as itself; without a designation it gets a `system` notice asking the user to choose. Owner decision **OD-4**. |
| **Auto-attach of plugins** (`attachAllPlugins`, `attachNewPluginsToFallbackAgent`, `attachToDefaultOrchestrator`) | Removed. A plugin install offers to attach the plugin to agents the operator picks; nothing is attached without that choice. |
| **UI orchestrator** of the desktop UI (`canvasChatAgent`, Tier 2) | Becomes the canvas renderer of the selected agent. The agent answers first, in its envelope; UI composition runs afterwards as a presentation step of that answer under the agent's identity. Deterministic local operations (Tier 1) stay. |
| **Orchestrator** as an agent | Gone. The `Orchestrator` class is the runtime of one agent; registry, router, consultation broker, scheduler and Conductor form the management layer (§5.6). |

### 5.3 Addressing in every channel

| Channel | How the user addresses an agent | Speaker rendering |
|---|---|---|
| Teams | The agent's own bot (#860). | Native: bot name and icon. |
| Telegram, Slack, Discord, WhatsApp, iMessage | One bot or account per agent where the platform allows it; otherwise explicit selection. | Native where one identity per agent exists, else the SDK name line. |
| Web chat (kernel `web-ui`) | Agent directory with name and avatar; the picker is always shown; the choice stays visible for the whole conversation. | Name and avatar on every message. |
| Desktop and mobile UI (`omadia-ui`, `omadia-ui-mobile`) | Agent selection per conversation; `ClientTurn` carries the agent id; the kernel dispatches per agent instead of the single `canvasChatAgent`. | Name and avatar on every message. |
| Public API | Agent slug required per conversation. | `speaker` field in the response. |

In a group chat several agents can be present, each through its own identity. Each one
answers only as itself. Bots never see each other's posts (Teams blocks bot-to-bot by
design); agent-to-agent work runs server-side and becomes visible as a consultation or as
each agent's own post (precedent: `middleware/src/conductor/sayService.ts`).

### 5.4 Consultation instead of delegation

**Permission.** A new table `agent_consultation_grants (from_agent_id, to_agent_id,
channel_scope, created_by, created_at)` holds directed grants: A may consult B, optionally
only in some channels. Grants are operator-managed, audited and revocable; revocation
takes effect on the next call. Facilitators can neither hold nor be the target of a grant.

**Flow.**
1. A calls the harness tool `consult(agent, request)`. The harness checks the grant, the
   depth (max. 1: B cannot consult further while answering A), a per-turn call budget and
   a timeout. No cycles are possible at depth 1.
2. The harness runs B in B's envelope (identity, instructions, capabilities, memory,
   model policy) with the authenticated turn context of A's turn (principals, channel,
   audience). B's data access is the intersection of B's grants and the audience's
   rights, never widened by A.
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
   B's Teams bot is a member), B's contribution is posted by B's identity; otherwise it is
   rendered as an attributed block inside A's message. A may add its own text, attributed
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
peer gate checks only the per-conversation relay switch
(`middleware/src/conductor/peerPolicy.ts:105`); a discussion between agents X and Y
requires grants in both directions.

### 5.5 Enforcement in the harness

- **Speaker.** `SemanticAnswer` gains `speaker: { kind: 'agent', agentId, slug,
  displayName, avatarUrl? } | { kind: 'system' }`, set in `toSemanticAnswer` from the
  routing decision. A channel SDK helper `speakerLine()` gives channels without per-agent
  identity a plain-text name line.
- **Single emitter.** Every path that produces user-visible text (model loop, fast path,
  deterministic actions, Conductor `say`, notices, errors) goes through one emitter that
  stamps the speaker. A path that cannot name its speaker cannot emit.
- **Identity guard (mandatory, fail-closed).** Before publication, an agent's text passes
  a guard that is independent of `VERIFIER_MODE`:
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

- The management layer routes deterministically: own channel identity, binding, explicit
  user selection, operator-designated default agent, else a `system` notice. It never
  runs a model to pick an agent. Suggesting a colleague is an agent's own act, done as a
  visible consultation or a visible hint ("Mira knows this better, write to her"), never
  as hidden re-routing.
- An agent may split its own work into internal helper runs (parallel research, long
  documents). Helpers run strictly inside that agent's envelope: same identity, grants,
  memory scope and model policy, nothing added. Their output is the agent's own work and
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
| Pace | Immediate acknowledgement of a request; visible progress for longer work (typing indicator, short status); a follow-up message when long work finishes instead of a timeout. |
| Honest limits | When something lies outside its capabilities or rights, the agent says so plainly and names who can help (a colleague agent or a person), instead of guessing. |
| Communication and emotion | Tone, warmth, humour and empathy follow the configured personality and the situation; it reacts to frustration, praise and urgency like a good colleague. It never claims to be human. |
| Team etiquette | In group chats it speaks when addressed or when its role calls for it, never chimes in on every message (#1035 communication profile). |
| Quality | Claims are checked before they ship (verifier), and the agent says how sure it is when it matters. |

Operators can see per agent how people rate the collaboration (a lightweight in-product
feedback signal), so the target picture of §1 becomes measurable.

### 5.9 Product language

- "Orchestrator" is replaced by "Agent" in all UIs, API descriptions and docs aimed at
  operators and users (`GLOSSARY.md` rule removed; German "Agent", plural "Agenten").
  Code identifiers stay.
- Onboarding and marketing describe agents as virtual employees with a name, a
  personality and clear permissions.

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
5. **Speaker everywhere.** Every user-visible message in every channel of the §5.3 matrix
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

## 7. Migration and compatibility

There are no customer installations yet (owner, 2026-11-18). The first ones follow
soon, after which a change of this depth would be far harder. This spec therefore builds
the target model directly, **without compatibility layers, deprecation periods or upgrade
paths**. Internal test and demo instances are re-seeded.

- **Migrations:** `agents.kind` (default `standard`); `agent_consultation_grants`;
  dropping `agent_subagents`, `agent_persona_skills` (identity use) and Direct Line state.
  No dead schema is kept.
- **Removed outright:** DB sub-agents and the Builder canvas node "Sub-Agent"; per-turn
  persona switching; `#token` Direct Line addressing and sticky mode; the orchestrator
  default identity text; every auto-attach of plugins; the fallback agent's special role;
  the Builder's persona-bearing plugin output (replaced by agent creation).
- **Kept and repurposed:** `agentsConsulted` stays as trace summary; `delegatedAnswer` is
  replaced by `contributions[]` (§5.4); `agent_to_agent` stays the per-conversation switch
  that lets agents speak in a chat, while authorization comes only from consultation
  grants.
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
3. Consultation: grants table, `consult` tool, envelope of B, two views,
   `contributions[]`, audience floor required, limits and cost attribution; the same
   grants authorize discussions and relays (INV-5, §5.4).
4. Audience provider enabled by default (G15).
5. Agent Builder creates agents instead of persona-bearing plugins (G2).
6. Remove DB sub-agents and the Builder "Sub-Agent" node (G3).
7. Remove persona skills as identity switch (G5).
8. Remove `#token` Direct Line addressing and sticky mode (G6).
9. Vendor domain plugins as capabilities: no persona towards users, product language (OD-1).
10. Fast path inside the agent envelope, including its planner and router (#1876, OD-3).
11. Fail loud instead of silent fallback (#1880, OD-4).
12. Least privilege by default: no auto-attach, onboarding without a super-agent, reach
    display and confirmation (INV-8, §5.7).
13. Management layer: deterministic routing without model choice, default agent
    designation, helper runs inside the envelope (INV-6, §5.6).
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

**Open:**

| Id | Question | Recommendation |
|---|---|---|
| OD-1 | Vendor domain plugins (HR, accounting, …): capabilities of an agent, or agents of their own? | Capabilities. They are software an employee uses; the agent that calls them stays the speaker and is accountable. Builder specialists are agents regardless (§5.2). |
| OD-2 | Do agents keep model-chosen consultations (A decides to ask B), or only user-requested ones? | Keep them, always visible and attributed (INV-5), limited by grants. |
| OD-3 | Fast path (#1876): bug or by design? | Bug: it must run inside the agent envelope (INV-2). |
| OD-4 | Unbound traffic: an operator-designated default agent, or a `system` notice asking the user to choose? | Operator setting; a fresh installation has no default agent until the operator designates one. |

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
(communication profile), #1876 (fast path), #1880 (silent fallback), #1888 and #1796
(`#name` and tool-name collisions, gone with sub-agent addressing), #1777 (Builder persona
only in preview), #575 (audience floor).
