/**
 * Privacy Shield v4 — schema-level PII classifier (Slice 2).
 *
 * The shape classifier's `sensitive-masked` verdict is deny-by-default: it
 * masks plenty of NON-PII (Odoo status enums, model names, ambiguous
 * strings). For leak DETECTION and an honest privacy receipt we need a
 * precise "is this a personal identity value" verdict -- a different concept
 * from "hide it from the LLM".
 *
 * This module asks a cheap Haiku model -- given only the SCHEMA (tool name +
 * field names + JSON types, NEVER any value) -- which fields carry personal
 * identity data. Sending only the schema keeps the v4 invariant intact: no
 * row data reaches an LLM here either.
 *
 * Verdicts are cached by a schema fingerprint; each distinct tool shape is
 * classified once. Cache validation is structural + temporal:
 *   - fingerprint = tool name + sorted `path:type` pairs, so a structural
 *     change (new/renamed field, type change) is a natural cache miss.
 *   - TTL, so a verdict is re-classified after `PII_CACHE_TTL_MS` and a
 *     one-off Haiku misjudgement self-heals.
 *
 * Fail-safe: any LLM error yields an empty verdict and is NOT cached. A
 * wrong/empty verdict can never cause a leak -- deny-by-default masking is
 * the safety net and is wholly independent of this module. This verdict
 * only drives detection / the receipt.
 */

/** The host-LLM call surface this module needs -- a structural subset of
 *  `@omadia/plugin-api`'s `LlmAccessor.complete`, so `ctx.llm.complete` can
 *  be passed straight in. */
export type LlmComplete = (req: {
  readonly model: string;
  readonly system?: string;
  readonly messages: ReadonlyArray<{
    readonly role: 'user' | 'assistant';
    readonly content: string;
  }>;
  readonly maxTokens?: number;
}) => Promise<{ readonly text: string }>;

/** A schema field as offered to the classifier -- path + JSON type, no value. */
export interface SchemaField {
  readonly path: string;
  readonly type: string;
}

/** Haiku model the schema classifier targets. MUST appear in the plugin
 *  manifest's `permissions.llm.models_allowed`. */
export const PII_CLASSIFIER_MODEL = 'claude-haiku-4-5';

/** A cached verdict is re-classified after this long even when the schema is
 *  unchanged -- bounds the lifetime of a one-off Haiku misjudgement. */
export const PII_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheEntry {
  readonly piiPaths: ReadonlySet<string>;
  readonly classifiedAt: number;
}

/**
 * Stable key for a tool-result schema -- tool name + sorted `path:type`
 * pairs. Any structural change yields a different fingerprint, so it is a
 * natural cache miss that triggers a fresh classification.
 */
export function schemaFingerprint(
  toolName: string,
  fields: ReadonlyArray<SchemaField>,
): string {
  const sig = fields
    .map((f) => `${f.path}:${f.type}`)
    .sort()
    .join(',');
  return `${toolName}|${sig}`;
}

/** Build the Haiku prompt -- schema only, never a value. */
export function buildClassifierPrompt(
  toolName: string,
  fields: ReadonlyArray<SchemaField>,
): string {
  const list = fields.map((f) => `- ${f.path} (${f.type})`).join('\n');
  return [
    `A backend tool named "${toolName}" returned rows with these fields:`,
    list,
    '',
    'Which of these fields carry PERSONAL IDENTITY data about an individual',
    '-- a person name, e-mail, phone number, personal/home address, or a',
    'direct handle to one (e.g. an employee or contact id that is paired',
    'with a name)? Status codes, enums, dates, counts, amounts, currency,',
    'model/type names, and opaque numeric ids are NOT personal identity',
    'data. Neither are organisational units and roles -- a department,',
    'team, company, job title/position or category -- even when paired',
    'with an id.',
    '',
    'Answer with ONLY a JSON array of the field paths that carry personal',
    'identity data -- e.g. ["employee","employee_id"]. Empty array if none.',
  ].join('\n');
}

/** Tolerant parse of the Haiku reply -- the first JSON array in the text,
 *  intersected with the known field paths (drops anything hallucinated). */
export function parseClassifierVerdict(
  text: string,
  knownPaths: ReadonlySet<string>,
): Set<string> {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  const out = new Set<string>();
  for (const v of parsed) {
    if (typeof v === 'string' && knownPaths.has(v)) out.add(v);
  }
  return out;
}

export interface PiiSchemaClassifier {
  /**
   * Return the set of field paths that carry personal identity data.
   * Cached by schema fingerprint -- only a cache miss or a TTL-expired entry
   * calls Haiku. Never throws: an LLM failure yields an empty set (and is
   * not cached, so the next call retries).
   */
  classify(
    toolName: string,
    fields: ReadonlyArray<SchemaField>,
  ): Promise<ReadonlySet<string>>;
}

/** Create the cached, Haiku-backed schema PII classifier. */
export function createPiiSchemaClassifier(deps: {
  readonly complete: LlmComplete;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly log?: (msg: string) => void;
}): PiiSchemaClassifier {
  const now = deps.now ?? ((): number => Date.now());
  const ttl = deps.ttlMs ?? PII_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  return {
    async classify(toolName, fields) {
      if (fields.length === 0) return new Set<string>();

      const key = schemaFingerprint(toolName, fields);
      const hit = cache.get(key);
      if (hit !== undefined && now() - hit.classifiedAt < ttl) {
        return hit.piiPaths;
      }

      const knownPaths = new Set(fields.map((f) => f.path));
      let piiPaths: Set<string>;
      try {
        const res = await deps.complete({
          model: PII_CLASSIFIER_MODEL,
          messages: [
            { role: 'user', content: buildClassifierPrompt(toolName, fields) },
          ],
          maxTokens: 256,
        });
        piiPaths = parseClassifierVerdict(res.text, knownPaths);
      } catch (err) {
        // Fail-safe: empty verdict, NOT cached -- deny-by-default masking is
        // unaffected, and the next intern of this schema retries.
        deps.log?.(
          `[privacy-guard v4] pii-classifier: Haiku call failed for ` +
            `tool=${toolName} -- empty verdict (deny-by-default masking ` +
            `still applies): ${err instanceof Error ? err.message : String(err)}`,
        );
        return new Set<string>();
      }

      cache.set(key, { piiPaths, classifiedAt: now() });
      deps.log?.(
        `[privacy-guard v4] pii-classifier: tool=${toolName} ` +
          `fields=${String(fields.length)} ` +
          `pii=[${[...piiPaths].join(',')}]`,
      );
      return piiPaths;
    },
  };
}
