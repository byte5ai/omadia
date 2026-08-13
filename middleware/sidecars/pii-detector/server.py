"""HTTP shim around GLiNER multilingual PII detection (issue #361).

Endpoints:
    GET  /health  -> 200 {"ok": true, "model": "...", "revision": "...",
                          "backend": "onnx"|"torch"}
                     The model is loaded BEFORE the server starts listening,
                     so a 200 here means inference is ready.
    POST /detect  -> body {"text": str, "labels"?: [str], "threshold"?: float}
                     responds {"ok": true, "model_version": str,
                               "spans": [{"start", "end", "text", "label",
                                          "score"}]}

Span offsets: `start`/`end` are Unicode CODE-POINT offsets into the request
text (Python `str` indexing — an astral-plane emoji counts as ONE position),
and `text` is the exact `text[start:end]` slice. The middleware client
converts code points to the UTF-16 offsets JavaScript needs and uses the
`text` field to verify its conversion (a mis-anchored span is a leak).

Fail-closed: any error (bad body, oversized body, model failure, overload)
answers non-200 with {"ok": false, "error": str} — never a 200 with a
half-result. The middleware treats a non-200 as "C1 unavailable" and rides
its audited degrade-to-C0 path.

PRIVACY: this sidecar handles raw user-prompt PII. Request text and span
values are NEVER logged — only lengths, counts, and durations.

Deliberately stdlib-only apart from the model runtime itself (precedent:
middleware/sidecars/skillspector/server.py). Stateless: nothing is persisted
between requests. The middleware-side contract lands with the
`createC1HttpDetector` client in harness-plugin-privacy-guard.
"""

import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8812"))
# Prompts, not file trees — 1 MiB is generous for a chat message.
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(1024 * 1024)))
# Max seconds a request waits for the serialized model before answering 503.
# (In-process inference cannot be interrupted mid-run; this bounds queueing.)
DETECT_TIMEOUT_S = float(os.environ.get("DETECT_TIMEOUT_S", "30"))

# Model identity — baked into the image by the Dockerfile (exact HF revision,
# downloaded at build time; the running container performs no egress).
MODEL_ID = os.environ.get("MODEL_ID", "onnx-community/gliner_multi_pii-v1")
MODEL_REVISION = os.environ.get(
    "MODEL_REVISION", "2e0397a7e8a250d76c37122232b3cbde42c8d629"
)
MODEL_DIR = os.environ.get("MODEL_DIR", "/app/model")
# "onnx" (default: quantized ONNX on CPU — avoids the documented AVX2
# "Illegal instruction" hazard of default torch inference) or "torch"
# (fallback; needs a torch-weights snapshot, see README).
DETECTOR_BACKEND = os.environ.get("DETECTOR_BACKEND", "onnx")
ONNX_MODEL_FILE = os.environ.get("ONNX_MODEL_FILE", "onnx/model_quantized.onnx")

# Calibrated, fixed label set — C1 owns exactly the classes regex cannot
# detect. Open-label flexibility is deliberately NOT exposed (false-positive
# cascade class, see #242 / piiAnnotation.ts history).
DEFAULT_LABELS = [
    label.strip()
    for label in os.environ.get("DETECTOR_LABELS", "person,address").split(",")
    if label.strip()
]
DEFAULT_THRESHOLD = float(os.environ.get("DETECTOR_THRESHOLD", "0.5"))

# GLiNER's encoder truncates at 384 tokens; ~250 words per window with a
# 30-word overlap keeps every entity fully inside at least one window.
CHUNK_MAX_WORDS = int(os.environ.get("CHUNK_MAX_WORDS", "250"))
CHUNK_OVERLAP_WORDS = int(os.environ.get("CHUNK_OVERLAP_WORDS", "30"))

_WORD_RE = re.compile(r"\S+")

# Populated once by main() before the server starts serving.
_STATE = {"model": None, "backend": None}
_INFER_LOCK = threading.Lock()


