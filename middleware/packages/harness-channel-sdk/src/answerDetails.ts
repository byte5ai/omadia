/**
 * The on-demand details of an answer (spec 2042 §5.14, ADR-0021, #2086).
 *
 * The message body holds what a good colleague would say. Everything that
 * proves or explains the answer stays in the structured `SemanticAnswer` and is
 * reachable on demand: a collapsed element where the channel has one (the
 * registered `answer_details` decoration), the trace in the operator UI, or by
 * asking the agent ("how do you know?"). This module is the ONE projection of
 * those fields, so every channel shows the same facts in its own form instead
 * of each channel reading the answer's fields on its own.
 *
 * Nothing here is rendered into the message body.
 */

import type { Speaker } from '@omadia/plugin-api';
import type { AgentConsultation, SemanticAnswer, VerifierBadge } from './outgoing.js';

export interface AnswerDetails {
  readonly speaker?: Speaker;
  /** The fact check, when a check settled at least one claim. */
  readonly verification?: VerifierBadge['status'];
  /** Colleagues whose delivered contributions are part of this answer. */
  readonly consulted: readonly { readonly name: string; readonly status: 'delivered' | 'failed' }[];
  /** Specialists the harness's run trace shows were invoked (not the model's claim). */
  readonly specialistsInvoked: readonly AgentConsultation[];
  /** The answer-size level the answer was generated under. */
  readonly answerSize?: 'concise' | 'standard' | 'detailed';
  /** Aggregate counts of the privacy receipt; never values. */
  readonly privacy?: { readonly fieldsMasked: number; readonly datasetsInterned: number };
  /** The answer carries values rendered server-side that the model never saw. */
  readonly systemData: boolean;
  /** Memory could have changed this answer. */
  readonly memoryUsed: boolean;
}

/**
 * Project the details of an answer, or `undefined` when there is nothing to
 * show (a plain answer with no check, no colleague, no system data): channels
 * then render no details element at all.
 */
export function buildAnswerDetails(answer: SemanticAnswer): AnswerDetails | undefined {
  const consulted = (answer.contributions ?? []).map((c) => ({
    name: c.speaker.displayName,
    status: c.status,
  }));
  const specialistsInvoked = answer.agentsConsulted ?? [];
  const verification = answer.verifier?.status;
  const privacy = answer.privacyReceipt
    ? {
        fieldsMasked: answer.privacyReceipt.fieldsMasked,
        datasetsInterned: answer.privacyReceipt.datasetsInterned,
      }
    : undefined;
  const systemData = (answer.maskedValues?.length ?? 0) > 0 || answer.answerSource === 'privacy-render';
  const memoryUsed = answer.memoryUsed === true;
  const answerSize = answer.answerVerbosity?.effective as AnswerDetails['answerSize'];
  if (
    verification === undefined &&
    consulted.length === 0 &&
    specialistsInvoked.length === 0 &&
    privacy === undefined &&
    !systemData &&
    !memoryUsed
  ) {
    return undefined;
  }
  return {
    ...(answer.speaker ? { speaker: answer.speaker } : {}),
    ...(verification ? { verification } : {}),
    consulted,
    specialistsInvoked,
    ...(answerSize ? { answerSize } : {}),
    ...(privacy ? { privacy } : {}),
    systemData,
    memoryUsed,
  };
}

const VERIFICATION_TEXT: Record<'de' | 'en', Record<VerifierBadge['status'], string>> = {
  de: {
    verified: 'Alle Angaben geprüft.',
    partial: 'Teilweise geprüft.',
    corrected: 'Angaben wurden korrigiert.',
    failed: 'Prüfung ergab Widersprüche.',
  },
  en: {
    verified: 'All claims checked.',
    partial: 'Partly checked.',
    corrected: 'Claims were corrected.',
    failed: 'The check found contradictions.',
  },
};

/**
 * The details as short plain lines, for a channel without a collapsed element
 * or for the agent's answer to "how do you know?". `undefined` when empty.
 */
export function answerDetailsText(
  details: AnswerDetails | undefined,
  locale: 'de' | 'en' = 'de',
): string | undefined {
  if (!details) return undefined;
  const de = locale === 'de';
  const lines: string[] = [];
  if (details.verification) lines.push(VERIFICATION_TEXT[locale][details.verification]);
  if (details.systemData) {
    lines.push(de ? 'Angaben stammen direkt aus dem Quellsystem.' : 'Figures come straight from the source system.');
  }
  for (const c of details.consulted) {
    const ok = c.status === 'delivered';
    lines.push(
      de
        ? `${c.name} hat ${ok ? 'beigetragen' : 'nicht antworten können'}.`
        : `${c.name} ${ok ? 'contributed' : 'could not answer'}.`,
    );
  }
  if (details.privacy && details.privacy.fieldsMasked > 0) {
    lines.push(
      de
        ? `${String(details.privacy.fieldsMasked)} Felder wurden maskiert.`
        : `${String(details.privacy.fieldsMasked)} fields were masked.`,
    );
  }
  if (details.memoryUsed) {
    lines.push(de ? 'Frühere Gespräche flossen mit ein.' : 'Earlier conversations were taken into account.');
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}
