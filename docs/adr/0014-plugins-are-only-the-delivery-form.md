# 0014 — Plugins are only the delivery form; one manifest kind per plugin

## Status

Accepted

- **Date:** 2026-11-19
- **Deciders:** Owner (byte5); spec author iret77
- **Supersedes:** — (amends the vocabulary of [ADR-0003](0003-capability-based-multi-provider-middleware.md); its capability registry stays)

## Context and Problem Statement

Plugins of manifest kind `agent` run their own model loop with a persona and appear as
`query_<short>` tools of whatever agent they are attached to; nobody can address them.
The Plugin Builder generates exactly such persona-bearing plugins. Manifest kind
`extension` covers unrelated things (kernel infrastructure and the LLM plugins).
"Plugin" is used for what something *does* instead of how it is *delivered*.

Where is the boundary between an agent and a plugin, and what may a plugin deliver?

## Decision Drivers

- Only agents are actors ([ADR-0012](0012-agents-are-virtual-employees.md)); a plugin must
  never speak to people or be addressable.
- Operators must see at install time what a package adds: abilities, a channel, a model,
  a new kind of agent, or infrastructure.
- Vendor domain know-how (HR, accounting, Confluence …) must stay installable from the Hub.
- Capability calls must never widen the calling agent's envelope.

## Considered Options

- **A — Plugin = delivery form; exactly one kind per plugin; agents come from templates**
- **B — Keep kind `agent`, forbid only the hidden tool path**
- **C — Treat plugins as agents** (each plugin gets its own identity)

## Decision Outcome

Chosen option: **A**.

| Delivers | Manifest `kind` | Attached to agents? |
|---|---|---|
| Capabilities | `integration`, `tool`, `skill` | Granted per agent; installing attaches to no agent |
| A channel | `channel` | No |
| A model (also embeddings, transcription) | `model` | No; used per model policy, only via the model gateway |
| An archetype | `archetype` | No; operator creates agents of it ([ADR-0015](0015-agent-archetypes-and-archetype-plugins.md)) |
| Infrastructure | `system-module` | No; install needs explicit confirmation |
| Agent templates | `agent-template` | No; presets the operator turns into agents |

- **Retired kinds:** `agent` (→ capability plugin, optionally with agent templates),
  `extension` (→ `system-module`; the LLM plugins → `model`), `provider` (→ `model`),
  `ui` (any plugin may bring a UI).
- **Kernel-enforced boundary:** a plugin registers no persona, speaker, channel identity
  or conversation endpoint answering on its own behalf (channel plugins only transport for
  kernel-managed agent identities). Capability results go to the calling agent as data;
  calls run in the caller's envelope; a capability plugin's internal model calls run in
  the caller's agent turn and appear in its trace and usage. A manifest with a persona,
  speaker or kind `agent` is rejected at install.
- **State:** capability plugins hold only technical state (config, caches, sync cursors),
  never conversation memory. Credentials stay in the vault; agents never see secrets.
- **Builders are admin tools, never agents.** The **Agent Builder** creates agents (identity,
  personality, capabilities, skills, helpers, triggers), never code. The **Plugin Builder**
  creates capability plugins as code, never agents, personas or kind `agent`/`archetype`.
  Their model steps run as operator jobs; previews are turns of a `draft` agent in the
  admin UI only.
- **Hub categories** follow the kinds: capabilities, channels, models, archetypes, system
  modules, templates.

### Consequences

- 🟢 **Good:** Install, grant and audit speak one language; an operator sees exactly what
  an install adds.
- 🟢 **Good:** Domain plugins stay valuable: "HR colleague" = agent from a template plus
  the HR capability.
- 🔴 **Bad:** Breaking manifest change for 16 plugin repos (7 × `agent`, 1 persona in an
  integration, 6 × LLM `extension`, dev-platform, facilitator), the plugin starter and the
  boilerplates; plugin-api, Hub and kernel must ship as one release train.
- ⚪ **Neutral:** Issues #2053, #2049, plugin-repo migration issues listed in #2053.

## Pros and Cons of the Options

### A — Delivery form, one kind

- 🟢 Clear actor/package boundary, enforceable at install.
- 🔴 Every existing agent plugin must be rebuilt.

### B — Keep kind `agent`

- 🟢 No plugin migration.
- 🔴 Persona-bearing packages remain a second kind of actor next to agents.

### C — Plugins as agents

- 🟢 Every package addressable.
- 🔴 Mixes delivery and identity; an agent's capabilities could no longer be granted
  independently of who it is.

## More Information

- Spec §5.2, §5.10; acceptance criterion 15. Terminology: "Plugins and capabilities".
- [ADR-0001](0001-plugin-distribution-via-signed-zip.md) (signed ZIP delivery) is unchanged.
- [ADR-0003](0003-capability-based-multi-provider-middleware.md): the capability registry
  stays; "provider plugin" is now "model plugin".
- Related: [ADR-0017](0017-model-gateway-and-execution-contexts.md) (model access and sandbox).
