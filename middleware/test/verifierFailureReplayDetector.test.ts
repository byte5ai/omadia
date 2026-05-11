import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectFailureReplay } from '@omadia/verifier';

function input(
  overrides: Partial<{
    userMessage: string;
    answer: string;
    domainToolsCalled: readonly string[];
  }>,
): {
  runId: string;
  userMessage: string;
  answer: string;
  domainToolsCalled?: readonly string[];
} {
  const base = {
    runId: 'r',
    userMessage: '',
    answer: '',
  };
  const result = { ...base, ...overrides };
  return result;
}

describe('verifier/failureReplayDetector — attachment absence', () => {
  it('flags "kein [attachments-info]-Block" when user message actually carries it', () => {
    const v = detectFailureReplay(
      input({
        userMessage:
          'das ist unser Logo\n\n---\n[attachments-info] 1 Datei(en)…',
        answer: 'Ich sehe keinen [attachments-info]-Block in deiner Nachricht.',
        domainToolsCalled: ['memory'],
      }),
    );
    assert.equal(v.length, 1);
    if (v[0]!.status !== 'contradicted') throw new Error('expected contradicted');
    assert.match(v[0]!.detail!, /Replay|Kontext/);
  });

  it('passes "kein Anhang" when user message has no attachments-info block', () => {
    const v = detectFailureReplay(
      input({
        userMessage: 'Hallo, hier meine Frage',
        answer: 'Es scheint, dass kein Anhang mit deiner Nachricht angekommen ist.',
        domainToolsCalled: ['memory'],
      }),
    );
    assert.equal(v.length, 0);
  });

  it('flags "bitte nochmal hochladen" when a file is present', () => {
    const v = detectFailureReplay(
      input({
        userMessage: 'hier nochmal\n\n[attachments-info] 1 Datei(en)',
        answer: 'Könntest du die Datei bitte nochmal hochladen?',
      }),
    );
    assert.equal(v.length, 1);
    if (v[0]!.status !== 'contradicted') throw new Error('expected contradicted');
    assert.match(v[0]!.detail!, /bereits/);
  });
});

describe('verifier/failureReplayDetector — generic operation failure', () => {
  it('flags "konnte nicht laden" when no tool was called', () => {
    const v = detectFailureReplay(
      input({
        userMessage: 'Zeig mir die offenen Rechnungen.',
        answer: 'Ich konnte die Rechnungen nicht laden.',
        domainToolsCalled: [],
      }),
    );
    assert.equal(v.length, 1);
    if (v[0]!.status !== 'contradicted') throw new Error('expected contradicted');
    assert.match(v[0]!.detail!, /0 Tool-Calls|nicht versucht/);
  });

  it('passes "konnte nicht laden" when a tool actually ran this turn', () => {
    const v = detectFailureReplay(
      input({
        userMessage: 'Zeig mir die offenen Rechnungen.',
        answer: 'Ich konnte die Rechnungen nicht laden — Odoo gab 500 zurück.',
        domainToolsCalled: ['query_odoo_accounting'],
      }),
    );
    assert.equal(v.length, 0);
  });

  it('flags English "access denied" without a tool call', () => {
    const v = detectFailureReplay(
      input({
        userMessage: 'pull the report',
        answer: 'Access denied while reading the report.',
        domainToolsCalled: [],
      }),
    );
    assert.equal(v.length, 1);
  });

  it('skips detector entirely when no trace evidence is supplied', () => {
    const v = detectFailureReplay(
      input({
        userMessage: 'Zeig mir die offenen Rechnungen.',
        answer: 'Ich konnte die Rechnungen nicht laden.',
        // domainToolsCalled intentionally omitted
      }),
    );
    assert.equal(v.length, 0);
  });
});

describe('verifier/failureReplayDetector — retry requests', () => {
  it('flags "bitte erneut senden" without tool activity', () => {
    const v = detectFailureReplay(
      input({
        userMessage: 'Zeig mir das Inventar.',
        answer: 'Könntest du bitte die Daten nochmal senden? Ich brauche sie.',
        domainToolsCalled: [],
      }),
    );
    assert.equal(v.length, 1);
  });

  it('passes a legitimate retry ask after a real attempt', () => {
    const v = detectFailureReplay(
      input({
        userMessage: 'Zeig mir das Inventar.',
        answer:
          'Der Odoo-Call lief gerade in einen Timeout — könntest du es bitte nochmal versuchen?',
        domainToolsCalled: ['query_odoo_accounting'],
      }),
    );
    assert.equal(v.length, 0);
  });
});

describe('verifier/failureReplayDetector — false-positive guards', () => {
  it('does not fire on neutral informative text', () => {
    const v = detectFailureReplay(
      input({
        userMessage: 'Was kannst du?',
        answer:
          'Ich helfe bei Odoo-Fragen, rendere Diagramme und führe Memory-Einträge.',
        domainToolsCalled: ['memory'],
      }),
    );
    assert.equal(v.length, 0);
  });

  it('does not fire on attachments-info when the bot correctly acknowledges it', () => {
    const v = detectFailureReplay(
      input({
        userMessage: 'das Logo\n\n[attachments-info] 1 Datei(en)',
        answer: '✅ Logo gespeichert unter /memories/_brand/logo.md.',
        domainToolsCalled: ['memory'],
      }),
    );
    assert.equal(v.length, 0);
  });

  it('does not double-flag the same match on multiple regex hits', () => {
    const v = detectFailureReplay(
      input({
        userMessage: 'das Logo\n\n[attachments-info] 1 Datei',
        answer:
          'Ich sehe keinen Anhang. Kein Anhang mit deiner Nachricht. Bitte nochmal hochladen.',
      }),
    );
    // Two distinct matches minimum (absence + retry), but no identical
    // regex should fire twice on the same substring.
    assert.ok(v.length >= 1);
    const texts = v
      .filter((x) => x.status === 'contradicted')
      .map((x) => x.claim.text);
    assert.equal(new Set(texts).size, texts.length);
  });
});
