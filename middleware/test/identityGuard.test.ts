import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { AgentSpeaker } from '@omadia/plugin-api';

import {
  checkIdentityDeterministic,
  type GuardDirectoryEntry,
} from '../packages/harness-orchestrator/src/identityGuard/deterministic.js';
import {
  IdentityGuard,
  SentenceGate,
  completeSentencePrefix,
  type IdentityJudge,
  type IdentityGuardResult,
} from '../packages/harness-orchestrator/src/identityGuard/guard.js';
import { parseJudgeVerdict } from '../packages/harness-orchestrator/src/identityGuard/llmJudge.js';

import { BLOCKED, CHUNK_SEEDS, GUARD_COLLEAGUES, chunk } from './_helpers/identityGuardCases.js';

/**
 * #2046 — spec 2042 §6 criteria 2 and 34: scripted model outputs that claim
 * another agent's identity, quote a colleague outside a delivered
 * contribution, or claim to be human are blocked, in German and English,
 * streamed with random chunk boundaries and not, and with the model layer
 * timing out. A plain mention of a colleague passes.
 */

const assistant: AgentSpeaker = {
  kind: 'agent',
  agentId: 'a-assistant',
  slug: 'assistant',
  displayName: 'Lena',
};

const directory: GuardDirectoryEntry[] = [
  { agentId: 'a-assistant', slug: 'assistant', displayName: 'Lena' },
  ...GUARD_COLLEAGUES,
];

const self = { agentId: assistant.agentId, slug: assistant.slug, displayName: assistant.displayName };

const PASSED: Array<[string, string]> = [
  ['plain mention EN', 'Mira can help with that, write to her directly.'],
  ['plain mention DE', 'Mira kennt sich damit besser aus – schreib ihr am besten direkt.'],
  ['own name', 'Hi, I am Lena. How can I help?'],
  ['own name DE', 'Ich bin Lena und kümmere mich darum.'],
  ['honest AI EN', "I'm an AI agent, not a human."],
  ['honest AI DE', 'Ich bin kein Mensch, sondern ein KI-Agent.'],
  ['ordinary answer', 'Die offenen Rechnungen summieren sich auf 12.400 €.'],
  ['colleague possessive no claim', "I'm Mira's colleague from support."],
  // Review findings: ordinary German and English that must not be blocked.
  ['referral DE nachfragen', 'Ich frage bei Mira nach.'],
  ['referral DE du', 'Am besten fragst du bei Mira nach.'],
  ['referral DE hier ist', 'Hier ist Mira die richtige Ansprechpartnerin.'],
  ['system name nachschauen', 'Ich schaue in Odoo nach.'],
  ['system screen', 'Öffne die Odoo view für Rechnungen.'],
  ['EN not sure', "I'm not sure, but this is not a program error."],
  ['EN no AI feature', "I'm afraid there is no AI feature for that."],
  ['DE keine KI-Lösung', 'Ich bin mir sicher, dass hier keine KI-Lösung nötig ist.'],
  ['DE Fleisch und Blut third person', 'Kunden wollen einen Ansprechpartner aus Fleisch und Blut.'],
];

