// Spec 2042 §5.14 / §6 criteria 29, 30 — uncluttered answers and channel
// parity through plain text; INV-4 name line; #2087 disclosure frequency.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InMemoryDisclosureMarkerStore,
  InMemoryDisclosureSeenStore,
  InMemorySpeakerHistoryStore,
  answerDetailsText,
  applyAiDisclosure,
  buildAnswerDetails,
  parseCardReply,
  renderCardAsText,
  renderPlainAnswer,
  speakerLine,
  type OutgoingInteractive,
  type SemanticAnswer,
} from '@omadia/channel-sdk';
import { CARD_QUESTION_KINDS, type AgentSpeaker, type CardQuestion, type CardQuestionKind, type QuestionCard } from '@omadia/plugin-api';

const mira: AgentSpeaker = { kind: 'agent', agentId: 'a-mira', slug: 'mira', displayName: 'Mira' };
const jonas: AgentSpeaker = { kind: 'agent', agentId: 'a-jonas', slug: 'jonas', displayName: 'Jonas' };

function plain(answer: SemanticAnswer, history = new InMemorySpeakerHistoryStore(), native = false) {
  return renderPlainAnswer(answer, { nativeIdentity: native, conversationKey: 'c1', speakerHistory: history });
}

describe('speaker name line (INV-4)', () => {
  it('never shows a name line in a one-agent conversation', () => {
    const history = new InMemorySpeakerHistoryStore();
    assert.equal(plain({ text: 'Hallo', speaker: mira }, history), 'Hallo');
    assert.equal(plain({ text: 'Noch eins', speaker: mira }, history), 'Noch eins');
  });

  it('shows it where two agents speak or after a change, never with native identity', () => {
    const history = new InMemorySpeakerHistoryStore();
    plain({ text: 'a', speaker: mira }, history);
    assert.equal(plain({ text: 'b', speaker: jonas }, history), 'Jonas: b');
    assert.equal(plain({ text: 'c', speaker: mira }, history), 'Mira: c');
    const native = new InMemorySpeakerHistoryStore();
    plain({ text: 'a', speaker: mira }, native, true);
    assert.equal(plain({ text: 'b', speaker: jonas }, native, true), 'b');
    assert.equal(speakerLine({ kind: 'system' }, { nativeIdentity: false, previousAgentIds: new Set(['x', 'y']) }), undefined);
  });
});

describe('plain answer (criterion 29: telegram is plain text)', () => {
  it('renders contributions as plain attribution, failed ones too', () => {
    const answer: SemanticAnswer = {
      text: 'Ich habe Jonas gefragt.',
      speaker: mira,
      contributions: [
        { id: 'c1', speaker: jonas, text: 'Das Budget reicht.', status: 'delivered' },
        { id: 'c2', speaker: jonas, text: 'Jonas konnte nicht antworten.', status: 'failed' },
      ],
      // none of these may leak into the plain text
      verifier: { status: 'verified' },
      disclaimer: 'unverified claims',
      followUps: [{ label: 'Mehr', prompt: 'Mehr bitte' }],
      agentsConsulted: [{ label: 'Jonas', status: 'success' }],
    };
    assert.equal(
      plain(answer),
      'Ich habe Jonas gefragt.\n\nJonas: Das Budget reicht.\n\nJonas: Jonas konnte nicht antworten.',
    );
  });

  it('renders a system notice as its own text, never under an agent name', () => {
    const text = plain({
      text: 'x',
      speaker: { kind: 'system' },
      systemNotice: { code: 'agent_disabled', text: 'Mira ist deaktiviert.', locale: 'de', agent: { slug: 'mira', displayName: 'Mira' } },
    });
    assert.equal(text, 'Mira ist deaktiviert.');
  });

  it('degrades a choice card to numbered text', () => {
    const text = plain({
      text: 'Welche Variante?',
      speaker: mira,
      interactive: { kind: 'choice', question: 'Welche?', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
    });
    assert.equal(text, 'Welche Variante?\n\nWelche?\n1) A\n2) B');
  });
});

describe('question cards through plain text (criterion 30)', () => {
  const card: QuestionCard = {
    cardId: 'poll1',
    title: 'Wann treffen wir uns?',
    questions: [
      { id: 'q1', kind: 'single_choice', label: 'Termin', options: [{ id: 'mo', label: 'Montag' }, { id: 'di', label: 'Dienstag' }] },
      { id: 'q2', kind: 'consent', label: 'Einverstanden?', reasonRequiredOnObject: true },
    ],
  };

  it('renders and parses a poll answer by number or label', () => {
    assert.match(renderCardAsText(card), /1\) Montag\n2\) Dienstag/);
    const q1 = card.questions[0]!;
    assert.deepEqual(parseCardReply(q1, '2'), { ok: true, value: { questionId: 'q1', kind: 'single_choice', optionId: 'di' } });
    assert.deepEqual(parseCardReply(q1, 'montag'), { ok: true, value: { questionId: 'q1', kind: 'single_choice', optionId: 'mo' } });
    assert.equal(parseCardReply(q1, '7').ok, false);
  });

  it('parses consent and requires a reason for an objection when asked', () => {
    const q2 = card.questions[1]!;
    assert.deepEqual(parseCardReply(q2, 'ja'), { ok: true, value: { questionId: 'q2', kind: 'consent', decision: 'agree' } });
    assert.equal(parseCardReply(q2, 'einwand').ok, false);
    assert.deepEqual(parseCardReply(q2, 'Einwand: zu teuer'), {
      ok: true,
      value: { questionId: 'q2', kind: 'consent', decision: 'object', reason: 'zu teuer' },
    });
  });
});

