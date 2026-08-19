# Golden-set regression eval (#129)

A behaviour-level regression gate for the verifier's stochastic LLM stages. CI's
`middleware` job proves the plumbing (lint / typecheck / unit tests); this proves
that the **pinned model still classifies known inputs into the same verifier
verdict class**. A model bump or a prompt edit that silently regresses agent
behaviour (LLM weakness #13, version drift) fails here instead of shipping.

## What it asserts

The assertion target is **not** the raw model string — it is the verifier
verdict *class*, which is stable despite generation stochasticity:

- `approved` — via trigger-skip **or** (v2) a deterministic-verified hard claim
- `approved_with_disclaimer` (the borderline path, `isBorderlineVerdict`)
- `blocked` — via a judge contradiction, a deterministic contradiction (v2), or
  the two synthetic claim paths:
  - `tool_postcondition` (#130)
  - `citation_missing` (#131)

Each corpus entry is a frozen `(userMessage, answer, trace fields, fixture
evidence, fixture Odoo records, expected status)` tuple run through a **real**
`VerifierPipeline` — real `ClaimExtractor` + real `EvidenceJudge` +
real `DeterministicChecker` on the Anthropic adapter — with **fixture-backed**
sources (an in-memory `FixtureOdooReader`, no Postgres, no live Odoo, no
orchestrator). That keeps the job hermetic and cheap while still exercising the
stochastic stages that actually drift.

Since v2 (#639) an entry may also assert the **path** that produced the class,
not just the class, via `expected.via`:

- `deterministic-verified` — an Odoo re-query CONFIRMED a hard claim (→ approved).
- `deterministic-contradicted` — an Odoo re-query REFUTED a hard claim (→ blocked).

This exists because the class alone is not enough for the deterministic
`approved` case: a triggering answer whose extractor returns **zero** claims
also lands in `approved`, so `status: "approved"` on its own would pass for the
wrong reason and hide a checker regression. `via` requires a decided-class
sample to also carry a hard-claim verdict of the required kind — a soft (judge)
or synthetic contradiction, or an empty extraction, does not satisfy it.

## Scope: v1, v2, and what is still open

All corpus paths pin **`VERIFIER_MODEL`** (default `claude-haiku-4-5-20251001`)
— the model the stochastic `ClaimExtractor`/`EvidenceJudge` actually run on.
Asserting against the orchestrator model would be dishonest; those stages never
call it. The deterministic checker is **pure code** (no model), so the v2
paths still pin only `VERIFIER_MODEL` (for the extractor that produces the
claim).

- **v1 (#129):** verifier-stage eval with `DeterministicChecker({})` — no reader,
  so every hard claim resolved `unverified` and the checker's verified/
  contradicted branches had zero coverage. `approved` was reachable **only** via
  trigger-skip (no hard signal → extraction skipped).
- **v2 (#639), Gaps 1 & 2 — done (this):** a `FixtureOdooReader` injected into
  `DeterministicChecker` lets a corpus entry declare frozen Odoo records the
  checker re-queries. This adds:
  - `corpus/approved-deterministic.jsonl` — a hard claim the ERP **confirms** →
    a genuine `verified → approved` (not trigger-skip). Closes Gap 1.
  - `corpus/blocked-deterministic-contradiction.jsonl` — a hard claim the ERP
    **refutes** → `blocked`, distinct from the judge-contradiction and the
    trace-missing-call paths. Closes Gap 2.

  Both use the value-parse-free **id/ref existence** check (the extractor need
  only fill `odoo_record`, not the optional `value`), which keeps the live eval
  stable under the majority-of-3 policy. The `amount`/`value` branch (verified
  and contradicted) is pinned **deterministically** in `goldenModel.test.ts`
  with a scripted extractor stub — no key, no jitter — rather than trusting the
  live model to populate `value`.
- **v2 (#639), Gap 3 — still open:** a full-turn eval
  (`userMessage → live orchestrator answer → verdict`) pinned to
  `ORCHESTRATOR_MODEL`/`SUB_AGENT_MODEL`. Deliberately deferred: it needs a
  headless turn runner that does not yet exist, and it is the larger lift called
  out as its own slice in #639. Until it lands, a model/prompt regression in the
  orchestrator itself (e.g. it stops calling a domain tool) is out of scope
  here — the corpus evaluates the verifier on frozen answers, it does not
  generate them.

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
  parsing, majority voting, flake-tolerant `runEntry`, the `via` path assertion,
  summary) and the pure `FixtureOdooReader` (`read`/`search`/`search_read` over
  declared rows). Both import `@omadia/verifier` as `import type` only, so this
  suite needs no build.
- `test/goldenModel.test.ts` covers the **model** layer (`goldenModel.ts`: the
  real `VerifierPipeline` wiring) with a **stub** `LlmProvider`. Two stub flavours:
  an empty-content stub drives the synthetic block paths (`tool_postcondition`,
  `citation_missing`, no model needed); a scripted `record_claims` stub drives
  the real extractor → classify → `DeterministicChecker` + `FixtureOdooReader`
  path to a deterministic-verified `approved` and a deterministic-contradicted
  `blocked`, and asserts the projected verdict tags — all without a key. It does
  need the workspace `dist/` built.

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
   (`approve.jsonl`, `approved-deterministic.jsonl`, `disclaimer.jsonl`,
   `blocked-citation.jsonl`, `blocked-tool-postcondition.jsonl`,
   `blocked-contradiction.jsonl`, `blocked-deterministic-contradiction.jsonl`),
   or add a new `*.jsonl` file for a new class. Every `.jsonl` in `corpus/` is
   picked up automatically.
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
     "odoo": {                            // optional (v2) — frozen Odoo records the
       "records": [                       //   DeterministicChecker re-queries this turn
         { "model": "account.move", "id": 42,
           "fields": { "name": "INV/2026/0042", "amount_total": 1234.56 } }
       ]
     },
     "expected": {
       "status": "blocked",               // required: approved | approved_with_disclaimer | blocked
       "via": "deterministic-contradicted" // optional (v2): deterministic-verified | deterministic-contradicted
     }
   }
   ```

   The `odoo` fixture is a tiny in-memory Odoo: `FixtureOdooReader` answers the
   checker's `read` / `search` / `search_read` calls against these rows, so a
   hard claim can resolve `verified` or `contradicted` instead of the reader-less
   `unverified`. `fields.name` is what a `search` on an accounting ref matches;
   `amount_total` / `invoice_date` back the amount / date checks (see
   `deterministicChecker.ts` for the per-model field map).

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
   - `approved` via **trigger-skip** needs an answer with **no** hard signal, so
     extraction is skipped (`approve.jsonl`).
   - `approved` via **deterministic-verified** (v2) and `blocked` via
     **deterministic-contradicted** (v2) both need: a hard signal (use an
     **accounting ref** like `INV/2026/0042` — it triggers without forcing a
     value-dependent amount claim), `trace.domainToolsCalled: ["query_odoo_*"]`
     (so the trace-cross-check does **not** pre-empt the checker), an `odoo`
     fixture the checker re-queries, and `expected.via` set. Prefer the id/ref
     **existence** check: the fixture holding the record → `verified`; the fixture
     lacking it → `contradicted`. It needs only `odoo_record`, not the optional
     `value`, so it is stable live. If you need to pin an amount/date `value`
     branch, do it in `goldenModel.test.ts` with a scripted extractor stub rather
     than a live corpus entry — the live model does not reliably fill `value`.
     Always assert `via`, never the class alone: a `deterministic-verified` entry
     that asserts only `status: "approved"` would silently pass on an empty
     extraction and hide the very regression it guards.
   - **`deterministic-verified` needs a soft-claim guard.** Clean `approved`
     requires **every** extracted claim to be non-`unverified`, and a triggering
     answer means the extractor ran. Beside the hard claim the model may
     co-extract a soft/qualitative claim off the same sentence; with no
     `evidence` that soft claim resolves `unverified` → the turn drops to
     `approved_with_disclaimer` and the entry FAILS for a reason you never
     controlled. So a `deterministic-verified` entry should also carry an
     `evidence` snippet that confirms the qualitative reading (it is simply never
     fetched if no soft claim is emitted). A `deterministic-contradicted` entry
     needs no such guard — a contradiction dominates the aggregate regardless of
     any co-extracted `unverified` claim.
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
