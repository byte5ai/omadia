/**
 * Privacy-Shield v2 — Slice S-6 — ChatTurnResult ↔ egress-filter glue.
 *
 * The privacy-guard service speaks in opaque `{ id, text }` slots so
 * it stays channel-agnostic. This module knows the shape of the
 * kernel's `ChatTurnResult` and serialises it into the flat slot
 * vocabulary, then re-merges the egress filter's replacements back
 * into the structural payload.
 *
 * Slot IDs are deterministic so a `replacements` map shipped from
 * the filter can be applied without preserving order. Each slot
 * corresponds to a single user-facing text region:
 *
 *   - `answer`                           → result.answer
 *   - `interactive.question`             → choice / slots / topic question
 *   - `interactive.rationale`            → choice rationale
 *   - `interactive.option.<i>.label`     → choice/topic option labels
 *   - `interactive.topic.<i>.hint`       → topic-hint strings
 *   - `interactive.slot.<i>.label`       → slot-picker row labels
 *   - `interactive.subjectHint`          → slot-picker subjectHint
 *   - `interactive.routine.<i>.name`     → routine-list row name
 *   - `interactive.routine.<i>.prompt`   → routine-list row prompt
 *   - `attachment.<i>.altText`           → attachment alt-text
 *   - `followUp.<i>.label`               → follow-up button label
 *   - `followUp.<i>.prompt`              → follow-up button prompt
 *
 * Empty / undefined slots are skipped; the host never asks the filter
 * to scan an empty string. `applyEgressReplacements` is tolerant of
 * partial replacement maps — slots without a replacement keep their
 * original value.
 */

import type { ChatTurnResult } from './chatAgent.js';

export interface EgressSlot {
  readonly id: string;
  readonly text: string;
}

/**
 * Serialise every user-facing text slot in a `ChatTurnResult` into a
 * flat list the privacy-guard egress filter can scan. The walk is
 * stable — the same result always produces the same slot order, so
 * tests can assert on it.
 */
export function collectEgressSlots(result: ChatTurnResult): EgressSlot[] {
  const out: EgressSlot[] = [];
  pushNonEmpty(out, 'answer', result.answer);

  if (result.pendingUserChoice) {
    pushNonEmpty(out, 'interactive.question', result.pendingUserChoice.question);
    pushNonEmpty(
      out,
      'interactive.rationale',
      result.pendingUserChoice.rationale,
    );
    result.pendingUserChoice.options.forEach((o, i) => {
      pushNonEmpty(out, `interactive.option.${String(i)}.label`, o.label);
    });
  } else if (result.pendingSlotCard) {
    pushNonEmpty(out, 'interactive.question', result.pendingSlotCard.question);
    pushNonEmpty(
      out,
      'interactive.subjectHint',
      result.pendingSlotCard.subjectHint,
    );
    result.pendingSlotCard.slots.forEach((s, i) => {
      pushNonEmpty(out, `interactive.slot.${String(i)}.label`, s.label);
    });
  } else if (result.pendingRoutineList) {
    result.pendingRoutineList.routines.forEach((r, i) => {
      pushNonEmpty(out, `interactive.routine.${String(i)}.name`, r.name);
      pushNonEmpty(out, `interactive.routine.${String(i)}.prompt`, r.prompt);
    });
  }

  if (result.attachments) {
    result.attachments.forEach((a, i) => {
      pushNonEmpty(out, `attachment.${String(i)}.altText`, a.altText);
    });
  }

  if (result.followUpOptions) {
    result.followUpOptions.forEach((f, i) => {
      pushNonEmpty(out, `followUp.${String(i)}.label`, f.label);
      pushNonEmpty(out, `followUp.${String(i)}.prompt`, f.prompt);
    });
  }

  return out;
}

function pushNonEmpty(out: EgressSlot[], id: string, text: string | undefined): void {
  if (text === undefined || text.length === 0) return;
  out.push({ id, text });
}

/**
 * Apply a map of `{ id → replacement-text }` back onto a
 * `ChatTurnResult`. Slots whose id is not in `replacements` (or whose
 * replacement equals the original) keep their structural identity —
 * no copy is made, references are reused so downstream identity
 * checks stay cheap. Slots whose replacement differs are written
 * back into a structurally shallow-copied result.
 *
 * The function never mutates `result`; it returns a new object only
 * if at least one slot changed.
 */
