import type { LlmProvider, LlmResponse, ToolSpec } from '@omadia/llm-provider';
import { textMessage } from '@omadia/llm-provider';
import { claimContext } from './claimContext.js';
import {
  describeExtractionResponse,
  readToolClaims,
  type ExtractionProblemCode,
} from './extractionResponse.js';
import { isRepairable, repairNote, repairShortfall } from './extractionRepair.js';
import type {
  Aggregation,
  Claim,
  ClaimExtraction,
  ClaimSource,
  ClaimType,
  ExtractionGap,
  OdooRecordRef,
  VerifierPrivacy,
} from './claimTypes.js';
import { restoreClaims } from './claimRestore.js';
import { verbatimSpans } from './verbatimSpan.js';

/**
 * Extracts structured factual claims from an orchestrator answer via a
 * Haiku tool-use call. The tool schema is enforced via `tool_choice`, so
 * the model is forced into a JSON-shaped response and cannot ramble.
 *
 * Design choices:
 *  - One LLM call per answer, plus at most one repair call when that
 *    response is unusable (below). The extractor is NOT recursive. The claims
 *    of every `record_claims` call in the response are read, in order: a
 *    model that splits its list over several calls gets every part checked.
 *  - The model MUST only return claims whose text appears verbatim in the
 *    answer; we police this client-side (`verbatimSpans`): a claim must quote
 *    the answer, case and whitespace set aside, and carries the quoted span
 *    of the answer as its text. This is our primary anti-hallucination guard
 *    on the extractor itself (ironic but necessary). The guard reads the
 *    whole claim — a claim is never shortened, before or after the match,
 *    since a check on its head would leave its tail unchecked. A claim that
 *    quotes nothing never reaches a checker, but it is not dropped without a
 *    trace either: the part of the answer it stood for was not checked, which
 *    the result reports as the `claims_not_in_answer` gap. Likewise a claim
 *    that quotes the answer but is longer than a check takes
 *    (`MAX_CLAIM_CHARS`) is the `claims_too_long` gap, not a cut-down claim.
 *  - A failed extraction is not an empty one. When the turn's privacy view
 *    does not admit the request, the LLM call fails, the
 *    response was cut off at the token limit or refused, it carries no usable
 *    `record_claims` call (none, or one of them without a `claims` array), or
 *    an entry breaks the `record_claims` schema, `extract` logs and rejects,
 *    and the pipeline reports the verifier as `unavailable`. An empty list
 *    without gaps means the model found no claim, which the pipeline reports
 *    as `skipped`. Returning [] — or the readable part of a broken response
 *    — on a failure would make an outage look like a clean, complete run.
 *  - One repair, never more. An unusable response (cut off, no call, no
 *    claims array, a broken entry) gets exactly one more extraction call:
 *    the same model, token budget and wire view, plus a fixed note naming
 *    what was wrong. It is a request of its own, so it is admitted — and
 *    counted in the receipt — like the first. A failed API call or a refusal
 *    the adapter reports (`LlmResponse.refusal`) is not retried. A repair
 *    that lists nothing, or fewer entries than the first response still
 *    showed, is rejected like a failed one: the first response was not empty.
 *    A non-empty list the model wrote as a JSON-encoded string is decoded
 *    without a second call (`readToolClaims`). Every failure logs a
 *    content-free description of the response (`describeExtractionResponse`).
 *  - Coverage is explicit. The model sees the first
 *    `EXTRACTION_WINDOW_CHARS` characters of the answer and is asked for at
 *    most `maxClaims + 1` claims. The result names what the extraction did
 *    not cover (`ClaimExtraction.gaps`): text beyond the window, a list that
 *    reached the request limit, since the model may have left claims out,
 *    claims that are not in the answer, claims too long to check, and —
 *    behind a Privacy Shield — claims that do not map back onto the answer
 *    the user was shown. The
 *    pipeline keeps each gap in the verdict as not checked, so an answer
 *    covered only in part is at most partly verified. No valid claim is cut
 *    here; the pipeline decides how many it checks.
 */

/** Characters of the answer the extractor sends to the model. Claims in the
 *  rest are never looked for, which the result reports as the
 *  `answer_beyond_window` gap. */
export const EXTRACTION_WINDOW_CHARS = 6000;

