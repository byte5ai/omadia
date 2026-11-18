# omadia terminology

**Binding for the whole omadia project:** code comments and identifiers of new code, docs,
specs, UI texts, API descriptions, issues, pull requests, plugin manifests and marketing in
`byte5ai/omadia` and every `omadia-*` sister repo use these terms with these meanings.
Where an older text uses a term differently, the older text is wrong and gets corrected.
The German column is the term shown to German-speaking users.

Source: `specs/2042-agents-as-virtual-employees/spec.md` and
`specs/2043-native-facilitators/spec.md`. A change to a definition here changes those specs
in the same pull request, and the other way round.

## In one paragraph

omadia extends a team with **agents**: virtual colleagues with a name, a personality and
clear permissions. Every agent belongs to exactly one **archetype**: the built-in `standard`
archetype or an archetype added by an **archetype plugin**, such as the facilitator. What an
agent can do comes from **capabilities**: tools, integrations, skills and more, delivered
by **capability plugins** or authored in the instance. People talk to agents in
**conversations** on **channels** such as Teams, Slack, Discord or Telegram. Below the
agents runs the deterministic **management layer**: it routes, enforces permissions and
discretion, schedules and audits, but never answers and never uses a model to pick who
answers. There is no orchestrator agent.

## Actors and roles

| Term | German | Definition | Not to be confused with |
|---|---|---|---|
| **Agent** | Agent (pl. Agenten) | A virtual colleague: one configured entity with its own identity, personality, capabilities, permissions, memory, model policy and channel identities. The only thing that speaks to people (besides `system` notices). Created by an operator. | Not a plugin, not a tool, not a "bot" (a bot is one channel identity of an agent), not an "assistant" in the sense of one entity serving everyone. |
| **Archetype** | Archetyp | The class of an agent, fixed when the agent is created; an agent never switches it. `standard` is the built-in archetype; further archetypes come from archetype plugins (today `facilitator`). The archetype defines what an agent of that class inherits, adds and deliberately omits. | Not an agent template (a preset of one agent), not a working mode. |
| **Standard agent** | Standard-Agent | An agent of the built-in archetype `standard`, omadia's normal agent: works for people and teams and may pursue their interests. | Not the default agent. |
| **Facilitator** | Facilitator | An agent of the archetype `facilitator`: an impartial moderator of group processes. Serves no particular person, holds no business capabilities and no general memory. | Not a moderation mode of a standard agent, not a capability. |
| **Default agent** | Standard-Ansprechpartner | The agent that answers a message nobody explicitly addressed, configured per human user and channel, per user, per channel or for the instance; any entry can be `off`. | Not a special super-agent, not the standard archetype. Formerly "fallback agent" / "Standard Orchestrator". |
| **Operator** | Administrator | The person who runs an omadia instance and configures agents, plugins, permissions and defaults. | Not byte5 (byte5 maintains the software, the operator runs the instance). |
| **User** | Nutzer | A human who works with agents through a channel. | Not an agent. |
| **Initiator** | Initiator | The person who starts a facilitation in a group. | Not the facilitator's owner; the group owns the process. |
| **Participant**, **stakeholder** | Teilnehmer, Stakeholder | In a facilitation: the people who take part; people who only receive the confirmed protocol and next steps. | |

## Inside an agent

| Term | German | Definition | Not to be confused with |
|---|---|---|---|
| **Identity** | Identität | Display name, avatar, descriptions and instructions of an agent. | |
| **Personality** | Persönlichkeit | The configured way an agent communicates (persona axes, tone, verbosity), within the bounds of its archetype. | "Persona skill" (retired term, see working mode). |
| **Instructions** | Anweisungen | The operator's standing guidance for an agent. | |
| **Working mode** | Arbeitsmodus | A skill an agent selects per turn to shape how it works on a request. Never changes the agent's name, personality or boundaries. | Formerly "persona skill"; it no longer replaces the identity. |
| **Internal helper** | interner Helfer | A run inside one agent's envelope that does part of its work: sub-agent helper, fast lane, model router, mode selection, presentation helper. Has no name towards people; its work is the agent's own. | Not an agent, not a consultation. Formerly "sub-agent" for the configured kind. |
| **Fast lane** | Schnellspur | The agent's internal helper that answers simple data questions without the full model loop, rendering data without a model seeing it. | Formerly "fast path" as a separate answer path. |
| **Envelope** | Rahmen | Everything an agent may use in a turn: its identity, instructions, personality, boundaries, model policy, skills, capability grants and memory scope, capped by the audience's rights. "No more, no less." | |
| **Reach** | Reichweite | Every connected system an agent can read or write through its grants. Shown on its page. | |
| **Model policy** | Modellrichtlinie | Which models an agent may use, including cheaper ones for internal helpers. | |

