"""Unit tests for the pure helpers in server.py (issue #361).

Stdlib-only; `server` is importable without gliner/onnxruntime installed
(the model import is deferred into load_model). Run from middleware/:

    python3 -m unittest sidecars/pii-detector/test_server.py
"""

import contextlib
import io
import json
import os
import socket
import sys
import threading
import time
import unittest

# Make `import server` work regardless of the caller's cwd (e.g. running
# `python3 -m unittest sidecars/pii-detector/test_server.py` from middleware/).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import server  # noqa: E402 — needs the sys.path entry above


def span(start, end, text="x", label="person", score=0.9):
    return {"start": start, "end": end, "text": text, "label": label, "score": score}


class ChunkTextTests(unittest.TestCase):
    def test_empty_text_yields_no_chunks(self):
        self.assertEqual(server.chunk_text(""), [])

    def test_whitespace_only_yields_no_chunks(self):
        self.assertEqual(server.chunk_text("   \n\t  "), [])

    def test_text_shorter_than_window_is_single_chunk_at_offset_zero(self):
        text = "  Anna Schmidt wohnt in Frankfurt.  "
        self.assertEqual(server.chunk_text(text, max_words=250), [(0, text)])

    def test_exactly_max_words_is_single_chunk(self):
        text = " ".join(f"w{i}" for i in range(10))
        self.assertEqual(server.chunk_text(text, max_words=10, overlap_words=3), [(0, text)])

    def test_chunk_offsets_slice_back_to_chunk(self):
        text = "  " + "  ".join(f"word{i}" for i in range(120)) + "  "
        for offset, chunk in server.chunk_text(text, max_words=25, overlap_words=5):
            self.assertEqual(text[offset : offset + len(chunk)], chunk)

    def test_every_word_is_covered_by_some_chunk(self):
        words = [f"word{i}" for i in range(97)]  # not a multiple of the step
        text = " ".join(words)
        chunks = server.chunk_text(text, max_words=20, overlap_words=4)
        for match in server._WORD_RE.finditer(text):
            covered = any(
                offset <= match.start() and match.end() <= offset + len(chunk)
                for offset, chunk in chunks
            )
            self.assertTrue(covered, f"word at {match.start()} not covered")

    def test_overlap_continuity_between_consecutive_chunks(self):
        text = " ".join(f"word{i}" for i in range(100))
        overlap = 4
        chunks = server.chunk_text(text, max_words=20, overlap_words=overlap)
        self.assertGreater(len(chunks), 1)
        for (off_a, chunk_a), (off_b, chunk_b) in zip(chunks, chunks[1:]):
            # The next chunk starts overlap words before the previous one ends.
            tail_words = chunk_a.split()[-overlap:]
            head_words = chunk_b.split()[:overlap]
            self.assertEqual(tail_words, head_words)
            self.assertLess(off_b, off_a + len(chunk_a))

    def test_offsets_are_code_points_with_multibyte_and_astral_chars(self):
        # "🜁" (astral) and "ä" each count as ONE code point in offsets.
        text = "🜁🜁 Müller 😀foo " + " ".join(f"w{i}" for i in range(50))
        chunks = server.chunk_text(text, max_words=10, overlap_words=2)
        for offset, chunk in chunks:
            self.assertEqual(text[offset : offset + len(chunk)], chunk)
        # The word "Müller" sits fully inside the first chunk at its str index.
        first_offset, first_chunk = chunks[0]
        idx = text.index("Müller")
        self.assertEqual(first_offset, 0)
        self.assertEqual(first_chunk[idx : idx + len("Müller")], "Müller")

    def test_invalid_parameters_raise(self):
        with self.assertRaises(ValueError):
            server.chunk_text("hello world", max_words=0)
        with self.assertRaises(ValueError):
            server.chunk_text("hello world", max_words=10, overlap_words=10)
        with self.assertRaises(ValueError):
            server.chunk_text("hello world", max_words=10, overlap_words=-1)


