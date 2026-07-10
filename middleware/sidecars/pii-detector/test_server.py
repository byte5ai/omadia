"""Unit tests for the pure helpers in server.py (issue #361).

Stdlib-only; `server` is importable without gliner/onnxruntime installed
(the model import is deferred into load_model). Run from middleware/:

    python3 -m unittest sidecars/pii-detector/test_server.py
"""

import os
import sys
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


if __name__ == "__main__":
    unittest.main()
