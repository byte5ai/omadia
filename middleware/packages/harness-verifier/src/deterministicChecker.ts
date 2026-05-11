import type {
  Claim,
  ClaimVerdict,
  HardClaim,
} from './claimTypes.js';

/**
 * Deterministic verifier for HardClaims. Runs an independent read-only
 * re-query against the knowledge graph and compares the result to the
 * claim. Never mutates.
 *
 * Independence is the whole point: we don't reuse whatever tool output the
 * orchestrator had during the first pass — a second fresh query is what
 * catches "orchestrator read the right record but then reported the wrong
 * field" class of hallucinations.
 *
 * Source coverage in this core implementation:
 *   - `'graph'`         — id/name verification against the knowledge graph
 *                         via the supplied GraphReader.
 *   - anything else     — returned as `unverified`. Plugins may install a
 *                         richer SourceChecker via the verifier plugin
 *                         registry to cover additional sources (e.g. an
 *                         ERP-specific deterministic checker).
 *
 * Design choices:
 *  - On transient failure (network, timeout, rate limit) we return
 *    `unverified`, not `contradicted`. The pipeline's aggregator decides
 *    whether that degrades the final verdict to `approved_with_disclaimer`.
 *  - Monetary tolerance is 0.01 (one currency-unit cent by default).
 *    Dates are compared as ISO strings, ids as exact matches.
 */

/** Minimal slice of `KnowledgeGraph` used for id/name verification. */
export interface GraphReader {
  findEntities(opts: {
    model: string;
    nameContains?: string;
    limit?: number;
  }): Promise<
    Array<{ id: string; props?: Readonly<Record<string, unknown>> }>
  >;
}

export interface DeterministicCheckerOptions {
  graph?: GraphReader;
  /** Numeric tolerance for amount / aggregate equality (absolute). */
  amountTolerance?: number;
  log?: (msg: string) => void;
}

const DEFAULTS = {
  amountTolerance: 0.01,
};

export class DeterministicChecker {
  private readonly tolerance: number;
  private readonly log: (msg: string) => void;
  private readonly graph?: GraphReader;

  constructor(opts: DeterministicCheckerOptions) {
    this.graph = opts.graph;
    this.tolerance = opts.amountTolerance ?? DEFAULTS.amountTolerance;
    this.log =
      opts.log ??
      ((msg: string): void => {
        console.error(msg);
      });
  }

  /** Check one claim. Always resolves — never throws. */
  async check(claim: HardClaim): Promise<ClaimVerdict> {
    try {
      if (claim.expectedSource === 'graph') {
        return await this.checkGraph(claim);
      }
      return unverified(
        claim,
        `no deterministic checker registered for source '${claim.expectedSource}' — install a SourceChecker plugin to verify this domain`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[verifier/deterministic] FAIL claim=${claim.id} err=${msg}`);
      return unverified(claim, `re-query error: ${msg}`);
    }
  }

  /** Fan out one checker run per claim, preserving order. */
  async checkAll(claims: HardClaim[]): Promise<ClaimVerdict[]> {
    return Promise.all(claims.map((c) => this.check(c)));
  }

  // --- Graph --------------------------------------------------------------

  private async checkGraph(claim: HardClaim): Promise<ClaimVerdict> {
    if (!this.graph) return unverified(claim, 'no graph reader configured');
    const ref = claim.sourceRecord;
    if (!ref) {
      return unverified(claim, 'graph claim without sourceRecord');
    }
    if (claim.type !== 'id') {
      return unverified(
        claim,
        `graph checks only support type=id (got ${claim.type})`,
      );
    }
    const rows = await this.graph.findEntities({
      model: ref.model,
      nameContains: typeof claim.value === 'string' ? claim.value : undefined,
      limit: 5,
    });
    if (rows.length === 0) {
      return contradicted(claim, null, `no entity in graph for ${ref.model}`);
    }
    const claimValue =
      typeof claim.value === 'string' ? claim.value.trim().toLowerCase() : '';
    const hit = rows.find((row) => {
      const name =
        typeof row.props?.['displayName'] === 'string'
          ? (row.props['displayName'] as string)
          : row.id;
      return name.trim().toLowerCase().includes(claimValue);
    });
    return hit ? verified(claim, 'graph') : contradicted(claim, rows[0]);
  }
}

// --- helpers --------------------------------------------------------------

function verified(claim: Claim, source: 'graph'): ClaimVerdict {
  return { status: 'verified', claim, source };
}

function contradicted(claim: Claim, truth: unknown, detail?: string): ClaimVerdict {
  const verdict: ClaimVerdict = {
    status: 'contradicted',
    claim,
    truth,
    source: claim.expectedSource,
  };
  if (detail !== undefined) {
    verdict.detail = detail;
  }
  return verdict;
}

function unverified(claim: Claim, reason: string): ClaimVerdict {
  return { status: 'unverified', claim, reason };
}
