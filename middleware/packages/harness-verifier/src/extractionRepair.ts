import type { ExtractionProblemCode } from './extractionResponse.js';

/**
 * The claim extractor's one repair attempt: when to make it, what fixed note
 * it carries, and when its result cannot stand. Used by
 * `ClaimExtractor.extract`; the attempt itself — same model, token budget,
 * tool and wire view, admitted and counted like the first call — lives there.
 */

/** A refusal is the model declining the request; asking again is no repair. */
export function isRepairable(code: ExtractionProblemCode): boolean {
  return code !== 'refused';
}

/**
 * Why a well-formed repair cannot stand, or undefined when it can: it lists
 * nothing — after a first response that failed rather than reported no claim
 * — or fewer entries than the first response still showed. Either may have
 * dropped claims; resolving it would pass a partial (or empty) extraction off
 * as the whole answer.
 */
export function repairShortfall(repaired: number, firstListed: number): string | undefined {
  if (repaired === 0) return 'the repair listed no claims after an unusable first response';
  if (repaired < firstListed) {
    return `the repair listed ${String(repaired)} entries, the first response ${String(firstListed)}`;
  }
  return undefined;
}

/**
 * The fixed note a repair attempt carries. Static prose only — it names the
 * contract and what broke it, never anything of the turn — so the request
 * still carries nothing but the turn's wire view and static prose.
 */
export function repairNote(
  code: ExtractionProblemCode,
  schema: {
    readonly toolName: string;
    readonly claimTypes: readonly string[];
    readonly claimSources: readonly string[];
  },
): string {
  const tool = schema.toolName;
  const contract = `Call ${tool} exactly once. Its input must be a JSON object whose "claims" field is a JSON array of claim objects — not a string, not a single claim, not nested under another key. Use an empty array only if the answer makes no factual claim.`;
  switch (code) {
    case 'truncated':
      // Compact without losing what the checks read: `related_entities`
      // scopes an aggregate's Odoo query and `aggregation` picks its
      // operator — dropping either turns a correct total into a false
      // contradiction. `unit` no check reads.
      return `REPAIR: your previous ${tool} call was cut off at the output token limit. ${contract} Keep every entry compact: quote the shortest verbatim span that still names its subject, and leave out unit. Keep value, odoo_record, related_entities and aggregation wherever they apply — the checks need them.`;
    case 'malformed_entries':
      return `REPAIR: some entries of your previous ${tool} call broke the schema. ${contract} Every entry needs a non-empty text, a type from [${schema.claimTypes.join(', ')}] and an expected_source from [${schema.claimSources.join(', ')}].`;
    case 'no_tool_call':
      return `REPAIR: your previous response did not call ${tool}. ${contract}`;
    case 'claims_not_array':
    case 'refused':
      return `REPAIR: your previous ${tool} call had no claims array. ${contract}`;
  }
}
