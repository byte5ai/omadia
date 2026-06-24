# omadia architecture overview

A one-page map of the system and how a request flows through it. This is the
orientation layer. For the full technical detail, read
[`middleware-agent-handoff.md`](middleware-agent-handoff.md); for the security
patterns, read [`security-architecture.md`](security-architecture.md).

omadia is a self-hostable agentic operating system. You compose teams of agents
from signed plugins, run them on one machine, and get an auditable trace for
every action they take.

## Component map

| Component | What it does |
|---|---|
| **Middleware kernel** | The Node process that boots everything, loads plugins, and exposes the HTTP API. Runs on `:3333` in the default compose setup. |
| **Orchestrator** | Routes each conversation turn to the right agent, dispatches tool calls, and streams the result back. Records a per-run trace. |
| **Plugin runtime** | Loads agents, tools, capability providers, and integrations behind one stable contract, [`@omadia/plugin-api`](../middleware/packages/plugin-api). Plugins ship as signed ZIPs with their dependencies baked in. |
| **Knowledge graph** | The agent memory substrate. pgvector on Postgres in production, with an in-memory alternative for tests. |
| **Embeddings** | Turns content into vectors for retrieval. Local Ollama or an external API, opt-in via a compose overlay. |
| **Vault** | Encrypted secret storage (AES-256-GCM file). Holds LLM keys and connector credentials; gated by `VAULT_KEY` in production. |
| **Ingress channels** | Where conversations enter. Web-chat (the admin UI) is in-tree; Teams and Telegram ship as separate plugin ZIPs. |
| **Web UI** | The Next.js admin UI: setup wizard, plugin builder, chat, and the call-stack trace viewer. Styled with Lume. |

## Data flow

A single turn travels one path:

```
channel  ->  orchestrator  ->  plugin (agent / tool)  ->  knowledge graph / vault
            (routes turn)     (does the work)            (memory + secrets)
   ^                                                            |
   |____________________  response + trace  _____________________|
```

1. A message arrives on a **channel** and is handed to the kernel through the
   ChannelSDK as a `SemanticAnswer` request.
2. The **orchestrator** picks the agent for the turn and passes it a
   `PluginContext` (`ctx`): memory access, tool dispatch, vault reads, and
   logging.
3. The **agent** runs, calling **tools** and **capability providers** as
   needed. Reads and writes go through the **knowledge graph**; secrets come
   from the **vault**, never from prompts or config.
4. The result streams back to the channel, and the full **trace** (every step,
   tool call, and decision) is stored as the run's audit receipt.

## Key design decisions

The reasoning behind the architecture is captured as ADRs under
[`docs/adr/`](adr/). The load-bearing ones:

- [ADR-0001: Plugin distribution via signed ZIP packages](adr/0001-plugin-distribution-via-signed-zip.md):
  plugins are verifiable packages, not arbitrary npm pulled at runtime.
- [ADR-0003: Capability-based, multi-provider middleware](adr/0003-capability-based-multi-provider-middleware.md):
  agents depend on capabilities, not concrete providers, so LLMs and storage
  stay swappable.
- [ADR-0004: Knowledge graph as the agent memory substrate](adr/0004-knowledge-graph-as-memory-substrate.md):
  memory is a graph, not a flat log.
- [ADR-0005: Two-phase confirmation for write-capable connectors](adr/0005-two-phase-confirmation-for-writes.md):
  write actions are proposed and confirmed, not fired blind.

## Go deeper

- [`middleware-agent-handoff.md`](middleware-agent-handoff.md): the plugin
  loading sequence, capability registry, and multi-provider auth layer.
- [`security-architecture.md`](security-architecture.md): vault credentials,
  proxy routes, scope-locked sub-agents, and signed URLs.
- [`adr/`](adr/): the full decision record.
