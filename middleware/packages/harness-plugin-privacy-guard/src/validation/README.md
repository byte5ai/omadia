# Prompt-PII detector validation harness (#361)

Standalone, runnable evaluation for the prompt-masking detector ensemble —
**not a CI gate**. It exists so that flipping the `mask_user_prompt` flag on
for a locale is a measured decision, not a vibe check: the pass/fail gates
below were committed *before* any run.

## Run

```bash
# from middleware/
npx tsx packages/harness-plugin-privacy-guard/src/validation/promptDetectorEval.ts
```

Scores the configured detectors (`C0` regex baseline; add the C1 transformer
detector to `DETECTOR_SETS` once wired) against the fixture sets, using
exact-match leak scoring via `v4/onTheWire.ts#findIdentityLeaks`: a PII
instance counts as masked only when the real value is entirely absent from
the masked output — any surviving identifying character is a leak.

## Pre-committed gates (per locale × detector set)

| Metric | Gate |
|---|---|
| Recall, structured identifiers (email, IBAN, phone, amount, date, address) | ≥ 0.97 |
| Recall, names / free-form entities (`person`) | ≥ 0.90 (requires C1 — C0 does not detect names) |
| Precision proxy (spans flagged on PII-free negatives) | ≥ 0.85 |
| Added latency, p95 per prompt | ≤ 400 ms |

**Flag policy:** `mask_user_prompt` may be enabled only for locales whose
fixture set passes ALL gates with the shipped detector set. C0 alone gates
on structured identifiers only — a deployment that needs name masking must
wire a C1 detector and re-run.

## Fixtures

`fixtures/<locale>.json` — array of items:

```json
{ "text": "…prompt…", "spans": [{ "value": "anna@firma.de", "type": "email", "tier": "high" }] }
```

- Items with `spans: []` are **negatives** (PII-free) and feed the
  over-masking measurement.
- `de` and `en` ship hand-built slices, including the documented NER-sidecar
  failure modes from `plugin-api/src/piiAnnotation.ts` (partial German
  names, "Krankheit"→ADDRESS-class false positives) — any C1 candidate must
  clear exactly these before a go verdict.
- `fr` / `es` / `it` / `nl` are **not yet populated** — per the RFC these
  locales need an ai4privacy-derived backbone plus a native-speaker-checked
  hand slice before their flag may flip on.

## Honest-measurement caveat (from the RFC)

Piiranha-class models are trained on ai4privacy-style data; evaluating them
on ai4privacy items is partially in-distribution and inflates numbers. The
go/no-go signal is the hand-built out-of-distribution slice in these
fixtures, not a public-benchmark score.
