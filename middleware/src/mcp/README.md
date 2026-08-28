# Public MCP Endpoint (`POST /api/v1/mcp`)

Exposes omadia's own tools over a **stateless Streamable-HTTP MCP server** so an
external MCP client (Claude Desktop, an agent framework, your own service) can
call them with an API key instead of driving the operator UI. This document is
for **external API consumers** — if you are looking for how the endpoint is
built, read the source in this directory, starting at `publicMcpServer.ts`.

Mirrors the shape of `packages/harness-channel-api/README.md`, which documents
the sibling public chat ingress.

> **Dark by default.** The endpoint is not mounted at all unless the operator
> sets `PUBLIC_MCP_ENABLED=true`. If you get a 404, it is off.

## Surface

| Surface | What it does |
|---|---|
| `POST /api/v1/mcp` | The one public route. MCP JSON-RPC over HTTP: `tools/list`, `tools/call`. Self-authenticating (bearer API key) — no session cookie. |
| `GET`/anything else on that path | `405 Method Not Allowed`. There is no standalone SSE stream. |

Key lifecycle (create/list/revoke) is **not** part of this API — see "Getting an
API key" below.

## Stateless by design

There is **no session**. You do not need to call `initialize`, you will never be
issued an `Mcp-Session-Id`, and you must not send one. Every POST is independently
answered, which is what lets an operator run several omadia instances behind a
load balancer and have any of them serve any of your requests.

Practically: send the JSON-RPC request you want, on its own, every time.

## Authentication

A bearer API key, exactly like the public chat ingress:

```
Authorization: Bearer <your-omadia-api-key>
```

- `401` — missing, unknown, or revoked key. Not retryable.
- `403` — the key authenticated but lacks a required scope. Not retryable.
- `429` — you exceeded the key's per-minute request budget. Retry after a pause.

The key is a **server credential**. It must never be shipped to a browser or an
end-user device: there is no session, no cookie and no consent step, so the key
is the whole identity.

## Scopes

Four capabilities, and you need the right combination. All default-deny.

| Scope | Grants |
|---|---|
| `mcp:list` | Call `tools/list`. |
| `mcp:invoke` | Call `tools/call` for a **read** tool. |
| `mcp:write:<tool>` | Call `tools/call` for the **one** write tool named. |
| `*` | Everything **except** any `mcp:write:<tool>`. |

Three consequences worth internalising before you file a bug:

1. **`mcp:invoke` is not enough for a write.** Every write tool needs its own
   `mcp:write:<tool>` scope, named for exactly that tool. There is no class-wide
   write scope, and `mcp:write` on its own is rejected as invalid at key-creation
   time.
2. **The wildcard `*` does not grant writes.** This is deliberate: `*` is a
   convenience for an operator's own tooling, and silently including "mutate
   production data over the internet" in that convenience is not a trade anyone
   makes consciously.
3. **`tools/list` shows you exactly what you can call — no more.** If a tool is
   missing from the list, either it is not on your key's allowlist or you lack
   its scope. The list is not a catalogue of what exists; it is your own
   capability set. This is intentional: a tool name you cannot call would still
   tell you which integrations the install runs.

## Your key's tool allowlist

Beyond scopes, the operator binds your key to:

- **exactly one agent**, and
- **an explicit list of tool names** on that agent.

A key with no binding authenticates fine and reaches **zero** tools. Nothing is
included until an operator names it — which is how integration-backed and
write-capable tools (Odoo, Microsoft 365, Confluence) stay out of reach by
default.

Some tools can **never** be exposed here regardless of what an operator
configures — the ones omadia's Privacy Shield deliberately exempts from masking
because the agent needs to read its own state in clear (`memory`,
`read_attachment`, and a small fixed set of others). Those are filtered out
unconditionally.

If a tool you expected is missing, ask the operator to add it to your key's
binding. You cannot change it yourself.

## Calling a tool

```bash
# List what this key can call
curl -sS -X POST https://<your-omadia-host>/api/v1/mcp \
  -H "Authorization: Bearer $OMADIA_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# Call one
curl -sS -X POST https://<your-omadia-host>/api/v1/mcp \
  -H "Authorization: Bearer $OMADIA_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"query_crm","arguments":{"q":"acme"}}}'
```

The `Accept` header must include both `application/json` and
`text/event-stream` — that is an MCP transport requirement, not an omadia one.

Any MCP client library works too; point it at the URL, set the bearer token, and
do not configure a session.

## What tool results look like

**Tool results are masked.** omadia's Privacy Shield interns raw tool output
server-side and returns an identity-free digest, so personal data in an
underlying record does not reach you. Expect placeholder-style values where
identities would be, and write your integration against the digest — not against
the shape of the upstream system's rows.

If masking is unavailable or fails, the call is **refused** rather than answered
with unmasked data. You will see an error, not a result. That is intentional and
not retryable in a tight loop — report it to the operator.

## When a tool needs more input (MRTR)

