# Contract: Capability Vocabulary

Phase 2 / T004 output. The controlled vocabulary of capability names a
plugin may list in `PluginManifest.requiredCapabilities` and resolve at
runtime via `scope.services.get(<capability>)`.

A capability is a stable string key for one service contract. The
`OrchestratorRegistry` populates a plugin's `PluginScope.services` with
exactly the capabilities its manifest declares — no more (Constitution
V: privacy by capability). Requesting an unknown or undeclared
capability throws.

## Naming

`domain:action`, lower-kebab within each segment. `domain` groups
related services; `action` names the access mode or operation.

## Registry

| Capability | Service it resolves | Provider |
|---|---|---|
| `llm:chat` | LLM chat-completion client | kernel (Anthropic SDK) |
| `kg:read` | Knowledge-graph read / query | `@omadia/knowledge-graph-*` |
| `kg:write` | Knowledge-graph mutation | `@omadia/knowledge-graph-*` |
| `memory:read` | Persistent-memory read | `@omadia/memory` |
| `memory:write` | Persistent-memory write | `@omadia/memory` |
| `embeddings:generate` | Text-embedding generation | `@omadia/embeddings` |
| `web:search` | Web search | `@omadia/plugin-web-search` |
| `http:fetch` | Sanctioned outbound HTTP | kernel |
| `diagram:render` | Diagram rendering | `@omadia/diagrams` |

## Rules

- The list is **extensible**: a new service contract adds a row here
  plus a `plugin-api` type for its shape. Capability strings are never
  invented ad hoc at a call site.
- A capability key, once published, is stable. Renaming one is a
  breaking change to every manifest that declares it.
- `read` / `write` are split where a plugin may legitimately need one
  without the other (`kg`, `memory`), so the scope grants the minimum.
- Members of `PluginScope` that every plugin always receives — the
  `ScopeLogger` and `registerDisposable` — are **not** capabilities;
  they are unconditional and never appear in `requiredCapabilities`.