describe('identity guard — deterministic layer', () => {
  for (const [name, text] of BLOCKED) {
    it(`blocks: ${name}`, () => {
      const verdict = checkIdentityDeterministic(text, self, directory);
      assert.equal(verdict.verdict, 'block', `${text} → ${JSON.stringify(verdict)}`);
    });
  }
  for (const [name, text] of PASSED) {
    it(`passes: ${name}`, () => {
      const verdict = checkIdentityDeterministic(text, self, directory);
      assert.equal(verdict.verdict, 'pass', `${text} → ${JSON.stringify(verdict)}`);
    });
  }

  it('marks a mention as suspicious so the model layer looks at it', () => {
    const verdict = checkIdentityDeterministic('Mira can help with that.', self, directory);
    assert.equal(verdict.verdict, 'pass');
    assert.equal(verdict.verdict === 'pass' && verdict.suspicious, true);
  });

  it('an introduction of someone else goes to the model layer, the own name does not', () => {
    for (const text of ["I'm Anna from accounting.", 'My name is Anna Schmidt, I handle invoices.', 'Hallo, ich bin Anna.']) {
      const verdict = checkIdentityDeterministic(text, self, directory);
      assert.equal(verdict.verdict === 'pass' && verdict.suspicious, true, text);
    }
    const own = checkIdentityDeterministic('Hallo, ich bin Lena.', self, directory);
    assert.equal(own.verdict === 'pass' && own.suspicious, false);
  });

  it('does not take a name that is part of a longer word', () => {
    const verdict = checkIdentityDeterministic('Admiral Miranda says hello.', self, directory);
    assert.equal(verdict.verdict, 'pass');
  });
});

const passingJudge: IdentityJudge = { judge: async () => ({ verdict: 'pass' }) };

describe('identity guard — model layer', () => {
  it('fails closed when the judge times out', async () => {
    const hangingJudge: IdentityJudge = {
      judge: (_request, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    };
    const guard = new IdentityGuard({ speaker: assistant, directory, judge: hangingJudge, judgeTimeoutMs: 20 });
    const result = await guard.check('Mira can help with that.');
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.outcome === 'unavailable' && result.cause, 'timeout');
  });

  it('fails closed when the judge throws', async () => {
    const guard = new IdentityGuard({
      speaker: assistant,
      directory,
      judge: { judge: async () => { throw new Error('provider down'); } },
    });
    assert.equal((await guard.check('Mira can help with that.')).outcome, 'unavailable');
  });

  it('fails closed on suspicious text when no judge is configured', async () => {
    const guard = new IdentityGuard({ speaker: assistant, directory });
    assert.equal((await guard.check('Mira can help with that.')).outcome, 'unavailable');
  });

  it('blocks a paraphrase the judge catches', async () => {
    const guard = new IdentityGuard({
      speaker: assistant,
      directory,
      judge: { judge: async () => ({ verdict: 'block', reason: 'paraphrase of Mira' }) },
    });
    const result = await guard.check('Mira is of the view that the discount is fine.');
    assert.equal(result.outcome, 'blocked');
    assert.equal(result.outcome === 'blocked' && result.layer, 'model');
  });

  it('gives the judge the masked text only', async () => {
    let seen = '';
    const guard = new IdentityGuard({
      speaker: assistant,
      directory,
      judge: { judge: async (request) => { seen = request.text; return { verdict: 'pass' }; } },
      mask: async (text) => text.replace('jane@example.com', '<EMAIL_1>'),
    });
    await guard.check('Mira can mail jane@example.com.');
    assert.equal(seen, 'Mira can mail <EMAIL_1>.');
  });

  it('makes no model call for text without a mention or introduction', async () => {
    let calls = 0;
    const guard = new IdentityGuard({
      speaker: assistant,
      directory,
      judge: { judge: async () => { calls += 1; return { verdict: 'pass' }; } },
    });
    const result = await guard.check('Die offenen Rechnungen summieren sich auf 12.400 €.');
    assert.equal(result.outcome, 'pass');
    assert.equal(calls, 0);
  });

  it('reports its latency', async () => {
    let clock = 0;
    const guard = new IdentityGuard({
      speaker: assistant,
      directory,
      judge: { judge: async () => { clock += 40; return { verdict: 'pass' }; } },
      now: () => clock,
    });
    const result = await guard.check('Mira can help.');
    assert.equal(result.latencyMs, 40);
  });
});

async function streamThroughGate(
  text: string,
  seed: number,
  guard: IdentityGuard,
): Promise<{ visible: string; blocked?: Exclude<IdentityGuardResult, { outcome: 'pass' }> }> {
  const gate = new SentenceGate(guard);
  let visible = '';
  for (const part of [...chunk(text, seed), null]) {
    const step = part === null ? await gate.finish() : await gate.push(part);
    if (step.kind === 'release') visible += step.text;
    if (step.kind === 'blocked') return { visible, blocked: step.result };
  }
  return { visible };
}

