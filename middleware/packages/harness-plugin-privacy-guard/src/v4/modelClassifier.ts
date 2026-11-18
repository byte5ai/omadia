/**
 * #1556 follow-up — classify Odoo models as personal / non-personal from
 * their SCHEMA only, with the plugin's own small model (Haiku).
 *
 * Input per model: its technical name, its display label, and the field
 * paths pointing to it with their labels and help texts. Never a value —
 * this module receives none. The kernel never sends person models (that
 * rule is its own); a verdict here is a suggestion an admin confirms.
 *
 * Fail-safe: no LLM, a failed call, an unparseable reply or a model missing
 * from the reply yields `uncertain` with confidence 0 for that model.
 */

import type {
  ModelClassificationRequest,
  ModelClassificationResult,
  ModelPersonalVerdict,
} from '@omadia/plugin-api';
import { parseLlmJson } from '@omadia/plugin-api';

import { PII_CLASSIFIER_MODEL, type LlmComplete } from './piiClassifier.js';

/** Models per Haiku call — keeps the reply well under `MAX_TOKENS`. */
export const MODELS_PER_CALL = 8;
const MAX_TOKENS = 512;
/** Cap on a label / help text in the prompt, and on a returned reason. */
const MAX_TEXT_CHARS = 200;
const MAX_FIELDS_PER_MODEL = 20;

const VERDICTS: ReadonlySet<ModelPersonalVerdict> = new Set([
  'personal',
  'non-personal',
  'uncertain',
]);

const SYSTEM_PROMPT = [
  'You classify Odoo models for a privacy filter, from their schema only.',
  'A model is "personal" when one of its records describes or identifies an',
  'individual person (a contact, employee, applicant, user, patient, a',
  "person's address or bank account). It is \"non-personal\" when its records",
  'are organisational or reference data (a department, team, company, job',
  'position, product, category, tag, stage, region, currency, project). Use',
  '"uncertain" when the schema does not tell.',
  '',
  'Reply with JSON only, no markdown fence:',
  '{"models":[{"model":"<technical name>","verdict":"personal|non-personal|uncertain",',
  '"confidence":<0..1>,"reason":"<one short sentence>"}]}',
  'One entry per model you were given, nothing else.',
].join('\n');

function clip(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_TEXT_CHARS ? trimmed.slice(0, MAX_TEXT_CHARS) : trimmed;
}

/** The user message for one batch — schema only. */
export function buildModelClassifierPrompt(
  requests: readonly ModelClassificationRequest[],
): string {
  const models = requests.map((r) => ({
    model: r.model,
    ...(clip(r.modelLabel) !== undefined ? { label: clip(r.modelLabel) } : {}),
    referencedBy: r.fields.slice(0, MAX_FIELDS_PER_MODEL).map((f) => ({
      field: f.path,
      ...(clip(f.label) !== undefined ? { label: clip(f.label) } : {}),
      ...(clip(f.help) !== undefined ? { help: clip(f.help) } : {}),
    })),
  }));
  return [
    'Classify these Odoo models. Each lists the fields that point to it.',
    JSON.stringify({ models }, null, 1),
  ].join('\n');
}

function uncertain(model: string): ModelClassificationResult {
  return { model, verdict: 'uncertain', confidence: 0, reason: '' };
}

function validEntry(
  raw: unknown,
  wanted: ReadonlySet<string>,
): ModelClassificationResult | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  const model = e['model'];
  const verdict = e['verdict'];
  if (typeof model !== 'string' || !wanted.has(model)) return undefined;
  if (typeof verdict !== 'string' || !VERDICTS.has(verdict as ModelPersonalVerdict)) {
    return undefined;
  }
  const confidence = e['confidence'];
  const hasConfidence =
    typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
  // A definite verdict without a usable confidence is not trusted.
  if (!hasConfidence) return uncertain(model);
  const reason = typeof e['reason'] === 'string' ? (clip(e['reason']) ?? '') : '';
  return { model, verdict: verdict as ModelPersonalVerdict, confidence, reason };
}

/** Parse one batch reply; models missing or invalid come back `uncertain`. */
export function parseModelClassifierReply(
  text: string,
  models: readonly string[],
): ModelClassificationResult[] {
  const parsed = parseLlmJson(text);
  const list =
    Array.isArray(parsed)
      ? parsed
      : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { models?: unknown }).models)
        ? ((parsed as { models: unknown[] }).models)
        : [];
  const wanted = new Set(models);
  const byModel = new Map<string, ModelClassificationResult>();
  for (const raw of list) {
    const entry = validEntry(raw, wanted);
    if (entry !== undefined && !byModel.has(entry.model)) byModel.set(entry.model, entry);
  }
  return models.map((m) => byModel.get(m) ?? uncertain(m));
}

/**
 * Classify `requests` in batches of `MODELS_PER_CALL`. One result per
 * distinct model, in input order. Never throws.
 */
export async function classifyModelsSchemaOnly(
  requests: readonly ModelClassificationRequest[],
  complete: LlmComplete | undefined,
  log?: (msg: string) => void,
): Promise<ModelClassificationResult[]> {
  const distinct = new Map<string, ModelClassificationRequest>();
  for (const r of requests) {
    if (typeof r.model === 'string' && r.model.length > 0 && !distinct.has(r.model)) {
      distinct.set(r.model, r);
    }
  }
  const unique = [...distinct.values()];
  if (complete === undefined) return unique.map((r) => uncertain(r.model));

  const results: ModelClassificationResult[] = [];
  for (let i = 0; i < unique.length; i += MODELS_PER_CALL) {
    const batch = unique.slice(i, i + MODELS_PER_CALL);
    const models = batch.map((r) => r.model);
    try {
      const res = await complete({
        model: PII_CLASSIFIER_MODEL,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildModelClassifierPrompt(batch) }],
        maxTokens: MAX_TOKENS,
      });
      const parsed = parseModelClassifierReply(res.text, models);
      const answered = parsed.filter((p) => p.confidence > 0).length;
      log?.(
        `[privacy-guard v4] model-classifier: models=${String(models.length)} ` +
          `answered=${String(answered)}`,
      );
      results.push(...parsed);
    } catch (err) {
      log?.(
        `[privacy-guard v4] model-classifier: Haiku call failed for ` +
          `${String(models.length)} model(s) — uncertain: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      results.push(...models.map(uncertain));
    }
  }
  return results;
}
