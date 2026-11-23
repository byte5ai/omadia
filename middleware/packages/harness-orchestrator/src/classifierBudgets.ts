/**
 * Output-token budgets for the orchestrator's short "one-line answer" model
 * calls — the security judge, the working-mode classifier (#1208, #2051) and
 * the identity judge (spec 2042 §5.5).
 *
 * WHY THESE ARE NOT TIGHT. Each of these calls wants a few tokens of visible
 * output: `ALLOW` / `QUARANTINE: <reason>`, or a working-mode slug. Both routes,
 * however, run on the AGENT's own model whenever nothing cheaper is
 * configured — `buildOrchestrator` builds the screener with `config.model`,
 * and the working-mode router falls back to the agent's primary model
 * (`modelRouting?.classifierModel`, else the policy's primary). From Opus 5.5 on, thinking is always on, the default effort is
 * medium, and thinking tokens count toward `max_tokens`. A budget sized for
 * the visible reply alone therefore ends the call BEFORE the reply exists, and
 * both routes read a truncated reply as an ordinary bad answer:
 *
 *   - the screener's `parseVerdict` throws `unparseable-verdict`, so
 *     `screenProvenance` fails open to `unscreenable` — the turn runs
 *     unscreened behind the `UNSCREENED_MARKER`;
 *   - the working-mode router matches no candidate and silently runs the
 *     Agent's default behaviour, indistinguishable from an honest
 *     `NO_WORKING_MODE_MATCH`.
 *
 * Both are ceilings, not spend: a model that answers in four tokens is billed
 * for four. Sizing them for thinking costs nothing on a model that does not
 * think, which is why no `effort` is set alongside them — these routes may run
 * on Haiku or on a non-Anthropic provider.
 *
 * `modelRouter.ts` deliberately keeps its own tight `maxTokens: 8` and is not
 * listed here: it runs only with an explicitly configured Haiku-tier
 * classifier, and its fallback on an unreadable reply is the STRONGER model —
 * overspend, not a silent downgrade. Point an always-thinking model at
 * `ModelRoutingConfig.classifierModel` and it has this same failure shape.
 */

/** Budget for {@link LlmScreener}'s judge call (verdict line + thinking). */
export const SCREENER_MAX_TOKENS = 4096;

/** Budget for the working-mode router's classifier call (slug + thinking). */
export const WORKING_MODE_CLASSIFIER_MAX_TOKENS = 1024;

/**
 * Budget for the identity judge's `PASS` / `BLOCK` (+ thinking). The judge
 * runs on the agent's own model when it has no classifier model; with 8
 * tokens an Opus 5.5 agent's judge thought and never answered, and the guard
 * failed closed on 3 of 4 live "wer bist du" turns (`gave no verdict: ""`).
 */
export const IDENTITY_JUDGE_MAX_TOKENS = 1024;