/** Longest claim a check takes, in characters of the answer span it quotes.
 *  A longer claim is not cut to fit — its tail would go unchecked without a
 *  trace — but kept from the checkers and reported as the `claims_too_long`
 *  gap. The tool schema asks the model for 1-200 characters. */
export const MAX_CLAIM_CHARS = 300;

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
  /**
   * The turn's privacy view (see {@link VerifierPrivacy}). When present the
   * model sees the turn's own wire view — `privacy.wireUserMessage` and
   * `privacy.wireAnswer`, never `userMessage` / `answer` above — and the
   * returned claims are restored to real values here, server-side, before
   * anything checks them.
   */
  privacy?: VerifierPrivacy;
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
   * or did not finish: the turn's privacy view did not admit the request,
   * the LLM call failed or was refused, or the response — and then its one
   * repair — was cut off at the token limit, carried no `record_claims` call
   * or one without a `claims` array, or had an entry that breaks the
   * `record_claims` schema; also when the repair listed nothing or fewer
   * entries than the first response. A well-formed claim whose
   * text is not in the answer is kept from the checkers (the
   * anti-hallucination guard) and reported as the `claims_not_in_answer`
   * gap, one longer than `MAX_CLAIM_CHARS` as the `claims_too_long` gap, and
   * — behind a Privacy Shield — one that does not map back onto the real
   * answer as the `claims_not_restored` gap; none of them is an error, and
   * none is shortened. Behind a shield the guard and the window apply to the
   * wire view, the text the model saw.
   */
  async extract(input: ExtractInput): Promise<ClaimExtraction> {
    const privacy = input.privacy;
    // Behind a Privacy Shield the model sees the turn's wire view only: the
    // answer as the turn's model wrote it, the prompt as the turn's model
    // received it — never the caller's own text.
    const answer = (privacy ? privacy.wireAnswer : input.answer).trim();
    if (answer.length === 0) return { claims: [], gaps: [] };
    const userMessage = privacy ? privacy.wireUserMessage : input.userMessage;
    await this.admit(privacy, 'claim extraction failed: the request was not admitted');

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
${truncate(userMessage, 2000)}

ASSISTANT ANSWER:
${truncate(answer, EXTRACTION_WINDOW_CHARS)}`;

    const prompt: ExtractionPrompt = { system, user, answer };
    let attempt = await this.attempt(prompt, undefined);
    if (!attempt.ok) {
      if (!isRepairable(attempt.code)) {
        throw new Error(`claim extraction failed: ${attempt.problem}`);
      }
      // Exactly one repair: the same model, token budget and wire view, plus
      // a fixed note on what was wrong. A request of its own — admitted and
      // counted in the receipt like the first one.
      const first = attempt;
      this.opts.log(`[claim-extractor] repair attempt 2/2 after: ${first.code}`);
      await this.admit(
        privacy,
        `claim extraction failed: ${first.problem}; the repair request was not admitted`,
      );
      try {
        attempt = await this.attempt(prompt, first.code);
      } catch (err) {
        throw new Error(
          `claim extraction failed: ${first.problem}; repair call failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
      if (!attempt.ok) {
        throw new Error(
          `claim extraction failed: ${first.problem}; repair attempt failed: ${attempt.problem}`,
        );
      }
      // The first response was not empty — it failed. A repair that now lists
      // nothing, or fewer entries than the first response still showed, may
      // have dropped claims; resolving it would pass a partial (or empty)
      // extraction off as the whole answer.
      const lost = repairShortfall(attempt.rawClaims.length, first.listed);
      if (lost) {
        this.opts.log(`[claim-extractor] repair rejected: ${lost}`);
        throw new Error(`claim extraction failed: ${first.problem}; repair rejected: ${lost}`);
      }
      this.opts.log(`[claim-extractor] repair attempt succeeded after: ${first.code}`);
    }
    const { rawClaims, normalised, missed, read } = attempt;

    // Behind a Privacy Shield every claim is mapped back to real values
    // before anything checks it. A claim that does not map back onto the
    // answer the user was shown never reaches a checker — and, like a claim
    // the verbatim guard kept back, it is not dropped without a trace: the
    // part of the answer it stood for was not checked (`claims_not_restored`).
    const out = privacy
      ? await restoreClaims(normalised, privacy, input.answer.trim(), claimContext)
      : normalised;
    const notRestored = normalised.length - out.length;
    const gaps = coverageGaps({
      answerLength: answer.length,
      rawClaimCount: rawClaims.length,
      requestLimit,
      notInAnswer: missed.not_verbatim,
      tooLong: missed.too_long,
      notRestored,
    });
    this.opts.log(
      `[claim-extractor] extracted=${String(out.length)} raw=${String(rawClaims.length)}${
        read.calls > 1 ? ` calls=${String(read.calls)}` : ''
      }${read.decoded ? ' decoded=json-string' : ''}${
        attempt.repaired ? ' attempts=2' : ''
      }${missed.not_verbatim > 0 ? ` not_in_answer=${String(missed.not_verbatim)}` : ''}${
        missed.too_long > 0 ? ` too_long=${String(missed.too_long)}` : ''
      }${notRestored > 0 ? ` not_restored=${String(notRestored)}` : ''}${
        gaps.length > 0 ? ` gaps=${gaps.join(',')}` : ''
      }`,
    );
    // Diagnostic: when the extractor returns zero claims even though the
    // trigger router fired, log the shape of the exchange. Lengths only: the
    // user message and the answer are turn content, and a log sink keeps
    // them in clear outside the privacy receipt's reach.
    if (rawClaims.length === 0) {
      this.opts.log(
        `[claim-extractor] zero-raw diag userLen=${String(userMessage.length)} answerLen=${String(answer.length)}`,
      );
    }
    return { claims: out, gaps };
  }

  /**
   * Admit one request carrying the turn's wire view — each extraction call
   * is one, and the receipt counts each. Nothing to admit without a shield.
   */
  private async admit(privacy: VerifierPrivacy | undefined, failure: string): Promise<void> {
    if (!privacy) return;
    try {
      await privacy.admitWireView();
    } catch (err) {
      this.opts.log(
        `[claim-extractor] extraction not sent — prompt masking blocked: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Nothing was looked for, so this is no empty extraction: the
      // pipeline maps the rejection to `unavailable`, never to `skipped`.
      throw new Error(failure, { cause: err });
    }
  }

  /**
   * One extraction call and the reading of its response. `repairOf` names
   * what the previous attempt got wrong; the call then carries a fixed note
   * about it — static prose, nothing of the turn's content. A failed API
   * call rejects (never retried here); an unusable response resolves as a
   * failure with a content-free description in the log.
   */
  private async attempt(
    prompt: ExtractionPrompt,
    repairOf: ExtractionProblemCode | undefined,
  ): Promise<AttemptResult> {
    let response: LlmResponse;
    try {
      response = await this.opts.llm.complete({
        model: this.opts.model,
        maxTokens: this.opts.maxTokens,
        system: repairOf
          ? `${prompt.system}\n\n${repairNote(repairOf, {
              toolName: TOOL_NAME,
              claimTypes: CLAIM_TYPES,
              claimSources: CLAIM_SOURCES,
            })}`
          : prompt.system,
        tools: [toolSpec],
        toolChoice: { type: 'tool', name: TOOL_NAME },
        messages: [textMessage('user', prompt.user)],
      });
    } catch (err) {
      this.opts.log(
        `[claim-extractor] API FAIL: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Not []: that reads as "the answer holds no claim". The pipeline maps
      // a rejection to `unavailable`.
      throw err;
    }
    const attemptNo = repairOf ? 2 : 1;
    const fail = (code: ExtractionProblemCode, problem: string, listed: number): AttemptResult => {
      this.opts.log(`[claim-extractor] ${problem}`);
      this.opts.log(
        `[claim-extractor] diag attempt=${String(attemptNo)} problem=${code} ${describeExtractionResponse(
          response,
          { providerId: this.opts.llm.id, toolName: TOOL_NAME },
        )}`,
      );
      return { ok: false, code, problem, listed };
    };

    const read = readToolClaims(response, TOOL_NAME);
    if (!read.ok) return fail(read.code, read.problem, read.listed);
    if (read.decoded) {
      this.opts.log(
        `[claim-extractor] claims arrived as a JSON-encoded string — decoded; ${describeExtractionResponse(
          response,
          { providerId: this.opts.llm.id, toolName: TOOL_NAME },
        )}`,
      );
    }

    // Verbatim guard against the text the model actually saw (the wire view
    // behind a Privacy Shield).
    const spanOf = verbatimSpans(prompt.answer);
    const normalised: Claim[] = [];
    let malformed = 0;
    const missed = { not_verbatim: 0, too_long: 0 };
    for (const raw of read.claims) {
      const claim = normaliseClaim(raw, normalised.length, prompt.answer, spanOf);
      if (claim === 'malformed') malformed += 1;
      else if (typeof claim === 'string') missed[claim] += 1;
      else normalised.push(claim);
    }
    if (malformed > 0) {
      // A broken entry is a claim we cannot read, not one the answer lacks:
      // returning the readable rest would pass off a partial extraction as
      // the whole answer.
      return fail(
        'malformed_entries',
        `${String(malformed)} of ${String(read.claims.length)} ${TOOL_NAME} entries do not match the schema`,
        read.claims.length,
      );
    }
    return {
      ok: true,
      read,
      rawClaims: read.claims,
      normalised,
      missed,
      repaired: repairOf !== undefined,
    };
  }
}

