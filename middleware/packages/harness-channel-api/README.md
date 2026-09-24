# Public API Channel (`@omadia/channel-api`)

Built-in channel plugin that exposes omadia's chat flow over a documented,
public HTTP API (issue #438) so external systems can integrate without
building a channel adapter or driving the operator UI. This document is for
**external API consumers** — if you are looking for how the plugin itself is
built, see the source under `src/`.

## Tools & capability

| Surface | What it does |
|---|---|
| `POST /api/public/v1/chat` | The one public route. Send a message, stream the turn back as NDJSON. Self-authenticating (bearer API key) — no session cookie. |
| `GET`/`POST /api/public/v1/admin/keys`, `POST /api/public/v1/admin/keys/:id/revoke` | Key lifecycle (create/list/revoke). **Not part of the public API** — see "Getting an API key" below. |

## Getting an API key

API keys are issued and managed by the omadia operator, not by external
callers. The `/api/public/v1/admin/keys` endpoints that create, list, and
revoke keys stay behind the same **operator session cookie** as every other
admin surface in this app — they are not reachable with a bearer token and
are out of scope for an external integrator. If you need a key, ask the
operator running the omadia instance to create one for you from the admin
UI/API and hand you the plaintext token; it is shown to the operator exactly
once, at creation time, and is never recoverable afterwards (only its hash is
stored).

Mechanically, that session check is enforced by `adminKeysRouter.ts` itself
via the kernel-published `ctx.operatorAuth` accessor (`@omadia/plugin-api`),
not by an absence from `publicPaths.ts` — see `docs/security-architecture.md`
§ 9 for why that distinction matters and the full mechanism.

## Authentication

Every call to `/api/public/v1/chat` must carry the key as a bearer token:

```
Authorization: Bearer omk_<...>
```

- Missing header, malformed header, or an empty token → `401 Unauthorized`.
- A key that doesn't match any stored key, or that has been revoked → `401
  Unauthorized`. Revocation takes effect immediately — a revoked key fails on
  its very next call, no propagation delay.
- A key that is valid but not scoped for the route → `403 Forbidden` (see
  "Scopes" below).
- Keys are per-caller identities in their own right (not a delegate for a
  human end-user) — every request is attributed to the key that made it.

### Scopes

Each key carries a set of scopes — `<resource>:<action>` strings, or the
global `*` — and every route states the scope it requires. `/chat` requires
`chat:write`, which is also what a key gets when the operator creates it
without naming any scopes, so an integration that only chats never has to
think about this. Ask your operator for `*` only if you actually need every
current and future capability.

Matching is exact: `chat:write` grants `chat:write` and nothing else. There
are no prefix wildcards (`chat:*`).

Omit `scopes` entirely to accept the default. Sending `"scopes": []` is a
`400`, not a key with no capabilities — a zero-capability key can never do
anything, so an empty array is treated as a mistake rather than silently
resolved in either direction.

```json
{ "error": "forbidden", "message": "this API key is not scoped for 'memory:read'" }
```

If a key suddenly answers `403` on a route it used to reach, ask your operator
to check the server log for `[api-key-auth] malformed persisted scopes`. A key
whose stored scope set cannot be read is denied every capability rather than
falling back to a default — it still authenticates, so `401` versus `403`
tells you which of the two happened.

## Server-to-server integration

This API is designed for calls from *your server*, not from a browser: the
key is a server credential and must never be shipped to a client. There is no
session, no cookie, and no user consent step — the key is the whole identity.

The credential is a plain bearer token, so any HTTP client works. curl:

```bash
curl -sS -N -X POST https://<your-omadia-host>/api/public/v1/chat \
  -H "Authorization: Bearer $OMADIA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message": "What is our current MRR?", "conversationId": "crm-42"}'
```

PHP (Laravel's HTTP client, streaming the NDJSON line by line):

```php
use Illuminate\Support\Facades\Http;

$response = Http::withToken(config('services.omadia.api_key'))
    ->withOptions(['stream' => true])
    ->post(config('services.omadia.url').'/api/public/v1/chat', [
        'message'        => 'What is our current MRR?',
        'conversationId' => 'crm-'.$customer->id,
    ]);