class MergeSpansTests(unittest.TestCase):
    def test_empty_input(self):
        self.assertEqual(server.merge_spans([]), [])
        self.assertEqual(server.merge_spans([(0, [])]), [])

    def test_chunk_offsets_are_applied(self):
        merged = server.merge_spans([(100, [span(5, 12, "Anna Sc")])])
        self.assertEqual(merged, [span(105, 112, "Anna Sc")])

    def test_overlapping_duplicate_keeps_higher_score(self):
        # Same entity seen by two overlapping windows at the same absolute spot.
        merged = server.merge_spans(
            [
                (0, [span(10, 22, "Anna Schmidt", score=0.71)]),
                (8, [span(2, 14, "Anna Schmidt", score=0.93)]),
            ]
        )
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["score"], 0.93)
        self.assertEqual((merged[0]["start"], merged[0]["end"]), (10, 22))

    def test_partial_overlap_keeps_higher_score(self):
        merged = server.merge_spans(
            [(0, [span(0, 10, score=0.6), span(8, 20, score=0.8)])]
        )
        self.assertEqual(len(merged), 1)
        self.assertEqual((merged[0]["start"], merged[0]["end"]), (8, 20))

    def test_score_tie_prefers_longer_span(self):
        merged = server.merge_spans(
            [(0, [span(0, 5, score=0.7), span(0, 12, score=0.7)])]
        )
        self.assertEqual(len(merged), 1)
        self.assertEqual((merged[0]["start"], merged[0]["end"]), (0, 12))

    def test_touching_spans_do_not_overlap(self):
        merged = server.merge_spans(
            [(0, [span(0, 5, score=0.9), span(5, 10, score=0.5)])]
        )
        self.assertEqual(len(merged), 2)

    def test_disjoint_spans_kept_and_sorted_by_start(self):
        merged = server.merge_spans(
            [
                (50, [span(0, 4, label="address", score=0.5)]),
                (0, [span(1, 5, score=0.99)]),
            ]
        )
        self.assertEqual([(s["start"], s["end"]) for s in merged], [(1, 5), (50, 54)])

    def test_coerces_numeric_types(self):
        merged = server.merge_spans([(0, [span(1, 3, score=1)])])
        self.assertIsInstance(merged[0]["score"], float)
        self.assertIsInstance(merged[0]["start"], int)


class ValidateRequestTests(unittest.TestCase):
    def test_valid_minimal_body_applies_defaults(self):
        text, labels, threshold = server.validate_request(
            {"text": "hello"}, default_labels=["person"], default_threshold=0.5
        )
        self.assertEqual(text, "hello")
        self.assertEqual(labels, ["person"])
        self.assertEqual(threshold, 0.5)

    def test_explicit_labels_and_threshold_pass_through(self):
        text, labels, threshold = server.validate_request(
            {"text": "t", "labels": [" person ", "address"], "threshold": 0.8}
        )
        self.assertEqual(labels, ["person", "address"])
        self.assertEqual(threshold, 0.8)

    def test_empty_text_is_valid(self):
        text, _, _ = server.validate_request({"text": ""})
        self.assertEqual(text, "")

    def test_rejects_non_object_body(self):
        for body in (None, [], "text", 42):
            with self.assertRaises(ValueError):
                server.validate_request(body)

    def test_rejects_missing_or_non_string_text(self):
        for body in ({}, {"text": 5}, {"text": None}, {"text": ["a"]}):
            with self.assertRaises(ValueError):
                server.validate_request(body)

    def test_rejects_bad_labels(self):
        for labels in ([], [""], ["  "], "person", [1], ["person", 2]):
            with self.assertRaises(ValueError):
                server.validate_request({"text": "t", "labels": labels})

    def test_rejects_bad_threshold(self):
        for threshold in (0, 0.0, 1.5, -0.1, "0.5", True, None):
            with self.assertRaises(ValueError):
                server.validate_request({"text": "t", "threshold": threshold})

    def test_threshold_upper_bound_inclusive(self):
        _, _, threshold = server.validate_request({"text": "t", "threshold": 1})
        self.assertEqual(threshold, 1.0)

    def test_rejects_unknown_keys(self):
        with self.assertRaises(ValueError):
            server.validate_request({"text": "t", "prompt": "smuggled"})


