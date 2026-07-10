# Prompt-PII detector validation harness (#361)

Standalone, runnable evaluation for the prompt-masking detector ensemble —
**not a CI gate**. It exists so that flipping the `mask_user_prompt` flag on
for a locale is a measured decision, not a vibe check: the pass/fail gates
below were committed *before* any run.

## Run

```bash
# from middleware/ — C0 regex baseline only:
npx tsx packages/harness-plugin-privacy-guard/src/validation/promptDetectorEval.ts

# with the GLiNER sidecar (docker-compose.pii-detector.yaml overlay, or a
# local `python server.py` from middleware/sidecars/pii-detector/) —
# adds the `c0+c1` and `c1-solo` sets:
PII_DETECTOR_URL=http://localhost:8812 \
  npx tsx packages/harness-plugin-privacy-guard/src/validation/promptDetectorEval.ts

# GitHub-flavored markdown output, ready to paste into issue #361:
PII_DETECTOR_URL=http://localhost:8812 \
  npx tsx packages/harness-plugin-privacy-guard/src/validation/promptDetectorEval.ts --markdown
```

Scoring uses exact-match leak scoring via `v4/onTheWire.ts#findIdentityLeaks`:
a PII instance counts as masked only when the real value is entirely absent
from the masked output — any surviving verbatim value is a leak. Honest
caveat that cuts the other way: a long value that is only *partially* masked
(e.g. the postal-code fragment of a free-form address) already counts as
masked under this criterion, because the full verbatim string is gone.
Surviving fragments are exactly what the C1 tier exists to catch — compare
the `c0` vs `c0+c1` address/person rows.

## Detector sets

| Set | Detectors | Gated? |
|---|---|---|
| `c0` | regex baseline (`createBaselineDetector`) | structured gates only |
| `c0+c1` | baseline + GLiNER sidecar (`createC1HttpDetector`, requires `PII_DETECTOR_URL`) | ALL gates incl. person recall |
| `c1-solo` | GLiNER sidecar alone | never — ablation for marginal-contribution analysis |

One un-timed warm-up call runs per set before measurement so sidecar/session
warm-up never pollutes the p95 latency numbers. The harness uses a 10 s C1
timeout (vs the runtime's 1500 ms) deliberately: it measures quality and
*reports* latency against the gate instead of converting a slow sidecar into
thrown timeouts.

## Pre-committed gates (per locale × detector set)

| Metric | Gate |
|---|---|
| Recall, structured identifiers (email, IBAN, phone, amount, date, address) | ≥ 0.97 |
| Recall, names / free-form entities (`person`) | ≥ 0.90 — enforced on the `c0+c1` set (C0 does not detect names) |
| Precision proxy (spans flagged on PII-free negatives) | ≥ 0.85 |
| Added latency, p95 per prompt | ≤ 400 ms |

`idnum` spans (locale ID numbers: Steuer-ID, NINO, NIE/DNI, codice fiscale,
BSN, n° de sécurité sociale) are measured **informationally only and never
gated in v1**: C0 has no patterns for them and C1's calibrated label set is
`person`/`address`. If a run shows Critical-tier `idnum` leaks in practice,
locale ID regexes are the recorded fast-follow.

**Flag policy (unchanged):** `mask_user_prompt` may be enabled only for
locales whose fixture set passes ALL gates with the shipped detector set,
and the harness results for that locale must be posted to issue #361 BEFORE
the flag flips on. A deployment that needs name masking must run the
`c0+c1` set against the GLiNER sidecar and pass the person gate.

## Fixtures

`fixtures/<locale>.json` — array of items:

```json
{
  "text": "…prompt…",
  "spans": [{ "value": "anna@firma.de", "type": "email", "tier": "high" }],
  "origin": "hand"
}
```

- Items with `spans: []` are **negatives** (PII-free) and feed the
  over-masking measurement.
- `origin` is optional: `"hand"` marks the hand-built out-of-distribution
  slice; absent means `"synthetic"` (LLM-generated backbone). The
  **hand-slice person recall is the go/no-go signal** (see caveat below);
  the harness reports it separately from overall recall.
- Every span `value` must occur verbatim in `text`; types and tiers must be
  from the known sets; duplicate items are rejected. The harness lints all
  fixture files at load time and fails the whole run loudly on any
  violation.

### Coverage (per locale)

| Locale | Items | Positives | Negatives | Hand slice |
|---|---|---|---|---|
| de | 121 | 89 | 32 (26%) | 25 |
| en | 121 | 89 | 32 (26%) | 25 |
| fr | 121 | 89 | 32 (26%) | 25 |
| es | 121 | 89 | 32 (26%) | 25 |
| it | 121 | 89 | 32 (26%) | 25 |
| nl | 121 | 89 | 32 (26%) | 25 |

Hand slices include the documented NER-sidecar failure modes from
`plugin-api/src/piiAnnotation.ts` (partial German names, "Krankheit"-class
false positives), German capitalized common nouns as person-FP bait,
multi-part Spanish surnames, French particle names (de/du/d'), Dutch
tussenvoegsel names ("Jan van der Berg"), Italian names adjacent to
codice-fiscale-shaped strings, adjacent distinct persons in one sentence,
free-form addresses longer than 12 words (probes GLiNER's span-width
ceiling), and locale ID numbers typed `idnum`.

### Provenance & licensing (hard rule)

- All committed fixtures are **original**: hand-built items plus
  LLM-generated synthetic chat prompts in the ai4privacy *style*. **No
  ai4privacy rows or derivatives are committed** — `pii-masking-300k`
  carries restricted commercial terms, and committed derivatives would
  contaminate the repo. ai4privacy may be used as a **local, uncommitted**
  supplementary check only.
- `fr` / `es` / `it` / `nl` fixtures are LLM-generated with a
  **native-speaker spot-check pending** — a standing caveat on those
  locales' go/no-go verdicts until cleared.
- Side effect of the originality rule: the committed set is
  out-of-distribution for the candidate model by construction, which is the
  honest go/no-go signal the RFC's in-distribution caveat asks for.

## Known C0 locale gaps (c0-only run, recorded findings)

The C0 regexes are de/en-centric by design. The 6-locale c0-only run
reports these honestly rather than the fixtures being softened around them:

| Locale | Structured recall (c0) | Main gaps |
|---|---|---|
| de | 100% — PASS | — |
| en | 100% — PASS | — |
| it | ~99% — PASS | street-only addresses without a postal code (dot-grouped amounts and 5-digit postal codes coincide with the de patterns) |
| es | ~94% — FAIL | amounts without thousands separator ("899 €"), local phone formats without leading 0/+ ("612 334 455"), street-only addresses |
| nl | ~85% — FAIL | Dutch addresses (`straat`/`gracht`/`plein` suffixes and 4-digit `1016 AZ` postcodes match nothing), dashed dates ("24-12-1987") |
| fr | ~75% — FAIL | space-grouped amounts ("2 400 €"), written-out dates ("17 septembre 1984"), street-only addresses |

Where fr/es/it/nl address rows *do* count as masked under c0, it is mostly
the partial-masking effect described above (the 5-digit postal-code
fragment matches the de pattern and breaks the full value) — not genuine
street-address detection. These gaps are part of what the per-locale flag
policy protects against: a locale whose structured identifiers C0 cannot
carry does not flip on, C1 or not.

## Honest-measurement caveat (from the RFC)

Transformer PII models are trained on ai4privacy-style data; evaluating
them on in-distribution items inflates numbers. The go/no-go signal is the
hand-built out-of-distribution slice in these fixtures (reported separately
as "hand-slice" person recall), not a public-benchmark score.
