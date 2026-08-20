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

`idnum` spans (locale ID numbers) are **gated since #760**: C0 carries
patterns for DE Steuer-ID (grouped + bare 11 digits) and USt-IdNr., ES
NIE/DNI, IT Codice Fiscale, UK NINO, and FR n° de sécurité sociale. The one
deliberately unpatterned form is the **NL BSN** — 9 bare digits with no
distinguishing shape; a global 9-digit pattern would mask half the numeric
universe. It stays a recorded miss inside nl's aggregate (see
`ci-baseline.json`, whose nl floor reflects it) rather than an ungated type.

**CI gate (#760):** `promptDetectorEval.ts --check` runs the deterministic
C0-only set in CI on every PR and compares each locale against the committed
per-locale floors in `ci-baseline.json` — a detection regression is a red
check, and an empty evaluation fails rather than reporting green.

**Flag policy (unchanged):** `mask_user_prompt` may be enabled only for
locales whose fixture set passes ALL gates with the shipped detector set,
and the harness results for that locale must be posted to issue #361 BEFORE
the flag flips on. A deployment that needs name masking must run the
`c0+c1` set against the GLiNER sidecar and pass the person gate.

**Recorded run:** the full `c0` / `c0+c1` / `c1-solo` × 6-locale run
(2026-07-10, pinned model + sidecar defaults) is committed in
[`RESULTS.md`](./RESULTS.md) — de/en/it pass ALL gates on `c0+c1`;
es/fr/nl fail on C0 structured locale gaps (details below and there).

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
- `fr` / `es` / `it` / `nl` fixtures are LLM-generated. The
  **native-speaker spot-check** is **cleared for the #482 miss classes** —
  the amount/date/phone formats those patterns target (`899 €`, `2 400 €`,
  `17 septembre 1984`, `30-06-2027`, `€ 899`, `612 334 455`) are
  locale-authentic. A full-prose native review of the synthetic backbone
  remains advisory.
- Side effect of the originality rule: the committed set is
  out-of-distribution for the candidate model by construction, which is the
  honest go/no-go signal the RFC's in-distribution caveat asks for.

## C0 locale coverage (see RESULTS.md)

The C0 regexes started de/en-centric; #482 (Run 2, 2026-08-05) added the
recorded es/fr/nl amount/date/phone miss classes. Current C0 structured
recall, with the derived `c0+c1` (Run-2 C0 ∪ the trusted Run-1 C1 — see the
derived-`c0+c1` note in RESULTS.md):

| Locale | Structured recall (c0 / c0+c1) | Remaining C0 gaps |
|---|---|---|
| de | 100% / 100% — PASS | — |
| en | 100% / 100% — PASS | — |
| it | 99.1% / 100% — PASS | street-only addresses without a postal code (carried by C1) |
| es | 99.1% / 100% — PASS | street-only addresses without a postal code (carried by C1) |
| fr | 99.1% / 100% — PASS | street-only addresses without a postal code (carried by C1) |
| nl | 89.0% / 100% — PASS (c0+c1) | Dutch addresses (`straat`/`gracht`/`plein` suffixes, 4-digit `1016 AZ` postcodes) match no C0 pattern but are fully carried by C1 |

The #482 patterns closed: separator-less amounts (`899 €`), space-grouped
amounts (`2 400 €`), the Spanish 3-3-3 local phone (`612 334 455`), dashed
dates (`30-06-2027`), and written-out dates (`17 septembre 1984`). nl's
`c0`-only number stays below the structured gate because Dutch street
addresses are C1 territory by design — every nl amount/date/phone is now C0.

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