def chunk_text(text, max_words=None, overlap_words=None):
    """Split `text` into overlapping word-window chunks.

    Returns a list of `(offset, chunk)` pairs where `offset` is the
    code-point offset of `chunk` inside `text`, i.e. the invariant
    `text[offset:offset + len(chunk)] == chunk` always holds. Words are
    maximal runs of non-whitespace; chunk boundaries sit on word boundaries,
    so only inter-word whitespace can fall between chunks. Empty /
    whitespace-only text yields no chunks.
    """
    max_words = CHUNK_MAX_WORDS if max_words is None else max_words
    overlap_words = CHUNK_OVERLAP_WORDS if overlap_words is None else overlap_words
    if max_words <= 0:
        raise ValueError("max_words must be positive")
    if not 0 <= overlap_words < max_words:
        raise ValueError("overlap_words must be in [0, max_words)")
    words = list(_WORD_RE.finditer(text))
    if not words:
        return []
    if len(words) <= max_words:
        return [(0, text)]
    step = max_words - overlap_words
    chunks = []
    for i in range(0, len(words), step):
        window = words[i : i + max_words]
        start = window[0].start()
        end = window[-1].end()
        chunks.append((start, text[start:end]))
        if i + max_words >= len(words):
            break
    return chunks


def merge_spans(chunk_results):
    """Map chunk-relative spans to absolute offsets and dedupe overlaps.

    `chunk_results` is `[(chunk_offset, spans)]` with GLiNER-shaped span
    dicts (`start`/`end`/`text`/`label`/`score`, offsets relative to the
    chunk). Overlapping absolute spans — typically the same entity seen by
    two overlapping windows — are deduped keeping the higher score;
    deterministic tie-break prefers the longer span, then the earlier one.
    Touching spans (`a.end == b.start`) do not overlap. Result is sorted by
    `start`.
    """
    absolute = []
    for offset, spans in chunk_results:
        for span in spans:
            absolute.append(
                {
                    "start": int(span["start"]) + offset,
                    "end": int(span["end"]) + offset,
                    "text": str(span["text"]),
                    "label": str(span["label"]),
                    "score": float(span["score"]),
                }
            )
    absolute.sort(
        key=lambda s: (
            -s["score"],
            -(s["end"] - s["start"]),
            s["start"],
            s["end"],
            s["label"],
        )
    )
    kept = []
    for cand in absolute:
        if any(
            cand["start"] < k["end"] and k["start"] < cand["end"] for k in kept
        ):
            continue
        kept.append(cand)
    kept.sort(key=lambda s: (s["start"], s["end"], s["label"]))
    return kept


def validate_request(body, default_labels=None, default_threshold=None):
    """Validate a /detect body; returns (text, labels, threshold).

    Raises ValueError with a text-free message on any malformed input —
    the error string must never echo prompt content.
    """
    default_labels = DEFAULT_LABELS if default_labels is None else default_labels
    default_threshold = (
        DEFAULT_THRESHOLD if default_threshold is None else default_threshold
    )
    if not isinstance(body, dict):
        raise ValueError("body must be a JSON object")
    unknown = set(body) - {"text", "labels", "threshold"}
    if unknown:
        raise ValueError(f"unknown body keys: {sorted(unknown)}")
    text = body.get("text")
    if not isinstance(text, str):
        raise ValueError("body needs a string 'text'")
    labels = body.get("labels", default_labels)
    if (
        not isinstance(labels, list)
        or not labels
        or not all(isinstance(l, str) and l.strip() for l in labels)
    ):
        raise ValueError("'labels' must be a non-empty array of non-empty strings")
    threshold = body.get("threshold", default_threshold)
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)):
        raise ValueError("'threshold' must be a number")
    threshold = float(threshold)
    if not 0.0 < threshold <= 1.0:
        raise ValueError("'threshold' must be in (0, 1]")
    return text, [label.strip() for label in labels], threshold


