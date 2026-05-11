# odoo-bot-middleware

Orchestrator middleware that answers Odoo accounting questions by combining:

- an Anthropic Messages API "brain" (the orchestrator) with persistent **memory** via the
  official `memory_20250818` tool, and
- the **Odoo Accounting Managed Agent** as a domain-specific backend tool
  (`query_odoo_accounting`) that handles all live Odoo JSON-RPC calls.

Each incoming HTTP request starts a fresh Messages API conversation. The orchestrator
reads and updates a global memory (shared across all sessions, file-based for now) and
delegates data-fetch questions to the managed agent.

## Architecture at a glance

```
HTTP POST /api/chat
        │
        ▼
   Orchestrator (Messages API, model from ORCHESTRATOR_MODEL)
        ├─ tool: memory_20250818          ← client-side → FilesystemMemoryStore
        └─ tool: query_odoo_accounting    ← delegates to OdooAgentClient
                                                 │
                                                 ▼
                                     Managed Agent session (Sessions API)
                                     → agent answers in natural language
```

## Requirements

- Node.js ≥ 20
- A Claude API key
- An existing Managed Agent + Environment (the Odoo Accounting agent defined in
  `../agent-config.yaml`)

## Setup

```bash
cd middleware
npm install
cp .env.example .env
# Fill in ANTHROPIC_API_KEY, CLAUDE_AGENT_ID, CLAUDE_ENVIRONMENT_ID
npm run dev
```

The server listens on `PORT` (default 3979).

## Usage

```bash
curl -sS -X POST http://localhost:3979/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Wie hoch sind unsere offenen Ausgangsrechnungen aktuell?"}'
```

Response shape:

```json
{
  "answer": "...",
  "telemetry": { "tool_calls": 3, "iterations": 2 }
}
```

## Memory layout

The memory lives on disk under `MEMORY_DIR` (default `./.memory`), exposed to Claude as
the virtual `/memories` directory. Path-traversal protection is enforced in
`src/memory/filesystem.ts`.

Typical files the orchestrator may create:

```
/memories/
  conventions.md              # accounting conventions, terminology
  customers/<name>.md         # notes about recurring customers
  journals.md                 # chart-of-journals overview
  recurring_queries.md        # saved canonical queries
```

## Project layout

```
src/
  index.ts                   # Express bootstrap
  config.ts                  # Zod-validated env config
  routes/
    chat.ts                  # POST /api/chat
  services/
    orchestrator.ts          # Messages API tool-use loop
    odooAgent.ts             # Managed Agent session wrapper
  memory/
    store.ts                 # MemoryStore interface
    filesystem.ts            # Filesystem implementation
  tools/
    memoryTool.ts            # memory_20250818 handler
    odooQueryTool.ts         # query_odoo_accounting custom tool
```

## Notes on beta APIs

- The memory tool requires the beta header `context-management-2025-06-27` (set in the
  orchestrator per-request).
- The Managed Agents Sessions API is still beta; the SDK sets its beta header
  automatically. Type surfaces are kept intentionally loose in `odooAgent.ts` until the
  SDK ships stable definitions for these endpoints.

## Next steps (out of scope for this increment)

- Teams Bot Framework integration (copy the pattern from `../../UFD-Teamsbot`).
- Swap `FilesystemMemoryStore` for a Postgres or Redis backend for multi-instance
  deployments.
- Authentication on `/api/chat` (the current build is trusted-network only).
