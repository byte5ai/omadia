/**
 * Reasoning for the verifier's model calls (claim extraction, evidence judge):
 * structured extraction into a forced tool call on a fast model. Measured live
 * on Haiku 5.5 (default effort `medium`): 204–564 output tokens per turn,
 * holding the turn's `done` behind the Privacy Shield in `shadow` and the
 * whole answer in `enforce`. `thinking: 'off'` is a hint the adapter applies
 * only where the model accepts it; the adapter drops `effort` for a model
 * without an effort ladder (Haiku 4.5, the default `VERIFIER_MODEL`).
 */
export const VERIFIER_REASONING = { effort: 'low', thinking: 'off' } as const;
