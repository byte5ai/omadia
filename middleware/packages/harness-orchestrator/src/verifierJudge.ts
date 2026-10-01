import type { ChatTurnInput, ChatTurnResult } from './orchestrator.js';
import type { PrivacyEgressContinuation } from './privacyEgress.js';
import type { RunTracePayload } from './runTraceCollector.js';
import type {
  VerifierPipeline,
  VerifierPrivacy,
  VerifierStore,
  VerifierVerdict,
} from '@omadia/verifier';
import { bindVerdictToClaims } from '@omadia/verifier';
import { privacyShieldVerdict } from './verifierDelivery.js';
import {
  modelFacingUserMessage,
  verifierGate,
  type PrivacyEgressHost,
} from './verifierPrivacyGate.js';
import {
  extractKnowledgeGraphToolsCalled,
  extractPostconditionViolations,
  extractToolsCalled,
} from './verifierTraceEvidence.js';

export interface VerifierJudgeOptions {
  readonly pipeline: VerifierPipeline;
  readonly store?: VerifierStore;
  readonly mode: 'shadow' | 'enforce';
  /** The orchestrator's privacy hand-over surface (feature-detected). */
  readonly host: PrivacyEgressHost;
  readonly log: (msg: string) => void;
}

/**
 * The part of `VerifierService` that talks to the injected pipeline and
 * store: the verdict on one turn's answer, bound to its claims, and the one
 * stored row per verified request.
 *
 * Every pipeline request goes through the privacy view of the pass it
 * verifies — the first run, a borderline resample, a correction retry, the
 * stream's retry: each hands its own continuation over (`privacyEgress.ts`),
 * and `verdictFor` takes the view from it (`verifierGate`). Nothing reaches
 * the verifier's provider unmasked: an answer the verifier may not see is
 * never sent.
 */
export class VerifierJudge {
  constructor(private readonly opts: VerifierJudgeOptions) {}

  /**
   * The verdict on one pass's answer (a `done` event or a turn result),
   * through that pass's privacy gate (`verifierGate`). An answer the verifier
   * may not see — one Privacy Shield rendered server-side (real values the
   * turn's model never saw), or, behind a shield, a pass that handed over no
   * view to verify through — never reaches the pipeline: `enforce` cannot
   * confirm it and records `unavailable` / `privacy_shield`, which withholds
   * it; `shadow` reports nothing (`undefined`).
   */
  async verdictFor(
    runId: string,
    input: ChatTurnInput,
    turn: Pick<ChatTurnResult, 'answer' | 'runTrace' | 'answerSource'>,
    egress: PrivacyEgressContinuation | undefined,
  ): Promise<VerifierVerdict | undefined> {
    const gate = verifierGate(turn.answerSource, egress, this.opts.host);
    if (!gate.verify) {
      this.opts.log(`[verifier/service] verification skipped run=${runId}: ${gate.reason}`);
      return this.opts.mode === 'enforce' ? privacyShieldVerdict() : undefined;
    }
    return this.safeVerify(runId, input, turn.answer, turn.runTrace, gate.privacy);
  }

  async safeVerify(
    runId: string,
    input: ChatTurnInput,
    answer: string,
    runTrace: RunTracePayload | undefined,
    privacy: VerifierPrivacy | undefined,
  ): Promise<VerifierVerdict> {
    const domainToolsCalled = extractToolsCalled(runTrace);
    const toolPostconditionViolations = extractPostconditionViolations(runTrace);
    const knowledgeGraphToolsCalled = extractKnowledgeGraphToolsCalled(runTrace);
    let returned: unknown;
    try {
      returned = await this.opts.pipeline.verify({
        runId,
        // What the turn's model saw — never an MCP input-card envelope.
        userMessage: modelFacingUserMessage(input.userMessage),
        answer,
        ...(domainToolsCalled ? { domainToolsCalled } : {}),
        ...(toolPostconditionViolations.length > 0
          ? { toolPostconditionViolations }
          : {}),
        ...(knowledgeGraphToolsCalled !== undefined
          ? { knowledgeGraphToolsCalled }
          : {}),
        // The pass's privacy view: every model request of the verifier goes
        // through it (absent only when no shield is installed).
        ...(privacy ? { privacy } : {}),
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
