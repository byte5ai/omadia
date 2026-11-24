/**
 * Question cards and choice cards as plain text (spec 2042 §5.14 channel
 * parity, #2086). A card is an optional enhancement; this is the path every
 * channel has: a numbered question and a reply the user types.
 *
 * `renderCardAsText` produces the message; `parseCardReply` turns the typed
 * reply into the same typed `CardAnswerValue`s a card submission would carry,
 * so the receiver of the answer cannot tell the difference.
 */

import type { CardAnswerValue, CardOption, CardQuestion, QuestionCard } from '@omadia/plugin-api';

function optionLines(options: readonly CardOption[]): string[] {
  return options.map((option, index) => `${String(index + 1)}) ${option.label}`);
}

function questionText(question: CardQuestion): string[] {
  const lines = [question.label];
  switch (question.kind) {
    case 'single_choice':
      lines.push(...optionLines(question.options));
      break;
    case 'multiple_choice':
      lines.push(...optionLines(question.options), '(mehrere möglich, z. B. 1,3)');
      break;
    case 'ranking':
      lines.push(...optionLines(question.options), '(beste zuerst, z. B. 2,1,3)');
      break;
    case 'consent':
      lines.push(`${question.agreeLabel ?? 'Ja'} oder ${question.objectLabel ?? 'Einwand'}`);
      break;
    case 'assignment':
      if (question.candidates !== 'conversation_members') lines.push(...optionLines(question.candidates));
      if (question.candidates === 'conversation_members') lines.push('(„ich“, wenn du es übernimmst)');
      else lines.push(question.allowVolunteer === true ? '(eine Nummer oder „ich“, wenn du es übernimmst)' : '(eine Nummer)');
      break;
    case 'text':
    case 'number':
    case 'date':
      break;
  }
  return lines;
}

/** The plain-text message for a card. Single question: no numbering of questions. */
export function renderCardAsText(card: QuestionCard): string {
  const parts = [card.title];
  if (card.intro) parts.push(card.intro);
  for (const question of card.questions) parts.push(questionText(question).join('\n'));
  return parts.join('\n\n');
}

export type CardReplyParse =
  | { readonly ok: true; readonly value: CardAnswerValue }
  | { readonly ok: false; readonly reason: string };

const NUMBER_LIST = /^\s*\d+(\s*[,;]\s*\d+)*\s*$/;

function pick(options: readonly CardOption[], raw: string): CardOption | undefined {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return options[Number(trimmed) - 1];
  const lower = trimmed.toLowerCase();
  return options.find((o) => o.label.toLowerCase() === lower || o.id.toLowerCase() === lower);
}

function pickMany(options: readonly CardOption[], raw: string): CardOption[] | undefined {
  const parts = raw.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const chosen: CardOption[] = [];
  for (const part of parts) {
    const option = pick(options, part);
    if (!option || chosen.some((c) => c.id === option.id)) return undefined;
    chosen.push(option);
  }
  return chosen;
}

/**
 * Parse a typed reply to ONE question of a card. Deterministic, no model; a
 * reply that does not fit is `ok: false` so the caller can ask again in words.
 */
export function parseCardReply(question: CardQuestion, reply: string): CardReplyParse {
  const text = reply.trim();
  const fail = (reason: string): CardReplyParse => ({ ok: false, reason });
  switch (question.kind) {
    case 'single_choice': {
      const option = pick(question.options, text);
      return option
        ? { ok: true, value: { questionId: question.id, kind: 'single_choice', optionId: option.id } }
        : fail('no such option');
    }
    case 'multiple_choice': {
      if (!NUMBER_LIST.test(text) && !text.includes(',') && pick(question.options, text) === undefined) {
        return fail('no such option');
      }
      const chosen = pickMany(question.options, text);
      if (!chosen) return fail('no such option');
      if (question.min !== undefined && chosen.length < question.min) return fail('too few options');
      if (question.max !== undefined && chosen.length > question.max) return fail('too many options');
      return {
        ok: true,
        value: { questionId: question.id, kind: 'multiple_choice', optionIds: chosen.map((o) => o.id) },
      };
    }
    case 'ranking': {
      const chosen = pickMany(question.options, text);
      if (!chosen) return fail('no such option');
      const needed = question.ranks ?? question.options.length;
      if (chosen.length !== needed) return fail(`rank exactly ${String(needed)} options`);
      return { ok: true, value: { questionId: question.id, kind: 'ranking', ranking: chosen.map((o) => o.id) } };
    }
    case 'consent': {
      const agree = [question.agreeLabel?.toLowerCase(), 'ja', 'yes', 'ok', 'einverstanden', 'agree'];
      const object = [question.objectLabel?.toLowerCase(), 'nein', 'no', 'einwand', 'object'];
      const [head = '', ...rest] = text.split(/[:\-–]\s*/);
      const word = head.trim().toLowerCase();
      const reason = rest.join(': ').trim();
      if (agree.includes(word)) return { ok: true, value: { questionId: question.id, kind: 'consent', decision: 'agree' } };
      if (object.includes(word)) {
        if (question.reasonRequiredOnObject && reason.length === 0) return fail('an objection needs a reason');
        return {
          ok: true,
          value: { questionId: question.id, kind: 'consent', decision: 'object', ...(reason ? { reason } : {}) },
        };
      }
      return fail('answer yes or object');
    }
    case 'number': {
      const value = Number(text.replace(',', '.'));
      if (!Number.isFinite(value)) return fail('not a number');
      if (question.min !== undefined && value < question.min) return fail('below minimum');
      if (question.max !== undefined && value > question.max) return fail('above maximum');
      return { ok: true, value: { questionId: question.id, kind: 'number', value } };
    }
    case 'date': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return fail('use YYYY-MM-DD');
      return { ok: true, value: { questionId: question.id, kind: 'date', value: text } };
    }
    case 'text': {
      if (text.length === 0) return fail('empty');
      if (question.maxLength !== undefined && text.length > question.maxLength) return fail('too long');
      return { ok: true, value: { questionId: question.id, kind: 'text', text } };
    }
    case 'assignment': {
      // "ich" takes it over: only where the card lets a person volunteer.
      const mayVolunteer = question.allowVolunteer === true;
      if (mayVolunteer && /^(ich|me|self|i)$/i.test(text)) {
        return { ok: true, value: { questionId: question.id, kind: 'assignment', assignee: 'self' } };
      }
      if (question.candidates !== 'conversation_members') {
        const option = pick(question.candidates, text);
        if (option) {
          return {
            ok: true,
            value: {
              questionId: question.id,
              kind: 'assignment',
              assignee: { kind: 'user', id: option.id, displayName: option.label },
            },
          };
        }
      }
      return fail(mayVolunteer ? 'name a candidate or say "ich"' : 'name a candidate');
    }
  }
}