def load_model():
    """Load GLiNER once at process start; returns (model, backend)."""
    from gliner import GLiNER  # deferred: unit tests import this module without it

    if DETECTOR_BACKEND == "onnx":
        model = GLiNER.from_pretrained(
            MODEL_DIR,
            load_onnx_model=True,
            load_tokenizer=True,
            onnx_model_file=ONNX_MODEL_FILE,
        )
        return model, "onnx"
    if DETECTOR_BACKEND == "torch":
        model = GLiNER.from_pretrained(MODEL_DIR)
        return model, "torch"
    raise ValueError(f"unsupported DETECTOR_BACKEND: {DETECTOR_BACKEND!r}")


def detect(text, labels, threshold):
    """Chunked, offset-remapped inference over `text`. Caller holds the lock."""
    model = _STATE["model"]
    if model is None:
        raise RuntimeError("model not loaded")
    chunk_results = []
    for offset, chunk in chunk_text(text):
        entities = model.predict_entities(chunk, labels, threshold=threshold)
        chunk_results.append((offset, entities))
    return merge_spans(chunk_results)


class Handler(BaseHTTPRequestHandler):
    def _respond(self, status, body):
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # noqa: N802 — http.server API
        if self.path == "/health":
            self._respond(
                200,
                {
                    "ok": True,
                    "model": MODEL_ID,
                    "revision": MODEL_REVISION,
                    "backend": _STATE["backend"],
                },
            )
        else:
            self._respond(404, {"ok": False, "error": "not found"})

    def do_POST(self):  # noqa: N802 — http.server API
        if self.path != "/detect":
            self._respond(404, {"ok": False, "error": "not found"})
            return
        length = int(self.headers.get("content-length", "0"))
        if length <= 0 or length > MAX_BODY_BYTES:
            self._respond(413, {"ok": False, "error": "body missing or too large"})
            return
        try:
            body = json.loads(self.rfile.read(length))
        except Exception:  # malformed JSON/encoding — never echo the payload
            self._respond(400, {"ok": False, "error": "invalid JSON body"})
            return
        try:
            text, labels, threshold = validate_request(body)
        except ValueError as err:  # validate_request messages are text-free
            self._respond(400, {"ok": False, "error": str(err)})
            return
        if not _INFER_LOCK.acquire(timeout=DETECT_TIMEOUT_S):
            self._respond(
                503, {"ok": False, "error": "detector busy (queue wait exceeded)"}
            )
            return
        started = time.monotonic()
        try:
            spans = detect(text, labels, threshold)
        except Exception as err:  # noqa: BLE001 — shim must answer, not die
            # Type name only: library errors could embed input fragments.
            self._respond(
                500, {"ok": False, "error": f"inference failed: {type(err).__name__}"}
            )
            return
        finally:
            _INFER_LOCK.release()
        duration_ms = int((time.monotonic() - started) * 1000)
        # Lengths/counts/durations only — never the text or span values.
        print(
            f"[pii-detector] /detect text_len={len(text)} labels={len(labels)} "
            f"spans={len(spans)} ms={duration_ms}",
            flush=True,
        )
        self._respond(
            200,
            {
                "ok": True,
                "model_version": f"{MODEL_ID}@{MODEL_REVISION[:12]}",
                "spans": spans,
            },
        )

    def log_message(self, fmt, *args):  # quiet default access log (paths only anyway)
        pass


if __name__ == "__main__":
    print(
        f"[pii-detector] loading {MODEL_ID}@{MODEL_REVISION[:12]} "
        f"(backend={DETECTOR_BACKEND}) ...",
        flush=True,
    )
    _load_started = time.monotonic()
    _STATE["model"], _STATE["backend"] = load_model()
    print(
        f"[pii-detector] model ready in {time.monotonic() - _load_started:.1f}s; "
        f"listening on :{PORT}",
        flush=True,
    )
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
