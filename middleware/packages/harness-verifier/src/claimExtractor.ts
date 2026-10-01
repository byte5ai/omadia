import type { LlmProvider, LlmResponse, ToolSpec } from '@omadia/llm-provider';
import { textMessage, toolCalls } from '@omadia/llm-provider';
import { claimContext } from './claimContext.js';
import type {
  Aggregation,
  Claim,
  ClaimExtraction,
  ClaimSource,
  ClaimType,
  ExtractionGap,
  OdooRecordRef,
} from './claimTypes.js';

/**
 * Extracts structured factual claims from an orchestrator answer via a
 * Haiku tool-use call. The tool schema is enforced via `tool_choice`, so
 * the model is forced into a JSON-shaped response and cannot ramble.
 *
 * Design choices:
 *  - One call per answer. The extractor is NOT recursive.
 *  - The model MUST only return claims whose text appears verbatim in the
 *    answer; we police this client-side by rejecting any claim whose
 *    `text` is not a substring. This is our primary anti-hallucination
 *    guard on the extractor itself (ironic but necessary).
 *  - A failed extraction is not an empty one. When the LLM call fails, the
 *    response was cut off at the token limit, it carries no usable
 *    `record_claims` call, or an entry breaks the `record_claims` schema,
 *    `extract` logs and rejects, and the pipeline reports the verifier as
 *    `unavailable`. An empty list means the model found no claim (or none
 *    survived the verbatim guard), which the pipeline reports as `skipped`.
 *    Returning [] — or the readable part of a broken response — on a
 *    failure would make an outage look like a clean, complete run.
 *  - Coverage is explicit. The model sees the first
 *    `EXTRACTION_WINDOW_CHARS` characters of the answer and is asked for at
 *    most `maxClaims + 1` claims. The result names what the extraction did
 *    not cover (`ClaimExtraction.gaps`): text beyond the window, and a list
 *    that reached the request limit, since the model may have left claims
 *    out. The pipeline keeps each gap in the verdict as not checked, so an
 *    answer read only in part is at most partly verified. No valid claim is
 *    cut here; the pipeline decides how many it checks.
 */

/** Characters of the answer the extractor sends to the model. Claims in the
 *  rest are never looked for, which the result reports as the
 *  `answer_beyond_window` gap. */
export const EXTRACTION_WINDOW_CHARS = 6000;

export interface ClaimExtractorOptions {
  /** Provider-agnostic LLM (Anthropic adapter today). Was `anthropic` before
   *  the provider-decoupling migration (phase 2). */
  llm: LlmProvider;
  /** Haiku model id. Defaults to the latest Haiku 4.5. */
  model?: string;
  /** The pipeline's per-answer claim cap. The prompt asks the model for one
   *  claim more, so a list that reaches that limit shows the answer may hold
   *  more claims than the model listed (the `claim_list_full` gap), while an
   *  answer with exactly `maxClaims` claims still gets its whole list. A
   *  model that returns more is not cut off here. Default 20. */
  maxClaims?: number;
  /** Token budget for the extraction call. */
  maxTokens?: number;
  log?: (msg: string) => void;
}

export interface ExtractInput {
  userMessage: string;
  answer: string;
}

const DEFAULTS = {
  model: 'claude-haiku-4-5-20251001',
  maxClaims: 20,
  maxTokens: 1024,
};

const TOOL_NAME = 'record_claims';

const CLAIM_TYPES: readonly ClaimType[] = [
  'amount',
  'id',
  'date',
  'name',
  'aggregate',
  'qualitative',
];

const CLAIM_SOURCES: readonly ClaimSource[] = [
  'odoo',
  'graph',
  'confluence',
  'unknown',
];

const AGGREGATIONS: readonly Aggregation[] = ['sum', 'count', 'avg', 'max', 'min'];

