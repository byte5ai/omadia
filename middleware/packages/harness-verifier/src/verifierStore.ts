import type { Pool } from 'pg';
import type {
  ClaimVerdict,
  VerifierInput,
  VerifierVerdict,
} from './claimTypes.js';

/**
 * Thin persistence layer for the verifier's telemetry tables (migration
 * 0007). Inserts are fire-and-forget from the orchestrator's point of
 * view: a failing write logs on stderr but never blocks the reply.
 */

export interface VerifierStoreOptions {
  pool: Pool;
  tenant: string;
  log?: (msg: string) => void;
}

export interface PersistVerdictInput {
  input: VerifierInput;
  verdict: VerifierVerdict;
  mode: 'shadow' | 'enforce';
  retryCount: number;
}

export class VerifierStore {
  private readonly pool: Pool;
  private readonly tenant: string;
  private readonly log: (msg: string) => void;

  constructor(opts: VerifierStoreOptions) {
    this.pool = opts.pool;
    this.tenant = opts.tenant;
    this.log =
      opts.log ??
      ((msg: string): void => {
        console.error(msg);
      });
  }

  async persist(opts: PersistVerdictInput): Promise<void> {
    const { input, verdict, mode, retryCount } = opts;
    const { hard, soft } = countByClass(verdict.claims);
    const contradictions =
      verdict.status === 'blocked' ? verdict.contradictions : [];
    const unverifiedCount = countUnverified(verdict);

    try {
      await this.pool.query(
        `INSERT INTO verifier_verdicts
           (tenant, run_id, agent, status, claim_count, hard_count,
            soft_count, contradiction_count, unverified_count, retry_count,
            latency_ms, mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          this.tenant,
          input.runId,
          input.agent ?? null,
          verdict.status,
          verdict.claims.length,
          hard,
          soft,
          contradictions.length,
          unverifiedCount,
          retryCount,
          verdict.latencyMs,
          mode,
        ],
      );
    } catch (err) {
      this.log(
        `[verifier/store] verdict insert failed: ${errMsg(err)} run=${input.runId}`,
      );
    }

    if (contradictions.length === 0) return;

    // Each contradiction as its own row — easier to query regressions per
    // claim type later than packing them into JSONB.
    for (const v of contradictions) {
      if (v.status !== 'contradicted') continue;
      try {
        await this.pool.query(
          `INSERT INTO verifier_contradictions
             (tenant, run_id, claim_id, claim_text, claim_type,
              claimed_value, truth_value, source, agent, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            this.tenant,
            input.runId,
            v.claim.id,
            v.claim.text.slice(0, 500),
            v.claim.type,
            formatValue(v.claim.value),
            formatValue(v.truth),
            v.source,
            input.agent ?? null,
            v.detail ?? null,
          ],
        );
      } catch (err) {
        this.log(
          `[verifier/store] contradiction insert failed: ${errMsg(err)} run=${input.runId} claim=${v.claim.id}`,
        );
      }
    }
  }
}

// --- helpers --------------------------------------------------------------

function countByClass(verdicts: readonly ClaimVerdict[]): {
  hard: number;
  soft: number;
} {
  let hard = 0;
  let soft = 0;
  for (const v of verdicts) {
    const t = v.claim.type;
    if (t === 'amount' || t === 'id' || t === 'date' || t === 'aggregate') {
      hard += 1;
    } else {
      soft += 1;
    }
  }
  return { hard, soft };
}

function countUnverified(verdict: VerifierVerdict): number {
  if (verdict.status === 'approved_with_disclaimer') return verdict.unverified.length;
  if (verdict.status === 'approved') return 0;
  return verdict.claims.filter((v) => v.status === 'unverified').length;
}

function formatValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.slice(0, 500);
  if (typeof v === 'number') return String(v);
  try {
    return JSON.stringify(v).slice(0, 500);
  } catch {
    return String(v).slice(0, 500);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
