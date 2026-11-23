// Question cards at the kernel boundary (#2089).
//
// A card comes from a plugin and goes to a channel; an answer comes from a
// channel and goes to a plugin. The kernel trusts neither side for the shape:
// it rebuilds the card from the fields it knows (nothing unknown is handed
// on), refuses what a channel could not render, and stores an answer only in
// the typed form of the contract. Whether an answer MATCHES the card that was
// sent (proposal, question ids, option ids) is the sender's check: the kernel
// does not keep the cards.

import {
  CARD_ID_PATTERN,
  CARD_QUESTION_KINDS,
  type CardAnswerValue,
  type CardOption,
  type CardQuestion,
  type CardQuestionKind,
  type CardSupport,
  type CardUpdate,
  type QuestionCard,
} from '@omadia/plugin-api';

/** The kernel's own ceiling, whatever a channel declares. */
export const MAX_CARD_QUESTIONS = 10;
const MAX_OPTIONS = 25;
const MIN_CHOICE_OPTIONS = 2;
const MAX_TITLE = 300;
const MAX_LABEL = 500;
const MAX_LONG_TEXT = 2000;
const MAX_TEXT_ANSWER_LIMIT = 4000;
const MAX_RESULT_LINES = 40;
const MAX_ANSWERS = MAX_CARD_QUESTIONS;
const MAX_ANSWER_TEXT = 10_000;
const MAX_REF = 512;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

type Read<T> = { readonly value: T } | { readonly error: string };

const isId = (raw: unknown): raw is string => typeof raw === 'string' && CARD_ID_PATTERN.test(raw);
const isText = (raw: unknown, max: number): raw is string =>
  typeof raw === 'string' && raw.trim().length > 0 && raw.length <= max;
const isOptionalText = (raw: unknown, max: number): raw is string | undefined =>
  raw === undefined || (typeof raw === 'string' && raw.length <= max);
const isInstant = (raw: unknown): raw is string => typeof raw === 'string' && !Number.isNaN(Date.parse(raw));
const isCount = (raw: unknown): raw is number => typeof raw === 'number' && Number.isInteger(raw) && raw >= 0;
const isObject = (raw: unknown): raw is Record<string, unknown> =>
  raw !== null && typeof raw === 'object' && !Array.isArray(raw);

function readOptions(raw: unknown, where: string, min: number): Read<CardOption[]> {
  if (!Array.isArray(raw) || raw.length < min || raw.length > MAX_OPTIONS) {
    return { error: `${where} needs ${String(min)}..${String(MAX_OPTIONS)} options` };
  }
  const options: CardOption[] = [];
  for (const option of raw as unknown[]) {
    if (!isObject(option) || !isId(option['id']) || !isText(option['label'], MAX_LABEL)) {
      return { error: `${where}: every option needs an id (A-Z a-z 0-9 _ -, 1..64) and a label` };
    }
    const id = option['id'];
    if (options.some((o) => o.id === id)) return { error: `${where}: option id '${id}' is not unique` };
    options.push({ id, label: option['label'] });
  }
  return { value: options };
}