const toolSpec: ToolSpec = {
  name: TOOL_NAME,
  description:
    'Record every factual claim made in the assistant answer. One entry per claim. Only include claims whose text appears VERBATIM in the answer. Do not invent, summarise, or paraphrase. If the answer contains no factual claims, return an empty array.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description:
                'Verbatim snippet from the answer (short, 1-200 chars).',
            },
            type: {
              type: 'string',
              enum: [...CLAIM_TYPES],
              description:
                'amount=money/number+unit; id=record reference (invoice/order/document number such as "INV/2026/0042", or a numeric record id) — ALWAYS emit a separate id claim for every record reference, even when the sentence also makes a qualitative statement about that record; date=calendar date; name=person/customer with context; aggregate=sum/count/avg over a set (especially HR leave totals); qualitative=non-numeric claim about an entity.',
            },
            expected_source: {
              type: 'string',
              enum: [...CLAIM_SOURCES],
              description:
                'Where the ground truth lives. "odoo" for ERP facts, "graph" for knowledge-graph facts, "confluence" for wiki content, "unknown" otherwise.',
            },
            value: {
              type: ['number', 'string'],
              description:
                'Parsed value when possible: number for amounts/aggregates, ISO-8601 string for dates, reference string for ids/names.',
            },
            unit: {
              type: 'string',
              description: 'e.g. "€", "h", "d", "%". Omit when not applicable.',
            },
            odoo_record: {
              type: 'object',
              properties: {
                model: { type: 'string' },
                id: { type: 'integer' },
                ref: { type: 'string' },
              },
              required: ['model'],
              description:
                'If the claim references a specific Odoo record, set model (and id/ref when available).',
            },
            related_entities: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Entity handles in "system:model:id" form, e.g. "odoo:res.partner:42".',
            },
            aggregation: {
              type: 'string',
              enum: [...AGGREGATIONS],
              description: 'Aggregation flavour — only for type=aggregate.',
            },
          },
          required: ['text', 'type', 'expected_source'],
        },
      },
    },
    required: ['claims'],
  },
};

interface RawClaim {
  text?: unknown;
  type?: unknown;
  expected_source?: unknown;
  value?: unknown;
  unit?: unknown;
  odoo_record?: unknown;
  related_entities?: unknown;
  aggregation?: unknown;
}

export class ClaimExtractor {
  private readonly opts: Required<
    Omit<ClaimExtractorOptions, 'llm' | 'log'>
  > & {
    llm: LlmProvider;
    log: (msg: string) => void;
  };

  constructor(opts: ClaimExtractorOptions) {
    this.opts = {
      llm: opts.llm,
      model: opts.model ?? DEFAULTS.model,
      // Normalised like the pipeline's cap, so the prompt never asks for a
      // negative or fractional number of claims.
      maxClaims:
        typeof opts.maxClaims === 'number' && Number.isFinite(opts.maxClaims)
          ? Math.max(0, Math.floor(opts.maxClaims))
          : DEFAULTS.maxClaims,
      maxTokens: opts.maxTokens ?? DEFAULTS.maxTokens,
      log:
        opts.log ??
        ((msg: string): void => {
          console.error(msg);
        }),
    };
  }