A tool may answer that it cannot finish without one more value from a human — a
confirmation, a missing parameter, a disambiguation. Instead of failing with
prose you cannot act on, the call comes back as
[MRTR](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
`input_required`:

```json
{
  "resultType": "input_required",
  "message": "PIN required for this room.",
  "inputRequests": [
    { "name": "pin", "label": "PIN", "secret": true, "required": true }
  ],
  "content": [{ "type": "text", "text": "PIN required for this room." }]
}
```

`content` is populated as well, so a client that predates MRTR still shows the
human what is being asked for rather than an empty result.

**This is not an error.** `isError` is absent, because the call succeeded — the
tool asked a question.

To continue, **retry the original request** with the collected values under
`inputResponses`:

```json
{
  "jsonrpc": "2.0", "method": "tools/call", "id": 2,
  "params": {
    "name": "book_room",
    "arguments": { "roomId": "r1", "inputResponses": { "pin": "4711" } }
  }
}
```

Things worth knowing before you build on this:

- **Nothing is parked server-side.** The endpoint is stateless (see above), so
  the retry must carry the original arguments too — they are not remembered for
  you. Any instance behind the load balancer can serve the retry.
- **One round trip, not a loop.** A tool that asks for input *again* on a request
  that already carried `inputResponses` is refused with an ordinary tool error.
  You will never be bounced indefinitely.
- **Render `message` and the field labels as untrusted text.** They are authored
  by the tool. Field counts and lengths are clamped server-side (at most 8
  fields; names ≤64 and labels ≤120 characters).
- **`secret: true` means render it masked.** It is advisory about display only —
  the value still crosses the wire to the tool.

### Two dialects, chosen by your protocol era (#700)

Everything above describes the **2025-era** dialect, and it is unchanged. If
your client negotiates the 2025 `initialize` handshake, that is what you get,
byte for byte.

A client that negotiates **2026-07-28** (via `server/discover`) gets the
revision's own MRTR instead:

| | 2025-era | 2026-07-28 |
|---|---|---|
| the ask | `inputRequests` as a flat array of fields | `inputRequests` as a map with one embedded `elicitation/create` request |
| the answers | `arguments.inputResponses`, flat | top-level `inputResponses` param, one `ElicitResult` per key |
| the loop guard | inferred from `inputResponses` being present | a signed `requestState` you echo back verbatim |

You do not choose between them and there is no configuration switch. The
endpoint routes on the era of your request, because neither SDK generation can
serve both: the 2025 line never answers `server/discover`, and the 2026 line
refuses to emit the array form at all.

Two things worth knowing on the modern dialect:

- **Echo `requestState` unchanged.** It is HMAC-signed, bound to your API key
  and the method, and valid for one hour. A modified, expired or borrowed one
  is refused with `-32602 Invalid or expired requestState`. It is also what
  counts your input rounds, so stripping it does not buy you another card.
- **`secret` cannot be expressed.** The revision's elicitation schema admits
  only the `email`, `date`, `uri` and `date-time` string formats, with no
  masked-input concept, so a field the tool marked secret is named in the
  prose instead of flagged in the schema. Your form widget will not mask it.

omadia's own MCP client speaks both since #562 phase 3.
- A tool that emits an unusable request errors with the reason named, rather than
  handing you a half-rendered form.

## Limits

| Limit | Value |
|---|---|
| Request body | 8 MB |
| Per-tool execution time | 30 s, then the call errors |
| Concurrent tool calls (whole endpoint) | 4; excess calls get "at capacity" |
| Requests/minute | per-key, set by the operator |
| **Write** calls/minute | a **separate, tighter** per-key budget |

Reads and writes draw on **different** rate-limit budgets. Exhausting your write
budget does not stop you reading, and heavy reading does not consume write
headroom.

## Idempotency — read this before relying on it

You may attach an idempotency key to a `tools/call`:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call",
 "params":{"name":"create_lead","arguments":{"…":"…"},
           "_meta":{"idempotencyKey":"your-uuid"}}}
```

It rides in `params._meta` because **MCP standardizes no idempotency field**.
That makes it advisory, and the guarantee is narrower than the name suggests:

- It applies to **write-capable tools only**. Reads ignore it (deduping a read
  would serve you stale data).
- It is **process-local**, with a ~15 minute window. If the operator runs more
  than one omadia instance behind a load balancer, **two requests carrying the
  same key can both execute** — they may land on different instances that share
  no dedupe state.
- It is therefore a **retry-safety mitigation, not distributed exactly-once**.

What you can rely on: retrying the *same* call with the *same* key against the
*same* instance inside the window will not execute the tool twice. What you
cannot rely on: that a write happened at most once globally. If at-most-once
matters for your use case, make the underlying operation idempotent on your side
(natural keys, upserts, reconciliation) and treat this field as a bonus.

## Audit

Every call — including every refusal — is recorded in the operator's MCP call log
with the acting identity of your key (`apikey:<id>`). Tool arguments and results
are **not** recorded. The operator can see that you called `create_lead` and
whether it succeeded; they cannot read the payload out of the audit trail.

## Getting an API key

Keys are issued and managed by the omadia operator, not by external callers, and
are the **same keys** the public chat ingress uses — scopes decide which surface
a given key can reach. Ask the operator to create one with the scopes and tool
allowlist you need; the plaintext token is shown to them exactly once, at
creation time, and is never recoverable afterwards (only its hash is stored).

See `packages/harness-channel-api/README.md` § "Getting an API key" for the
mechanism.