class BindStackTests(unittest.TestCase):
    """The listener must be reachable over IPv6.

    Fly.io's private network between apps is IPv6-only, so an IPv4-only
    listener is invisible to the middleware even though the container looks
    perfectly healthy locally (process up, model loaded,
    `curl 127.0.0.1:8812/health` -> 200). That combination cost real debugging
    time once; these tests pin the bind behaviour so it cannot regress
    silently.
    """

    def setUp(self):
        self._saved = os.environ.get("PII_DETECTOR_BIND_V4_ONLY")
        os.environ.pop("PII_DETECTOR_BIND_V4_ONLY", None)
        # Ephemeral port — never contend with a real sidecar on 8812.
        self._saved_port = server.PORT
        server.PORT = 0

    def tearDown(self):
        server.PORT = self._saved_port
        os.environ.pop("PII_DETECTOR_BIND_V4_ONLY", None)
        if self._saved is not None:
            os.environ["PII_DETECTOR_BIND_V4_ONLY"] = self._saved

    def test_default_bind_is_ipv6_and_accepts_v4_mapped(self):
        srv, desc = server.build_server()
        try:
            self.assertEqual(srv.socket.family, socket.AF_INET6)
            # IPV6_V6ONLY must be OFF so v4-mapped clients (Docker Compose's
            # v4 bridge) still connect through the same socket.
            self.assertEqual(
                srv.socket.getsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY),
                0,
            )
            self.assertIn("IPv4-mapped", desc)
        finally:
            srv.server_close()

    def test_ipv6_loopback_actually_connects(self):
        """The regression itself: [::1] must be reachable, not just 127.0.0.1."""
        srv, _ = server.build_server()
        try:
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            port = srv.socket.getsockname()[1]
            with socket.create_connection(("::1", port), timeout=5) as sock:
                self.assertIsNotNone(sock)
        finally:
            srv.shutdown()
            srv.server_close()

    def test_env_override_forces_ipv4_only(self):
        os.environ["PII_DETECTOR_BIND_V4_ONLY"] = "1"
        srv, desc = server.build_server()
        try:
            self.assertEqual(srv.socket.family, socket.AF_INET)
            self.assertIn("IPv4 only", desc)
        finally:
            srv.server_close()


class SelfTestTests(unittest.TestCase):
    """`run_selftest` must reject a model that loads but predicts noise.

    The production failure it guards: a u8s8-quantized ONNX export on a CPU
    without VNNI returns near-uniform ~0.15 scores instead of predictions.
    Nothing raises, /health answers 200, and every span falls under
    threshold — so the sidecar masks nothing while looking healthy.
    """

    class FakeModel:
        def __init__(self, ents):
            self._ents = ents

        def predict_entities(self, text, labels, threshold=0.0):
            return [e for e in self._ents if e["score"] >= threshold]

    class RaisingModel:
        def predict_entities(self, *a, **k):
            raise RuntimeError("session failed")

    def test_accepts_a_model_that_finds_the_known_person(self):
        m = self.FakeModel(
            [{"start": 0, "end": 12, "text": "Anna Schmidt", "label": "person", "score": 0.99}]
        )
        ok, detail = server.run_selftest(m)
        self.assertTrue(ok)
        self.assertIn("0.99", detail)

    def test_rejects_the_noise_signature(self):
        # Exactly what the broken quantized model returned in production:
        # every token scored ~0.15, decaying with position.
        noise = [
            {"start": 0, "end": 4, "text": "Anna", "label": "person", "score": 0.191},
            {"start": 5, "end": 12, "text": "Schmidt", "label": "person", "score": 0.174},
            {"start": 13, "end": 18, "text": "wohnt", "label": "person", "score": 0.159},
            {"start": 19, "end": 21, "text": "in", "label": "person", "score": 0.150},
        ]
        ok, detail = server.run_selftest(self.FakeModel(noise))
        self.assertFalse(ok)
        self.assertIn("not found", detail)

    def test_rejects_a_correct_span_scored_below_the_floor(self):
        m = self.FakeModel(
            [{"start": 0, "end": 12, "text": "Anna Schmidt", "label": "person", "score": 0.2}]
        )
        ok, detail = server.run_selftest(m)
        self.assertFalse(ok)
        self.assertIn("<", detail)

    def test_rejects_a_model_whose_inference_raises(self):
        ok, detail = server.run_selftest(self.RaisingModel())
        self.assertFalse(ok)
        self.assertIn("RuntimeError", detail)

    def test_detail_never_leaks_request_text(self):
        # Only the synthetic sentence may ever appear in the audit line.
        ok, detail = server.run_selftest(self.FakeModel([]))
        self.assertFalse(ok)
        self.assertNotIn("@", detail)