/**
 * Criterion 30 — every question kind a card can ask, and every interactive
 * element an answer can carry, has a plain-text form. A new kind fails here
 * (card kinds at run time against CARD_QUESTION_KINDS, interactive kinds at
 * type-check time through the exhaustive record) until it has one.
 */
const CARD_SAMPLES: { readonly [K in CardQuestionKind]: { readonly question: Extract<CardQuestion, { kind: K }>; readonly reply: string; readonly shows: RegExp } } = {
  single_choice: {
    question: { id: 'q', kind: 'single_choice', label: 'Termin', options: [{ id: 'mo', label: 'Montag' }, { id: 'di', label: 'Dienstag' }] },
    reply: '2',
    shows: /1\) Montag\n2\) Dienstag/,
  },
  multiple_choice: {
    question: { id: 'q', kind: 'multiple_choice', label: 'Themen', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] },
    reply: '1,2',
    shows: /1\) Alpha\n2\) Beta/,
  },
  ranking: {
    question: { id: 'q', kind: 'ranking', label: 'Reihenfolge', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] },
    reply: '2,1',
    shows: /1\) Alpha\n2\) Beta/,
  },
  consent: {
    question: { id: 'q', kind: 'consent', label: 'Einverstanden?' },
    reply: 'ja',
    shows: /Ja oder Einwand/,
  },
  assignment: {
    question: { id: 'q', kind: 'assignment', label: 'Wer übernimmt?', candidates: [{ id: 'anna', label: 'Anna' }] },
    reply: 'Anna',
    shows: /Wer übernimmt\?/,
  },
  text: { question: { id: 'q', kind: 'text', label: 'Dein Beitrag' }, reply: 'Mehr Tests.', shows: /Dein Beitrag/ },
  number: { question: { id: 'q', kind: 'number', label: 'Budget', min: 0 }, reply: '1200,5', shows: /Budget/ },
  date: { question: { id: 'q', kind: 'date', label: 'Bis wann?' }, reply: '2026-12-01', shows: /Bis wann\?/ },
};

const INTERACTIVE_SAMPLES: { readonly [K in OutgoingInteractive['kind']]: { readonly interactive: Extract<OutgoingInteractive, { kind: K }>; readonly shows?: RegExp } } = {
  choice: {
    interactive: { kind: 'choice', question: 'Welche?', options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
    shows: /Welche\?\n1\) A\n2\) B/,
  },
  topic: {
    interactive: { kind: 'topic', question: 'Welche Firma?', topics: [{ label: 'ACME GmbH', value: 'acme' }, { label: 'ACME AG', value: 'acme-ag' }] },
    shows: /Welche Firma\?\n1\) ACME GmbH\n2\) ACME AG/,
  },
  slots: {
    interactive: {
      kind: 'slots',
      question: 'Wann?',
      slots: [{ slotId: 's1', start: '2026-12-01T09:00:00Z', end: '2026-12-01T09:30:00Z', timeZone: 'Europe/Berlin', label: 'Di 10:00', confidence: 0.9 }],
    },
    shows: /Wann\?\n1\) Di 10:00/,
  },
  // The two below are folded into the answer text by the kernel / narrated
  // by the agent; the plain form is that text (no extra lines).
  routine_list: {
    interactive: { kind: 'routine_list', filter: 'all', totals: { all: 0, active: 0, paused: 0 }, routines: [] },
  },
  mcp_input: {
    interactive: { kind: 'mcp_input', correlationId: 'c', serverName: 'Jira', serverId: 'jira', toolName: 'create', fields: [{ name: 'summary' }] },
  },
};

