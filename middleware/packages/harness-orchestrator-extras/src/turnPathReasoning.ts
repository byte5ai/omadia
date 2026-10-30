/**
 * Reasoning for the extras' calls that sit ON a chat turn's critical path: the
 * recall relevance judge (before the first model call) and the save-as-memory
 * excerpt (before `done`). Both are short classification/extraction tasks; on
 * an always-thinking fast model (Haiku 5.5 defaults to effort `medium`) they
 * spent ~500–1000 output tokens each — measured live, ~3 s before the first
 * Opus call and ~3 s before `done`. Same setting as the fast path's own
 * classifier calls (`FAST_MODEL_REASONING`). `thinking: 'off'` is a hint the
 * adapter applies only where the model accepts it; `effort` works everywhere
 * an effort ladder exists and is ignored elsewhere.
 */
export const TURN_PATH_REASONING = { effort: 'low', thinking: 'off' } as const;
