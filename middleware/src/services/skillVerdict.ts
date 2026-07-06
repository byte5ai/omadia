import { scanSkillForRisks, type SkillRisk, type SkillRiskCode } from './skillGuard.js';

/**
 * Single source-controlled active verifier version. A truly coordinated
 * rolling-deploy cross-pod version pointer would need a shared config row; one
 * constant per deployed binary is the pragmatic MVP of a single shared source.
 */
export const CURRENT_VERIFIER_VERSION = 'v1';

export type Severity =
  | 'no_signals'
  | 'flagged'
  | 'high_risk'
  | 'scan_failed'
  | 'pending'
  | 'too_large_to_scan';

export interface SkillVerdictRiskCodeEntry {
  readonly code: SkillRiskCode;
  readonly severity: SkillRisk['severity'];
}

export interface SkillVerdictRiskCodesEntry {
  readonly verifier: string;
  readonly risks: readonly SkillVerdictRiskCodeEntry[];
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  no_signals: 0,
  pending: 1,
  // Post-review fix: an LLM-side operational gap (scan_failed /
  // too_large_to_scan) must never outrank a real DETERMINISTIC `flagged`
  // finding — that would hide a genuine content risk behind a merely
  // operational status, contradicting "the LLM layer can only escalate,
  // never soften" (a real deterministic finding is never LLM-side, so this
  // reordering cannot let an LLM problem mask it). `high_risk` still wins
  // over everything; an operational gap still outranks a bare no_signals/
  // pending so it isn't silently invisible either.
  scan_failed: 2,
  too_large_to_scan: 3,
  flagged: 4,
  high_risk: 5,
};

const SEVERE_RISK_CODES = new Set<SkillRiskCode>([
  'data_exfiltration',
  'credential_harvest',
  'silent_permission_escalation',
]);

const RECENT_VERIFIER_RUNS = new Map<string, number>();

/**
 * Total order for verdict aggregation. `pending` is stronger than
 * `no_signals` because work is incomplete; `high_risk` remains the strongest
 * state. `scan_failed`/`too_large_to_scan` rank above `no_signals`/`pending`
 * (an operational gap is still visible when there's otherwise no finding)
 * but BELOW `flagged` — an LLM-side operational problem must never mask a
 * real deterministic content finding.
 */
export function worstSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Escalation-only aggregation for the Phase 1b LLM verifier. Reusing the
 * existing total order means an LLM `no_signals` can never downgrade a
 * deterministic `flagged`/`high_risk`; the more alarming severity always wins.
 */
export function combineWithLlmSeverity(
  deterministic: Severity,
  llm: Severity,
): Severity {
  return worstSeverity(deterministic, llm);
}

/**
 * Deterministic thresholding for the regex verifier: zero findings means
 * `no_signals`, one or two findings means `flagged`, and either 3+ findings or
 * any severe code elevates the verdict to `high_risk`.
 */
export function computeVerdict(
  contentHash: string,
  risks: SkillRisk[],
): { severity: Severity; riskCodes: readonly SkillVerdictRiskCodesEntry[] } {
  void contentHash;
  if (risks.length === 0) {
    return { severity: 'no_signals', riskCodes: [] };
  }
  const hasSevereCode = risks.some((risk) => SEVERE_RISK_CODES.has(risk.code));
  const severity: Severity = hasSevereCode || risks.length >= 3 ? 'high_risk' : 'flagged';
  return {
    severity,
    riskCodes: [
      {
        verifier: 'regex_pattern',
        risks: risks.map((risk) => ({ code: risk.code, severity: risk.severity })),
      },
    ],
  };
}

export interface SkillVerdictRow {
  readonly contentHash: string;
  readonly verifierVersion: string;
  readonly modelId: string;
  readonly promptHash: string;
  readonly severity: Severity;
  readonly riskCodes: readonly SkillVerdictRiskCodesEntry[];
  readonly rationale: string | null;
  readonly computedAt: Date;
}

export interface SkillVerdictStore {
  getVerdict(contentHash: string, verifierVersion: string): Promise<SkillVerdictRow | undefined>;
  upsertVerdict(row: SkillVerdictRow): Promise<void>;
  getAck(contentHash: string, verifierVersion: string): Promise<{ ackedBy: string; ackedAt: Date } | undefined>;
  upsertAck(contentHash: string, verifierVersion: string, ackedBy: string): Promise<void>;
}

/**
 * Cheap in-memory TTL dedupe for bursty duplicate work. This matters much more
 * for Phase 1b's costly LLM verifier; here it only avoids redundant rapid
 * deterministic re-scans. The persistent store lookup remains the correctness
 * mechanism, so callers must never treat this helper as an authorization or
 * cache-truth gate.
 */
export function shouldRunVerifier(
  contentHash: string,
  verifierVersion: string,
  ttlMs = 5000,
): boolean {
  const now = Date.now();
  for (const [key, expiresAt] of RECENT_VERIFIER_RUNS) {
    if (expiresAt <= now) RECENT_VERIFIER_RUNS.delete(key);
  }
  const dedupeKey = `${contentHash}:${verifierVersion}`;
  const expiresAt = RECENT_VERIFIER_RUNS.get(dedupeKey);
  if (expiresAt !== undefined && expiresAt > now) {
    return false;
  }
  RECENT_VERIFIER_RUNS.set(dedupeKey, now + ttlMs);
  return true;
}

/**
 * Cache-aside lookup for the deterministic verdict row. Must never be called
 * synchronously inside `GET /skills` or any other list-render path. The store
 * lookup is the real dedupe/correctness gate; `shouldRunVerifier` is only an
 * optional in-memory optimization for higher layers.
 */
export async function getOrComputeVerdict(
  store: SkillVerdictStore,
  contentHash: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<SkillVerdictRow> {
  const existing = await store.getVerdict(contentHash, CURRENT_VERIFIER_VERSION);
  if (existing) return existing;

  const risks = scanSkillForRisks(frontmatter, body);
  const computed = computeVerdict(contentHash, risks);
  const row: SkillVerdictRow = {
    contentHash,
    verifierVersion: CURRENT_VERIFIER_VERSION,
    modelId: '',
    promptHash: '',
    severity: computed.severity,
    riskCodes: computed.riskCodes,
    rationale: null,
    computedAt: new Date(),
  };
  await store.upsertVerdict(row);
  return row;
}