  /**
   * Extract claims from the given answer, and name what the extraction did
   * not cover (`gaps`, see `ClaimExtraction`). Resolves no claims when there
   * is nothing to extract: an empty answer, or a model that reports no claim
   * (with the gaps that still apply). Rejects when extraction could not run
   * or did not finish: the LLM call failed, the response was cut off at the
   * token limit, it carries no usable `record_claims` call, or an entry
   * breaks the `record_claims` schema. A well-formed claim whose text is not
   * in the answer is dropped (the anti-hallucination guard), not an error.
   */
  async extract(input: ExtractInput): Promise<ClaimExtraction> {
    const answer = input.answer.trim();
    if (answer.length === 0) return { claims: [], gaps: [] };

    // One more than the pipeline checks: a list that reaches this limit shows
    // the answer may hold claims the model left out.
    const requestLimit = this.opts.maxClaims + 1;
    const system = `You are a claim extractor. Given an assistant answer (in German or English), list EVERY factual claim it makes. A claim is any concrete, verifiable assertion: monetary amounts, record references, dates, named entities, totals.

Strict rules:
- Only include claims whose text appears VERBATIM in the answer.
- Do NOT paraphrase, summarise, translate, or reformulate.
- Do NOT extract the user's question, instructions, or meta-commentary.
- Do NOT invent claims that are "implied" but not stated.
- When in doubt, skip the claim rather than invent one.
- A record reference (invoice, order or document number, numeric record id) is ALWAYS its own claim of type "id" with odoo_record.model and odoo_record.ref/id set — in addition to any qualitative claim about the same record.
- A qualitative claim must be a self-contained statement: include the subject it is about in the verbatim span ("Anna Müller wechselte in die IT-Abteilung"), never a bare fragment ("in die IT-Abteilung"). An independent reviewer will judge the claim WITHOUT seeing the answer.
- List the claims in the order they appear in the answer. Return at most ${String(requestLimit)} claims via the ${TOOL_NAME} tool; if the answer makes more, return its first ${String(requestLimit)}.`;

    const user = `USER MESSAGE:
${truncate(input.userMessage, 2000)}

ASSISTANT ANSWER:
${truncate(answer, EXTRACTION_WINDOW_CHARS)}`;

    let response: LlmResponse;
    try {
      response = await this.opts.llm.complete({
        model: this.opts.model,
        maxTokens: this.opts.maxTokens,
        system,
        tools: [toolSpec],
        toolChoice: { type: 'tool', name: TOOL_NAME },
        messages: [textMessage('user', user)],
      });
    } catch (err) {
      this.opts.log(
        `[claim-extractor] API FAIL: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Not []: that reads as "the answer holds no claim". The pipeline maps
      // a rejection to `unavailable`.
      throw err;
    }

    const read = readToolClaims(response);
    if (!read.ok) {
      this.opts.log(`[claim-extractor] ${read.problem}`);
      throw new Error(`claim extraction failed: ${read.problem}`);
    }
    const rawClaims = read.claims;

    const out: Claim[] = [];
    let malformed = 0;
    for (const raw of rawClaims) {
      const claim = normaliseClaim(raw, out.length, answer);
      if (claim === 'malformed') malformed += 1;
      else if (claim !== 'not_verbatim') out.push(claim);
    }
    if (malformed > 0) {
      // A broken entry is a claim we cannot read, not one the answer lacks:
      // returning the readable rest would pass off a partial extraction as
      // the whole answer.
      const problem = `${String(malformed)} of ${String(rawClaims.length)} ${TOOL_NAME} entries do not match the schema`;
      this.opts.log(`[claim-extractor] ${problem}`);
      throw new Error(`claim extraction failed: ${problem}`);
    }
    const gaps = coverageGaps(answer.length, rawClaims.length, requestLimit);
    this.opts.log(
      `[claim-extractor] extracted=${String(out.length)} raw=${String(rawClaims.length)}${
        gaps.length > 0 ? ` gaps=${gaps.join(',')}` : ''
      }`,
    );
    // Diagnostic: when the extractor returns zero claims even though the
    // trigger router fired, we want to see WHY. Log the first 300 chars
    // of the answer + user message — that's enough to tell whether the
    // bot was honest ("I cannot answer") or Haiku under-extracted a
    // valid numeric response. Safe to log: the answer already landed in
    // session_logger / graph, no new PII surface.
    if (rawClaims.length === 0) {
      this.opts.log(
        `[claim-extractor] zero-raw diag user="${shortSnippet(input.userMessage, 200)}" answerLen=${String(answer.length)} answerHead="${shortSnippet(answer, 400)}" answerTail="${shortSnippet(tail(answer, 400), 400)}"`,
      );
    }
    return { claims: out, gaps };
  }
}

/**
 * What an extraction did not cover: answer text beyond the window the model
 * saw, and a raw list that reached the request limit — counted before the
 * verbatim guard, since the model stopped listing either way.
 */
function coverageGaps(
  answerLength: number,
  rawClaimCount: number,
  requestLimit: number,
): ExtractionGap[] {
  const gaps: ExtractionGap[] = [];
  if (answerLength > EXTRACTION_WINDOW_CHARS) gaps.push('answer_beyond_window');
  if (rawClaimCount >= requestLimit) gaps.push('claim_list_full');
  return gaps;
}

function shortSnippet(value: string, max = 300): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

/**
 * The claims of the forced `record_claims` call, or why the response has none
 * to read: it was cut off at the token limit, it holds no such call, or the
 * call has no `claims` array. Each is a failed extraction, which is not the
 * same as a call that lists no claims.
 */
function readToolClaims(
  response: LlmResponse,
): { ok: true; claims: unknown[] } | { ok: false; problem: string } {
  // A call cut off at the token limit can still parse into a claims array —
  // just not the whole one: the rest of the answer was never extracted.
  if (response.finishReason === 'max_tokens') {
    return { ok: false, problem: 'response truncated at the token limit' };
  }
  // Defensive: the contract guarantees `content` is an array.
  if (Array.isArray(response.content)) {
    for (const call of toolCalls(response.content)) {
      if (call.name !== TOOL_NAME) continue;
      const input = call.input as { claims?: unknown } | null | undefined;
      return input && Array.isArray(input.claims)
        ? { ok: true, claims: input.claims }
        : { ok: false, problem: `${TOOL_NAME} call without a claims array` };
    }
  }
  return { ok: false, problem: 'no tool_use block in response' };
}

/**
 * Validate + normalise a single raw claim. An entry without the schema's
 * required fields — a non-empty `text`, a known `type`, a known
 * `expected_source` — is `'malformed'`: a failed extraction, never a claim to
 * drop quietly. A well-formed entry whose text is not in the answer is
 * `'not_verbatim'`: the anti-hallucination guard drops it. Optional fields
 * that do not parse are left out of the claim.
 */
function normaliseClaim(
  raw: unknown,
  idx: number,
  answer: string,
): Claim | 'malformed' | 'not_verbatim' {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'malformed';
  const r = raw as RawClaim;

  const text = asShortString(r.text, 300);
  const type = asEnum<ClaimType>(r.type, CLAIM_TYPES);
  const expectedSource = asEnum<ClaimSource>(r.expected_source, CLAIM_SOURCES);
  if (!text || !type || !expectedSource) return 'malformed';

  // Anti-hallucination: reject claims that don't literally appear in the
  // answer. Case-insensitive to tolerate title-casing drift.
  if (!answer.toLowerCase().includes(text.toLowerCase())) return 'not_verbatim';

  const claim: Claim = {
    id: `c_${String(idx + 1).padStart(3, '0')}`,
    text,
    type,
    expectedSource,
    relatedEntities: asStringArray(r.related_entities),
  };

  const value = asValue(r.value);
  if (value !== undefined) claim.value = value;

  const unit = asShortString(r.unit, 16);
  if (unit) claim.unit = unit;

  const agg = asEnum<Aggregation>(r.aggregation, AGGREGATIONS);
  if (agg) claim.aggregation = agg;

  const odoo = asOdooRecord(r.odoo_record);
  if (odoo) claim.odooRecord = odoo;

  const context = claimContext(text, answer);
  if (context) claim.context = context;

  return claim;
}

function asShortString(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const trimmed = v.trim();
  if (!trimmed) return '';
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  if (typeof v !== 'string') return null;
  return (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = asShortString(item, 128);
    if (s) out.push(s);
  }
  return out;
}

function asValue(v: unknown): number | string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!trimmed) return undefined;
    return trimmed.length <= 200 ? trimmed : trimmed.slice(0, 200);
  }
  return undefined;
}

function asOdooRecord(v: unknown): OdooRecordRef | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as { model?: unknown; id?: unknown; ref?: unknown };
  const model = asShortString(r.model, 128);
  if (!model) return undefined;
  const out: OdooRecordRef = { model };
  if (typeof r.id === 'number' && Number.isInteger(r.id) && r.id > 0) {
    out.id = r.id;
  }
  const ref = asShortString(r.ref, 128);
  if (ref) out.ref = ref;
  return out;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