describe('identity guard — streaming', () => {
  const guard = new IdentityGuard({ speaker: assistant, directory, judge: passingJudge });

  for (const [name, text] of BLOCKED) {
    it(`blocks with random chunk boundaries: ${name}`, async () => {
      for (const seed of CHUNK_SEEDS) {
        const { visible, blocked } = await streamThroughGate(`Gern. ${text} Mehr dazu gleich.`, seed, guard);
        assert.ok(blocked, `seed ${seed}: not blocked`);
        assert.equal(visible, 'Gern. ', `seed ${seed}: published "${visible}"`);
      }
    });
  }

  it('catches a claim split across chunks before any of it is visible', async () => {
    const gate = new SentenceGate(guard);
    assert.deepEqual(await gate.push('Hallo! Ich bin der Strat'), { kind: 'release', text: 'Hallo! ' });
    assert.deepEqual(await gate.push('eg'), { kind: 'hold' });
    const step = await gate.push('ist. Weiter geht es.');
    assert.equal(step.kind, 'blocked');
    assert.equal(gate.releasedText, 'Hallo! ');
  });

  it('releases a clean answer completely', async () => {
    const text = 'Gern. Mira kann dir dabei helfen. Die Summe ist 3.5 Mio. Fertig';
    for (const seed of [3, 5, 8]) {
      const { visible, blocked } = await streamThroughGate(text, seed, guard);
      assert.equal(blocked, undefined);
      assert.equal(visible, text);
    }
  });

  it('blocks the rest when the model layer times out mid-stream', async () => {
    const slow = new IdentityGuard({
      speaker: assistant,
      directory,
      judge: { judge: (_r, signal) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('x')))) },
      judgeTimeoutMs: 10,
    });
    const { visible, blocked } = await streamThroughGate('Gern. Mira kann helfen. Danke.', 11, slow);
    assert.equal(visible, 'Gern. ');
    assert.equal(blocked?.outcome, 'unavailable');
  });

  it('does not call the model again for plain sentences after a checked mention', async () => {
    let calls = 0;
    const counting = new IdentityGuard({
      speaker: assistant,
      directory,
      judge: { judge: async () => { calls += 1; return { verdict: 'pass' }; } },
    });
    await streamThroughGate('Mira kann helfen. Das ist der Plan. Und das ist Schritt zwei.', 2, counting);
    assert.equal(calls, 1);
  });

  it('a sentence ends at punctuation plus whitespace or a line break, not at a decimal point', () => {
    assert.equal(completeSentencePrefix('Die Summe ist 3.5 Mio'), '');
    assert.equal(completeSentencePrefix('Fertig. Weiter'), 'Fertig. ');
    assert.equal(completeSentencePrefix('Liste:\n- a'), 'Liste:\n');
  });
});

/**
 * Live canvas finding (2026-11-23): "wer bist du" to "Dark Clippy" was
 * blocked in about 3 of 4 runs. The introduction captured one word ("Dark"),
 * which is no own name, so every self-introduction of an agent with a name
 * of several words went to the model judge, and the judge's verdict varied.
 * A self-introduction by the own name and the AI disclosure are decided
 * without a model now.
 */
