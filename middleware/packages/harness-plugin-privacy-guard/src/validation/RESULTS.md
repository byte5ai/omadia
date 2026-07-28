# Recorded prompt-PII validation run (#361)

Full `c0` / `c0+c1` / `c1-solo` × 6-locale run of the harness in this
directory (`promptDetectorEval.ts --markdown`, verbatim output below).
Gates were committed in `README.md` before this run; nothing was tuned
afterwards. These are the tables to post to issue #361 — per the flag
policy, a locale's results must be on the issue before `mask_user_prompt`
flips on for it.

## Run environment

| | |
|---|---|
| Date | 2026-07-10 |
| Model | `onnx-community/gliner_multi_pii-v1` @ `2e0397a7e8a250d76c37122232b3cbde42c8d629` (pinned) |
| Backend | ONNX, `onnx/model_quantized.onnx` (sidecar default) |
| Runtime | `gliner` 0.2.27, `onnxruntime` 1.27.0, Python 3.13 — the pins from `middleware/sidecars/pii-detector/requirements.txt` |
| Labels / threshold | `person,address` / `0.5` (sidecar defaults) |
| Sidecar | `server.py` local, loopback `http://localhost:8812` |
| Host | Apple M4 Max, CPU inference |
| Code state | includes the dedup remainder fix (losing overlap spans keep their uncovered parts) — this run measures the shipped masking path |

**Latency caveat:** the p95 numbers below are loopback-to-a-local-sidecar on
developer hardware. The ≤ 400 ms gate must be re-confirmed on the target
deployment (compose network, production CPU) before a latency-sensitive
install relies on it; detection *quality* numbers are hardware-independent.

## Verdict summary

| Locale | `c0` (structured gates) | `c0+c1` (ALL gates) | Blocking gap |
|---|---|---|---|
| de | PASS | **PASS** | — |
| en | PASS | **PASS** | — |
| it | PASS | **PASS** | — |
| es | FAIL (structured 94.4%) | FAIL (structured 95.4%) | C0: separator-less amounts ("899 €"), local phone formats |
| fr | FAIL (structured 75.0%) | FAIL (structured 75.9%) | C0: space-grouped amounts ("2 400 €"), written-out dates |
| nl | FAIL (structured 85.3%) | FAIL (structured 96.3%) | C0: dashed dates ("24-12-1987"); addresses are carried by C1 |

- **de / en / it pass ALL gates on `c0+c1`** — person recall 100% incl. the
  hand-built OOD slice, precision proxy ≥ 87.5%, p95 ≤ 85.2 ms. These
  locales are eligible for `mask_user_prompt` once these tables are posted
  to #361.
- **es / fr / nl stay off** — every failure is a *C0 structured-identifier*
  locale gap (recorded per locale below), not a C1 quality problem. Closing
  them means locale-aware C0 patterns (amounts, dates, phones), a recorded
  fast-follow — C1 already carries `person` at 100% and lifts `address` to
  100% in all six locales.
- **nl person recall is 100%** even though the GLiNER fine-tune's language
  card does not list Dutch — the gate policy absorbed the risk, and the
  measurement (not the model card) decides. The structured `date` gap keeps
  nl off regardless.
- `c1-solo` confirms the division of labor: GLiNER alone collapses on
  structured identifiers (20–25% structured recall) — C0 stays load-bearing;
  C1 is additive, never a replacement.
- fr/es/it/nl fixtures still carry the standing **native-speaker spot-check
  pending** caveat from `README.md`.

## Harness output (verbatim)

Detector sets: `c0`, `c0+c1`, `c1-solo`.


## de

