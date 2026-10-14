import type { LlmResponse } from '@omadia/llm-provider';
import { toolCalls } from '@omadia/llm-provider';

/**
 * Reading — and describing — the claim extractor's tool-call response.
 *
 * The extraction contract is one `record_claims` call (or several, read in
 * order) whose input is `{ claims: [...] }`. Everything else is a failed
 * extraction, never an empty one: the caller rejects or makes its one repair
 * attempt (`ClaimExtractor.extract`), it never returns `[]` for a response it
 * could not read.
 *
 * {@link describeExtractionResponse} is the diagnostic for a response that
 * failed the contract. It is CONTENT-FREE by construction: provider metadata,
 * counts, types and field names — never the prompt, the answer, a claim's text
 * or any value of a tool argument. Field names are model output too, so only
 * names from a fixed list (the schema's, common wrappers) are printed; any
 * other key is counted as `<other:N>`.
 */

/** Why a response holds no claims to read. `refused` is the one a repair
 *  cannot fix: the model declined the request. */
export type ExtractionProblemCode =
  | 'truncated'
  | 'refused'
  | 'no_tool_call'
  | 'claims_not_array'
  | 'malformed_entries';

export type ReadToolClaims =
  | {
      readonly ok: true;
      readonly claims: unknown[];
      readonly calls: number;
      /** At least one call carried its list as a JSON-encoded string. */
      readonly decoded: boolean;
    }
  | {
      readonly ok: false;
      readonly code: ExtractionProblemCode;
      readonly problem: string;
      /** Entries the unusable response still listed (a list cut off at the
       *  token limit, or one with broken entries). A repair that returns
       *  fewer may have lost claims. 0 when nothing was listed. */
      readonly listed: number;
    };

/**
 * The claims of every `toolName` call in the response, in order, or why the
 * response has none to read: cut off at the token limit, refused, no such
 * call, or a call whose `claims` is not an array. A model may split its list
 * over several calls; reading only the first would drop the rest.
 *
 * One lossless repair is applied: a `claims` value that is a JSON-encoded
 * string of a NON-EMPTY array (a known tool-use failure mode — the model
 * writes the list as a string literal) is decoded. The entries still go
 * through the caller's full schema and verbatim checks. A string that does
 * not decode to such an array — `"[]"` included, which would otherwise pass
 * an unusable call off as a clean "no claims" — is not a list and fails like
 * any other non-array.
 */
export function readToolClaims(response: LlmResponse, toolName: string): ReadToolClaims {
  // Defensive: the contract guarantees `content` is an array.
  const calls = (Array.isArray(response.content) ? toolCalls(response.content) : []).filter(
    (call) => call.name === toolName,
  );
  const rawLists = calls.map((call) => (call.input as { claims?: unknown } | null | undefined)?.claims);
  // What the response still listed, for a repair that must not return less.
  const listed = rawLists.reduce<number>((n, raw) => n + (Array.isArray(raw) ? raw.length : 0), 0);
  // A call cut off at the token limit can still parse into a claims array —
  // just not the whole one: the rest of the answer was never extracted.
  if (response.finishReason === 'max_tokens') {
    return { ok: false, code: 'truncated', problem: 'response truncated at the token limit', listed };
  }
  // A refusal (the Anthropic adapter reports one as `refusal`) ends the
  // response early too — and what it left is not a list.
  if (response.refusal !== undefined) {
    return { ok: false, code: 'refused', problem: 'the model refused the extraction request', listed };
  }
  if (calls.length === 0) {
    return { ok: false, code: 'no_tool_call', problem: 'no tool_use block in response', listed };
  }
  const lists: unknown[][] = [];
  let decoded = false;
  for (const raw of rawLists) {
    const list = Array.isArray(raw) ? raw : decodeJsonArray(raw);
    // One unreadable call makes the whole list partial, like a broken entry.
    if (list === undefined) {
      return {
        ok: false,
        code: 'claims_not_array',
        problem: `${toolName} call without a claims array`,
        listed,
      };
    }
    if (!Array.isArray(raw)) decoded = true;
    lists.push(list);
  }
  return { ok: true, claims: lists.flat(), calls: calls.length, decoded };
}

/** A JSON-encoded non-empty array, decoded; undefined for anything else. */
function decodeJsonArray(value: unknown): unknown[] | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Field names printed verbatim: the schema's own and the wrappers a model
 * typically invents. Any other key is model-written text — it can carry a
 * name or a number — and is only counted (`<other:N>`).
 */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'claims',
  'claim',
  'items',
  'list',
  'data',
  'input',
  'arguments',
  'parameters',
  'properties',
  'results',
  'entries',
  'text',
  'type',
  'expected_source',
  'value',
  'unit',
  'odoo_record',
  'related_entities',
  'aggregation',
]);

/**
 * Content-free one-line description of an extraction response, for the log:
 * `provider=… model=… finish=…/… refusal=… toolCalls=… [call: name input keys
 * claims] in=… out=…`. Values of tool arguments never appear — only their
 * JSON type, an array's length, a string's length and what it would decode to.
 */
export function describeExtractionResponse(
  response: LlmResponse,
  meta: { readonly providerId: string; readonly toolName: string },
): string {
  const content = Array.isArray(response.content) ? response.content : [];
  const calls = toolCalls(content);
  const callDescriptions = calls.map((call) => {
    const name = call.name === meta.toolName ? call.name : 'other';
    const input: unknown = call.input;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return `${name}(input=${describeType(input)})`;
    }
    const keys = Object.keys(input);
    const safe = keys.filter((k) => KNOWN_KEYS.has(k));
    const other = keys.length - safe.length;
    const keyList = [...safe, ...(other > 0 ? [`<other:${String(other)}>`] : [])].join('|') || '-';
    const claims = (input as Record<string, unknown>)['claims'];
    return `${name}(input=object keys=${keyList} claims=${describeType(claims)})`;
  });
  const usage = response.usage;
  return [
    `provider=${meta.providerId}`,
    `model=${response.model || '-'}`,
    `finish=${response.finishReason}/${response.providerFinishReason ?? '-'}`,
    `refusal=${response.refusal !== undefined ? 'yes' : 'no'}`,
    `textParts=${String(content.filter((p) => p.type === 'text').length)}`,
    `toolCalls=${String(calls.length)}`,
    ...callDescriptions,
    `in=${String(usage?.inputTokens ?? '-')}`,
    `out=${String(usage?.outputTokens ?? '-')}`,
  ].join(' ');
}

/** The JSON type of a value, with sizes — never the value itself. */
function describeType(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${String(value.length)})`;
  if (typeof value === 'string') {
    const decoded = decodeJsonArray(value);
    if (decoded !== undefined) return `string(len=${String(value.length)},json=array(${String(decoded.length)}))`;
    return `string(len=${String(value.length)},json=${jsonKind(value)})`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return `object(keys=${String(keys.length)})`;
  }
  return typeof value;
}

/** What a string would parse to as JSON: a kind, never content. */
function jsonKind(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null) return 'null';
    if (Array.isArray(parsed)) return 'array';
    return typeof parsed;
  } catch {
    return 'invalid';
  }
}