function readQuestion(raw: unknown, index: number): Read<CardQuestion> {
  const where = `question ${String(index + 1)}`;
  if (!isObject(raw)) return { error: `${where} must be an object` };
  if (!isId(raw['id'])) return { error: `${where}: id must be 1..64 characters of A-Z a-z 0-9 _ -` };
  const at = `question '${raw['id']}'`;
  if (!isText(raw['label'], MAX_LABEL)) return { error: `${at}: label must be 1..${String(MAX_LABEL)} characters` };
  if (!isOptionalText(raw['help'], MAX_LONG_TEXT)) return { error: `${at}: help is too long` };
  if (raw['required'] !== undefined && typeof raw['required'] !== 'boolean') {
    return { error: `${at}: required must be a boolean` };
  }
  const base = {
    id: raw['id'],
    label: raw['label'],
    ...(raw['help'] ? { help: raw['help'] } : {}),
    ...(raw['required'] !== undefined ? { required: raw['required'] } : {}),
  };
  const kind = raw['kind'];
  switch (kind) {
    case 'single_choice': {
      const options = readOptions(raw['options'], at, MIN_CHOICE_OPTIONS);
      return 'error' in options ? options : { value: { ...base, kind, options: options.value } };
    }
    case 'multiple_choice': {
      const options = readOptions(raw['options'], at, MIN_CHOICE_OPTIONS);
      if ('error' in options) return options;
      const { min, max } = raw;
      const count = options.value.length;
      if (min !== undefined && (!isCount(min) || min > count)) return { error: `${at}: min must be 0..${String(count)}` };
      if (max !== undefined && (!isCount(max) || max < 1 || max > count)) {
        return { error: `${at}: max must be 1..${String(count)}` };
      }
      if (min !== undefined && max !== undefined && min > max) return { error: `${at}: min is above max` };
      return {
        value: {
          ...base,
          kind,
          options: options.value,
          ...(min !== undefined ? { min } : {}),
          ...(max !== undefined ? { max } : {}),
        },
      };
    }
    case 'ranking': {
      const options = readOptions(raw['options'], at, MIN_CHOICE_OPTIONS);
      if ('error' in options) return options;
      const { ranks, rankLabels } = raw;
      const count = options.value.length;
      if (ranks !== undefined && (!isCount(ranks) || ranks < 1 || ranks > count)) {
        return { error: `${at}: ranks must be 1..${String(count)}` };
      }
      const expected = ranks ?? count;
      if (
        rankLabels !== undefined &&
        (!Array.isArray(rankLabels) ||
          rankLabels.length !== expected ||
          !rankLabels.every((label) => isText(label, MAX_LABEL)))
      ) {
        return { error: `${at}: rankLabels needs exactly ${String(expected)} labels` };
      }
      return {
        value: {
          ...base,
          kind,
          options: options.value,
          ...(ranks !== undefined ? { ranks } : {}),
          ...(rankLabels !== undefined ? { rankLabels: [...(rankLabels as string[])] } : {}),
        },
      };
    }
    case 'consent': {
      const { agreeLabel, objectLabel, reasonRequiredOnObject } = raw;
      if (!isOptionalText(agreeLabel, MAX_LABEL) || !isOptionalText(objectLabel, MAX_LABEL)) {
        return { error: `${at}: a label is too long` };
      }
      if (reasonRequiredOnObject !== undefined && typeof reasonRequiredOnObject !== 'boolean') {
        return { error: `${at}: reasonRequiredOnObject must be a boolean` };
      }
      return {
        value: {
          ...base,
          kind,
          ...(agreeLabel ? { agreeLabel } : {}),
          ...(objectLabel ? { objectLabel } : {}),
          ...(reasonRequiredOnObject !== undefined ? { reasonRequiredOnObject } : {}),
        },
      };
    }
    case 'assignment': {
      const { candidates, allowVolunteer } = raw;
      if (allowVolunteer !== undefined && typeof allowVolunteer !== 'boolean') {
        return { error: `${at}: allowVolunteer must be a boolean` };
      }
      const volunteer = allowVolunteer !== undefined ? { allowVolunteer } : {};
      if (candidates === 'conversation_members') return { value: { ...base, kind, candidates, ...volunteer } };
      const options = readOptions(candidates, at, 1);
      if ('error' in options) {
        return { error: `${at}: candidates must be 'conversation_members' or a list of options (${options.error})` };
      }
      return { value: { ...base, kind, candidates: options.value, ...volunteer } };
    }
    case 'text': {
      const { multiline, maxLength, mode } = raw;
      if (multiline !== undefined && typeof multiline !== 'boolean') return { error: `${at}: multiline must be a boolean` };
      if (maxLength !== undefined && (!isCount(maxLength) || maxLength < 1 || maxLength > MAX_TEXT_ANSWER_LIMIT)) {
        return { error: `${at}: maxLength must be 1..${String(MAX_TEXT_ANSWER_LIMIT)}` };
      }
      if (mode !== undefined && mode !== 'replace' && mode !== 'append') {
        return { error: `${at}: mode must be 'replace' or 'append'` };
      }
      return {
        value: {
          ...base,
          kind,
          ...(multiline !== undefined ? { multiline } : {}),
          ...(maxLength !== undefined ? { maxLength } : {}),
          ...(mode !== undefined ? { mode } : {}),
        },
      };
    }
    case 'number': {
      const { min, max } = raw;
      const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
      if ((min !== undefined && !finite(min)) || (max !== undefined && !finite(max))) {
        return { error: `${at}: min and max must be numbers` };
      }
      if (min !== undefined && max !== undefined && min > max) return { error: `${at}: min is above max` };
      return { value: { ...base, kind, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) } };
    }
    case 'date':
      return { value: { ...base, kind } };
    default:
      return { error: `${at}: unknown kind '${String(kind)}' (${CARD_QUESTION_KINDS.join(', ')})` };
  }
}

/** Validate a card. Returns the card rebuilt from the known fields, or the
 *  reason it is refused (nothing is posted then). */