class ParsePriorityTests(unittest.TestCase):
    def test_absent_header_is_background_for_backward_compat(self):
        self.assertEqual(server.parse_priority(None), "background")
        self.assertEqual(server.parse_priority(""), "background")

    def test_known_values_case_and_whitespace_insensitive(self):
        self.assertEqual(server.parse_priority("interactive"), "interactive")
        self.assertEqual(server.parse_priority("  Interactive "), "interactive")
        self.assertEqual(server.parse_priority("BACKGROUND"), "background")

    def test_unknown_value_falls_back_to_background(self):
        # Scheduling hint only — an unknown value must not fail the request,
        # and must not be able to claim the fast lane either.
        self.assertEqual(server.parse_priority("urgent"), "background")


class PriorityGateTests(unittest.TestCase):
    """Single inference slot; interactive first, FIFO per class, bg aging."""

    def _wait_for_depth(self, gate, interactive, background):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if gate.depths() == {"interactive": interactive, "background": background}:
                return
            time.sleep(0.005)
        self.fail(f"queue depth never reached {interactive}/{background}: {gate.depths()}")

    def _enqueue(self, gate, prio, name, order, expect_depth):
        """Start a waiter and block until it is visibly queued (deterministic order)."""

        def run():
            grant = gate.acquire(prio, timeout=5)
            self.assertIsNotNone(grant)
            order.append(name)
            gate.release()

        t = threading.Thread(target=run, daemon=True)
        t.start()
        self._wait_for_depth(gate, *expect_depth)
        return t

    def test_idle_gate_grants_immediately_with_zero_wait(self):
        gate = server.PriorityGate(aging_s=5)
        grant = gate.acquire("background", timeout=1)
        self.assertIsNotNone(grant)
        self.assertLess(grant.wait_ms, 50)
        self.assertEqual(grant.queued, {"interactive": 0, "background": 0})
        gate.release()

    def test_interactive_waiters_go_before_background_fifo_within_class(self):
        gate = server.PriorityGate(aging_s=60)
        self.assertIsNotNone(gate.acquire("background", timeout=1))  # hold the slot
        order = []
        threads = [
            self._enqueue(gate, "background", "bg1", order, (0, 1)),
            self._enqueue(gate, "interactive", "int1", order, (1, 1)),
            self._enqueue(gate, "background", "bg2", order, (1, 2)),
            self._enqueue(gate, "interactive", "int2", order, (2, 2)),
        ]
        gate.release()
        for t in threads:
            t.join(5)
        self.assertEqual(order, ["int1", "int2", "bg1", "bg2"])
        self.assertEqual(gate.depths(), {"interactive": 0, "background": 0})

    def test_background_waiting_past_aging_is_served_next(self):
        gate = server.PriorityGate(aging_s=0.2)
        self.assertIsNotNone(gate.acquire("interactive", timeout=1))
        order = []
        threads = [self._enqueue(gate, "background", "bg-old", order, (0, 1))]
        time.sleep(0.3)  # bg-old is now older than the aging threshold
        threads.append(self._enqueue(gate, "interactive", "int-new", order, (1, 1)))
        gate.release()
        for t in threads:
            t.join(5)
        self.assertEqual(order, ["bg-old", "int-new"])

    def test_young_background_does_not_jump_interactive(self):
        gate = server.PriorityGate(aging_s=60)
        self.assertIsNotNone(gate.acquire("interactive", timeout=1))
        order = []
        threads = [self._enqueue(gate, "background", "bg", order, (0, 1))]
        time.sleep(0.3)
        threads.append(self._enqueue(gate, "interactive", "int", order, (1, 1)))
        gate.release()
        for t in threads:
            t.join(5)
        self.assertEqual(order, ["int", "bg"])

    def test_waiter_reports_queue_depth_seen_on_arrival_and_wait_ms(self):
        gate = server.PriorityGate(aging_s=60)
        self.assertIsNotNone(gate.acquire("background", timeout=1))
        grants = {}

        def run(prio, name):
            grants[name] = gate.acquire(prio, timeout=5)
            gate.release()

        a = threading.Thread(target=run, args=("background", "a"), daemon=True)
        a.start()
        self._wait_for_depth(gate, 0, 1)
        b = threading.Thread(target=run, args=("interactive", "b"), daemon=True)
        b.start()
        self._wait_for_depth(gate, 1, 1)
        time.sleep(0.05)
        gate.release()
        a.join(5)
        b.join(5)
        self.assertEqual(grants["b"].queued, {"interactive": 0, "background": 1})
        self.assertGreaterEqual(grants["b"].wait_ms, 40)
        self.assertEqual(grants["a"].priority, "background")

    def test_timeout_returns_none_and_leaves_no_ghost_waiter(self):
        gate = server.PriorityGate(aging_s=60)
        self.assertIsNotNone(gate.acquire("background", timeout=1))
        self.assertIsNone(gate.acquire("interactive", timeout=0.1))
        self.assertEqual(gate.depths(), {"interactive": 0, "background": 0})
        gate.release()
        # The slot is free again: a timed-out waiter must not have been granted.
        grant = gate.acquire("background", timeout=0.1)
        self.assertIsNotNone(grant)
        gate.release()

    def test_release_hands_off_to_waiter_not_to_a_fresh_arrival(self):
        gate = server.PriorityGate(aging_s=60)
        self.assertIsNotNone(gate.acquire("background", timeout=1))
        order = []
        t = self._enqueue(gate, "background", "waiter", order, (0, 1))
        gate.release()
        # The slot went straight to the waiter; a newcomer queues behind it.
        late = gate.acquire("interactive", timeout=5)
        self.assertIsNotNone(late)
        order.append("late")
        gate.release()
        t.join(5)
        self.assertEqual(order[0], "waiter")


