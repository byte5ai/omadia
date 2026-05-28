/**
 * Shared type definitions for the answer-verifier pipeline.
 *
 * The pipeline consumes an orchestrator answer + run-trace, extracts
 * factual claims, and produces a Verdict that decides whether the answer
 * is released, blocked for retry, or released with a disclaimer.
 *
 * See docs/plans/answer-verifier-agent.md for the full design.
 */

/** Kind of factual assertion we can recognise inside an answer. */
export type ClaimType =
  | 'amount'      // monetary or numeric value with unit (e.g. "1.234,56 €")
  | 'id'          // record identifier or reference (invoice no., employee id)
  | 'date'        // concrete calendar date or period boundary
  | 'name'        // person / customer / vendor name with contextual assertion
  | 'aggregate'   // sum / count / avg over a set (especially HR leave)
  | 'qualitative' // non-numeric statement about an entity ("X ist Kunde seit …")
  | 'tool_postcondition' // #130 — synthetic claim: a tool returned a value
                          // that didn't match its declared output Zod schema.
                          // Never produced by the LLM-side claim extractor;
                          // verifierPipeline manufactures one per violation
                          // it scans out of the runTrace before extraction.
  | 'citation_missing'; // #131 — synthetic claim: the turn called a
                        // knowledge-graph tool but the answer contains no
                        // `[ref:nodeId]` markers, so any KG-grounded
                        // statement in the answer is structurally
                        // unattributable. Drives the correctionPrompt
                        // retry to force the model to add citations.

/** Which subsystem is authoritative for this claim. */
export type ClaimSource = 'odoo' | 'graph' | 'confluence' | 'unknown';

/** Reference to a specific Odoo record the claim implicitly depends on. */
export interface OdooRecordRef {
  model: string;           // e.g. "account.move", "hr.leave", "res.partner"
  id?: number;
  ref?: string;            // human reference (e.g. "INV/2026/0042")
}

/** Aggregation flavour — relevant only when `type === 'aggregate'`. */
export type Aggregation = 'sum' | 'count' | 'avg' | 'max' | 'min';

/**
 * A single factual claim extracted from the orchestrator answer.
 *
 * `value` is the structured representation (number, ISO date, id) when we
 * could parse one out of `text`; otherwise it stays undefined and the
 * deterministic checker falls back to string comparison.
 */
export interface Claim {
  id: string;                           // local: "c_001"
  text: string;                         // verbatim snippet from the answer
  type: ClaimType;
  expectedSource: ClaimSource;
  value?: number | string;              // parsed numeric or normalised literal
  unit?: string;                        // "€", "h", "d" (days), "%", …
  odooRecord?: OdooRecordRef;
  relatedEntities: string[];            // ["res.partner:42", "hr.employee:7"]
  aggregation?: Aggregation;
}

/** A claim that can be checked deterministically against a source of truth. */
export interface HardClaim extends Claim {
  type: 'amount' | 'id' | 'date' | 'aggregate';
  expectedSource: 'odoo' | 'graph';
}

/** A claim that needs an LLM judge because no deterministic check exists. */
export interface SoftClaim extends Claim {
  type: 'name' | 'qualitative';
}

/** Outcome for a single claim after checking. */
export type ClaimVerdict =
  | { status: 'verified'; claim: Claim; source: ClaimSource }
  | {
      status: 'contradicted';
      claim: Claim;
      truth: unknown;                   // actual value we found
      source: ClaimSource;
      detail?: string;
    }
  | { status: 'unverified'; claim: Claim; reason: string };

/** Aggregated result the orchestrator consumes. */
export type VerifierVerdict =
  | { status: 'approved'; claims: ClaimVerdict[]; latencyMs: number }
  | {
      status: 'approved_with_disclaimer';
      claims: ClaimVerdict[];
      unverified: ClaimVerdict[];
      latencyMs: number;
    }
  | {
      status: 'blocked';
      claims: ClaimVerdict[];
      contradictions: ClaimVerdict[];   // only those with status === 'contradicted'
      latencyMs: number;
    };

/** Inputs the pipeline needs to verify one answer. */
export interface VerifierInput {
  runId: string;
  userMessage: string;
  answer: string;
  /**
   * Which Managed-Agent domain produced the answer (accounting | hr | …).
   * Used only for metrics / contradiction storage; the pipeline itself is
   * domain-agnostic.
   */
  agent?: string;
  /**
   * Names of every tool / sub-agent actually invoked in THIS turn.
   * Example: ["query_odoo_accounting", "memory"]. Used by the trace-cross-
   * check rule: if the orchestrator makes an Odoo-numeric claim without
   * having called any `query_odoo_*` tool in the same turn, the claim is
   * a context-block replay (or hallucination) and we flag it as
   * contradicted — not merely unverified.
   *
   * Empty / missing means "we have no trace evidence either way"; the
   * pipeline then falls back to deterministic re-query (the existing path).
   */
  domainToolsCalled?: readonly string[];
  /**
   * #130 — postcondition violations the bridge detected on tool returns
   * (output Zod schema mismatch). Extracted from the runTrace before the
   * pipeline runs; the pipeline manufactures a synthetic `tool_postcondition`
   * ClaimVerdict with status='contradicted' for each entry. Drives the
   * existing correctionPrompt retry loop.
   */
  toolPostconditionViolations?: readonly {
    toolName: string;
    callId: string;
    agentContext: string;
    issues: readonly string[];
  }[];
  /**
   * #131 — true when the turn called the knowledge-graph (or any KG-backed
   * fetch tool). When set, the verifier scans the answer for
   * `[ref:nodeId]` citation markers; an answer with KG evidence but no
   * markers produces a synthetic `citation_missing` claim that drives the
   * correctionPrompt retry loop.
   *
   * Extracted from the runTrace in `verifierService` alongside
   * `domainToolsCalled`. Undefined ⇒ "no trace evidence" (dev CLI etc.);
   * the pipeline skips the citation check in that case.
   */
  knowledgeGraphToolsCalled?: boolean;
}

/** Badge used by the Teams card to communicate verifier status. */
export type VerifierBadge =
  | 'verified'            // ✓ verified
  | 'partial'             // ⚠ partially confirmed
  | 'corrected'           // ↻ corrected (after a successful retry)
  | 'failed';             // blocked + retry still failed

/**
 * Narrow a generic Claim into a HardClaim when it qualifies for the
 * deterministic checker. Pure predicate; no I/O.
 */
export function isHardClaim(claim: Claim): claim is HardClaim {
  if (claim.expectedSource !== 'odoo' && claim.expectedSource !== 'graph') {
    return false;
  }
  return (
    claim.type === 'amount' ||
    claim.type === 'id' ||
    claim.type === 'date' ||
    claim.type === 'aggregate'
  );
}

export function isSoftClaim(claim: Claim): claim is SoftClaim {
  return claim.type === 'name' || claim.type === 'qualitative';
}
