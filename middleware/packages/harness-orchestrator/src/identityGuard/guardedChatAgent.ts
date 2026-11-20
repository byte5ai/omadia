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
 * Only model prose is checked. A management-layer notice (`system`), the
 * verifier's withheld notice and the server-rendered data of the privacy
 * shield are not the agent's prose; for a privacy-rendered answer the model
 * layer sees the text with the restored values masked again.
 */

import type { ChatAgent, ChatStreamEvent, SemanticAnswer } from '@omadia/channel-sdk';
import { SYSTEM_SPEAKER, type AgentSpeaker, type SystemNotice } from '@omadia/plugin-api';

import type { AgentAnswerEmitter } from '../management/answerEmitter.js';
import { buildSystemNotice } from '../management/systemNotices.js';

import { SentenceGate, type IdentityGuardResult } from './guard.js';

/** Masks values the privacy shield restored server-side (the model never saw them). */
export function maskRestoredValues(text: string, values: readonly string[] | undefined): string {
  if (!values || values.length === 0) return text;
  let masked = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (value.length > 0) masked = masked.split(value).join('‹masked›');
  }
  return masked;
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
function withheld(passed: string, notice: SystemNotice): { answer: string; system: boolean } {
  const kept = passed.trimEnd();
  return kept.length === 0
    ? { answer: notice.text, system: true }
    : { answer: `${kept}\n\n${notice.text}`, system: false };
}

export function withIdentityGuard<A extends ChatAgent>(inner: A, emitter: AgentAnswerEmitter): A {
  const speaker = emitter.speaker;

  const chat = async (input: Parameters<ChatAgent['chat']>[0]): Promise<SemanticAnswer> => {
    const answer = await inner.chat(input);
    if (answer.speaker?.kind === 'system' || !isAgentProse(answer.answerSource)) return answer;
    const outcome = await emitter.emit({
      type: 'prose',
      speaker,
      text: answer.text,
      ...(answer.maskedValues ? { restoredValues: answer.maskedValues } : {}),
    });
    if (outcome.published) return answer;
    const notice = outcome.replacement.notice;
    return {
      text: notice.text,
      speaker: SYSTEM_SPEAKER,
      systemNotice: notice,
      ...(answer.aiDisclosure ? { aiDisclosure: answer.aiDisclosure } : {}),
    };
  };

  async function* chatStream(
    input: Parameters<ChatAgent['chatStream']>[0],
    observer?: Parameters<ChatAgent['chatStream']>[1],
  ): AsyncGenerator<ChatStreamEvent> {
    const gate = new SentenceGate(emitter.guardFor());
    let failure: Exclude<IdentityGuardResult, { outcome: 'pass' }> | undefined;
    const note = (step: Awaited<ReturnType<SentenceGate['push']>>): ChatStreamEvent | undefined => {
      if (step.kind === 'release') return { type: 'text_delta', text: step.text };
      if (step.kind === 'blocked') {
        failure = step.result;
        emitter.reportGuardResult(step.result);
      }
      return undefined;
    };
    for await (const event of inner.chatStream(input, observer)) {
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
        const segment = event.answer.startsWith(released) ? event.answer.slice(released.length) : undefined;
        const result = await emitter.guardFor(event.maskedValues).check(
          event.answer,
          segment !== undefined && released.length > 0 ? segment : undefined,
        );
        emitter.reportGuardResult(result);
        if (result.outcome !== 'pass') failure = result;
      }
      if (!failure) {
        yield event;
        continue;
      }
      const notice = guardNotice(failure, speaker, emitter.noticeLocale());
      const { answer, system } = withheld(gate.releasedText, notice);
      yield {
        type: 'done',
        answer,
        toolCalls: event.toolCalls,
        iterations: event.iterations,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.aiDisclosure ? { aiDisclosure: event.aiDisclosure } : {}),
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
