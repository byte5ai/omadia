# Golden-set regression eval (#129)

A behaviour-level regression gate for the verifier's stochastic LLM stages. CI's
`middleware` job proves the plumbing (lint / typecheck / unit tests); this proves
that the **pinned model still classifies known inputs into the same verifier
verdict class**. A model bump or a prompt edit that silently regresses agent
behaviour (LLM weakness #13, version drift) fails here instead of shipping.

## What it asserts

The assertion target is **not** the raw model string — it is the verifier
verdict *class*, which is stable despite generation stochasticity:

- `approved`
- `approved_with_disclaimer` (the borderline path, `isBorderlineVerdict`)
- `blocked` — including the two synthetic claim paths:
  - `tool_postcondition` (#130)
  - `citation_missing` (#131)

Each corpus entry is a frozen `(userMessage, answer, trace fields, fixture
evidence, expected status)` tuple run through a **real** `VerifierPipeline` —
real `ClaimExtractor` + real `EvidenceJudge` on the Anthropic adapter — with
**fixture-backed** deterministic sources (no Postgres, no Odoo, no orchestrator).
That keeps the job hermetic and cheap while still exercising the two stochastic
stages that actually drift.

## Scope (v1) and what is v2

- **v1 (this):** verifier-stage eval. The stochastic stages run on
  `VERIFIER_MODEL` (default `claude-haiku-4-5-20251001`), so that is the model
  pinned here — asserting against the orchestrator model would be dishonest,
  those stages never call it. Hard-claim verdicts resolve to `unverified` (no
  Odoo/graph reader is wired), so no fixture relies on deterministic hard-claim
  verification. Consequence: the judge's `verified → approved` path is **not**
  exercised in v1 (a triggering answer's hard claim is always `unverified` →
  disclaimer), so v1's `approved` fixtures cover only the trigger-skip path.
- **v2 (not built) — tracked in [#639](https://github.com/byte5ai/omadia/issues/639):**
  a deterministic Odoo/graph fixture reader (enables a genuine judge/deterministic
  `verified → approved` entry and a deterministic-contradiction `blocked` entry),
  and a full-turn eval (`input → live orchestrator answer → verdict`) once a
  headless turn runner exists.

## Running locally

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run eval:golden            # runs the whole corpus, exits non-zero on regression
GOLDEN_MODEL=claude-opus-4-8 npm run eval:golden   # pin a different model
```

Without `ANTHROPIC_API_KEY` the runner **skips with a notice and exits 0** — the
same behaviour CI relies on so an unconfigured repo/fork stays green. `npm test`
never invokes this runner (it lives outside the `test/**/*.test.ts` glob); only
the key-free suites run there:

- `test/goldenRunner.test.ts` covers the **pure** harness (`goldenRunner.ts`:
  parsing, majority voting, flake-tolerant `runEntry`, summary). That module
  imports `@omadia/verifier` as `import type` only, so this suite needs no build.
- `test/goldenModel.test.ts` covers the **model** layer (`goldenModel.ts`: the
  real `VerifierPipeline` wiring) with a **stub** `LlmProvider`. The synthetic
  block paths (`tool_postcondition`, `citation_missing`) need no model, so this
  drives the real pipeline to a verdict — and asserts the trace fields are wired
  through — without a key. It does need the workspace `dist/` built.

## Type coverage

The middleware `lint`/`typecheck` scripts only cover `src/`, so `test/` is
normally unchecked. `npm run typecheck:golden` (chained into `npm run typecheck`,
i.e. run on every PR) type-checks `test/golden/**` + the two suites via
`test/golden/tsconfig.json`, so a drift in `@omadia/verifier`'s types fails a PR
instead of surfacing only at the key-gated eval on `main`.

## Flake policy

Verdict classes are stable but not immune to model jitter. An entry that matches
its expected class on the first sample costs **one** model call. An entry that
misses on the first sample is re-run up to **3 samples total** and decided by
majority. Worst-case cost is therefore `3 × corpus size`. Per-entry token cost is
printed in the run summary and the GitHub job summary.

## CI

`.github/workflows/golden-eval.yml` runs on push to `main`, manual
`workflow_dispatch`, and a weekly cron — **not** on every PR (cost vs. signal).
It requires the `ANTHROPIC_API_KEY` GitHub Actions secret; when the secret is
absent the job skips cleanly with a notice. Because the workflow never triggers
on `pull_request`, forks never attempt to run it.

## Adding a corpus entry (do this when you ship a new agent type or verdict path)

1. Pick the file under `corpus/` that matches the **expected verdict class**
   (`approve.jsonl`, `disclaimer.jsonl`, `blocked-citation.jsonl`,
   `blocked-tool-postcondition.jsonl`, `blocked-contradiction.jsonl`), or add a
   new `*.jsonl` file for a new class. Every `.jsonl` in `corpus/` is picked up
   automatically.
2. Append one JSON object per line with this shape:

   ```jsonc
   {
     "id": "unique_stable_id",          // required, unique across the corpus
     "note": "why this class is expected", // recommended
     "userMessage": "…",                 // required
     "answer": "…",                      // required — the answer under eval
     "trace": {                           // optional VerifierInput trace fields
       "agent": "accounting",
       "domainToolsCalled": ["query_odoo_accounting"],
       "knowledgeGraphToolsCalled": true,
       "toolPostconditionViolations": [
         { "toolName": "…", "callId": "…", "agentContext": "…", "issues": ["…"] }
       ]
     },
     "evidence": [                        // optional fixture evidence for the judge
       { "nodeId": "n1", "source": "graph", "content": "…", "title": "…" }
     ],
     "expected": { "status": "blocked" } // required: approved | approved_with_disclaimer | blocked
   }
   ```

3. **The trigger trap — read this before writing a judge fixture.** The
   pipeline runs the stochastic extractor + judge only when
   `shouldTriggerVerifier(answer)` fires, and it fires **only on a hard signal in
   the answer**: a currency amount (`1.234,56 €`), a date (`01.03.2023` /
   `2026-04-19`), an accounting ref (`INV/2026/0042`), a percentage, or a
   duration (`12 Urlaubstage`) — an aggregate keyword next to a 3+ digit number
   also counts. **A soft/qualitative claim alone never triggers.** If the answer
   has no signal, `verify()` skips extraction and returns `approved` *before the
   judge runs* — so a `disclaimer`/`contradiction` fixture whose answer lacks a
   signal silently resolves to `approved` and fails. Every judge-dependent
   fixture in this corpus therefore embeds a date or an amount in the answer;
   keep that up. (Verify with the trigger check pattern used in review, or just
   run `eval:golden`.)
4. **Author for robustness.** Prefer entries where the expected class does not
   hinge on brittle extractor jitter:
   - `blocked` via `trace.toolPostconditionViolations` or
     `trace.knowledgeGraphToolsCalled=true` + no `[ref:]` marker is synthetic and
     robust — the extractor need not cooperate, and no trigger signal is needed
     (these fire independent of `shouldTriggerVerifier`).
   - `approved_with_disclaimer` needs a soft (qualitative/name) claim in the
     answer **plus a trigger signal**, with `evidence: []` (or on-topic-but-silent
     evidence) → judge returns `unverified`. The signal's own hard claim also
     resolves `unverified` (no Odoo reader), consistent with the outcome.
   - `blocked` via judge contradiction needs a **trigger signal** plus evidence
     that **explicitly** states something incompatible (the judge only
     contradicts on explicit conflict); a contradiction dominates the co-extracted
     `unverified` hard claim, so the verdict is `blocked`.
   - `approved` is reachable in v1 **only** via the trigger-skip path (no signal →
     extraction skipped). A judge-*verified* approve is not achievable in v1: any
     triggering answer carries a hard claim that resolves `unverified` → disclaimer.
     That path is v2 (needs the deterministic Odoo/graph reader).
5. Lines starting with `#` and blank lines are ignored — use them for section
   headers.
6. Validate the shape without spending tokens: `npm test` runs the parser over
   the harness unit suite. To smoke the real classification, run
   `npm run eval:golden` with a key.

## Adding coverage when a new agent type ships

A new domain agent (a new Odoo-backed agent, a new tool surface, etc.) brings a
new way its output can regress — most importantly its **tool-postcondition**
contract. Add at least one fixture per new agent so a regression in that agent's
verification is caught, not just the agents that existed when the corpus was
written. The robust, model-independent choice is the synthetic
`tool_postcondition` path (it needs no trigger signal and no judge):

1. Add one line to `corpus/blocked-tool-postcondition.jsonl`:

   ```jsonc
   {
     "id": "blocked_tool_postcondition_<agent>",   // e.g. blocked_tool_postcondition_projects
     "note": "<agent> tool returned a payload that failed its output-schema postcondition.",
     "userMessage": "…a question that routes to the new agent…",
     "answer": "…the agent's answer (a trigger signal is NOT required for this path)…",
     "trace": {
       "agent": "<agent>",                          // the new agent's id
       "domainToolsCalled": ["<the_new_tool>"],     // the tool it calls
       "toolPostconditionViolations": [
         { "toolName": "<the_new_tool>", "callId": "call_1", "agentContext": "<agent>",
           "issues": ["<what the schema check reported>"] }
       ]
     },
     "expected": { "status": "blocked" }
   }
   ```

   This blocks via a synthetic contradiction built directly from
   `toolPostconditionViolations`, independent of the model — so it is stable the
   day the agent ships, before you have a feel for how its answers read.

2. If the agent cites the knowledge graph, also add a `citation_missing` line to
   `corpus/blocked-citation.jsonl` (set `trace.knowledgeGraphToolsCalled: true`
   and leave the answer without a `[ref:nodeId]` marker) — likewise synthetic and
   robust.

3. Only once you want to pin the agent's *judge* behaviour, add a
   `disclaimer` / `contradiction` fixture — and then obey the **trigger trap**
   above (the answer must carry a hard signal) and confirm the expected class on a
   real `eval:golden` run.

4. The `agent` id in `trace.agent` is free-form here (it flows into
   `VerifierInput.agent`); use the same id the orchestrator tags that agent with,
   so a `git grep` for the agent id turns up both its code and its golden
   coverage.
