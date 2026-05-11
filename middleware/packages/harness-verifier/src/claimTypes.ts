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
  | 'qualitative';// non-numeric statement about an entity ("X ist Kunde seit …")

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
}

/** Badge used by the Teams card to communicate verifier status. */
export type VerifierBadge =
  | 'verified'            // ✓ geprüft
  | 'partial'             // ⚠ teilweise bestätigt
  | 'corrected'           // ↻ korrigiert (after a successful retry)
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