if ($response->status() === 401 || $response->status() === 403) {
    // 401: unknown or revoked key. 403: the key lacks the `chat:write` scope.
    // Neither is retryable — ask the omadia operator for a new key.
    throw new RuntimeException($response->json('message'));
}

$body = $response->toPsrResponse()->getBody();
$buffer = '';
$answer = '';

while (! $body->eof()) {
    $buffer .= $body->read(8192);

    // NDJSON: one complete JSON object per line. Never buffer the whole
    // response and json_decode it once — it is a stream, not a document.
    while (($newline = strpos($buffer, "\n")) !== false) {
        $line   = substr($buffer, 0, $newline);
        $buffer = substr($buffer, $newline + 1);
        if (trim($line) === '') {
            continue;
        }

        $event = json_decode($line, true);
        match ($event['type'] ?? null) {
            'text_delta' => $answer .= $event['text'],
            // `done.answer` carries the full text, so a caller that doesn't
            // need incremental output can ignore text_delta entirely.
            'done'       => $answer = $event['answer'],
            'error'      => throw new RuntimeException($event['message']),
            // Unknown event types are informational — skip, don't fail.
            default      => null,
        };
    }
}
```

Retry advice: `429` is the only status worth retrying automatically. **No
`Retry-After` header is sent** — there is no machine-readable signal for when
the window resets. The window is a fixed 60 seconds (see "Rate limiting"), so a
client waits a hardcoded 60 seconds rather than reading a header. `401`/`403`
mean the credential itself is wrong and retrying will not fix it. A `200` whose
stream ends in an `error` event means the turn failed, not the credential.

## `POST /api/public/v1/chat`

The route is **POST-only**. `GET /api/public/v1/chat` — or any other non-POST
method such as `PUT` or `DELETE` — returns `404 Not Found`; the router registers
`POST` only. (`OPTIONS` is the exception: it is answered with `200` and
`Allow: POST`.) If a `GET` returns 404, that is the method, not a missing route
or a bad key.

### Request

```json
{
  "message": "What is our current MRR?",
  "conversationId": "optional-caller-chosen-thread-id"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `message` | string | yes | Non-empty. |
| `conversationId` | string | no | 1–200 chars. Omit it to start a fresh conversation on every call. When set, reusing the same value on later calls continues the same conversation *for that key* — conversation scope is always namespaced per API key, so two different keys can never collide on the same `conversationId`. |

`message` and `conversationId` are the **only** accepted fields. The body is
validated strictly: any other key (for example `stream`, `userId`, `locale`,
or a `conversationID` casing typo) is **rejected** with `400 invalid_request`
naming the offending field — it is never silently ignored. This keeps the
contract honest and leaves room to add real fields such as `stream` or
`locale` later without changing the behaviour for callers already sending
them.

The request must be sent with `Content-Type: application/json`. A body sent
without that header (or with any other content type) is **not** parsed and
returns `415 Unsupported Media Type` naming `application/json`, rather than a
misleading body-shape error.

A body that fails validation returns `400 Bad Request` with an `issues`
array (Zod's validation error shape). This still counts as an authenticated
call — the key must be valid to reach validation at all.

### Response — NDJSON streaming, no other format in v1

The response is **always** a stream, one JSON object per line
(`Content-Type: application/x-ndjson`), regardless of how short the answer
turns out to be. This is the only response shape v1 supports — there is no
folded, single-JSON-body, non-streaming variant, and none is planned as a
follow-up; this is a deliberate v1 design decision, not a gap. Integrators
should read the body as a stream and parse it line by line rather than
buffering the whole response and calling `JSON.parse` once.

The events on the stream are the same event vocabulary every other omadia
channel (Teams, Telegram, the operator UI) consumes internally. The ones
relevant to a plain chat integration:

| `type` | Meaning |
|---|---|
| `text_delta` | Incremental chunk of the assistant's answer text — a **live preview** of the model's own text as it is produced. Concatenate these to show progress, but treat them as non-authoritative: the concatenated deltas can differ from `done.answer` — the server MAY replace the answer before `done` (see `done.answerSource`), and it adds the AI-disclosure paragraph to `done.answer` only, never as a delta. |
| `done` | Terminal event on success, and the **authoritative** answer. Carries the full `answer` string plus `toolCalls` / `iterations` counters. If you only need the final text, read `done.answer` and ignore the deltas. When `done.answerSource` is present and not `"model"` (currently only `"privacy-render"`), the answer was materialized server-side and the earlier `text_delta` chunks are superseded — render `done.answer`, not the accumulated deltas; `answerIsError: true` then marks that render as a failure rather than a result. May also carry `receiptId` — see **Correlating a turn with its privacy receipt** below. |
| `done` with `degraded: true` | Terminal event for a **degraded** turn: one or more tool calls committed real side effects and the turn then threw before an answer existed. Deliberately not an `error` — the committed work must not be reported as failed — but it is **not a successful answer either**: the user's question is unanswered. Carries `committedTools` (distinct tool names that ran, in commit order — not a call count) and `correlationId` (the token in the server's `[orchestrator] turn failed (correlationId=…)` log line). `answer` is a localized notice stating that the turn did not finish, which tools already ran and the support token — never a claim of success — unless `answerSource` is `"privacy-render"`, in which case it is the answer the server had already rendered. `runTrace.status` is `"error"`. See **Degraded turns** below. |
| `error` | Terminal event when the turn failed mid-stream (the orchestrator threw, or the orchestrator/verifier yielded an in-band error event without throwing). Carries a `message`. |
| `verifier` | **Informational, safe to ignore.** Only appears when the omadia instance has verifier mode enabled — one extra event **after** `done`, carrying a `summary` of the post-hoc fact-check. Never blocks or retries the turn; the caller already has the answer by the time this arrives. |

### `text_delta` vs `done.answer` — which one wins

They are **not** interchangeable. `done.answer` is authoritative; the
concatenated `text_delta` chunks are a live preview of the model's text and
may be superseded server-side before the turn ends. The `done` event carries
an optional `answerSource` field to tell the two apart:

- absent or `"model"` — `answer` is the model's own streamed text. It equals
  the concatenated deltas, except that on the first turn of a conversation
  scope `done.answer` also carries the folded AI-disclosure paragraph (plus the
  operator note, if one is configured), which is never streamed as a
  `text_delta` — see "`done` event fields" below.
- `"privacy-render"` — Privacy Shield materialized the final `answer`
  server-side from ground truth (the model never saw those values). The
  earlier deltas are stale and will not match; render `done.answer`.

A client that reconstructs the answer from deltas should therefore **always**
replace its accumulated text with `done.answer` when `done` arrives — not only
when `answerSource` is set, or it drops the AI-disclosure paragraph on the
first turn of every conversation. `answerSource` only tells you *why* the two
differ; it is additive and optional, and a client that ignores it and always
renders `done.answer` is already correct.

A server-rendered answer can also be a **failure**: the model asked the shield
to render a result that is in fact a tool error or an authorization prompt. The
`done` event then carries `answerIsError: true` alongside
`answerSource: "privacy-render"`. Use it to present the turn as an error in
your own wording instead of showing the raw English error text as a successful
result. Absent means "not known to be an error" — it is never `false`, and a
client that ignores it keeps today's behaviour.

Note: `agent_bound` — an event some other omadia channel routes emit — is
**not** emitted on this route. `CoreApi.handleTurnStream` (what this plugin
calls directly) never yields it; it's synthesized by the kernel's own
`/api/chat/stream` HTTP route handler, which this plugin doesn't go through.
Integrators porting code from that route should not expect it here.

The full event union carries additional internal event types (tool-call
tracing, heartbeats, token-usage accounting, and similar) that a simple
integration can safely ignore — treat any `type` you don't recognize as
informational and skip it rather than treating it as an error. `done` and
`error` are the terminal events for the turn itself, but note the `verifier`
row above: a `done` or `error` event is not a guarantee that nothing else
will ever appear on the stream afterward.

#### `done` event fields

The `done` event carries more than the `answer` / `toolCalls` / `iterations`
shown in the minimal example below. All fields beyond `answer`, `toolCalls` and
`iterations` are optional and additive — a client that does not know a field
ignores it — but two of them,
`provenance` and `aiDisclosure`, are exactly what a compliance-relevant
integration needs, so read them from the structured fields rather than parsing
the answer text.

| Field | Type | Notes |
|---|---|---|
| `answer` | string | The full assistant answer. On the first turn of a conversation scope it also contains the folded AI-disclosure paragraph — see below. |
| `toolCalls` | number | Tool invocations this turn. |
| `iterations` | number | Agentic iterations this turn. |
| `answerSource` | string | `"privacy-render"` when the server materialized `answer` itself; absent (or `"model"`) otherwise. See "`text_delta` vs `done.answer` — which one wins" above. |
| `provenance` | object | AI-Act Art. 50 machine-readable marker: `{"aiGenerated": true}`. Always stamped on this route (the plugin owns the NDJSON envelope). The literal `true` is the only state — there is no `aiGenerated: false`. |
| `aiDisclosure` | object | Structured AI disclosure — `{ text, level: "standard"\|"concise", locale, source: "default"\|"operator", operatorNote? }`. **This is the stable carrier: read the disclosure from here on every turn.** Present on every turn the disclosure is active. Absent when an operator turned disclosure `off` — and currently also on instances running the subscription-CLI runtime (`claude-cli`), where the paragraph is not folded into `answer` either. Never read its absence as permission to show the answer unmarked: `provenance.aiGenerated` and the `X-AI-Generated` header are always present on a streamed turn, so render your own AI marking when `aiDisclosure` is missing. |
| `receiptId` | string | Present only when a privacy receipt was written this turn. See "Correlating a turn with its privacy receipt" below. |
| `runTrace` | object | Agentic run trace for the turn (verifier evidence, dev UIs). Ignore if you don't need it. |
| `palaiaExcerpt` | object | Verbatim source snippet, present only when the instance runs the excerpt extractor. Ignore if you don't need it. |

The full event union carries still more internal fields (`model`, `turnId`,
`privacyReceipt`, `agentsConsulted`, and others) that a plain chat integration
can ignore.

**The AI-disclosure paragraph in `done.answer` is folded once per conversation
scope, not on every turn.** On the first turn of a scope the disclosure line
(e.g. `Diese Antwort wurde von einem KI-System erzeugt.`) is appended to
`done.answer` as its own paragraph, followed by the operator note as a second
paragraph if one is configured; on later turns with the same `conversationId`
it is not. The structured `aiDisclosure` field, by contrast, rides **every**
turn while disclosure is active (see the table above for when it is absent).
Consequences to design for:

- **Do not depend on the paragraph being present in `done.answer`.** Read the
  disclosure from the `aiDisclosure` field — that is the stable carrier.
- Sending the same request twice within a scope yields answer text that differs
  by that whole paragraph (plus the operator note, if configured). That is the
  fold-once rule, not nondeterminism.
- Without a `conversationId` every call is its own scope, so every call folds
  the paragraph in again.
- The seen-store is in-memory and per-process, so a server restart (or a second
  replica) makes the next turn in an existing conversation fold the paragraph in
  once more. This is the fail-safe direction — after a restart or on another
  replica the marking repeats rather than being skipped.
- The fold is consumed server-side when the turn completes, whether or not your
  client is still connected (a dropped connection does not stop the turn, see
  below). A retry in the same scope after a dropped connection therefore gets
  no paragraph in `answer`; `aiDisclosure` still rides it.

An `X-AI-Generated: true` response header is also set on every `200` streaming
response from this route, at envelope-open, so it is present regardless of how
the turn ends. Rejections before the stream opens (`401`, `403`, `415`, `400`,
`429`) do not carry it.

A dropped connection on the caller's side does not fail the underlying turn
server-side; the server simply stops writing once it detects the client is
gone.

## Degraded turns (`done` with `degraded: true`)

A turn can commit real side effects and then fail: a tool creates a record,
and a later step of the same turn (a follow-up model call, the nudge
pipeline, …) throws. Reporting that as `error` would be a false negative —
and would invite a retry that runs the committed tool a second time — so the
stream ends with `done`. That `done` is explicitly marked:

```json
{
  "type": "done",
  "answer": "This turn did not finish. These actions had already run and took effect: memory, query_dataset. Generating the answer failed afterwards, so your question is still unanswered. Ask it again — and check before repeating anything that changes data. Reference for support: 4f1c…",
  "degraded": true,
  "committedTools": ["memory", "query_dataset"],
  "correlationId": "4f1c…",
  "toolCalls": 3,
  "iterations": 2,
  "runTrace": { "status": "error" }
}
```

How to handle it:

- **`answer` is a notice, not an answer.** It states that the turn failed and
  which tools already ran, in the language the operator configured (the same
  locale mechanism as the AI-Act marking, `de` by default). Rendering it
  verbatim is safe — it never claims success — but there is no answer to the
  user's question in this turn.
- **Exception: `answerSource: "privacy-render"`.** If Privacy Shield had
  already rendered the answer server-side before the failure, `answer` is that
  rendered answer, not the notice. `degraded`, `committedTools` and
  `correlationId` are still set.
- **Do not blindly retry the same request.** The tools in `committedTools`
  already ran; re-sending may repeat their side effects.
- **Keep `correlationId`.** It is the token the operator can search the
  middleware log for (`[orchestrator] turn failed (correlationId=…)`).
- `degraded` is absent on every healthy turn, and on middleware older than
  this field. A client that ignores it still shows the notice rather than a
  fake success — which is why the wording rides `answer` and not only a flag.
- Internally the turn is persisted as a neutral, language-free marker
  (`<turn-incomplete tools="…" ref="…"></turn-incomplete>`), so the session
  log and the knowledge graph carry no locale-specific prose and no fake
  success. That form is not what this route delivers.

## Correlating a turn with its privacy receipt

When the omadia instance runs on the Postgres backend and the privacy shield
recorded activity during a turn, the turn's `done` event carries a `receiptId`:

```
{"type":"done","answer":"…","toolCalls":1,"iterations":2,"receiptId":"3f2a…-uuid"}
```

`receiptId` is the key of the persisted privacy-receipt row
(`turn_receipts.turn_id`). An operator can resolve it directly:

```bash
curl -H "cookie: omadia_session=<operator-token>" \
  https://<your-omadia-host>/api/v1/operator/receipts/<receiptId>
```

Notes:

- `receiptId` is **only** present when a receipt was actually written. A row
  is written solely when the privacy shield masked or otherwise processed
  something this turn, so a tool-free turn produces no receipt and no
  `receiptId`. Treat its absence as "nothing to correlate", not an error.
- It is **distinct** from any `turnId` on the event (the knowledge-graph turn
  node id, `turn:<scope>:<time>`). Only `receiptId` resolves through the
  operator receipts route.
- Receipts written for this channel carry `channel = "api"`, so operators can
  tell external-integration traffic apart from every other channel.

## Rate limiting

Each API key has its own per-minute request budget (`rateLimitPerMinute`,
set by the operator when the key was created — default 60/min). Exceeding it
returns `429 Too Many Requests`:

```json
{ "error": "rate_limited", "message": "this key is limited to 60 requests/minute" }
```

This is a fixed 60-second window, in-memory on the server — wait for the window
to reset and retry. **No `Retry-After` header is sent**, so the 60 seconds is a
fixed value to hardcode, not something to read off the response. A rate-limited
call is authenticated (the key was valid) but never reaches the orchestrator.

**Each key's budget is counted separately per limiter, not pooled across
routes.** The limit is always keyed by API key — `rateLimitPerMinute` is a
per-key value — but the *counter* is not shared between routes. The same key is
also valid for the public MCP route (`POST /api/v1/mcp`), and each route runs
its own independent limiter instance, so a key with `rateLimitPerMinute = 60`
gets 60/min on `/api/public/v1/chat` **and** a separate 60/min on
`/api/v1/mcp`, rather than one shared 60/min across both. Every MCP request,
reads and writes alike, counts against that one general per-key MCP budget
(`rateLimitPerMinute`). MCP write tool calls are additionally capped by the key
binding's `writeRateLimitPerMinute` (default 5) — a stricter sub-cap inside the
MCP budget, not extra capacity. A key's per-process ceiling is therefore at most
2 × `rateLimitPerMinute` (chat + MCP), and 1× on installs where the public MCP
route is not mounted (it stays off unless the operator sets
`PUBLIC_MCP_ENABLED=true`, and it also needs the Postgres backend). Size a key
with this in mind: an operator sizing purely by "requests per minute for this
customer" will under-count if the customer uses both routes.

**This limiter is in-memory and per-process.** It resets on every restart
and does not share state across multiple replicas/instances of this app —
if the app is ever scaled horizontally, each replica enforces the budget
independently, so a key's effective ceiling becomes `rateLimitPerMinute ×
replica count`. This is a known, accepted v1 trade-off (see
`docs/security-architecture.md` § 9), not an oversight.

## Error summary

| Status | `error` | When |
|---|---|---|
| `401` | `unauthorized` | Missing/malformed `Authorization` header, or an unknown/revoked key. |
| `403` | `forbidden` | Valid key, but it is not scoped for this route. |
| `400` | `invalid_request` | Body fails schema validation (e.g. empty `message`, or an unknown field). |
| `415` | `unsupported_media_type` | Body sent without `Content-Type: application/json`. |
| `429` | `rate_limited` | Key is over its per-minute budget. |
| `200` + `error` NDJSON event | `error` | Key and request were valid, but the turn itself failed mid-stream. |
| `200` + `done` NDJSON event with `degraded: true` | — | Key and request were valid, tool calls committed, and the turn then failed before producing an answer. Not an `error` by design; check the flag if you need to distinguish an answer from a degraded turn. |

## Minimal curl example

```bash
curl -N -X POST https://<your-omadia-host>/api/public/v1/chat \
  -H "Authorization: Bearer omk_<your-key>" \
  -H "Content-Type: application/json" \
  -d '{"message": "What is our current MRR?"}'
```

`-N` disables curl's output buffering so you see each NDJSON line as it
arrives rather than only once the stream closes. A successful call prints a
sequence of lines like:

```
{"type":"text_delta","text":"Your "}
{"type":"text_delta","text":"current MRR is..."}
{"type":"done","answer":"Your current MRR is...\n\nDiese Antwort wurde von einem KI-System erzeugt.","toolCalls":0,"iterations":1,"provenance":{"aiGenerated":true},"aiDisclosure":{"text":"Diese Antwort wurde von einem KI-System erzeugt.","level":"standard","locale":"de","source":"default"}}
```

The `done` line above is abbreviated for readability — the wire also carries
`runTrace`, `model` and, on instances that run the excerpt extractor,
`palaiaExcerpt`.
See "`done` event fields" above for the full shape and the fold-once rule that
governs the disclosure paragraph inside `answer`.

## Layout

Standard channel-plugin shape: `src/plugin.ts` wires the routes at
`activate()`; `src/chatRouter.ts` is the public `/chat` route,
`src/adminKeysRouter.ts` the operator-only key-management routes.

The credential itself is **not** implemented here. Minting, hashing (sha256,
constant-time verified), vault-backed storage, scopes, the per-key rate limit,
the usage audit trail, and the `requireApiKey` middleware this route mounts
all live in `@omadia/api-key-auth`
(`middleware/packages/harness-api-key-auth/`, issue #439) so the kernel and
other plugins can reuse the same implementation. See
`docs/security-architecture.md` § 9 for the full security posture (threat
model, storage design, verification details) and
`docs/middleware-agent-handoff.md` for the implementation handoff notes.

## Tests

Central suite: `middleware/test/channelApi/` (router, key store, token,
rate limiter, audit log, manifest, plugin wiring, public-path exemption,
the reuse seam against `@omadia/api-key-auth`, and privacy-guard integration
tests). The auth middleware and the scope model are covered separately in
`middleware/test/auth/requireApiKey.test.ts` and
`middleware/test/auth/apiKeyScopes.test.ts`.
