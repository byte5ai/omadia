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

There are no setup fields: the boundary is generic over JSON shape and value
statistics — no per-tenant policy, allowlist, or detector configuration.
The only permission is `llm` (see below).

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

Versioning: manifest and `package.json` are aligned at `0.2.0` (the
`package.json 0.1.0` mismatch was fixed in #431). Stays independently
versioned; does not bump in lockstep with core.

## Tests

Central suites: `middleware/test/privacyV4*.test.ts` (acceptance, dataset
store, digest, materializer, on-the-wire leak scorer, pseudonym projection,
PII classifier, shape classifier, tool defs, verbs, service) plus
`privacyInternPolicy.test.ts` and `privacyV4Bypass.test.ts` (Slice 2.5
per-plugin bypass).
