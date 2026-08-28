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
  /** #129 — the sentence of the answer that contains `text`, cut
   *  deterministically by the extractor (no LLM). Present only when it adds
   *  something beyond `text`, i.e. the claim is a fragment ("in die
   *  IT-Abteilung") whose subject lives elsewhere in the sentence. The judge
   *  reads it for disambiguation; it never sees the whole answer. */
  context?: string;
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
/**
 * #132 — a verdict is "borderline" when the verifier produced no
 * contradictions but at least one claim remained `unverified`. Today this
 * is exactly `approved_with_disclaimer`. The gate keeps the predicate
 * encapsulated so the VerifierService and tests share one definition.
 */
export function isBorderlineVerdict(verdict: VerifierVerdict): boolean {
  return verdict.status === 'approved_with_disclaimer';
}

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

/**
 * #129 — a *qualitative* claim is *anchored* when it names a concrete Odoo
 * record (`odooRecord.id` or a document-style `.ref`) with
 * `expectedSource: 'odoo'`. Whether that record EXISTS is checkable
 * deterministically no matter how the extractor typed the claim — Haiku
 * types "INV/2026/0099 ist verbucht" as `id` in some samples and
 * `qualitative` in others.
 *
 * Deliberately narrow (review on PR #781): `name` claims are excluded —
 * an exact `name = "John Doe"` search would refute "Doe, John" and block a
 * correct answer — and a `ref` only counts when it looks like a document
 * sequence (contains a digit), never a bare person/company name.
 * Pure predicate; no I/O.
 */
/** A reference that starts with a non-space and carries at least one digit —
 *  "INV/2026/0042", "SO0123", "RE-4711"; not "ACME GmbH" or "John Doe". */
const DOCUMENT_REF_PATTERN = /^\S.*\d/;

export function hasOdooRecordAnchor(claim: Claim): boolean {
  if (claim.type !== 'qualitative' || claim.expectedSource !== 'odoo') return false;
  const ref = claim.odooRecord;
  if (!ref || typeof ref.model !== 'string' || ref.model.length === 0) return false;
  if (typeof ref.id === 'number' && Number.isInteger(ref.id) && ref.id > 0) return true;
  return typeof ref.ref === 'string' && DOCUMENT_REF_PATTERN.test(ref.ref);
}

/**
 * Per-model fields that may hold a human-readable record reference. `name`
 * is the sequence on customer invoices / orders / pickings, but vendor bills
 * carry the supplier number in `ref`, sale orders the customer's PO in
 * `client_order_ref`, purchase orders the vendor's in `partner_ref`.
 * A model outside this map has no safe reference field → the existence
 * check stays `unverified` (judge decides) instead of guessing.
 */
export const SOFT_ANCHOR_REF_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'account.move': ['name', 'ref'],
  'account.payment': ['name', 'ref'],
  'sale.order': ['name', 'client_order_ref'],
  'purchase.order': ['name', 'partner_ref'],
  'stock.picking': ['name', 'origin'],
  'hr.expense.sheet': ['name'],
};