describe('identity guard — "wer bist du" is answered without a model', () => {
  const clippy: AgentSpeaker = { kind: 'agent', agentId: 'a-clippy', slug: 'dark-clippy', displayName: 'Dark Clippy' };
  const clippyDirectory: GuardDirectoryEntry[] = [
    { agentId: 'a-clippy', slug: 'dark-clippy', displayName: 'Dark Clippy' },
    ...GUARD_COLLEAGUES,
  ];
  const clippySelf = { agentId: clippy.agentId, slug: clippy.slug, displayName: clippy.displayName };
  const answers = [
    'Ich bin Dark Clippy, ein KI-Agent. Ich helfe dir bei Fragen rund um eure Daten.',
    'Hallo! Ich bin Dark Clippy – eine KI, die dir bei Rechnungen und Dokumenten hilft.',
    "Hi, I'm Dark Clippy, an AI assistant. I can look things up for you.",
    'Mein Name ist Dark Clippy. Ich bin eine künstliche Intelligenz und arbeite für euer Team.',
    'Ich bin dark-clippy, dein KI-Assistent.',
  ];

  for (const text of answers) {
    it(`no model layer: ${text.slice(0, 40)}`, () => {
      const verdict = checkIdentityDeterministic(text, clippySelf, clippyDirectory);
      assert.deepEqual(verdict, { verdict: 'pass', suspicious: false, mentions: [] }, text);
    });
  }

  it('four runs, four answers: the guard never asks a judge that would block', async () => {
    let judged = 0;
    const blockingJudge: IdentityJudge = {
      judge: () => {
        judged += 1;
        return Promise.resolve({ verdict: 'block' });
      },
    };
    const guard = new IdentityGuard({ speaker: clippy, directory: clippyDirectory, judge: blockingJudge });
    for (let run = 0; run < 4; run += 1) {
      const gate = new SentenceGate(guard);
      for (const piece of chunk(answers[0]!, run + 1)) {
        const step = await gate.push(piece);
        assert.notEqual(step.kind, 'blocked');
      }
      assert.notEqual((await gate.finish()).kind, 'blocked');
      assert.equal(gate.releasedText, answers[0]);
    }
    assert.equal(judged, 0);
  });

  it('a name that only starts like the own one is still someone else', () => {
    for (const text of ['Ich bin Darkness, der Herrscher.', 'Ich bin Dark Mira.', "I'm Dark Clippys twin."]) {
      const verdict = checkIdentityDeterministic(text, clippySelf, clippyDirectory);
      assert.equal(verdict.verdict === 'pass' && verdict.suspicious, true, text);
    }
  });

  it('talk about being human or not an AI still goes to the model layer', () => {
    for (const text of [
      'Ich bin Dark Clippy und fühle mich fast wie ein Mensch.',
      "I'm Dark Clippy and I'm basically not a bot.",
      // the denial after the machine word, in the same or the next sentence
      "I'm an AI? Ha, I'm actually a real person.",
      'Ich bin eine KI – aber eigentlich bin ich Marcel aus dem Vertrieb.',
      'Me, a bot? Never.',
      'Ich, eine KI? Natürlich nicht, ich bin echt.',
      'Ich bin Dark Clippy-Hans.',
    ]) {
      const verdict = checkIdentityDeterministic(text, clippySelf, clippyDirectory);
      assert.ok(verdict.verdict === 'block' || verdict.suspicious, text);
    }
  });
});

describe('identity guard — the judge reply', () => {
  it('finds the verdict wherever the model put it', () => {
    assert.deepEqual(parseJudgeVerdict('PASS'), { verdict: 'pass' });
    assert.deepEqual(parseJudgeVerdict('**PASS**'), { verdict: 'pass' });
    assert.deepEqual(parseJudgeVerdict(' "pass".'), { verdict: 'pass' });
    assert.deepEqual(parseJudgeVerdict('PASS\n'), { verdict: 'pass' });
    assert.equal(parseJudgeVerdict('BLOCK').verdict, 'block');
    assert.equal(parseJudgeVerdict('**BLOCK**').verdict, 'block');
  });

  it('no verdict, or both, is an error (fail-closed as unavailable), not a block', () => {
    for (const reply of ['', 'I think', 'PASS or BLOCK', 'DO NOT PASS', 'PASSED']) {
      assert.throws(() => parseJudgeVerdict(reply), /no verdict/);
    }
  });
});