class DetectEndpointPriorityTests(unittest.TestCase):
    """The HTTP handler reads X-PII-Priority and logs prio/wait/queue depth."""

    def setUp(self):
        self._saved = (server.PORT, server.detect, server._GATE)
        server.PORT = 0
        server.detect = lambda text, labels, threshold: []
        server._GATE = server.PriorityGate(aging_s=5)
        os.environ.pop("PII_DETECTOR_BIND_V4_ONLY", None)
        self.srv, _ = server.build_server()
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.socket.getsockname()[1]

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        server.PORT, server.detect, server._GATE = self._saved

    def _post(self, headers):
        import http.client

        conn = http.client.HTTPConnection("::1", self.port, timeout=5)
        body = json.dumps({"text": "Anna Schmidt"})
        conn.request(
            "POST", "/detect", body, {"content-type": "application/json", **headers}
        )
        res = conn.getresponse()
        payload = json.loads(res.read())
        conn.close()
        return res.status, payload

    def _post_capturing_log(self, headers):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            status, payload = self._post(headers)
        return status, payload, buf.getvalue()

    def test_interactive_header_is_logged(self):
        status, payload, log = self._post_capturing_log({"X-PII-Priority": "interactive"})
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertIn("prio=interactive", log)
        self.assertIn("wait_ms=", log)
        self.assertIn("queued_interactive=0 queued_background=0", log)
        self.assertNotIn("Anna", log)  # never the text

    def test_missing_header_defaults_to_background(self):
        status, _, log = self._post_capturing_log({})
        self.assertEqual(status, 200)
        self.assertIn("prio=background", log)

    def test_queue_wait_exceeded_answers_503(self):
        saved_timeout = server.DETECT_TIMEOUT_S
        server.DETECT_TIMEOUT_S = 0.1
        self.assertIsNotNone(server._GATE.acquire("background", timeout=1))
        try:
            status, payload, log = self._post_capturing_log(
                {"X-PII-Priority": "interactive"}
            )
        finally:
            server._GATE.release()
            server.DETECT_TIMEOUT_S = saved_timeout
        self.assertEqual(status, 503)
        self.assertFalse(payload["ok"])
        self.assertIn("prio=interactive", log)


if __name__ == "__main__":
    unittest.main()
