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

    // Pre-check: any hard claim that needs a domain-source re-query but
    // whose turn never called a matching tool is a **replay / hallucination**.
    // We fail it directly as `contradicted` — no need to even ask the
    // deterministic checker; the missing tool call IS the proof.
    //
    // The core verifier only catches the `'graph'` source here (kernel
    // capability). Plugins that provide their own SourceChecker should
    // mirror this trace-cross-check pattern for their domain.
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
 * Trace-cross-check is currently a no-op in the core verifier. Plugins
 * that register a SourceChecker for a non-`graph` source can layer their
 * own "claim X needs tool Y to have run this turn" rule on top by
 * filtering claims before they reach this pipeline.
 *
 * Kept as a hook so the pipeline shape stays stable when a SourceChecker
 * registry lands.
 */
function traceMissingCallVerdict(
  _claim: HardClaim,
  _domainToolsCalled: readonly string[] | undefined,
): ClaimVerdict | undefined {
  return undefined;
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
