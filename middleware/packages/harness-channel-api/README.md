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
§ 8 for why that distinction matters and the full mechanism.

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

```json
{ "error": "forbidden", "message": "this API key is not scoped for 'memory:read'" }
```

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

Retry advice: `429` is the only status worth retrying automatically (back off
until the 60-second window resets). `401`/`403` mean the credential itself is
wrong and retrying will not fix it. A `200` whose stream ends in an `error`
event means the turn failed, not the credential.

## `POST /api/public/v1/chat`

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
| `text_delta` | Incremental chunk of the assistant's answer text. Concatenate these to reconstruct the streamed answer as it's produced. |
| `done` | Terminal event on success. Carries the full `answer` string plus `toolCalls` / `iterations` counters — read `done.answer` if you only want the final text and don't care about incremental deltas. |
| `error` | Terminal event when the turn failed mid-stream (the orchestrator threw, or the orchestrator/verifier yielded an in-band error event without throwing). Carries a `message`. |
| `verifier` | **Informational, safe to ignore.** Only appears when the omadia instance has verifier mode enabled — one extra event **after** `done`, carrying a `summary` of the post-hoc fact-check. Never blocks or retries the turn; the caller already has the answer by the time this arrives. |

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

A dropped connection on the caller's side does not fail the underlying turn
server-side; the server simply stops writing once it detects the client is
gone.

## Rate limiting

Each API key has its own per-minute request budget (`rateLimitPerMinute`,
set by the operator when the key was created — default 60/min). Exceeding it
returns `429 Too Many Requests`:

```json
{ "error": "rate_limited", "message": "this key is limited to 60 requests/minute" }
```

This is a fixed 60-second window, counted per key, in-memory on the server —
back off and retry after the window resets. A rate-limited call is
authenticated (the key was valid) but never reaches the orchestrator.

**This limiter is in-memory and per-process.** It resets on every restart
and does not share state across multiple replicas/instances of this app —
if the app is ever scaled horizontally, each replica enforces the budget
independently, so a key's effective ceiling becomes `rateLimitPerMinute ×
replica count`. This is a known, accepted v1 trade-off (see
`docs/security-architecture.md` § 8), not an oversight.

## Error summary

| Status | `error` | When |
|---|---|---|
| `401` | `unauthorized` | Missing/malformed `Authorization` header, or an unknown/revoked key. |
| `403` | `forbidden` | Valid key, but it is not scoped for this route. |
| `400` | `invalid_request` | Body fails schema validation (e.g. empty `message`). |
| `429` | `rate_limited` | Key is over its per-minute budget. |
| `200` + `error` NDJSON event | `error` | Key and request were valid, but the turn itself failed mid-stream. |

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
{"type":"done","answer":"Your current MRR is...","toolCalls":0,"iterations":1}
```

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
`docs/security-architecture.md` § 8 for the full security posture (threat
model, storage design, verification details) and
`docs/middleware-agent-handoff.md` for the implementation handoff notes.

## Tests

Central suite: `middleware/test/channelApi/` (router, key store, token,
rate limiter, audit log, manifest, plugin wiring, public-path exemption,
the reuse seam against `@omadia/api-key-auth`, and privacy-guard integration
tests). The auth middleware and the scope model are covered separately in
`middleware/test/auth/requireApiKey.test.ts` and
`middleware/test/auth/apiKeyScopes.test.ts`.