interface ExtractionPrompt {
  readonly system: string;
  readonly user: string;
  /** The answer the model sees — the verbatim guard reads this text. */
  readonly answer: string;
}

type AttemptResult =
  | {
      readonly ok: true;
      readonly read: { readonly calls: number; readonly decoded: boolean };
      readonly rawClaims: unknown[];
      readonly normalised: Claim[];
      readonly missed: { not_verbatim: number; too_long: number };
      readonly repaired: boolean;
    }
  | {
      readonly ok: false;
      readonly code: ExtractionProblemCode;
      readonly problem: string;
      /** Entries the unusable response still listed (see `readToolClaims`). */
      readonly listed: number;
    };

/**
 * What an extraction did not cover: answer text beyond the window the model
 * saw; a raw list that reached the request limit — counted before the
 * verbatim guard, since the model stopped listing either way; claims the
 * guard kept from the checkers because the answer does not hold them;
 * claims longer than a check takes; and, behind a Privacy Shield, claims
 * that do not map back onto the answer the user was shown.
 */
function coverageGaps(extraction: {
  answerLength: number;
  rawClaimCount: number;
  requestLimit: number;
  notInAnswer: number;
  tooLong: number;
  notRestored: number;
}): ExtractionGap[] {
  const gaps: ExtractionGap[] = [];
  if (extraction.answerLength > EXTRACTION_WINDOW_CHARS) gaps.push('answer_beyond_window');
  if (extraction.rawClaimCount >= extraction.requestLimit) gaps.push('claim_list_full');
  if (extraction.notInAnswer > 0) gaps.push('claims_not_in_answer');
  if (extraction.tooLong > 0) gaps.push('claims_too_long');
  if (extraction.notRestored > 0) gaps.push('claims_not_restored');
  return gaps;
}

