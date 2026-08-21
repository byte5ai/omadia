import type { LlmProvider, LlmResponse, ToolSpec } from '@omadia/llm-provider';
import { textMessage, toolCalls } from '@omadia/llm-provider';
import type {
  Aggregation,
  Claim,
  ClaimSource,
  ClaimType,
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
 *  - On any parser / network failure we return []; the caller treats an
 *    empty claim list as "nothing to verify" and approves the answer. The
 *    trigger router has already decided this turn deserves verification,
 *    so a silent empty-extractor result is a minor telemetry signal but
 *    not a hard fail.
 */

export interface ClaimExtractorOptions {
  /** Provider-agnostic LLM (Anthropic adapter today). Was `anthropic` before
   *  the provider-decoupling migration (phase 2). */
  llm: LlmProvider;
  /** Haiku model id. Defaults to the latest Haiku 4.5. */
  model?: string;
  /** Cap on claims returned. Haiku usually stays well below this. */
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
      maxClaims: opts.maxClaims ?? DEFAULTS.maxClaims,
      maxTokens: opts.maxTokens ?? DEFAULTS.maxTokens,
      log:
        opts.log ??
        ((msg: string): void => {
          console.error(msg);
        }),
    };
  }

  /**
   * Extract claims from the given answer. Never throws; returns [] on any
   * error (network, parse, validation).
   */
  async extract(input: ExtractInput): Promise<Claim[]> {
    const answer = input.answer.trim();
    if (answer.length === 0) return [];

    const system = `You are a claim extractor. Given an assistant answer (in German or English), list EVERY factual claim it makes. A claim is any concrete, verifiable assertion: monetary amounts, record references, dates, named entities, totals.

Strict rules:
- Only include claims whose text appears VERBATIM in the answer.
- Do NOT paraphrase, summarise, translate, or reformulate.
- Do NOT extract the user's question, instructions, or meta-commentary.
- Do NOT invent claims that are "implied" but not stated.
- When in doubt, skip the claim rather than invent one.
- A record reference (invoice, order or document number, numeric record id) is ALWAYS its own claim of type "id" with odoo_record.model and odoo_record.ref/id set — in addition to any qualitative claim about the same record.
- A qualitative claim must be a self-contained statement: include the subject it is about in the verbatim span ("Anna Müller wechselte in die IT-Abteilung"), never a bare fragment ("in die IT-Abteilung"). An independent reviewer will judge the claim WITHOUT seeing the answer.
- Return at most ${String(this.opts.maxClaims)} claims via the ${TOOL_NAME} tool.`;

    const user = `USER MESSAGE:
${truncate(input.userMessage, 2000)}

ASSISTANT ANSWER:
${truncate(answer, 6000)}`;

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
      return [];
    }

    const rawClaims = readToolClaims(response);
    if (rawClaims === null) {
      this.opts.log('[claim-extractor] no tool_use block in response');
      return [];
    }

    const out: Claim[] = [];
    let idx = 0;
    for (const raw of rawClaims.slice(0, this.opts.maxClaims)) {
      const claim = normaliseClaim(raw, idx, answer);
      if (claim) {
        out.push(claim);
        idx += 1;
      }
    }
    this.opts.log(
      `[claim-extractor] extracted=${String(out.length)} raw=${String(rawClaims.length)}`,
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
    return out;
  }
}

function shortSnippet(value: string, max = 300): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

function readToolClaims(response: LlmResponse): unknown[] | null {
  // Defensive: the contract guarantees `content` is an array, but keep the
  // historical "never throws; returns []" invariant against malformed input.
  if (!Array.isArray(response.content)) return null;
  for (const call of toolCalls(response.content)) {
    if (call.name !== TOOL_NAME) continue;
    const input = call.input as { claims?: unknown };
    if (!input || !Array.isArray(input.claims)) return [];
    return input.claims;
  }
  return null;
}

/**
 * Validate + normalise a single raw claim. Rejects anything that doesn't
 * meet minimum invariants (known type, known source, text is verbatim,
 * text length sane). Returns null when the claim should be dropped.
 */
const MAX_CONTEXT_CHARS = 400;

/**
 * #129 — the sentence of `answer` that contains `text` (case-insensitive),
 * or `undefined` when `text` is absent or already spans the whole sentence.
 *
 * Sentence boundaries are `.`, `!`, `?` followed by whitespace/end, or a
 * newline — so "01.03.2023" and "z.B." stay intact. Pure string work, no
 * LLM: the extractor sometimes emits a subject-less fragment ("in die
 * IT-Abteilung") and the judge, which never sees the answer, needs the
 * enclosing sentence to know *who* moved where.
 */
export function claimContext(text: string, answer: string): string | undefined {
  const needle = text.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  const hay = answer.toLowerCase();
  const at = hay.indexOf(needle);
  if (at < 0) return undefined;

  let start = at;
  while (start > 0 && !isSentenceBoundaryBefore(answer, start)) start -= 1;
  let end = at + needle.length;
  while (end < answer.length && !isSentenceBoundaryAfter(answer, end)) end += 1;

  if (end - start > MAX_CONTEXT_CHARS) {
    // Over-long sentence: keep a window around the span, not its head.
    const room = Math.floor((MAX_CONTEXT_CHARS - needle.length) / 2);
    start = Math.max(start, at - room);
    end = Math.min(end, at + needle.length + room);
  }
  const sentence = answer.slice(start, end).trim();
  if (sentence.length === 0 || sentence.toLowerCase() === needle) return undefined;
  return sentence;
}

/** True when position `i` starts a new sentence (previous char ends one). */
function isSentenceBoundaryBefore(s: string, i: number): boolean {
  const prev = s[i - 1];
  if (prev === '\n') return true;
  return (prev === '.' || prev === '!' || prev === '?') && /\s/.test(s[i] ?? ' ');
}

/** True when position `i` (exclusive end) closes a sentence — `i` is the
 *  index just past the terminator. */
function isSentenceBoundaryAfter(s: string, i: number): boolean {
  const ch = s[i - 1];
  if (s[i] === '\n') return true;
  return (ch === '.' || ch === '!' || ch === '?') && (i >= s.length || /\s/.test(s[i] ?? ''));
}

function normaliseClaim(raw: unknown, idx: number, answer: string): Claim | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawClaim;

  const text = asShortString(r.text, 300);
  if (!text) return null;
  // Anti-hallucination: reject claims that don't literally appear in the
  // answer. Case-insensitive to tolerate title-casing drift.
  if (!answer.toLowerCase().includes(text.toLowerCase())) return null;

  const type = asEnum<ClaimType>(r.type, CLAIM_TYPES);
  if (!type) return null;

  const expectedSource = asEnum<ClaimSource>(r.expected_source, CLAIM_SOURCES);
  if (!expectedSource) return null;

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
