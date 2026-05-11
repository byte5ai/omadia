import type Anthropic from '@anthropic-ai/sdk';
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
  anthropic: Anthropic;
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

const toolSpec = {
  name: TOOL_NAME,
  description:
    'Record every factual claim made in the assistant answer. One entry per claim. Only include claims whose text appears VERBATIM in the answer. Do not invent, summarise, or paraphrase. If the answer contains no factual claims, return an empty array.',
  input_schema: {
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
                'amount=money/number+unit; id=record reference; date=calendar date; name=person/customer with context; aggregate=sum/count/avg over a set (especially HR leave totals); qualitative=non-numeric claim about an entity.',
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
    Omit<ClaimExtractorOptions, 'anthropic' | 'log'>
  > & {
    anthropic: Anthropic;
    log: (msg: string) => void;
  };

  constructor(opts: ClaimExtractorOptions) {
    this.opts = {
      anthropic: opts.anthropic,
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
- Return at most ${String(this.opts.maxClaims)} claims via the ${TOOL_NAME} tool.`;

    const user = `USER MESSAGE:
${truncate(input.userMessage, 2000)}

ASSISTANT ANSWER:
${truncate(answer, 6000)}`;

    let response: Anthropic.Messages.Message;
    try {
      response = await this.opts.anthropic.messages.create({
        model: this.opts.model,
        max_tokens: this.opts.maxTokens,
        system,
        tools: [toolSpec],
        tool_choice: { type: 'tool', name: TOOL_NAME },
        messages: [{ role: 'user', content: user }],
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

function readToolClaims(response: Anthropic.Messages.Message): unknown[] | null {
  if (!Array.isArray(response.content)) return null;
  for (const block of response.content) {
    if (block.type !== 'tool_use' || block.name !== TOOL_NAME) continue;
    const input = block.input as { claims?: unknown };
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
