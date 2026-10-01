import type { ChatTurnInput, ChatTurnResult } from './orchestrator.js';
import type { RunTracePayload } from './runTraceCollector.js';
import type {
  VerifierPipeline,
  VerifierStore,
  VerifierVerdict,
} from '@omadia/verifier';
import { bindVerdictToClaims } from '@omadia/verifier';
import { mayVerifyAnswer, privacyShieldVerdict } from './verifierDelivery.js';
import {
  extractKnowledgeGraphToolsCalled,
  extractPostconditionViolations,
  extractToolsCalled,
} from './verifierTraceEvidence.js';

export interface VerifierJudgeOptions {
  readonly pipeline: VerifierPipeline;
  readonly store?: VerifierStore;
  readonly mode: 'shadow' | 'enforce';
  readonly log: (msg: string) => void;
}

/**
 * The part of `VerifierService` that talks to the injected pipeline and
 * store: the verdict on one turn's answer, bound to its claims, and the one
 * stored row per verified request.
 */
export class VerifierJudge {
  constructor(private readonly opts: VerifierJudgeOptions) {}

  /**
   * The verdict on one turn's answer (a `done` event or a turn result).
   * `enforce` never hands the pipeline an answer Privacy Shield rendered
   * server-side (`mayVerifyAnswer`): its claim extractor would send the real
   * values the shield kept from the turn's model to the verifier's provider.
   * That answer gets `unavailable` / `privacy_shield`, which withholds it.
   * `shadow` verifies as before.
   */
  async verdictFor(
    runId: string,
    input: ChatTurnInput,
    turn: Pick<ChatTurnResult, 'answer' | 'runTrace' | 'answerSource'>,
  ): Promise<VerifierVerdict> {
    if (this.opts.mode === 'enforce' && !mayVerifyAnswer(turn)) {
      this.opts.log(`[verifier/service] not verified run=${runId}: answer rendered by the privacy shield`);
      return privacyShieldVerdict();
    }
    return this.safeVerify(runId, input, turn.answer, turn.runTrace);
  }

  async safeVerify(
    runId: string,
    input: ChatTurnInput,
    answer: string,
    runTrace: RunTracePayload | undefined,
  ): Promise<VerifierVerdict> {
    const domainToolsCalled = extractToolsCalled(runTrace);
    const toolPostconditionViolations = extractPostconditionViolations(runTrace);
    const knowledgeGraphToolsCalled = extractKnowledgeGraphToolsCalled(runTrace);
    let returned: unknown;
    try {
      returned = await this.opts.pipeline.verify({
        runId,
        userMessage: input.userMessage,
        answer,
        ...(domainToolsCalled ? { domainToolsCalled } : {}),
        ...(toolPostconditionViolations.length > 0
          ? { toolPostconditionViolations }
          : {}),
        ...(knowledgeGraphToolsCalled !== undefined
          ? { knowledgeGraphToolsCalled }
          : {}),
      });
    } catch (err) {
      this.opts.log(`[verifier/service] pipeline FAIL: ${errMsg(err)}`);
      // Nothing was checked. The reason is a closed code: this verdict is
      // summarised onto the stream, the message stays in the log line above.
      return {
        status: 'unavailable',
        reason: 'pipeline_error',
        claims: [],
        latencyMs: 0,
      };
    }
    // Everything below acts on this verdict, so it is bound once, here: the
    // status its claims back, a closed reason. What did not hold is logged
    // with the raw value; the stream only ever sees the bound verdict.
    const bound = bindVerdictToClaims(returned);
    if (bound.problem !== undefined) {
      this.opts.log(`[verifier/service] pipeline verdict not taken as returned: ${bound.problem}`);
    }
    return bound.verdict;
  }

  async persist(
    runId: string,
    input: ChatTurnInput,
    verdict: VerifierVerdict,
    retryCount: number,
  ): Promise<void> {
    const store = this.opts.store;
    if (!store) return;
    try {
      await store.persist({
        input: {
          runId,
          userMessage: input.userMessage,
          answer: '', // intentionally omitted — no PII beyond what's already
          // captured in session_logger/graph. The store only uses `runId`.
        },
        verdict,
        mode: this.opts.mode,
        retryCount,
      });
    } catch (err) {
      this.opts.log(`[verifier/service] persist FAIL: ${errMsg(err)}`);
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
