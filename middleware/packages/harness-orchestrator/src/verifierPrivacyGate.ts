/**
 * How the answer verifier wrapper binds its model requests to the privacy
 * policy of the turn it verifies.
 *
 * The wrapper asks the orchestrator to hand each turn's privacy finalisation
 * over (`markPrivacyFinalizeHeld`), verifies through the continuation it gets
 * back, and finalizes every continuation exactly once. This module holds the
 * bookkeeping and the decisions, so `VerifierService` only wires them:
 *
 *   - {@link EgressLedger}: mark → run → take, and finalize every
 *     continuation once (the returned turn's first, the rest in `finally`).
 *   - {@link StreamEgress}: the same for one streamed turn, whose `done`
 *     carries the receipt once the verifier is done.
 *   - {@link verifierGate}: verify with the turn's privacy view, verify as
 *     before (no shield installed), or skip — never verify raw behind a
 *     shield.
 *   - {@link privacySafeCorrection}: the retry hint carries no truth values
 *     and, behind a shield, is withheld when masking would still alter it.
 *   - {@link carriesUnresolvedPlaceholders}: whether a second answer (re-sample
 *     or retry) may replace the first one the user would otherwise see.
 *   - {@link modelFacingUserMessage}: the prompt the pipeline gets — the one
 *     the turn's model saw, never an MCP input-card envelope.
 */

import type { ChatTurnInput, ChatTurnResult } from './orchestrator.js';
import type { PrivacyReceipt } from '@omadia/plugin-api';
import type { VerifierPrivacy, VerifierVerdict } from '@omadia/verifier';
import { buildCorrectionPrompt } from '@omadia/verifier';

import { mcpInputReplyLabel, parseMcpInputReply } from './mcp/pendingMcpInput.js';
import type { PrivacyEgressContinuation } from './privacyEgress.js';

/**
 * The orchestrator surface the wrapper needs for the hand-over. Optional so
 * a stub orchestrator (tests, a host that predates it) keeps working — its
 * turns then finalize themselves, as before.
 */
export interface PrivacyEgressHost {
  markPrivacyFinalizeHeld?(input: ChatTurnInput): void;
  takePrivacyEgress?(input: ChatTurnInput): PrivacyEgressContinuation | undefined;
  isPrivacyGuardActive?(): boolean;
}

/** One orchestrator turn plus the privacy continuation it handed over. */
export interface EgressTurn {
  readonly result: ChatTurnResult;
  readonly egress: PrivacyEgressContinuation | undefined;
}

/**
 * Tracks the continuations of one wrapped `chat()` call — first turn,
 * borderline re-sample, correction retry — so each is finalized exactly
 * once, including on the error path.
 */
export class EgressLedger {
  private readonly open = new Set<PrivacyEgressContinuation>();

  constructor(
    private readonly host: PrivacyEgressHost,
    private readonly log: (msg: string) => void,
  ) {}

  /** Mark `input` as held, run the turn, collect its continuation. */
  async runTurn(
    input: ChatTurnInput,
    run: () => Promise<ChatTurnResult>,
  ): Promise<EgressTurn> {
    this.host.markPrivacyFinalizeHeld?.(input);
    try {
      const result = await run();
      return { result, egress: this.collect(input) };
    } catch (err) {
      // A thrown turn hands nothing over; collect defensively anyway.
      this.collect(input);
      throw err;
    }
  }

  /** Finalize one turn's continuation (for the turn being returned). */
  async settle(turn: EgressTurn): Promise<PrivacyReceipt | undefined> {
    if (turn.egress === undefined) return undefined;
    this.open.delete(turn.egress);
    return settleQuietly(turn.egress, this.log);
  }

  /** Finalize everything not settled yet (discarded turns, error paths). */
  async settleAll(): Promise<void> {
    const pending = [...this.open];
    this.open.clear();
    await Promise.all(pending.map((egress) => settleQuietly(egress, this.log)));
  }

  private collect(input: ChatTurnInput): PrivacyEgressContinuation | undefined {
    const egress = this.host.takePrivacyEgress?.(input);
    if (egress !== undefined) this.open.add(egress);
    return egress;
  }
}

/**
 * The hand-over of one streamed turn: taken once — at its `done`, or at the
 * latest when the stream is over — and finalized exactly once, after the
 * verifier or, when the stream ended early or threw, in the caller's
 * `finally`.
 */
export class StreamEgress {
  #egress: PrivacyEgressContinuation | undefined;
  #taken = false;
  #settled = false;

  constructor(
    private readonly host: PrivacyEgressHost,
    private readonly input: ChatTurnInput,
    private readonly log: (msg: string) => void,
  ) {}

  /** The continuation the turn handed over, or `undefined` (no shield, or
   *  nothing handed over yet). Taken from the host on the first call. */
  take(): PrivacyEgressContinuation | undefined {
    if (!this.#taken) {
      this.#taken = true;
      this.#egress = this.host.takePrivacyEgress?.(this.input);
    }
    return this.#egress;
  }

  /** `done` as it goes out: the turn finalized, its receipt attached. */
  async finishDone<T extends { readonly type: 'done' }>(done: T): Promise<T> {
    const egress = this.take();
    if (egress === undefined) return done;
    this.#settled = true;
    const receipt = await settleQuietly(egress, this.log);
    return receipt ? { ...done, privacyReceipt: receipt, receiptId: egress.receiptId } : done;
  }