### Set `c0`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 20/20 | 100.0% | 4/4 (100.0%) | structured |
| amount | 26/26 | 100.0% | 2/2 (100.0%) | structured |
| date | 19/19 | 100.0% | 3/3 (100.0%) | structured |
| email | 22/22 | 100.0% | 2/2 (100.0%) | structured |
| iban | 14/14 | 100.0% | 2/2 (100.0%) | structured |
| idnum | 0/1 | 0.0% | 0/1 (0.0%) | informational — ungated in v1 |
| person | 0/64 | 0.0% | 0/16 (0.0%) | c1-scope |
| phone | 14/14 | 100.0% | 2/2 (100.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 100.0% | ≥ 97% | PASS |
| person recall | 0.0% | ≥ 90% | not gated |
| precision proxy (negatives clean) | 32/32 (100.0%) | ≥ 85% | PASS |
| p95 added latency | 0.0 ms | ≤ 400 ms | PASS |

**Verdict** (structured-identifier gates only): **PASS**

### Set `c0+c1`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 20/20 | 100.0% | 4/4 (100.0%) | structured |
| amount | 26/26 | 100.0% | 2/2 (100.0%) | structured |
| date | 19/19 | 100.0% | 3/3 (100.0%) | structured |
| email | 22/22 | 100.0% | 2/2 (100.0%) | structured |
| iban | 14/14 | 100.0% | 2/2 (100.0%) | structured |
| idnum | 0/1 | 0.0% | 0/1 (0.0%) | informational — ungated in v1 |
| person | 64/64 | 100.0% | 16/16 (100.0%) | c1-scope |
| phone | 14/14 | 100.0% | 2/2 (100.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 100.0% | ≥ 97% | PASS |
| person recall | 100.0% | ≥ 90% | PASS |
| precision proxy (negatives clean) | 28/32 (87.5%) | ≥ 85% | PASS |
| p95 added latency | 19.5 ms | ≤ 400 ms | PASS |

**Verdict** (all gates incl. person recall): **PASS**

### Set `c1-solo`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 20/20 | 100.0% | 4/4 (100.0%) | structured |
| amount | 0/26 | 0.0% | 0/2 (0.0%) | structured |
| date | 0/19 | 0.0% | 0/3 (0.0%) | structured |
| email | 4/22 | 18.2% | 1/2 (50.0%) | structured |
| iban | 5/14 | 35.7% | 0/2 (0.0%) | structured |
| idnum | 0/1 | 0.0% | 0/1 (0.0%) | informational — ungated in v1 |
| person | 64/64 | 100.0% | 16/16 (100.0%) | c1-scope |
| phone | 0/14 | 0.0% | 0/2 (0.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 25.2% | ≥ 97% | not gated |
| person recall | 100.0% | ≥ 90% | not gated |
| precision proxy (negatives clean) | 28/32 (87.5%) | ≥ 85% | not gated |
| p95 added latency | 59.9 ms | ≤ 400 ms | not gated |

**Verdict** (ablation — reported, never gated): n/a

## en

### Set `c0`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 19/19 | 100.0% | 3/3 (100.0%) | structured |
| amount | 26/26 | 100.0% | 2/2 (100.0%) | structured |
| date | 18/18 | 100.0% | 2/2 (100.0%) | structured |
| email | 22/22 | 100.0% | 2/2 (100.0%) | structured |
| iban | 13/13 | 100.0% | 1/1 (100.0%) | structured |
| idnum | 0/1 | 0.0% | 0/1 (0.0%) | informational — ungated in v1 |
| person | 0/64 | 0.0% | 0/16 (0.0%) | c1-scope |
| phone | 14/14 | 100.0% | 2/2 (100.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 100.0% | ≥ 97% | PASS |
| person recall | 0.0% | ≥ 90% | not gated |
| precision proxy (negatives clean) | 32/32 (100.0%) | ≥ 85% | PASS |
| p95 added latency | 0.0 ms | ≤ 400 ms | PASS |

**Verdict** (structured-identifier gates only): **PASS**

### Set `c0+c1`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 19/19 | 100.0% | 3/3 (100.0%) | structured |
| amount | 26/26 | 100.0% | 2/2 (100.0%) | structured |
| date | 18/18 | 100.0% | 2/2 (100.0%) | structured |
| email | 22/22 | 100.0% | 2/2 (100.0%) | structured |
| iban | 13/13 | 100.0% | 1/1 (100.0%) | structured |
| idnum | 0/1 | 0.0% | 0/1 (0.0%) | informational — ungated in v1 |
| person | 64/64 | 100.0% | 16/16 (100.0%) | c1-scope |
| phone | 14/14 | 100.0% | 2/2 (100.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 100.0% | ≥ 97% | PASS |
| person recall | 100.0% | ≥ 90% | PASS |
| precision proxy (negatives clean) | 30/32 (93.8%) | ≥ 85% | PASS |
| p95 added latency | 18.6 ms | ≤ 400 ms | PASS |

**Verdict** (all gates incl. person recall): **PASS**

### Set `c1-solo`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 19/19 | 100.0% | 3/3 (100.0%) | structured |
| amount | 0/26 | 0.0% | 0/2 (0.0%) | structured |
| date | 0/18 | 0.0% | 0/2 (0.0%) | structured |
| email | 6/22 | 27.3% | 1/2 (50.0%) | structured |
| iban | 0/13 | 0.0% | 0/1 (0.0%) | structured |
| idnum | 0/1 | 0.0% | 0/1 (0.0%) | informational — ungated in v1 |
| person | 64/64 | 100.0% | 16/16 (100.0%) | c1-scope |
| phone | 2/14 | 14.3% | 0/2 (0.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 24.1% | ≥ 97% | not gated |
| person recall | 100.0% | ≥ 90% | not gated |
| precision proxy (negatives clean) | 30/32 (93.8%) | ≥ 85% | not gated |
| p95 added latency | 93.5 ms | ≤ 400 ms | not gated |

**Verdict** (ablation — reported, never gated): n/a

## es

### Set `c0`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 17/18 | 94.4% | 1/2 (50.0%) | structured |
| amount | 21/25 | 84.0% | 1/1 (100.0%) | structured |
| date | 17/17 | 100.0% | 1/1 (100.0%) | structured |
| email | 22/22 | 100.0% | 2/2 (100.0%) | structured |
| iban | 13/13 | 100.0% | 1/1 (100.0%) | structured |
| idnum | 0/2 | 0.0% | 0/2 (0.0%) | informational — ungated in v1 |
| person | 0/66 | 0.0% | 0/18 (0.0%) | c1-scope |
| phone | 12/13 | 92.3% | 0/1 (0.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 94.4% | ≥ 97% | FAIL |
| person recall | 0.0% | ≥ 90% | not gated |
| precision proxy (negatives clean) | 32/32 (100.0%) | ≥ 85% | PASS |
| p95 added latency | 0.0 ms | ≤ 400 ms | PASS |

**Verdict** (structured-identifier gates only): **FAIL**

### Set `c0+c1`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 18/18 | 100.0% | 2/2 (100.0%) | structured |
| amount | 21/25 | 84.0% | 1/1 (100.0%) | structured |
| date | 17/17 | 100.0% | 1/1 (100.0%) | structured |
| email | 22/22 | 100.0% | 2/2 (100.0%) | structured |
| iban | 13/13 | 100.0% | 1/1 (100.0%) | structured |
| idnum | 0/2 | 0.0% | 0/2 (0.0%) | informational — ungated in v1 |
| person | 66/66 | 100.0% | 18/18 (100.0%) | c1-scope |
| phone | 12/13 | 92.3% | 0/1 (0.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 95.4% | ≥ 97% | FAIL |
| person recall | 100.0% | ≥ 90% | PASS |
| precision proxy (negatives clean) | 31/32 (96.9%) | ≥ 85% | PASS |
| p95 added latency | 49.9 ms | ≤ 400 ms | PASS |

**Verdict** (all gates incl. person recall): **FAIL**

### Set `c1-solo`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 17/18 | 94.4% | 1/2 (50.0%) | structured |
| amount | 0/25 | 0.0% | 0/1 (0.0%) | structured |
| date | 0/17 | 0.0% | 0/1 (0.0%) | structured |
| email | 6/22 | 27.3% | 0/2 (0.0%) | structured |
| iban | 0/13 | 0.0% | 0/1 (0.0%) | structured |
| idnum | 0/2 | 0.0% | 0/2 (0.0%) | informational — ungated in v1 |
| person | 66/66 | 100.0% | 18/18 (100.0%) | c1-scope |
| phone | 0/13 | 0.0% | 0/1 (0.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 21.3% | ≥ 97% | not gated |
| person recall | 100.0% | ≥ 90% | not gated |
| precision proxy (negatives clean) | 31/32 (96.9%) | ≥ 85% | not gated |
| p95 added latency | 61.0 ms | ≤ 400 ms | not gated |

**Verdict** (ablation — reported, never gated): n/a

## fr

### Set `c0`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 17/18 | 94.4% | 1/2 (50.0%) | structured |
| amount | 0/25 | 0.0% | 0/1 (0.0%) | structured |
| date | 17/18 | 94.4% | 1/2 (50.0%) | structured |
| email | 21/21 | 100.0% | 1/1 (100.0%) | structured |
| iban | 13/13 | 100.0% | 1/1 (100.0%) | structured |
| idnum | 0/1 | 0.0% | 0/1 (0.0%) | informational — ungated in v1 |
| person | 0/66 | 0.0% | 0/18 (0.0%) | c1-scope |
| phone | 13/13 | 100.0% | 1/1 (100.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 75.0% | ≥ 97% | FAIL |
| person recall | 0.0% | ≥ 90% | not gated |
| precision proxy (negatives clean) | 32/32 (100.0%) | ≥ 85% | PASS |
| p95 added latency | 0.0 ms | ≤ 400 ms | PASS |

**Verdict** (structured-identifier gates only): **FAIL**

### Set `c0+c1`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 18/18 | 100.0% | 2/2 (100.0%) | structured |
| amount | 0/25 | 0.0% | 0/1 (0.0%) | structured |
| date | 17/18 | 94.4% | 1/2 (50.0%) | structured |
| email | 21/21 | 100.0% | 1/1 (100.0%) | structured |
| iban | 13/13 | 100.0% | 1/1 (100.0%) | structured |
| idnum | 0/1 | 0.0% | 0/1 (0.0%) | informational — ungated in v1 |
| person | 66/66 | 100.0% | 18/18 (100.0%) | c1-scope |
| phone | 13/13 | 100.0% | 1/1 (100.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 75.9% | ≥ 97% | FAIL |
| person recall | 100.0% | ≥ 90% | PASS |
| precision proxy (negatives clean) | 30/32 (93.8%) | ≥ 85% | PASS |
| p95 added latency | 115.6 ms | ≤ 400 ms | PASS |

**Verdict** (all gates incl. person recall): **FAIL**

### Set `c1-solo`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 18/18 | 100.0% | 2/2 (100.0%) | structured |
| amount | 0/25 | 0.0% | 0/1 (0.0%) | structured |
| date | 0/18 | 0.0% | 0/2 (0.0%) | structured |
| email | 4/21 | 19.0% | 0/1 (0.0%) | structured |
| iban | 0/13 | 0.0% | 0/1 (0.0%) | structured |
| idnum | 0/1 | 0.0% | 0/1 (0.0%) | informational — ungated in v1 |
| person | 66/66 | 100.0% | 18/18 (100.0%) | c1-scope |
| phone | 0/13 | 0.0% | 0/1 (0.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 20.4% | ≥ 97% | not gated |
| person recall | 100.0% | ≥ 90% | not gated |
| precision proxy (negatives clean) | 30/32 (93.8%) | ≥ 85% | not gated |
| p95 added latency | 38.0 ms | ≤ 400 ms | not gated |

**Verdict** (ablation — reported, never gated): n/a

## it

### Set `c0`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 18/19 | 94.7% | 2/3 (66.7%) | structured |
| amount | 25/25 | 100.0% | 1/1 (100.0%) | structured |
| date | 17/17 | 100.0% | 1/1 (100.0%) | structured |
| email | 21/21 | 100.0% | 1/1 (100.0%) | structured |
| iban | 13/13 | 100.0% | 1/1 (100.0%) | structured |
| idnum | 0/2 | 0.0% | 0/2 (0.0%) | informational — ungated in v1 |
| person | 0/66 | 0.0% | 0/18 (0.0%) | c1-scope |
| phone | 13/13 | 100.0% | 1/1 (100.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 99.1% | ≥ 97% | PASS |
| person recall | 0.0% | ≥ 90% | not gated |
| precision proxy (negatives clean) | 32/32 (100.0%) | ≥ 85% | PASS |
| p95 added latency | 0.0 ms | ≤ 400 ms | PASS |

**Verdict** (structured-identifier gates only): **PASS**

### Set `c0+c1`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 19/19 | 100.0% | 3/3 (100.0%) | structured |
| amount | 25/25 | 100.0% | 1/1 (100.0%) | structured |
| date | 17/17 | 100.0% | 1/1 (100.0%) | structured |
| email | 21/21 | 100.0% | 1/1 (100.0%) | structured |
| iban | 13/13 | 100.0% | 1/1 (100.0%) | structured |
| idnum | 0/2 | 0.0% | 0/2 (0.0%) | informational — ungated in v1 |
| person | 66/66 | 100.0% | 18/18 (100.0%) | c1-scope |
| phone | 13/13 | 100.0% | 1/1 (100.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 100.0% | ≥ 97% | PASS |
| person recall | 100.0% | ≥ 90% | PASS |
| precision proxy (negatives clean) | 30/32 (93.8%) | ≥ 85% | PASS |
| p95 added latency | 85.2 ms | ≤ 400 ms | PASS |

**Verdict** (all gates incl. person recall): **PASS**

### Set `c1-solo`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 18/19 | 94.7% | 2/3 (66.7%) | structured |
| amount | 0/25 | 0.0% | 0/1 (0.0%) | structured |
| date | 0/17 | 0.0% | 0/1 (0.0%) | structured |
| email | 4/21 | 19.0% | 0/1 (0.0%) | structured |
| iban | 0/13 | 0.0% | 0/1 (0.0%) | structured |
| idnum | 0/2 | 0.0% | 0/2 (0.0%) | informational — ungated in v1 |
| person | 66/66 | 100.0% | 18/18 (100.0%) | c1-scope |
| phone | 0/13 | 0.0% | 0/1 (0.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 20.4% | ≥ 97% | not gated |
| person recall | 100.0% | ≥ 90% | not gated |
| precision proxy (negatives clean) | 30/32 (93.8%) | ≥ 85% | not gated |
| p95 added latency | 38.6 ms | ≤ 400 ms | not gated |

**Verdict** (ablation — reported, never gated): n/a

## nl

### Set `c0`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 7/19 | 36.8% | 1/3 (33.3%) | structured |
| amount | 25/25 | 100.0% | 1/1 (100.0%) | structured |
| date | 14/18 | 77.8% | 2/2 (100.0%) | structured |
| email | 21/21 | 100.0% | 1/1 (100.0%) | structured |
| iban | 13/13 | 100.0% | 1/1 (100.0%) | structured |
| idnum | 0/1 | 0.0% | 0/1 (0.0%) | informational — ungated in v1 |
| person | 0/66 | 0.0% | 0/18 (0.0%) | c1-scope |
| phone | 13/13 | 100.0% | 1/1 (100.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 85.3% | ≥ 97% | FAIL |
| person recall | 0.0% | ≥ 90% | not gated |
| precision proxy (negatives clean) | 32/32 (100.0%) | ≥ 85% | PASS |
| p95 added latency | 0.0 ms | ≤ 400 ms | PASS |

**Verdict** (structured-identifier gates only): **FAIL**

### Set `c0+c1`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 19/19 | 100.0% | 3/3 (100.0%) | structured |
| amount | 25/25 | 100.0% | 1/1 (100.0%) | structured |
| date | 14/18 | 77.8% | 2/2 (100.0%) | structured |
| email | 21/21 | 100.0% | 1/1 (100.0%) | structured |
| iban | 13/13 | 100.0% | 1/1 (100.0%) | structured |
| idnum | 0/1 | 0.0% | 0/1 (0.0%) | informational — ungated in v1 |
| person | 66/66 | 100.0% | 18/18 (100.0%) | c1-scope |
| phone | 13/13 | 100.0% | 1/1 (100.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 96.3% | ≥ 97% | FAIL |
| person recall | 100.0% | ≥ 90% | PASS |
| precision proxy (negatives clean) | 28/32 (87.5%) | ≥ 85% | PASS |
| p95 added latency | 77.5 ms | ≤ 400 ms | PASS |

**Verdict** (all gates incl. person recall): **FAIL**

### Set `c1-solo`

| Type | Masked/Total | Recall | Hand slice | Scope |
|---|---|---|---|---|
| address | 18/19 | 94.7% | 2/3 (66.7%) | structured |
| amount | 0/25 | 0.0% | 0/1 (0.0%) | structured |
| date | 0/18 | 0.0% | 0/2 (0.0%) | structured |
| email | 5/21 | 23.8% | 0/1 (0.0%) | structured |
| iban | 0/13 | 0.0% | 0/1 (0.0%) | structured |
| idnum | 0/1 | 0.0% | 0/1 (0.0%) | informational — ungated in v1 |
| person | 66/66 | 100.0% | 18/18 (100.0%) | c1-scope |
| phone | 0/13 | 0.0% | 0/1 (0.0%) | structured |

| Gate | Value | Threshold | Status |
|---|---|---|---|
| structured recall | 21.1% | ≥ 97% | not gated |
| person recall | 100.0% | ≥ 90% | not gated |
| precision proxy (negatives clean) | 28/32 (87.5%) | ≥ 85% | not gated |
| p95 added latency | 42.3 ms | ≤ 400 ms | not gated |

**Verdict** (ablation — reported, never gated): n/a
