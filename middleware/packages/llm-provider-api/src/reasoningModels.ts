/**
 * Which OpenAI models take a reasoning effort (spec 2042 follow-up).
 *
 * `reasoning_effort` (Chat Completions) and `reasoning.effort` (Responses)
 * exist only on OpenAI's reasoning models: the o-series (`o1`, `o3-mini`,
 * `o4-mini`, …) and GPT-5 (`gpt-5`, `gpt-5.4`, `gpt-5-mini`, …). `gpt-4o` and
 * `gpt-4.1` answer the field with a 400, so a caller's effort hint (the
 * verifier's, the fast path's, the PASS/BLOCK judges') broke every such call.
 * The same models reject a `temperature` other than the default.
 *
 * Matches the bare id and a routed one (`openai/gpt-5`). An allowlist: a model
 * it does not know gets no effort, which costs a little reasoning, never a 400.
 */
const OPENAI_REASONING_MODEL = /^(?:[\w.-]+\/)?(?:o\d+(?:$|[-.])|gpt-5(?:$|[-.]))/i;
/** Inside those families: `o1-mini` / `o1-preview` predate the effort field,
 *  and the `*-chat-latest` aliases are the non-reasoning chat models. */
const WITHOUT_EFFORT = /(?:^|\/)o1-(?:mini|preview)(?:$|-)|-chat(?:-latest)?$/i;

export function isOpenAiReasoningModel(model: string): boolean {
  const id = model.trim();
  return OPENAI_REASONING_MODEL.test(id) && !WITHOUT_EFFORT.test(id);
}
