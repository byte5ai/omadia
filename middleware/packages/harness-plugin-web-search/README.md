# Web Search (`@omadia/plugin-web-search`)

Live web-search core plugin. Publishes the `webSearch@1` capability and a
`web_search` native tool with structured citation objects, backed by one of
two providers the operator picks at install time:

- **Tavily** (default) — built for AI use, structured snippets, optional
  extracted full text.
- **Brave Search** — independent crawler, no full-text inlining.

If the selected provider's API key is empty at activate time, the plugin
degrades to "no capability published" instead of failing activation — see
`src/plugin.ts`.

## Tools & capability

| Surface | What it does |
|---|---|
| `web_search` (native tool) | Query → ranked results with title, URL, snippet, and citation objects. Attached to the orchestrator's tool list automatically. |
| `webSearch@1` (capability) | Programmatic search for consuming plugins — declare `requires: ["webSearch@^1"]`. |

## Config keys (`setup.fields`)

| Key | Type | Default | Notes |
|---|---|---|---|
| `provider` | enum | `tavily` | `tavily` or `brave`; only the matching key is needed. |
| `tavily_api_key` | secret | — | Vault-stored. Only when `provider: tavily`. |
| `brave_api_key` | secret | — | Vault-stored. Only when `provider: brave`. |
| `default_top_k` | integer | `5` | Results per query when the caller omits `top_k` (1–20). |
| `cache_ttl_search_sec` | integer | `600` | Identical queries are served from an in-memory cache to protect the provider quota. |
| `cache_max_entries` | integer | `200` | LRU bound on the cache map. |

## Permissions

Outbound network is an exact-hostname allow-list (`api.tavily.com`,
`api.search.brave.com`) enforced by the host's `HttpAccessor`; no memory,
graph, or filesystem access. All outbound calls route through `ctx.http`,
all secrets through `ctx.secrets`.

## Layout

Standard tool-plugin shape: `src/` → compiled `dist/` (`lifecycle.entry:
dist/plugin.js`). `src/providers/` holds the per-provider adapters,
`searchService.ts` the cache + dispatch, `searchTool.ts` the native-tool
binding.

## PluginContext surface — v1.0 readiness audit (#431)

| Surface | Decision | Rationale |
|---|---|---|
| `ctx.jobs` | skip | Searches are synchronous, second-scale calls; nothing long-running to schedule. |
| `ctx.status` | skip for 1.0 | Missing-key handling (degrade to "no capability") predates `ctx.status`; reporting it as an action status is a candidate follow-up, not a readiness blocker. |
| `ctx.llm` | skip | Pure retrieval — no LLM step inside the plugin. |
| `ctx.mcp` | skip | Direct provider REST APIs via `ctx.http` are the point of this plugin; an MCP indirection adds nothing. |

Versioning: stays independently versioned; does not bump in lockstep with core
(`compat.core: ">=1.0 <2.0"` states compatibility). The version lives in
`manifest.yaml` (`identity.version`) **and** `package.json` — bump both;
`middleware/test/pluginPackageVersions.test.ts` fails CI when they drift.

## Release

The Hub ZIP is cut only by `npm run package -w @omadia/plugin-web-search`
(→ `middleware/scripts/build-plugin-zip.mjs`, output in `<repo>/out/`), from a
clean, committed tree. Publish steps: `docs/creating-plugins.md` §8
("In-tree-Pakete").

## Tests

Central suite: `middleware/test/webSearchPlugin.test.ts`.