export function readQuestionCard(raw: unknown): { card: QuestionCard } | { error: string } {
  if (!isObject(raw)) return { error: 'card must be an object' };
  if (!isId(raw['cardId'])) return { error: 'cardId must be 1..64 characters of A-Z a-z 0-9 _ -' };
  if (!isText(raw['title'], MAX_TITLE)) return { error: `title must be 1..${String(MAX_TITLE)} characters` };
  if (!isOptionalText(raw['intro'], MAX_LONG_TEXT)) return { error: 'intro is too long' };
  const { proposalId, proposalVersion, closesAt, changeable, locale } = raw;
  if (proposalId !== undefined && !isText(proposalId, MAX_REF)) return { error: 'proposalId must be 1..512 characters' };
  if (proposalVersion !== undefined && !isCount(proposalVersion)) {
    return { error: 'proposalVersion must be a non-negative integer' };
  }
  if (closesAt !== undefined && !isInstant(closesAt)) return { error: 'closesAt must be an ISO 8601 timestamp' };
  if (changeable !== undefined && typeof changeable !== 'boolean') return { error: 'changeable must be a boolean' };
  if (locale !== undefined && !isText(locale, 35)) return { error: 'locale must be a BCP 47 tag' };
  const rawQuestions = raw['questions'];
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > MAX_CARD_QUESTIONS) {
    return { error: `a card needs 1..${String(MAX_CARD_QUESTIONS)} questions` };
  }
  const questions: CardQuestion[] = [];
  for (const [index, rawQuestion] of (rawQuestions as unknown[]).entries()) {
    const question = readQuestion(rawQuestion, index);
    if ('error' in question) return question;
    if (questions.some((q) => q.id === question.value.id)) {
      return { error: `question id '${question.value.id}' is not unique` };
    }
    questions.push(question.value);
  }
  return {
    card: {
      cardId: raw['cardId'],
      ...(proposalId !== undefined ? { proposalId } : {}),
      ...(proposalVersion !== undefined ? { proposalVersion } : {}),
      title: raw['title'],
      ...(raw['intro'] ? { intro: raw['intro'] } : {}),
      questions,
      ...(closesAt !== undefined ? { closesAt } : {}),
      ...(changeable !== undefined ? { changeable } : {}),
      ...(locale !== undefined ? { locale } : {}),
    },
  };
}

/** A channel's declaration, read defensively: it comes from a plugin. */
export function readCardSupport(raw: unknown): CardSupport | undefined {
  if (!isObject(raw) || !Array.isArray(raw['kinds'])) return undefined;
  const kinds = CARD_QUESTION_KINDS.filter((kind) => (raw['kinds'] as unknown[]).includes(kind));
  const declared = raw['maxQuestions'];
  const maxQuestions = isCount(declared) && declared >= 1 ? Math.min(declared, MAX_CARD_QUESTIONS) : 1;
  return kinds.length > 0 ? { kinds, maxQuestions, update: raw['update'] === true } : undefined;
}

/**
 * Why this channel cannot show this card, or `undefined` when it can. The
 * sentence goes back to the sender as a `channel_error`, so it names what to
 * fall back from.
 */
export function cardRefusalFor(card: QuestionCard, support: CardSupport | undefined, channelType: string): string | undefined {
  if (!support) return `the '${channelType}' channel plugin does not declare question cards`;
  const missing: CardQuestionKind[] = [];
  for (const question of card.questions) {
    if (!support.kinds.includes(question.kind) && !missing.includes(question.kind)) missing.push(question.kind);
  }
  if (missing.length > 0) {
    return `the '${channelType}' channel plugin does not declare the question kind${missing.length > 1 ? 's' : ''} ${missing.join(', ')} (it declares ${support.kinds.join(', ')})`;
  }
  if (card.questions.length > support.maxQuestions) {
    return `the '${channelType}' channel plugin shows at most ${String(support.maxQuestions)} question${support.maxQuestions === 1 ? '' : 's'} on a card; this one has ${String(card.questions.length)}`;
  }
  return undefined;
}