/**
 * Validate + normalise a single raw claim. An entry without the schema's
 * required fields — a non-empty `text`, a known `type`, a known
 * `expected_source` — is `'malformed'`: a failed extraction, never a claim to
 * drop quietly. A well-formed entry whose text is not in the answer is
 * `'not_verbatim'`, one whose span is longer than `MAX_CLAIM_CHARS`
 * `'too_long'`: either is kept from the checkers, and the caller reports it as
 * a coverage gap. Optional fields that do not parse are left out of the
 * claim.
 */
function normaliseClaim(
  raw: unknown,
  idx: number,
  answer: string,
  spanOf: (claimText: string) => string | undefined,
): Claim | 'malformed' | 'not_verbatim' | 'too_long' {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'malformed';
  const r = raw as RawClaim;

  // The whole text, never a prefix: a claim cut before the guard sees it
  // would be matched — and checked — on its head alone.
  const quoted = typeof r.text === 'string' ? r.text.trim() : '';
  const type = asEnum<ClaimType>(r.type, CLAIM_TYPES);
  const expectedSource = asEnum<ClaimSource>(r.expected_source, CLAIM_SOURCES);
  if (!quoted || !type || !expectedSource) return 'malformed';

  // Anti-hallucination: a claim must quote the answer. Case and whitespace
  // drift are tolerated; the claim then carries the span of the answer.
  const text = spanOf(quoted);
  if (text === undefined) return 'not_verbatim';
  if (text.length > MAX_CLAIM_CHARS) return 'too_long';

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
