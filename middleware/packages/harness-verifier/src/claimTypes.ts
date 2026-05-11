/**
 * Shared type definitions for the answer-verifier pipeline.
 *
 * The pipeline consumes an orchestrator answer + run-trace, extracts
 * factual claims, and produces a Verdict that decides whether the answer
 * is released, blocked for retry, or released with a disclaimer.
 *
 * Source-specific deterministic checks (e.g. against an ERP or CRM) live
 * in domain plugins that consume the SourceChecker contract; the core
 * verifier knows only the generic `'graph'` source.
 */

/** Kind of factual assertion we can recognise inside an answer. */
export type ClaimType =
  | 'amount'      // monetary or numeric value with unit (e.g. "1.234,56 €")
  | 'id'          // record identifier or reference
  | 'date'        // concrete calendar date or period boundary
  | 'name'        // person / customer / vendor name with contextual assertion
  | 'aggregate'   // sum / count / avg over a set
  | 'qualitative';// non-numeric statement about an entity

/**
 * Which subsystem is authoritative for this claim.
 *
 * `'graph'` and `'unknown'` are first-class core values. Plugins may add
 * their own opaque source labels (e.g. `'erp.accounting'`); the
 * SourceChecker registry routes claims to the matching plugin.
 */
export type ClaimSource = 'graph' | 'unknown' | string;

/**
 * Reference to a specific source record the claim implicitly depends on.
 * Source-specific (the source-aware extension reads only the fields it
 * understands; the core ignores it).
 */
export interface RecordRef {
  /** Source-defined model / collection / table identifier. */
  model: string;
  /** Primary key inside the source, when known. */
  id?: number;
  /** Human-readable reference label, when known. */
  ref?: string;
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
  /** Opaque reference handed to the matching SourceChecker plugin. */
  sourceRecord?: RecordRef;
  /** Free-form entity hints used by the LLM judge for context. */
  relatedEntities: string[];
  aggregation?: Aggregation;
}

/** A claim that can be checked deterministically against a source of truth. */
export interface HardClaim extends Claim {
  type: 'amount' | 'id' | 'date' | 'aggregate';
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
   * Which sub-agent domain produced the answer. Used only for metrics /
   * contradiction storage; the pipeline itself is domain-agnostic.
   */
  agent?: string;
  /**
   * Names of every tool / sub-agent actually invoked in THIS turn.
   * Used by the trace-cross-check rule: when an answer claims a fresh
   * domain value without a matching tool call in the same turn, the claim
   * is treated as a context-block replay (or hallucination) and flagged
   * as contradicted rather than merely unverified.
   *
   * Empty / missing means "we have no trace evidence either way"; the
   * pipeline then falls back to deterministic re-query (the existing path).
   */
  domainToolsCalled?: readonly string[];
}

/** Badge used by the channel adapter to communicate verifier status. */
export type VerifierBadge =
  | 'verified'            // ✓ checked
  | 'partial'             // ⚠ partially confirmed
  | 'corrected'           // ↻ corrected (after a successful retry)
  | 'failed';             // blocked + retry still failed

/**
 * Narrow a generic Claim into a HardClaim when it qualifies for the
 * deterministic checker. Pure predicate; no I/O.
 */
export function isHardClaim(claim: Claim): claim is HardClaim {
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