## Working together

| Term | German | Definition | Not to be confused with |
|---|---|---|---|
| **Consultation** | Rückfrage | One agent asking another agent, as a colleague, for a contribution. Off by default, configured per agent and per pair; never gives the asking agent more access than it has itself. | Not delegation to a hidden sub-agent. |
| **Contribution** | Beitrag | What a consulted agent answers: delivered unchanged and attributed to it. In a facilitation: what a participant contributes (idea, position, vote, commitment …). | |
| **Speaker** | Absender | Who a message is from: an agent, or `system`. Stamped by the management layer, never by a model. | |
| **System notice** | Systemhinweis | A message of the management layer (for example "this agent is not available"), never attributed to an agent. | |
| **Discussion** | Diskussion | A visible conversation between agents in a chat, run by the Conductor, authorised like a consultation. | |

## Platform

| Term | German | Definition | Not to be confused with |
|---|---|---|---|
| **omadia** | omadia | The team-first agentic OS. | |
| **Instance** | Instanz | One installation of omadia, run by an operator. | |
| **Kernel** | Kern | The core software of omadia (`byte5ai/omadia`), including the management layer and the agent runtime. | |
| **Management layer** | Verwaltungsebene | The deterministic part of the kernel below the agents: routing, identity, permissions, discretion, privacy shield, memory scoping, scheduling, audit, Conductor. Never answers, never uses a model to choose who answers. | Not an agent. Formerly "orchestrator" in the product sense. |
| **Agent runtime** | Agentenlaufzeit | The code that runs one agent's turns. Its package is still named `harness-orchestrator` for historical reasons. | |
| **Orchestrator** | (not used) | **Retired as a product term.** Only a code name of the agent runtime package. Never in UI texts, docs for users or operators, specs or marketing. omadia has no orchestrator agent. | |
| **Conductor** | Conductor | The kernel's workflow engine for operator-designed processes (triggers, steps, human steps). | Not the management layer as a whole. |
| **Privacy shield** | Privacy Shield | The kernel component that masks personal and classified data before a model sees it and restores it for permitted readers. | |
| **Harness** | Harness | The kernel's deterministic machinery around models: routing, permissions, guards, budgets, scheduling and emission. Used in code and developer docs; in product texts say management layer. | Not an agent, not a model. |
| **Audience floor** | Leserkreis-Grenze | The rule that an answer may contain only what every human who can read it is allowed to know; enforced by the management layer. | |
| **Model context** | Modellkontext | The conversation history and inputs a model sees in one agent's turns. | Not a session. |
| **Side channel** | Seitenkanal | The path on which data from a source system reaches people without passing through a model; the agent coordinates and gets a status. | |

## Plugins and capabilities

| Term | German | Definition | Not to be confused with |
|---|---|---|---|
| **Plugin** | Plugin | An installable package. Exactly one of two classes: capability plugin or archetype plugin. A plugin is never an actor: it never speaks to people and has no identity of its own. | Not an agent. |
| **Capability plugin** | Fähigkeits-Plugin | Extends what agents can do. Kinds: `integration`, `tool`, `channel`, `provider`, `extension`, `ui`, `skill`, `agent-template`. Installing it attaches it to no agent. | Formerly plugins of kind `agent`; that kind is retired. |
| **Archetype plugin** | Archetyp-Plugin | Adds a new agent archetype to the system (manifest kind `archetype`), for example `omadia-agent-facilitator`. The operator then creates agents of that archetype; the kernel runs them under all agent rules. Listed in its own hub category; installing it needs an explicit confirmation. | Not a plugin that is attached to an agent. |
| **Capability** | Fähigkeit | Something an agent may be granted: a tool, an integration scope (read or write), a skill. | |
| **Grant** | Freigabe | The permission that gives one agent one capability (or one consultation). | |
| **Tool** | Werkzeug | A function an agent can call. | |
| **Integration** | Integration | A connection to a third-party system (ERP, CRM, mail, calendar) with its credentials in the vault; agents never see the secrets. | |
| **Skill** | Skill | Instructions and knowledge an agent can load; delivered by a skill plugin or authored, imported or forked in the instance. A capability, never an actor. | Not an agent, not a plugin by itself. |
| **Agent template** | Agentenvorlage | A preset of identity, personality and suggested capabilities from which an operator creates an agent of an existing archetype. Never runs itself. | Not an archetype. |
| **MCP server** | MCP-Server | An external tool provider connected through the Model Context Protocol; its tools are capabilities. | |