describe('criterion 30: every question kind and interactive element has a plain-text path', () => {
  it('criterion 30: each card question kind renders as text and parses a typed reply into its typed answer', () => {
    assert.deepEqual(Object.keys(CARD_SAMPLES).sort(), [...CARD_QUESTION_KINDS].sort(), 'a new question kind needs a plain-text sample here');
    for (const kind of CARD_QUESTION_KINDS) {
      const { question, reply, shows } = CARD_SAMPLES[kind];
      const text = renderCardAsText({ cardId: `card-${kind}`, title: 'Frage', questions: [question] });
      assert.match(text, shows, `${kind}: rendered as "${text}"`);
      assert.ok(text.includes(question.label), `${kind}: label missing`);
      const parsed = parseCardReply(question, reply);
      assert.equal(parsed.ok, true, `${kind}: "${reply}" → ${JSON.stringify(parsed)}`);
      assert.equal(parsed.ok && parsed.value.kind, kind);
      assert.equal(parsed.ok && parsed.value.questionId, question.id);
    }
  });

  it('criterion 30: each interactive element of an answer has a plain-text form', () => {
    for (const [kind, { interactive, shows }] of Object.entries(INTERACTIVE_SAMPLES)) {
      const text = plain({ text: 'Antwort.', speaker: mira, interactive });
      assert.ok(text.startsWith('Antwort.'), `${kind}: answer text lost`);
      if (shows) assert.match(text, shows, `${kind}: rendered as "${text}"`);
      else assert.equal(text, 'Antwort.', `${kind}: folded into the text, nothing added`);
    }
  });
});

describe('AI disclosure frequency (#2087)', () => {
  const run = (frequency: 'channel_default' | 'per_answer' | 'per_conversation', n: number, agentIds: string[] = []) => {
    const seen = new InMemoryDisclosureSeenStore();
    const markerStore = new InMemoryDisclosureMarkerStore();
    let now = 1_000_000;
    return Array.from({ length: n }, (_, i) => {
      now += 60_000;
      const r = applyAiDisclosure('Antwort', { scope: 's', seen, markerStore, frequency, agentId: agentIds[i] ?? 'a', now });
      return { folded: r.text !== 'Antwort', chip: r.aiDisclosure?.markers?.chip, field: r.aiDisclosure !== undefined };
    });
  };

  it('channel_default is today: line on the first answer, chip on every answer', () => {
    const r = run('channel_default', 2);
    assert.deepEqual(r.map((x) => x.folded), [true, false]);
    assert.deepEqual(r.map((x) => x.chip), [true, true]);
  });

  it('per_answer marks every answer', () => {
    assert.deepEqual(run('per_answer', 3).map((x) => x.folded), [true, true, true]);
  });

  it('per_conversation marks the first answer, a speaker change and a pause', () => {
    const r = run('per_conversation', 4, ['a', 'a', 'b', 'b']);
    assert.deepEqual(r.map((x) => x.folded), [true, false, true, false]);
    // the pause: 61 minutes later the same agent is marked again
    const seen = new InMemoryDisclosureSeenStore();
    const markerStore = new InMemoryDisclosureMarkerStore();
    const ctx = { scope: 's', seen, markerStore, frequency: 'per_conversation' as const, agentId: 'a' };
    assert.equal(applyAiDisclosure('x', { ...ctx, now: 0 }).text !== 'x', true);
    assert.equal(applyAiDisclosure('x', { ...ctx, now: 30 * 60_000 }).text !== 'x', false);
    assert.equal(applyAiDisclosure('x', { ...ctx, now: 100 * 60_000 }).text !== 'x', true);
  });

  it('keeps the structured field on every answer in every mode', () => {
    for (const f of ['channel_default', 'per_answer', 'per_conversation'] as const) {
      assert.ok(run(f, 3).every((x) => x.field), f);
    }
  });

  it('off removes everything (operator source only)', () => {
    const r = applyAiDisclosure('x', { policy: { level: 'off', source: 'operator' } });
    assert.deepEqual(r, { text: 'x' });
  });
});

describe('answer details (criterion 29: reachable on demand, not in the body)', () => {
  it('has nothing to show for a plain answer', () => {
    assert.equal(buildAnswerDetails({ text: 'Hallo', speaker: mira }), undefined);
    assert.equal(answerDetailsText(undefined), undefined);
  });

  it('projects verification, colleagues, system data and privacy for on-demand display', () => {
    const answer: SemanticAnswer = {
      text: 'Es sind 3 Rechnungen offen.',
      speaker: mira,
      verifier: { status: 'verified' },
      contributions: [{ id: 'c1', speaker: jonas, text: 'ok', status: 'delivered' }],
      privacyReceipt: { datasetsInterned: 1, fieldsMasked: 4, fieldsCleartext: 2, verbsExecuted: [], pseudonymProjectionUsed: false },
      answerSource: 'privacy-render',
    };
    const details = buildAnswerDetails(answer);
    assert.equal(details?.verification, 'verified');
    assert.deepEqual(details?.consulted, [{ name: 'Jonas', status: 'delivered' }]);
    assert.equal(details?.systemData, true);
    const text = answerDetailsText(details, 'de') ?? '';
    assert.match(text, /Alle Angaben geprüft/);
    assert.match(text, /Quellsystem/);
    assert.match(text, /Jonas hat beigetragen/);
    assert.match(text, /4 Felder wurden maskiert/);
    // and none of it is in the plain body
    assert.equal(plain(answer).includes('geprüft'), false);
  });
});
