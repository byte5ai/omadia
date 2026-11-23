/**
 * #2046 — the identity guard on an agent's answers (spec 2042 INV-3, §5.5,
 * ADR-0013). Mandatory, fail-closed, independent of the fact verifier.
 *
 * Streaming: text is released in complete sentences, each checked together
 * with all text released so far ({@link SentenceGate}). Once a check fails or
 * cannot decide, nothing more is released and the `done` event carries an
 * honest `system` notice instead of the rest. Non-streaming: the whole answer
 * is checked before it is returned.
 *
 * Either way the verdict reaches the turn's record ({@link AnswerRecordGate}):
 * the rows the agent wrote get the verdict, a withheld answer's rows lose
 * their text and no facts are learned from it, so no later turn recalls it.
 *
 * Only model prose is checked. A management-layer notice (`system`), the
 * verifier's withheld notice and the server-rendered data of the privacy
 * shield are not the agent's prose; for a privacy-rendered answer the model
 * layer sees the text with the restored values masked again.
 */

import type { ChatAgent, ChatStreamEvent, SemanticAnswer } from '@omadia/channel-sdk';
import {
  SYSTEM_SPEAKER,
  type AgentSpeaker,
  type SystemNotice,
  type TurnIdentityGuardVerdict,
} from '@omadia/plugin-api';

import type { AgentAnswerEmitter } from '../management/answerEmitter.js';
import { buildSystemNotice } from '../management/systemNotices.js';

import {
  AnswerRecordGate,
  runGeneratorWithAnswerRecordGate,
  runWithAnswerRecordGate,
} from './answerRecordGate.js';
import { SentenceGate, usedModelLayer, type IdentityGuardResult } from './guard.js';

/** Masks values the privacy shield restored server-side (the model never saw them). */
export function maskRestoredValues(text: string, values: readonly string[] | undefined): string {
  if (!values || values.length === 0) return text;
  let masked = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (value.length > 0) masked = masked.split(value).join('‹masked›');
  }
  return masked;
}

/**
 * #2085 — what the guard checks of an answer: its prose without the
 * side-channel rows (`textWithoutData`), plus the column labels of its
 * tables (a fast-lane planner writes those). Rows are system data straight
 * from a tool, never the agent's words: a customer named like a colleague
 * must not block an invoice list.
 */
export function proseToCheck(answer: {
  readonly text?: string;
  readonly answer?: string;
  readonly textWithoutData?: string;
  readonly data?: readonly { readonly columns: readonly string[] }[];
}): string {
  const prose = answer.textWithoutData ?? answer.text ?? answer.answer ?? '';
  const labels = (answer.data ?? []).flatMap((d) => d.columns);
  return labels.length > 0 ? `${prose}\n${labels.join(' · ')}` : prose;
}

function isAgentProse(source: string | undefined): boolean {
  // The verifier's notice is the harness's own text, not the agent's prose.
  return source !== 'verifier-blocked';
}

function guardNotice(result: Exclude<IdentityGuardResult, { outcome: 'pass' }>, speaker: AgentSpeaker, locale?: string): SystemNotice {
  return buildSystemNotice(result.outcome === 'blocked' ? 'identity_guard_blocked' : 'identity_guard_unavailable', {
    agent: { slug: speaker.slug, displayName: speaker.displayName, agentId: speaker.agentId },
    ...(locale ? { locale } : {}),
  });
}

/**
 * The published text when a guard check failed: what had already passed,
 * then the notice. Without any passed text the answer IS the notice, from
 * `system`.
 */
/** The guard's verdict as the turn's record stores it (spec 2042, tracing). */
export function recordedGuardVerdict(
  result: IdentityGuardResult,
  latencyMs: number = result.latencyMs,
): TurnIdentityGuardVerdict {
  const layer = usedModelLayer(result) ? 'model' : 'deterministic';
  if (result.outcome === 'pass') return { outcome: 'pass', layer, latencyMs };
  if (result.outcome === 'blocked') {
    return { outcome: 'blocked', layer, latencyMs, ...(result.rule ? { reason: result.rule } : {}) };
  }
  return { outcome: 'unavailable', layer, latencyMs, reason: result.cause };
}

function withheld(passed: string, notice: SystemNotice): { answer: string; system: boolean } {
  const kept = passed.trimEnd();
  return kept.length === 0
    ? { answer: notice.text, system: true }
    : { answer: `${kept}\n\n${notice.text}`, system: false };
}