## Channels and conversations

| Term | German | Definition | Not to be confused with |
|---|---|---|---|
| **Channel** | Kanal | A messaging platform through which people reach agents: Teams, Slack, Discord, Telegram, WhatsApp, iMessage, web chat, the public API. Provided by a channel plugin. Every capability must work through plain text in every channel. | Not a Teams "channel" inside a team (that is a conversation). |
| **Channel identity** | Kanalidentität | The bot or account through which one agent appears in a channel. | |
| **Conversation** | Gespräch | A 1:1 chat, group chat, channel thread or meeting chat. | |
| **Binding** | Zuordnung | A configured link from a conversation to an agent. Explicit addressing always wins over a binding. | |
| **Explicit addressing** | direkte Ansprache | Reaching an agent through its own channel identity, a mention, an explicit selection, or the agent slug of an API conversation. | |

## Memory and discretion

| Term | German | Definition | Not to be confused with |
|---|---|---|---|
| **Memory** | Gedächtnis | What an agent keeps across turns, stored in context tiers; recall only where the current context allows it. | Not the process state of an archetype plugin. |
| **Discretion** | Diskretion | The rule that information flows only to recipients who may know it, in the permitted level of detail, across memory, capability calls and agent-to-agent communication. | |
| **Label** | Herkunftskennzeichen | What every piece of information carries about its origin (context, source system, grant, classification); it persists into everything derived from it. | |
| **Audience** | Leserkreis | The humans who can read an answer; their rights cap what any agent may disclose. | |
| **Disclosure level** | Offenlegungsstufe | How much of an information may flow: `full`, `redacted`, `aggregate`, `existence`, `none`. | |

## Proactivity

| Term | German | Definition | Not to be confused with |
|---|---|---|---|
| **Trigger** | Auslöser | What lets an agent act unasked: a **hook** on an event, a one-shot **wakeup** or a short-lived **timer**. Always with a deadline, limits and a budget enforced by the management layer. | Not a heartbeat; omadia has none. |
| **Routine** | Routine | A trigger a user asked an agent to run on a schedule; the user stays its owner. | |
| **Plugin job** | Plugin-Job | Model-free technical maintenance of a plugin (for example a sync). | Not a trigger; never calls a model. |

## Facilitation

| Term | German | Definition | Not to be confused with |
|---|---|---|---|
| **Facilitation** | Moderation | One moderated process of a facilitator with a group, from preparation to follow-up. | |
| **Session** | Sitzung | An asynchronous phase in the chat or a live meeting within a facilitation. | Not the model context; not a chat session in the UI sense. |
| **Step** | Schritt | One item of the agenda (collect, discuss, cluster, prioritise, decide, assign …). | |
| **Format** | Format | An agenda template for a kind of process (decision, prioritisation, assignment, idea collection, retrospective, alignment). | |
| **Decision method** | Entscheidungsverfahren | How a step decides (ranked vote, single choice, approval, consent, assignment), counted deterministically. | |
| **Definition of done** | Definition of Done | When the facilitation has reached its goal; versioned, changed only by group consent. | |

## Retired terms

| Do not use | Use instead |
|---|---|
| Orchestrator (as a product concept, in UI, docs, specs, marketing) | Agent, or management layer, depending on what is meant |
| Standard Orchestrator, fallback agent | Default agent |
| Sub-agent (towards users) | Internal helper (inside one agent) or agent (if people address it) |
| Persona skill, "answering as X" | Working mode |
| Direct Line | Explicit addressing; consultation |
| Fast path (as a separate answer path) | Fast lane of an agent |
| Plugin of kind `agent`, "agent plugin" for capabilities | Capability plugin; archetype plugin for a new agent class |
| Heartbeat | Trigger (hook, wakeup, timer) |
