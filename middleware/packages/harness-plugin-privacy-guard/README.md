# Privacy Guard (`@omadia/plugin-privacy-guard`)

Privacy Shield **v4 — Data-Plane Boundary**. Publishes the
`privacy.redact@1` capability the orchestrator's tool-dispatch hook calls on
every tool result:

1. Raw tool results are **interned server-side** into a per-turn Dataset
   Store — real rows never reach the LLM wire.
2. The LLM receives only a shape-classified, identity-free **Digest**.
3. Identity-/order-critical work (filter, sort, join, aggregate) runs through
   a server-side **Verb API** (`v4_*` tools) against the real rows.
4. The final answer is **materialized from ground truth** via
   `v4_render_answer`; real values are resolved behind the boundary.
5. Each turn emits a PII-free **PrivacyReceipt** that the channel renderers
   (Teams Adaptive Card, web inline disclosure) surface to the user.

The boundary itself has no configuration: it is generic over JSON shape and
value statistics — no per-tenant policy, allowlist, or detector tuning. The
only permission is `llm` (see below).

## Free-text user-prompt masking (#361, default off)

The one setup field is `mask_user_prompt` (enum `off`/`on`, **default
`off`** — flag-off is byte-identical to pre-#361 behavior). When on, PII
spans detected in the user's own message (and the ingested attachment tail)
are substituted with realistic, type-shaped pseudonyms before the prompt
crosses the LLM wire; the surrogate↔real map is held server-side per turn
and inverted over the final answer. Wire-substitution with answer-side
restore — NOT server-side interning (the prompt must cross the wire) and
NOT an on-wire token map (deleted for cause by #119/#126/#153).

- **Detection:** pluggable `PromptPiiDetector` seam. Shipped: the
  deterministic **C0 regex baseline** (email, IBAN, phone, German
  postal+street, currency/salary amounts, DOB dates). Names/free-form
  entities need the **C1 transformer** slot (Piiranha/GLiNER), which ships
  as an inert stub until the committed validation harness
  (`src/validation/`, runnable via `npx tsx …/promptDetectorEval.ts`)
  passes its documented recall gates for a locale.
- **Failure-closed:** the C1 detector throwing degrades to C0 with a
  `promptMaskDegraded` audit line; a baseline failure or a residual real
  span surviving substitution **blocks the turn** — there is no
  pass-through-unmasked path.
- **Transparency:** masked spans surface (type + detector only, PII-free)
  as `maskedPromptSpans` on the turn's `PrivacyReceipt`.

## Canonical implementation path (resolved in #431)

`src/service.ts` (**the** v4 service factory, `createPrivacyGuardService`)
plus the `src/v4/` engine modules (datasetStore, shapeClassifier, digest,
verbs, materializer, pseudonym, onTheWire, piiClassifier) are the **single
canonical implementation**. There is no parallel legacy path: the pre-v4
on-wire token map (`«TYPE_N»`), its response restore pass, and the Presidio
NER sidecar were removed by #119/#126/#153/#242 — the documented failure
modes live in `plugin-api/src/piiAnnotation.ts` as the historical record.
The `v4/` directory name is kept deliberately: it is the engine namespace
that tests (`middleware/test/privacyV4*.test.ts`) and the #361 prompt-mask
design reference; flattening it would churn PII-handling paths for no
behavioral gain.

## PluginContext surface — v1.0 readiness audit (#431)

| Surface | Decision | Rationale |
|---|---|---|
| `ctx.llm` | **adopted** (Slice 2) | Schema-level PII classification (field names + types only, never values); absent LLM ⇒ byte-identical no-classifier behavior. |
| `ctx.jobs` | skip | All state is turn-scoped and dropped in `finalizeTurn`; nothing outlives a turn. |
| `ctx.status` | skip | No external connection or degraded mode to report. |
| `ctx.mcp` | skip | MCP tool results reach the boundary via the orchestrator choke point (`internToolResultV4`) like every other tool result; the guard must not source data itself. |

Versioning: manifest and `package.json` are aligned (the `package.json
0.1.0` vs manifest `0.2.0` mismatch was fixed in #431; both bumped to
`0.3.0` with #361). Stays independently versioned; does not bump in
lockstep with core.

## Tests

Central suites: `middleware/test/privacyV4*.test.ts` (acceptance, dataset
store, digest, materializer, on-the-wire leak scorer, pseudonym projection,
PII classifier, shape classifier, tool defs, verbs, service) plus
`privacyInternPolicy.test.ts` and `privacyV4Bypass.test.ts` (Slice 2.5
per-plugin bypass).
