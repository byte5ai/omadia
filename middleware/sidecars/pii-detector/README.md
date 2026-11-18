# GLiNER PII-detector sidecar (issue #361)

HTTP shim around [urchade/GLiNER](https://github.com/urchade/GLiNER)
(Apache-2.0) running the `gliner_multi_pii-v1` multilingual PII fine-tune
(Apache-2.0). It is the C1 transformer tier of the privacy guard (prompt
masking, tool-error redaction and the answer verifier's evidence
projection): it finds the PII classes regex structurally cannot detect — `person` names and free-form `address`es — in en/de/fr/es/it
(the fine-tune's card does not list nl; the per-locale validation gate
absorbs that honestly).

The middleware posts raw text to `POST /detect`: the turn's prompt text while
`mask_user_prompt` is on and, regardless of that flag, tool-error text and
every evidence-judge request of the answer verifier (the restored claim plus
knowledge-graph evidence). The shim runs chunked GLiNER inference and answers
scored spans. Enable in the middleware via `PRIVACY_C1_DETECTOR_URL` (see
`docker-compose.pii-detector.yaml`). Sidecar unavailable ⇒ the middleware's
audited degrade-to-C0 path fires (`promptMaskDegraded`,
`toolErrorRedactDegraded`) — never a silent unmasked pass-through.

**This sidecar handles raw customer data** (prompt text, tool-error text,
verifier evidence). It must only ever be reachable
from the internal network (the compose overlay publishes no ports), it is
stateless, and it never logs request text or span values — only lengths,
counts, and durations.

## HTTP contract (fail-closed, versioned)

- `GET /health` →
  `200 {"ok": true, "model": "...", "revision": "<pinned sha>", "backend": "onnx"}`.
  The model loads before the server starts listening, so a 200 means
  inference is ready (compose healthcheck uses `start_period: 120s` to cover
  the load).
- `POST /detect` with `{"text": str, "labels"?: [str], "threshold"?: float}` →
  `200 {"ok": true, "model_version": str, "spans": [{"start": int, "end": int,
  "text": str, "label": str, "score": float}]}`.
  - Defaults when omitted: `labels = ["person", "address"]` (env
    `DETECTOR_LABELS`, comma-separated), `threshold = 0.5` (env
    `DETECTOR_THRESHOLD`).
  - Any error (bad body, oversized body, model failure, overload) → non-200
    with `{"ok": false, "error": str}`. Never a 200 with a half-result.

### Priority lane (`X-PII-Priority`)

Inference is single-flight (CPU-bound, the model is not thread-safe), so
requests queue for one slot. The optional request header
`X-PII-Priority: interactive|background` picks the queue:

- `interactive`: turn masking on the critical path of a chat turn (user
  prompt, recalled tail, verifier projection, tool-error redaction). The
  middleware's shared C1 detector sends this by default.
- `background`: stored-text masking for memory jobs and skeleton masking
  (`openStoredTextScope` → `storedTextScope.ts` rebinds the detector via
  `withC1Priority(…, 'background')`).
- Absent or unrecognised → `background`, so older clients keep their old
  behaviour and cannot claim the fast lane by accident.

When the slot frees, queued `interactive` requests go first, FIFO within a
class. Anti-starvation: a `background` request that has waited longer than
`BACKGROUND_AGING_S` (default 5 s) is served next, even ahead of queued
interactive work. The slot is handed directly to the chosen waiter, so a
fresh arrival never jumps the queue. `DETECT_TIMEOUT_S` still bounds the
wait per request (→ `503`). The header only changes order. Results are identical.

The per-request log line carries the scheduling data (never text):

```
[pii-detector] /detect text_len=4210 labels=2 spans=3 ms=3870 wait_ms=12 prio=interactive queued_interactive=0 queued_background=2
```

`wait_ms` is the time spent queued for the slot. `queued_*` is the number of
waiters per class this request found on arrival. A queue-wait timeout logs
`/detect busy … status=503 wait_ms=… prio=…` with the current depths.

### Addressing on Fly.io: use `.flycast`, not `.internal`

Point `PRIVACY_C1_DETECTOR_URL` at the app's **Flycast** address
(`http://<app>.flycast:<port>`), not `<app>.internal`. `.internal` resolves
straight to machine 6PN addresses and bypasses the Fly proxy. The client
then pins to whichever machine it resolved, and extra machines add no
throughput. `.flycast` goes through the Fly proxy, which balances per
request across machines using the service's concurrency limits.

Requirements on the sidecar app:

- A private Flycast IP: `fly ips allocate-v6 --private -a <app>`.
- A service for the internal port (`8812`) with request-based concurrency,
  for example in `fly.toml`:

  ```toml
  [http_service]
    internal_port = 8812
    auto_stop_machines = "off"   # model load + selftest takes minutes; never cold-start a turn
    min_machines_running = 2

    [http_service.concurrency]
      type = "requests"          # keep-alive connections would pin to one machine under "connections"
      soft_limit = 1             # one inference per machine: steer the next request elsewhere
      hard_limit = 8             # keep above peak burst so requests reach the sidecar's priority queue
  ```

The proxy does not know about `X-PII-Priority`. Requests it holds back at
`hard_limit` wait in the proxy's FIFO, not the sidecar's priority queue.
That's why `hard_limit` stays generous and `soft_limit` low: the proxy
spreads load, and each machine orders its own queue.

### Span offset semantics

`start`/`end` are **Unicode code-point offsets into the request text**
(Python `str` indexing — an astral-plane emoji counts as one position), and
`text` is the exact `text[start:end]` slice. JavaScript string indices are
UTF-16 code units, so the middleware client converts code points → UTF-16
offsets and then asserts its slice equals the returned `text` field; a
mismatch is treated as a detector failure (a mis-anchored span is a leak).

## Configuration (env)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8812` | Listen port |
| `MAX_BODY_BYTES` | `1048576` (1 MiB) | Request-body cap — prompts, not file trees |
| `DETECT_TIMEOUT_S` | `30` | Max seconds a request waits for the serialized model (inference is single-flight behind the priority gate) before answering `503` |
| `BACKGROUND_AGING_S` | `5` | A `background` request queued longer than this is served next, ahead of queued `interactive` work (anti-starvation) |
| `DETECTOR_LABELS` | `person,address` | Default label set — fixed and calibrated; open-label mode is deliberately not exposed (false-positive cascade class, see #242) |
| `DETECTOR_THRESHOLD` | `0.5` | Default score threshold |
| `DETECTOR_BACKEND` | `onnx` | `onnx` (quantized, CPU-friendly, avoids the documented AVX2 "Illegal instruction" hazard of default torch inference) or `torch` (fallback) |
| `ONNX_MODEL_FILE` | `onnx/model_quantized.onnx` | ONNX file inside the model snapshot |
| `CHUNK_MAX_WORDS` / `CHUNK_OVERLAP_WORDS` | `250` / `30` | Word-window chunking (GLiNER's encoder truncates at 384 tokens); overlapping windows are offset-remapped and deduped (higher score wins) |

## Model pin & bump procedure

The Dockerfile bakes the model at **build time**, pinned to an exact HF
revision sha — the running container needs no egress (`HF_HUB_OFFLINE=1`
makes accidental download attempts fail hard).

- Default (ONNX): `onnx-community/gliner_multi_pii-v1` @
  `2e0397a7e8a250d76c37122232b3cbde42c8d629`
- Torch fallback: `urchade/gliner_multi_pii-v1` @
  `1fcf13e85f4eef5394e1fcd406cf2ca9ea82351d` — build with
  `--build-arg MODEL_ID=urchade/gliner_multi_pii-v1 --build-arg
  MODEL_REVISION=1fcf13e… --build-arg DETECTOR_BACKEND=torch`

To bump the pin (model revision or the `gliner`/`onnxruntime` pins in
`requirements.txt`):

1. Pick the new revision on Hugging Face (`GET
   https://huggingface.co/api/models/<repo>` → `sha`) and review the upstream
   diff / model-card changes since the current pin. License must stay
   Apache-2.0 (Piiranha-v1 was rejected for CC-BY-NC-ND — do not "upgrade"
   into a non-commercial license).
2. Update the `ARG MODEL_REVISION` default in the Dockerfile (and
   `MODEL_REVISION` default in `server.py`), rebuild
   (`docker build middleware/sidecars/pii-detector`), and re-run the smoke
   probe below.
3. Re-run the 6-locale validation harness
   (`harness-plugin-privacy-guard/src/validation/`) before any locale keeps
   `mask_user_prompt` enabled on the new pin — detector quality is gated per
   locale, not assumed.

## Tests & smoke probe

Model-free unit tests (chunking, span merge, request validation, priority
gate ordering/aging/timeout, and the `/detect` header + log line against a
real HTTP server with inference stubbed out):

```bash
cd middleware && python3 -m unittest sidecars/pii-detector/test_server.py
```

Manual smoke after a build:

```bash
docker compose -f docker-compose.yaml -f docker-compose.pii-detector.yaml up -d
docker compose exec middleware node -e "fetch('http://pii-detector:8812/health').then(r => r.json()).then(j => console.log(j))"
docker compose exec middleware node -e "
fetch('http://pii-detector:8812/detect', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'Anna Schmidt wohnt in der Bahnhofstr. 5, 60311 Frankfurt.' }),
}).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2)))"
```

Expected: a `person` span covering exactly `Anna Schmidt` and a plausible
`address` span; for every span, `text` equals the code-point slice
`[start, end)` of the request text. (The probe runs from inside the
middleware container because the sidecar deliberately publishes no host
port.)