export function applyEgressReplacements(
  result: ChatTurnResult,
  replacements: ReadonlyMap<string, string>,
): ChatTurnResult {
  if (replacements.size === 0) return result;
  let changed = false;
  const next: ChatTurnResult = { ...result };

  const rebound = rebind(replacements, 'answer', result.answer);
  if (rebound !== result.answer) {
    next.answer = rebound;
    changed = true;
  }

  if (result.pendingUserChoice) {
    const q = rebind(
      replacements,
      'interactive.question',
      result.pendingUserChoice.question,
    );
    const r = rebind(
      replacements,
      'interactive.rationale',
      result.pendingUserChoice.rationale,
    );
    const options = result.pendingUserChoice.options.map((o, i) => {
      const lbl = rebind(replacements, `interactive.option.${String(i)}.label`, o.label);
      return lbl === o.label ? o : { ...o, label: lbl };
    });
    if (
      q !== result.pendingUserChoice.question ||
      r !== result.pendingUserChoice.rationale ||
      options.some((o, i) => o !== result.pendingUserChoice?.options[i])
    ) {
      next.pendingUserChoice = {
        ...result.pendingUserChoice,
        question: q,
        ...(r !== undefined ? { rationale: r } : {}),
        options,
      };
      changed = true;
    }
  } else if (result.pendingSlotCard) {
    const q = rebind(
      replacements,
      'interactive.question',
      result.pendingSlotCard.question,
    );
    const h = rebind(
      replacements,
      'interactive.subjectHint',
      result.pendingSlotCard.subjectHint,
    );
    const slots = result.pendingSlotCard.slots.map((s, i) => {
      const lbl = rebind(replacements, `interactive.slot.${String(i)}.label`, s.label);
      return lbl === s.label ? s : { ...s, label: lbl };
    });
    if (
      q !== result.pendingSlotCard.question ||
      h !== result.pendingSlotCard.subjectHint ||
      slots.some((s, i) => s !== result.pendingSlotCard?.slots[i])
    ) {
      next.pendingSlotCard = {
        ...result.pendingSlotCard,
        question: q,
        ...(h !== undefined ? { subjectHint: h } : {}),
        slots,
      };
      changed = true;
    }
  } else if (result.pendingRoutineList) {
    const routines = result.pendingRoutineList.routines.map((r, i) => {
      const name = rebind(replacements, `interactive.routine.${String(i)}.name`, r.name);
      const prompt = rebind(
        replacements,
        `interactive.routine.${String(i)}.prompt`,
        r.prompt,
      );
      if (name === r.name && prompt === r.prompt) return r;
      return { ...r, name, prompt };
    });
    if (routines.some((r, i) => r !== result.pendingRoutineList?.routines[i])) {
      next.pendingRoutineList = {
        ...result.pendingRoutineList,
        routines,
      };
      changed = true;
    }
  }

  if (result.attachments) {
    const attachments = result.attachments.map((a, i) => {
      const alt = rebind(replacements, `attachment.${String(i)}.altText`, a.altText);
      return alt === a.altText ? a : { ...a, altText: alt };
    });
    if (attachments.some((a, i) => a !== result.attachments?.[i])) {
      next.attachments = attachments;
      changed = true;
    }
  }

  if (result.followUpOptions) {
    const followUps = result.followUpOptions.map((f, i) => {
      const lbl = rebind(replacements, `followUp.${String(i)}.label`, f.label);
      const pmt = rebind(replacements, `followUp.${String(i)}.prompt`, f.prompt);
      if (lbl === f.label && pmt === f.prompt) return f;
      return { ...f, label: lbl, prompt: pmt };
    });
    if (followUps.some((f, i) => f !== result.followUpOptions?.[i])) {
      next.followUpOptions = followUps;
      changed = true;
    }
  }

  return changed ? next : result;
}

function rebind<T extends string | undefined>(
  replacements: ReadonlyMap<string, string>,
  id: string,
  current: T,
): T {
  if (current === undefined || current.length === 0) return current;
  const replacement = replacements.get(id);
  if (replacement === undefined || replacement === current) return current;
  return replacement as T;
}

/**
 * Build a new `ChatTurnResult` whose `answer` is the configured
 * block-placeholder and whose interactive / follow-up / attachments
 * are all stripped. The host calls this when the egress filter
 * returns `routing: 'blocked'` so the channel never sees the
 * potentially-PII-bearing payload.
 *
 * Verifier badge, oauth flag, capture disclosure, privacy receipt and
 * the kernel-side observability fields (runTrace, toolCalls, …) are
 * preserved — they are non-content metadata the audit pipeline needs.
 */
export function buildBlockedResult(
  result: ChatTurnResult,
  placeholderText: string,
): ChatTurnResult {
  const out: ChatTurnResult = { ...result };
  out.answer = placeholderText;
  delete out.attachments;
  delete out.followUpOptions;
  delete out.pendingUserChoice;
  delete out.pendingSlotCard;
  delete out.pendingRoutineList;
  return out;
}
