import type {
  Claim,
  ClaimVerdict,
  HardClaim,
  SoftClaim,
  VerifierInput,
  VerifierVerdict,
} from './claimTypes.js';
import { isHardClaim, isSoftClaim } from './claimTypes.js';
import type { ClaimExtractor } from './claimExtractor.js';
import type { DeterministicChecker } from './deterministicChecker.js';
import type { EvidenceJudge } from './evidenceJudge.js';
import { detectFailureReplay } from './failureReplayDetector.js';
import { shouldTriggerVerifier } from './triggerRouter.js';

/**
 * End-to-end verifier pipeline.
 *
 *   answer → triggerRouter → claimExtractor → classify
 *                            ├─► DeterministicChecker (hard claims, parallel)
 *                            └─► EvidenceJudge        (soft claims, parallel)
 *                            → aggregate → VerifierVerdict
 *
 * Never throws. On any failure below the API level the pipeline returns
 * an `approved` verdict — the trigger router decided the answer was worth
 * checking, so a silent extractor failure shouldn't stop the user from
 * seeing the reply. The caller logs the empty-claim case as telemetry.
 */

export interface VerifierPipelineOptions {
  extractor: ClaimExtractor;
  deterministic: DeterministicChecker;
  judge: EvidenceJudge;
  log?: (msg: string) => void;
}

export class VerifierPipeline {
  private readonly extractor: ClaimExtractor;
  private readonly deterministic: DeterministicChecker;
  private readonly judge: EvidenceJudge;
  private readonly log: (msg: string) => void;

  constructor(opts: VerifierPipelineOptions) {
    this.extractor = opts.extractor;
    this.deterministic = opts.deterministic;
    this.judge = opts.judge;
    this.log =
      opts.log ??
      ((msg: string): void => {
        console.error(msg);
      });
  }

  /** Run the full verifier pipeline. Always resolves. */
  async verify(input: VerifierInput): Promise<VerifierVerdict> {
    const started = Date.now();

    // Failure-replay detection runs independent of the trigger router.
    // The classic case: a turn with no numeric content but the answer
    // says "ich sehe keinen Anhang" while the [attachments-info] block
    // is literally present in the user message. The trigger router has
    // no reason to fire for such a turn, but we still need to catch the
    // contradiction.
    const replayVerdicts = detectFailureReplay(input);

    const trigger = shouldTriggerVerifier(input.answer);
    if (!trigger.shouldVerify) {
      // Only the replay verdicts matter here.
      return aggregate(replayVerdicts, started);
    }

    let claims: Claim[];
    try {
      claims = await this.extractor.extract({
        userMessage: input.userMessage,
        answer: input.answer,
      });
    } catch (err) {
      this.log(`[verifier/pipeline] extractor FAIL: ${errMsg(err)}`);
      return aggregate(replayVerdicts, started);
    }

    if (claims.length === 0) {
      this.log(
        `[verifier/pipeline] no claims extracted (trigger=${trigger.reasons.join(',')})`,
      );
      return aggregate(replayVerdicts, started);
    }

    const { hard, soft } = classify(claims);

    // Pre-check: any hard claim that needs Odoo re-query but whose turn
    // never called a `query_odoo_*` tool is a **replay / hallucination**.
    // We fail it directly as `contradicted` — no need to even ask the
    // deterministic checker; the missing tool call IS the proof.
    const traceVerdicts: ClaimVerdict[] = [];
    const hardToActuallyCheck: HardClaim[] = [];
    for (const claim of hard) {
      const replayVerdict = traceMissingCallVerdict(
        claim,
        input.domainToolsCalled,
      );
      if (replayVerdict) {
        traceVerdicts.push(replayVerdict);
      } else {
        hardToActuallyCheck.push(claim);
      }
    }

    // Parallelise hard + soft checks. Each branch is fault-tolerant on its
    // own — we never need to wait on one to start the other.
    const [hardVerdicts, softVerdicts] = await Promise.all([
      this.deterministic.checkAll(hardToActuallyCheck),
      this.judge.checkAll(soft),
    ]);

    const all: ClaimVerdict[] = [
      ...replayVerdicts,
      ...traceVerdicts,
      ...hardVerdicts,
      ...softVerdicts,
    ];
    return aggregate(all, started);
  }
}

// --- helpers --------------------------------------------------------------

/**
 * Which tool names count as "I actually looked at Odoo this turn".
 * Keep the list tight: `query_graph` alone is not enough — the graph is
 * a 6-hourly snapshot, not the source of truth for numbers.
 */
const ODOO_TOOL_PREFIXES: readonly string[] = [
  'query_odoo_',       // fach-agents: query_odoo_accounting, query_odoo_hr
  'odoo_execute',      // raw Odoo RPC (sub-agents + dev)
];

/**
 * If the claim needs Odoo and the turn made NO Odoo tool call, return a
 * contradicted verdict. Otherwise return undefined and let the regular
 * deterministic checker do its thing.
 *
 * `domainToolsCalled === undefined` means "no trace evidence available"
 * (e.g. dev CLI turn without sessionScope). In that case we skip the
 * cross-check — better a false negative than a false positive when we
 * genuinely don't know.
 */
function traceMissingCallVerdict(
  claim: HardClaim,
  domainToolsCalled: readonly string[] | undefined,
): ClaimVerdict | undefined {
  if (claim.expectedSource !== 'odoo') return undefined;
  if (!domainToolsCalled) return undefined;
  const hasOdooCall = domainToolsCalled.some((name) =>
    ODOO_TOOL_PREFIXES.some((p) => name.startsWith(p)),
  );
  if (hasOdooCall) return undefined;
  return {
    status: 'contradicted',
    claim,
    truth: null,
    source: 'odoo',
    detail:
      'Claim ohne Fach-Agent-Call im Turn — Antwort hat keine Live-Daten aus Odoo abgerufen (Kontext-Replay).',
  };
}

function classify(claims: readonly Claim[]): {
  hard: HardClaim[];
  soft: SoftClaim[];
} {
  const hard: HardClaim[] = [];
  const soft: SoftClaim[] = [];
  for (const c of claims) {
    if (isHardClaim(c)) {
      hard.push(c);
    } else if (isSoftClaim(c)) {
      soft.push(c);
    }
    // Claims that fit neither (e.g. amount claim with expectedSource=unknown)
    // are silently dropped — we won't invent a way to check them.
  }
  return { hard, soft };
}

function aggregate(
  verdicts: ClaimVerdict[],
  startedAt: number,
): VerifierVerdict {
  const latencyMs = Date.now() - startedAt;
  const contradictions = verdicts.filter((v) => v.status === 'contradicted');
  const unverified = verdicts.filter((v) => v.status === 'unverified');

  if (contradictions.length > 0) {
    return {
      status: 'blocked',
      claims: verdicts,
      contradictions,
      latencyMs,
    };
  }
  if (unverified.length > 0) {
    return {
      status: 'approved_with_disclaimer',
      claims: verdicts,
      unverified,
      latencyMs,
    };
  }
  return approved(verdicts, startedAt);
}

function approved(claims: ClaimVerdict[], startedAt: number): VerifierVerdict {
  return {
    status: 'approved',
    claims,
    latencyMs: Date.now() - startedAt,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
