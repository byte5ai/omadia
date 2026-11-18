/**
 * `decisionModel@1` — capability contract for a typed decision model.
 *
 * A decision model picks ONE of a closed set of options for an input and says
 * how sure it is — a classification, not text generation. Decisions that
 * today cost a forced-tool LLM call (the fast-path router: deterministic vs
 * agent, which tool) run on it far faster and cheaper when one is installed.
 * The first provider is TypeSafe AI's Jev (`@omadia/decision-jev`, own repo);
 * any classifier that returns calibrated probabilities fits.
 *
 * Adapter plugins publish ONE implementation of {@link DecisionModelService}
 * under the bare registry key {@link DECISION_MODEL_SERVICE_NAME}; consumers
 * declare {@link DECISION_MODEL_CAPABILITY} in `optional_requires`, resolve it
 * lazily per call and fall back to their LLM path when it is absent, throws,
 * or answers below their confidence bar. A decision model never runs a tool
 * and never sees tool results — it only chooses.
 *
 * Same two-constant split as `transcription.ts`: the bare name is the
 * service-registry key, the `@1` form the manifest capability ref.
 *
 * PRIVACY. Everything in a request is sent to the provider. The input — and
 * any turn data a consumer puts into an instruction or option (a recalled
 * note, a claim, an evidence snippet, a candidate span) — must already have
 * gone through the turn's privacy run (masked when a Privacy Shield runs),
 * the same rule as every LLM call site; everything else is fixed,
 * plugin-authored text.
 */

/** Service-registry key (bare, unversioned). */
export const DECISION_MODEL_SERVICE_NAME = 'decisionModel';
/** Manifest capability ref (`provides:` / `optional_requires:` form). */
export const DECISION_MODEL_CAPABILITY = 'decisionModel@1';

/** One option of a choice. `id` is what comes back; `description` is what
 *  the model decides on. */
export interface DecisionOption {
  readonly id: string;
  readonly description: string;
}

export interface DecisionChoiceRequest {
  /** stable id of the decision site (`fast-path.route`) — for the
   *  provider's metrics and per-task tuning, never shown to a model as data */
  readonly task: string;
  /** what to decide, in one or two sentences — fixed text */
  readonly instruction: string;
  /** the input to decide on — already privacy-masked by the caller */
  readonly input: string;
  /** at least two options with unique ids */
  readonly options: readonly DecisionOption[];
  /** cooperative cancellation / the caller's deadline */
  readonly signal?: AbortSignal;
}

export interface DecisionChoiceResult {
  /** the id of the chosen option — always one of the request's ids */
  readonly choice: string;
  /** calibrated probability (0..1) that `choice` is right */
  readonly confidence: number;
  /** option id → probability, when the provider reports a distribution */
  readonly probabilities?: Readonly<Record<string, number>>;
  /** provider model id that decided (e.g. `jev-1.13.0`), for the logs */
  readonly model?: string;
}

/** One question of a batch: pick one option, or the probability of yes. */
export type DecisionQuestion =
  | { readonly kind: 'choice'; readonly instruction: string; readonly options: readonly DecisionOption[] }
  | { readonly kind: 'yesno'; readonly instruction: string };

/**
 * Several questions about ONE input in one provider round trip. A provider
 * that evaluates questions in parallel (Jev) answers a batch about as fast
 * as a single question — the reason the fast path asks its whole turn gate
 * at once instead of chaining calls.
 */
export interface DecisionBatchRequest {
  /** stable id of the decision site (`fast-path.turn-gate`) */
  readonly task: string;
  /** the input every question refers to — already privacy-masked */
  readonly input: string;
  /** question id → question; ids are `[a-z0-9_]` */
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
  readonly signal?: AbortSignal;
}

export type DecisionAnswer =
  | {
      readonly kind: 'choice';
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities?: Readonly<Record<string, number>>;
    }
  | {
      readonly kind: 'yesno';
      /** calibrated probability (0..1) that the answer is yes */
      readonly probability: number;
    };

export interface DecisionBatchResult {
  /** question id → answer; a question without a valid answer is absent */
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  /** provider model id (e.g. `jev-1.14.0`), for the logs */
  readonly model?: string;
}

export interface DecisionModelService {
  /** provider id for logs and the admin UI (`jev`) */
  readonly provider: string;
  /** Pick one option. Throws on transport/provider errors and on an answer
   *  that names no requested option — the caller then falls back. */
  choose(req: DecisionChoiceRequest): Promise<DecisionChoiceResult>;
  /** Optional: answer a batch in one round trip. Absent → consumers ask
   *  question by question through {@link choose}. Throws like `choose`. */
  decideAll?(req: DecisionBatchRequest): Promise<DecisionBatchResult>;
}

/** Validates a provider answer against its request: a known choice and a
 *  finite confidence clamped to 0..1, else undefined. Providers and
 *  consumers share it so a malformed answer can never pass as a decision. */
export function normalizeDecisionChoice(
  req: Pick<DecisionChoiceRequest, 'options'>,
  raw: { choice?: unknown; confidence?: unknown; probabilities?: unknown; model?: unknown },
): DecisionChoiceResult | undefined {
  const ids = new Set(req.options.map((o) => o.id));
  if (typeof raw.choice !== 'string' || !ids.has(raw.choice)) return undefined;
  if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence)) return undefined;
  const confidence = Math.min(1, Math.max(0, raw.confidence));
  const probabilities = normalizeProbabilities(ids, raw.probabilities);
  return {
    choice: raw.choice,
    confidence,
    ...(probabilities ? { probabilities } : {}),
    ...(typeof raw.model === 'string' && raw.model.length > 0 ? { model: raw.model } : {}),
  };
}

function normalizeProbabilities(ids: ReadonlySet<string>, raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [id, p] of Object.entries(raw as Record<string, unknown>)) {
    if (ids.has(id) && typeof p === 'number' && Number.isFinite(p)) out[id] = Math.min(1, Math.max(0, p));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Validates a provider's batch answers against the request: every answer
 *  must match its question's kind (and options); invalid or unknown ones
 *  are dropped, never guessed. */
export function normalizeDecisionBatch(
  req: Pick<DecisionBatchRequest, 'questions'>,
  raw: { answers?: unknown; model?: unknown },
): DecisionBatchResult {
  const out: Record<string, DecisionAnswer> = {};
  const answers = typeof raw.answers === 'object' && raw.answers !== null ? (raw.answers as Record<string, unknown>) : {};
  for (const [id, question] of Object.entries(req.questions)) {
    const a = answers[id];
    if (typeof a !== 'object' || a === null) continue;
    const r = a as Record<string, unknown>;
    if (question.kind === 'yesno') {
      const p = r['probability'];
      if (typeof p === 'number' && Number.isFinite(p)) out[id] = { kind: 'yesno', probability: Math.min(1, Math.max(0, p)) };
      continue;
    }
    const choice = normalizeDecisionChoice(question, r);
    if (choice) {
      out[id] = {
        kind: 'choice',
        choice: choice.choice,
        confidence: choice.confidence,
        ...(choice.probabilities ? { probabilities: choice.probabilities } : {}),
      };
    }
  }
  return { answers: out, ...(typeof raw.model === 'string' && raw.model.length > 0 ? { model: raw.model } : {}) };
}
