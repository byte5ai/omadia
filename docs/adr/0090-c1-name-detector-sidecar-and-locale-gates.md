# 0090 — Names are detected by an optional, pinned sidecar; prompt masking is gated per locale

## Status

Accepted

- **Date:** 2026-11-25
- **Deciders:** omadia maintainers (recorded retroactively from the code on main);
  implemented in #361 / #481, CI floor in #760, posture in #1562.
- **Supersedes:** —

## Context and Problem Statement

Free-text masking ([ADR-0095](0095-prompt-masking-wire-substitution-fail-closed.md)) needs a detector. A
regex baseline (C0) finds structured identifiers but no person names and no free-form
addresses. A transformer finds them, at the price of a model, latency and a process that
handles raw customer text. The earlier Presidio sidecar was removed for its false-positive
cascades (#242).

Where does name detection run, which model, and when may an operator rely on it? This
record is retroactive.

## Decision Drivers

- The default stack must run without a model sidecar.
- A detector that sees raw prompts must not be reachable from outside or log text.
- Licence must allow commercial self-hosting.
- Detector quality differs per language; enabling masking must be a measured decision.

## Considered Options

- **A — Two tiers: deterministic C0 in-process, an optional C1 HTTP sidecar (GLiNER
  `gliner_multi_pii-v1`), with pre-committed validation gates per locale.**
- **B — A transformer in-process in the middleware.**
- **C — C0 only; no name detection.**
- **D — A hosted PII-detection API.**

## Decision Outcome

Chosen option: **A**.

- **Seam.** Detectors implement `PromptPiiDetector`. C0 (`createBaselineDetector`) always
  runs. C1 is wired only when a URL is set: the guard's `c1_detector_url` setting first,
  the env `PRIVACY_C1_DETECTOR_URL` as fallback (`src/plugin.ts`).
- **Sidecar.** `middleware/sidecars/pii-detector` is an HTTP shim around GLiNER
  (Apache-2.0), quantised ONNX on CPU by default. The model is baked into the image at
  build time, pinned to an exact revision sha, and the container runs with
  `HF_HUB_OFFLINE=1`. Labels are fixed to `person,address`; open-label mode is not exposed.
  The compose overlay (`docker-compose.pii-detector.yaml`) publishes no ports. The service
  is stateless and logs lengths, counts and durations, never text.
- **Contract.** `POST /detect` answers scored spans or a non-200; never a 200 with a
  half-result. Offsets are Unicode code points; the client converts them and asserts its
  slice equals the returned `text`, treating a mismatch as a detector failure.
- **Scheduling.** Inference is single-flight. `X-PII-Priority: interactive|background`
  picks the queue; a turn's masking is interactive, stored-text jobs are background, an
  absent header means background, and a background request older than `BACKGROUND_AGING_S`
  (default 5 s) is served next.
- **Failure.** Sidecar down or failing means the audited degrade to C0
  (`promptMaskDegraded`, `toolErrorRedactDegraded`). The admin privacy posture reports
  `name_detector` as unconfigured, active or unreachable (#1562).
- **Locale gates.** `mask_user_prompt` may be enabled for a locale only after a green run
  of the committed harness (`src/validation/`): structured-identifier recall ≥ 0.97,
  person recall ≥ 0.90 on `c0+c1`, precision proxy ≥ 0.85, p95 added latency ≤ 400 ms.
  CI runs the deterministic C0 set on every PR against per-locale floors in
  `ci-baseline.json` (#760).

### Consequences

- 🟢 **Good:** No customer text leaves the operator's network for detection.
- 🟢 **Good:** The default install has no Python or model dependency.
- 🔴 **Bad:** Without the sidecar no names are masked in free text, replayed answers,
  tool errors or verifier evidence; only C0 shapes and the deny-list are.
- 🔴 **Bad:** The sidecar is a second place that handles raw customer data, and it adds
  seconds of CPU inference per request.
- 🔴 **Bad (accepted):** The NL BSN (nine bare digits) is deliberately unpatterned in C0;
  the fine-tune's model card does not list `nl`.
- ⚪ **Neutral:** A model bump re-runs the six-locale harness before a locale keeps the flag.

## Pros and Cons of the Options

### A — C0 in-process, optional C1 sidecar

- 🟢 Opt-in cost; clear failure boundary over HTTP.
- 🔴 Extra service to deploy, size and monitor.

### B — Transformer in-process

- 🟢 No network hop.
- 🔴 Python model runtime inside a Node middleware; blocks the event loop or needs workers.

### C — C0 only

- 🟢 Deterministic, fast.
- 🔴 Names, the most common personal datum, stay unmasked.

### D — Hosted API

- 🟢 No operations.
- 🔴 Sends the raw text to a third party, which is what masking is meant to prevent.

## More Information

- The sidecar README records that Piiranha-v1 was rejected for its CC-BY-NC-ND licence.
- Code: `middleware/sidecars/pii-detector/` (`server.py`, `Dockerfile`, `README.md`),
  `docker-compose.pii-detector.yaml`,
  `middleware/packages/harness-plugin-privacy-guard/src/c1Detector.ts`,
  `c1SegmentCache.ts`, `src/validation/` (`README.md`, `RESULTS.md`, `ci-baseline.json`).
- Tests: `middleware/sidecars/pii-detector/test_server.py`,
  `middleware/test/privacyPromptC1Detector.test.ts`, `privacyC1SegmentCache.test.ts`.