  /** Finalizes a continuation nobody finished (an early exit, a throw). */
  async settleUnfinished(): Promise<void> {
    const egress = this.take();
    if (egress === undefined || this.#settled) return;
    this.#settled = true;
    await settleQuietly(egress, this.log);
  }
}

/**
 * The streamed passes of one request — the first run and, in `enforce`, its
 * correction retry. Each is marked held before its stream starts and
 * finalized exactly once: before the request's merged receipt is read, or in
 * the caller's `finally`.
 */
export class StreamPasses {
  readonly #passes: StreamEgress[] = [];

  constructor(
    private readonly host: PrivacyEgressHost,
    private readonly log: (msg: string) => void,
  ) {}

  /** Marks the next turn run with `input` held and tracks its hand-over.
   *  Call before that pass's `chatStream` starts. */
  open(input: ChatTurnInput): StreamEgress {
    this.host.markPrivacyFinalizeHeld?.(input);
    const egress = new StreamEgress(this.host, input, this.log);
    this.#passes.push(egress);
    return egress;
  }

  /** Finalizes every pass not finalized yet, in the order they ran. */
  async settleAll(): Promise<void> {
    for (const pass of this.#passes) await pass.settleUnfinished();
  }
}

/**
 * The caller's user message as the turn's model received it, before masking:
 * an MCP input-card reply becomes its label (field names only), exactly as
 * `runTurn` / `chatStream` normalise it. The envelope's values were typed for
 * a third-party server and may be secrets, so the verifier pipeline never
 * gets them — with a shield (server-side checks only) or without one (the
 * extractor's request then carries this text).
 */
export function modelFacingUserMessage(userMessage: string): string {
  const reply = parseMcpInputReply(userMessage);
  return reply === undefined ? userMessage : mcpInputReplyLabel(reply);
}

/**
 * True when `turn`'s restored answer still carries placeholders of its own
 * turn: the model wrote one back in another spelling ("10.000 €" for
 * "€10000", "1970-01-01" for "01.01.1970"), restore could not map it back,
 * and the user would read a fake value. `false` for a turn that handed
 * nothing over (no shield, nothing masked). Must run before the turn's
 * continuation is finalized — finalize drops the map it reads.
 */
export async function carriesUnresolvedPlaceholders(turn: EgressTurn): Promise<boolean> {
  if (turn.egress === undefined) return false;
  return (await turn.egress.countUnresolvedSurrogates(turn.result.answer)) > 0;
}

/** `finalize()` that never throws — the answer outranks the receipt row. */
export async function settleQuietly(
  egress: PrivacyEgressContinuation,
  log: (msg: string) => void,
): Promise<PrivacyReceipt | undefined> {
  try {
    return await egress.finalize();
  } catch (err) {
    log(
      `[verifier/service] privacy finalize FAIL: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

export type VerifierGate =
  | { readonly verify: true; readonly privacy?: VerifierPrivacy }
  | { readonly verify: false; readonly reason: string };

/**
 * Whether — and through which view — a turn's answer may be verified.
 *
 *   - a server-rendered v4 answer holds real values its model never saw:
 *     never verified;
 *   - a continuation came back: verify through its view, or skip when it
 *     has none (Direct Line relay, privacy refusal);
 *   - a shield is installed but nothing came back: skip rather than send
 *     raw text (fail closed);
 *   - no shield at all: verify as before.
 */
export function verifierGate(
  answerSource: ChatTurnResult['answerSource'],
  egress: PrivacyEgressContinuation | undefined,
  host: PrivacyEgressHost,
): VerifierGate {
  if (answerSource === 'privacy-render') {
    return { verify: false, reason: 'server-rendered answer' };
  }
  if (egress !== undefined) {
    return egress.verifierPrivacy !== undefined
      ? { verify: true, privacy: egress.verifierPrivacy }
      : { verify: false, reason: 'no model answer to verify behind the privacy shield' };
  }
  if (host.isPrivacyGuardActive?.() === true) {
    return { verify: false, reason: 'privacy shield active but no privacy view handed over' };
  }
  return { verify: true };
}

/**
 * The correction hint for a blocked verdict. It never carries what the
 * verifier found out itself — no re-queried truth, no detail derived from it
 * (`buildCorrectionPrompt`): only the contradicted claims, the turn's own
 * tool names and call ids, and fixed text. Behind a shield, when the turn's
 * policy would still alter the hint (the claim spans themselves carry
 * detected values) the retry is withheld altogether, so no
 * placeholder-bearing hint goes to the model. A hint that passes is masked
 * once, by the retry's own turn (`wireExtraSystemHint`), like the user's
 * message — never twice with different maps. Checked against the turn whose
 * verdict the hint corrects, before that turn is finalized: the preview
 * needs its live policy and adds nothing to its receipt.
 */
export async function privacySafeCorrection(
  verdict: VerifierVerdict,
  egress: PrivacyEgressContinuation | undefined,
): Promise<{ readonly correction?: string; readonly withheld: boolean }> {
  const correction = buildCorrectionPrompt(verdict);
  if (correction === undefined) return { withheld: false };
  if (egress !== undefined && (await egress.maskWouldAlter(correction))) {
    return { withheld: true };
  }
  return { correction, withheld: false };
}