export function withIdentityGuard<A extends ChatAgent>(inner: A, emitter: AgentAnswerEmitter): A {
  const speaker = emitter.speaker;

  const chat = async (input: Parameters<ChatAgent['chat']>[0]): Promise<SemanticAnswer> => {
    const recordGate = new AnswerRecordGate();
    const answer = await runWithAnswerRecordGate(recordGate, () => inner.chat(input));
    if (answer.speaker?.kind === 'system' || !isAgentProse(answer.answerSource)) {
      void recordGate.resolve({ kept: true });
      return answer;
    }
    const text = proseToCheck(answer);
    const result = await emitter.guardFor(answer.maskedValues).check(text);
    const outcome = await emitter.emit(
      {
        type: 'prose',
        speaker,
        text,
        ...(answer.maskedValues ? { restoredValues: answer.maskedValues } : {}),
      },
      result,
    );
    if (outcome.published) {
      void recordGate.resolve({ kept: true, guard: recordedGuardVerdict(result) });
      return answer;
    }
    // The sender's language, when the turn names it, outranks the agent's.
    const notice = input.locale
      ? buildSystemNotice(outcome.replacement.notice.code, {
          ...(outcome.replacement.notice.agent ? { agent: outcome.replacement.notice.agent } : {}),
          locale: input.locale,
        })
      : outcome.replacement.notice;
    void recordGate.resolve({ kept: false, guard: recordedGuardVerdict(result) });
    return {
      text: notice.text,
      speaker: SYSTEM_SPEAKER,
      systemNotice: notice,
      ...(answer.aiDisclosure ? { aiDisclosure: answer.aiDisclosure } : {}),
      // INV-5: colleagues' delivered blocks are theirs, not A's prose; A
      // being withheld must not suppress them.
      ...(answer.contributions ? { contributions: answer.contributions } : {}),
    };
  };

  async function* chatStream(
    input: Parameters<ChatAgent['chatStream']>[0],
    observer?: Parameters<ChatAgent['chatStream']>[1],
  ): AsyncGenerator<ChatStreamEvent> {
    const gate = new SentenceGate(emitter.guardFor());
    const recordGate = new AnswerRecordGate();
    let failure: Exclude<IdentityGuardResult, { outcome: 'pass' }> | undefined;
    let judged = false;
    let doneLatency = 0;
    const note = (step: Awaited<ReturnType<SentenceGate['push']>>): ChatStreamEvent | undefined => {
      if (step.kind === 'release') return { type: 'text_delta', text: step.text };
      if (step.kind === 'blocked') {
        failure = step.result;
        emitter.reportGuardResult(step.result);
      }
      return undefined;
    };
    const latency = (): number => gate.latencyMs.reduce((sum, ms) => sum + ms, 0) + doneLatency;
    const stream = runGeneratorWithAnswerRecordGate(recordGate, () => inner.chatStream(input, observer));
    for await (const event of stream) {
      if (event.type === 'text_delta') {
        if (failure) continue;
        const out = note(await gate.push(event.text));
        if (out) yield out;
        continue;
      }
      if (event.type === 'text_retract') {
        const dropReleased = gate.retract(event.chars);
        if (dropReleased > 0) yield { type: 'text_retract', chars: dropReleased };
        continue;
      }
      if (event.type !== 'done') {
        yield event;
        continue;
      }
      if (event.speaker?.kind === 'system' || !isAgentProse(event.answerSource)) {
        // A draft the gate already stopped stays withheld from the record.
        void recordGate.resolve(failure ? { kept: false, guard: recordedGuardVerdict(failure, latency()) } : { kept: true });
        yield event;
        continue;
      }
      if (!failure) {
        const out = note(await gate.finish());
        if (out) yield out;
      }
      if (!failure) {
        // `done.answer` is authoritative and may differ from the preview
        // (privacy render, folded disclosure): check what was not checked.
        const released = gate.releasedText;
        const checked = proseToCheck(event);
        const segment = checked.startsWith(released) ? checked.slice(released.length) : undefined;
        const result = await emitter.guardFor(event.maskedValues).check(
          checked,
          segment !== undefined && released.length > 0 ? segment : undefined,
        );
        emitter.reportGuardResult(result);
        doneLatency = result.latencyMs;
        judged = usedModelLayer(result);
        if (result.outcome !== 'pass') failure = result;
      }
      if (!failure) {
        void recordGate.resolve({
          kept: true,
          guard: {
            outcome: 'pass',
            layer: gate.usedModelLayer || judged ? 'model' : 'deterministic',
            latencyMs: latency(),
          },
        });
        yield event;
        continue;
      }
      const notice = guardNotice(failure, speaker, input.locale ?? emitter.noticeLocale());
      const { answer, system } = withheld(gate.releasedText, notice);
      void recordGate.resolve({ kept: false, guard: recordedGuardVerdict(failure, latency()) });
      yield {
        type: 'done',
        answer,
        toolCalls: event.toolCalls,
        iterations: event.iterations,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.aiDisclosure ? { aiDisclosure: event.aiDisclosure } : {}),
        ...(event.contributions ? { contributions: event.contributions } : {}),
        ...(system ? { speaker: SYSTEM_SPEAKER } : {}),
        systemNotice: notice,
      };
    }
  }

  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'chat') return chat;
      if (prop === 'chatStream') return chatStream;
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