/** Validate a card update. */
export function readCardUpdate(raw: unknown): { update: CardUpdate } | { error: string } {
  if (!isObject(raw)) return { error: 'update must be an object' };
  if (raw['state'] === 'open') {
    const card = readQuestionCard(raw['card']);
    return 'error' in card ? card : { update: { state: 'open', card: card.card } };
  }
  if (raw['state'] !== 'closed') return { error: "update.state must be 'closed' or 'open'" };
  if (!isText(raw['title'], MAX_TITLE)) return { error: `title must be 1..${String(MAX_TITLE)} characters` };
  if (!isInstant(raw['closedAt'])) return { error: 'closedAt must be an ISO 8601 timestamp' };
  const lines = raw['resultLines'];
  if (!Array.isArray(lines) || lines.length > MAX_RESULT_LINES || !lines.every((line) => isText(line, MAX_LABEL))) {
    return { error: `resultLines must be at most ${String(MAX_RESULT_LINES)} non-empty lines of up to ${String(MAX_LABEL)} characters` };
  }
  return {
    update: { state: 'closed', title: raw['title'], resultLines: [...(lines as string[])], closedAt: raw['closedAt'] },
  };
}

function readAnswer(raw: unknown): CardAnswerValue | undefined {
  if (!isObject(raw) || !isId(raw['questionId'])) return undefined;
  const questionId = raw['questionId'];
  const ids = (list: unknown): list is string[] =>
    Array.isArray(list) && list.length <= MAX_OPTIONS && list.every(isId) && new Set(list).size === list.length;
  switch (raw['kind']) {
    case 'single_choice':
      return isId(raw['optionId']) ? { questionId, kind: 'single_choice', optionId: raw['optionId'] } : undefined;
    case 'multiple_choice':
      return ids(raw['optionIds']) ? { questionId, kind: 'multiple_choice', optionIds: [...raw['optionIds']] } : undefined;
    case 'ranking':
      return ids(raw['ranking']) && raw['ranking'].length > 0
        ? { questionId, kind: 'ranking', ranking: [...raw['ranking']] }
        : undefined;
    case 'consent': {
      const { decision, reason } = raw;
      if ((decision !== 'agree' && decision !== 'object') || !isOptionalText(reason, MAX_ANSWER_TEXT)) return undefined;
      return { questionId, kind: 'consent', decision, ...(reason ? { reason } : {}) };
    }
    case 'assignment': {
      const { assignee } = raw;
      if (assignee === 'self') return { questionId, kind: 'assignment', assignee };
      if (!isObject(assignee) || !isText(assignee['kind'], 64) || !isText(assignee['id'], MAX_REF)) return undefined;
      const displayName = assignee['displayName'];
      return {
        questionId,
        kind: 'assignment',
        assignee: {
          kind: assignee['kind'],
          id: assignee['id'],
          ...(isText(displayName, 256) ? { displayName } : {}),
        },
      };
    }
    case 'text':
      return typeof raw['text'] === 'string' && raw['text'].length <= MAX_ANSWER_TEXT
        ? { questionId, kind: 'text', text: raw['text'] }
        : undefined;
    case 'number':
      return typeof raw['value'] === 'number' && Number.isFinite(raw['value'])
        ? { questionId, kind: 'number', value: raw['value'] }
        : undefined;
    case 'date':
      return typeof raw['value'] === 'string' && ISO_DATE.test(raw['value']) && !Number.isNaN(Date.parse(raw['value']))
        ? { questionId, kind: 'date', value: raw['value'] }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The typed part of a card answer as a channel stated it: `undefined` fields
 * were not stated. `error` = stated, but not in the contract's form; the
 * event is refused then, because a structured answer is never stored as
 * something else.
 */
export function readCardAnswerFields(answer: {
  proposalId?: unknown;
  proposalVersion?: unknown;
  answers?: unknown;
}): Read<{ proposalId?: string; proposalVersion?: number; answers?: CardAnswerValue[] }> {
  const { proposalId, proposalVersion, answers } = answer;
  if (proposalId !== undefined && !isText(proposalId, MAX_REF)) return { error: 'cardAnswer.proposalId' };
  if (proposalVersion !== undefined && !isCount(proposalVersion)) return { error: 'cardAnswer.proposalVersion' };
  let typed: CardAnswerValue[] | undefined;
  if (answers !== undefined) {
    if (!Array.isArray(answers) || answers.length > MAX_ANSWERS) return { error: 'cardAnswer.answers' };
    typed = [];
    for (const raw of answers as unknown[]) {
      const one = readAnswer(raw);
      if (!one || typed.some((a) => a.questionId === one.questionId)) return { error: 'cardAnswer.answers' };
      typed.push(one);
    }
  }
  return {
    value: {
      ...(proposalId !== undefined ? { proposalId } : {}),
      ...(proposalVersion !== undefined ? { proposalVersion } : {}),
      ...(typed !== undefined ? { answers: typed } : {}),
    },
  };
}
