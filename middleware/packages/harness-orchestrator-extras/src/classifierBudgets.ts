/**
 * Output-token budgets for the kernel's short "one-line answer" model
 * calls — the security judge, the working-mode classifier (#1208, #2051),
 * the PASS/BLOCK judges of the identity guard and the boundary guards
 * (spec 2042 §5.5, #2085, criterion 33) and the topic detector's classifier.
 * Lives here, in `@omadia/orchestrator-extras`, because the orchestrator
 * depends on this package and both use it; the orchestrator's
 * `classifierBudgets.ts` re-exports it.
 *
 * WHY THESE ARE NOT TIGHT. Each of these calls wants a few tokens of visible
 * output: `ALLOW` / `QUARANTINE: <reason>`, a working-mode slug, `PASS` /
 * `BLOCK`, or `continue` / `reset` / `unsure`. They run on an always-thinking
 * model whenever one is configured or nothing cheaper is: `buildOrchestrator`
 * builds the screener with `config.model`, the working-mode router falls back
 * to the agent's primary model (`modelRouting?.classifierModel`, else the
 * policy's primary), and the topic detector uses `topic_classifier_model`. From Opus 5.5 on, thinking is always on, the default effort is
 * medium, and thinking tokens count toward `max_tokens`. A budget sized for
 * the visible reply alone therefore ends the call BEFORE the reply exists, and
 * each caller reads a truncated reply as an ordinary bad answer, for example:
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
 * think. The screener and the working-mode router set no `effort`; the verdict
 * judges add {@link VERDICT_JUDGE_REASONING}, hints every adapter maps or
 * ignores, and send no `temperature` (a reasoning effort with a temperature
 * other than 1 is refused by some providers).
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
 * Budget for the PASS / BLOCK judges (identity guard, data-plan and summary
 * boundary guards) + thinking. They run on the agent's classifier model, else
 * its own model. With only the verdict's few tokens, an always-thinking model
 * spent them all on thinking and returned no text: the identity guard withheld
 * every suspicious answer of such an agent as `unavailable` (live: Opus 5.5,
 * `identity judge gave no verdict: ""`), the boundary guards refused every
 * plan and summary they judged.
 */
export const VERDICT_JUDGE_MAX_TOKENS = 1024;

/** Reasoning of the PASS / BLOCK judges: as little thinking as the model allows. */
export const VERDICT_JUDGE_REASONING = { effort: 'low', thinking: 'off' } as const;

/**
 * Budget for the topic detector's `continue` / `reset` / `unsure` call +
 * thinking. Its model is `topic_classifier_model` (Haiku 4.5 by default),
 * which an operator may point at an always-thinking model. With the old 64
 * tokens such a model spent them all on thinking, the reply was empty, and
 * every ambiguous follow-up became `unsure` (the user is asked each time).
 * It sends {@link VERDICT_JUDGE_REASONING} like the verdict judges.
 */
export const TOPIC_CLASSIFIER_MAX_TOKENS = 1024;
