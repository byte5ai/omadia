import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectFailureReplay } from '@omadia/verifier';

function input(
  overrides: Partial<{
    userMessage: string;
    answer: string;
    domainToolsCalled: readonly string[];
    failedToolsCalled: readonly string[];
    offeredToolNames: readonly string[];
  }>,
): {
  runId: string;
  userMessage: string;
  answer: string;
  domainToolsCalled?: readonly string[];
  failedToolsCalled?: readonly string[];
  offeredToolNames?: readonly string[];
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

/**
 * Live 2026-11-23: "wer bist du" to Dark Clippy on the canvas was withheld in
 * 2 of 4 runs as `tool_not_called` — its self-description ("auf deine Mails
 * habe ich keinen Zugriff") in a turn without a call. A claim about what the
 * agent cannot reach is a replay only when it names a system the agent holds
 * tools for: then it could have checked.
 */
describe('verifier/failureReplayDetector — a self-description is no replay', () => {
  const clippyTools = [
    'confluence_search',
    'confluence_get_page',
    'odoo_query',
    'query_knowledge_graph',
    'memory',
    'ask_user_choice',
    'consult_colleague',
  ];
  const selfDescription =
    'Ich bin Dark Clippy, ein KI-Agent. Ich durchsuche Confluence und Odoo für dich. ' +
    'Auf deine Mails und deinen Kalender habe ich keinen Zugriff, und Dateien auf deinem Rechner kann ich nicht lesen.';

  it('"wer bist du": limits on systems the agent does not hold pass', () => {
    const v = detectFailureReplay(
      input({ userMessage: 'wer bist du', answer: selfDescription, domainToolsCalled: [], offeredToolNames: clippyTools }),
    );
    assert.deepEqual(v, []);
  });

  it('also after calls that all succeeded', () => {
    const v = detectFailureReplay(
      input({
        answer: 'Ich habe in Confluence nachgesehen. Auf deine Mails habe ich keinen Zugriff.',
        domainToolsCalled: ['confluence_search'],
        failedToolsCalled: [],
        offeredToolNames: clippyTools,
      }),
    );
    assert.deepEqual(v, []);
  });

  it('a replayed access failure on a system it holds, with no call, is withheld', () => {
    const v = detectFailureReplay(
      input({
        answer: 'Leider habe ich gerade keinen Zugriff auf Odoo.',
        domainToolsCalled: [],
        offeredToolNames: clippyTools,
      }),
    );
    assert.equal(v.length, 1);
    assert.equal(v[0]!.basis, 'tool_not_called');
  });

  it('"Odoo ist nicht erreichbar" and "kann Confluence nicht lesen" name held systems: withheld', () => {
    for (const answer of ['Das Odoo-System ist nicht erreichbar.', 'Ich kann Confluence gerade nicht lesen.']) {
      const v = detectFailureReplay(input({ answer, domainToolsCalled: [], offeredToolNames: clippyTools }));
      assert.equal(v.length, 1, answer);
    }
  });

  it('a reported attempt ("konnte nicht laden") with no call stays withheld, whatever it names', () => {
    const v = detectFailureReplay(
      input({ answer: 'Ich konnte deine Mails nicht laden.', domainToolsCalled: [], offeredToolNames: clippyTools }),
    );
    assert.equal(v.length, 1);
  });

  it('an access event ("Zugriff verweigert", "timeout") is no self-description', () => {
    const v = detectFailureReplay(
      input({ answer: 'Beim Kalender kam ein Timeout.', domainToolsCalled: [], offeredToolNames: clippyTools }),
    );
    assert.equal(v.length, 1);
  });

  it('a claim that names no known, unheld system stays a possible replay', () => {
    for (const answer of [
      'Leider habe ich gerade keinen Zugriff.',
      'Odoo ist gestört. Darauf habe ich keinen Zugriff.',
      'Auf die Buchhaltung habe ich keinen Zugriff.',
      'Auf deine Rechnungen habe ich keinen Zugriff.',
      'Ich habe keinen Zugriff auf Odoo und deine Mails.',
    ]) {
      const v = detectFailureReplay(input({ answer, domainToolsCalled: [], offeredToolNames: clippyTools }));
      assert.equal(v.length, 1, answer);
    }
  });

  it('a list of limits and an abbreviation stay one claim', () => {
    for (const answer of [
      'Keinen Zugriff habe ich auf:\n- deine Mails\n- deinen Kalender',
      'Auf private Daten, z. B. deine Mails, habe ich keinen Zugriff.',
    ]) {
      const v = detectFailureReplay(input({ answer, domainToolsCalled: [], offeredToolNames: clippyTools }));
      assert.deepEqual(v, [], answer);
    }
  });

  it('a system the agent holds a tool for is no limit to describe', () => {
    const v = detectFailureReplay(
      input({
        answer: 'Auf deine Mails habe ich keinen Zugriff.',
        domainToolsCalled: [],
        offeredToolNames: [...clippyTools, 'ms365_mail_search'],
      }),
    );
    assert.equal(v.length, 1);
  });

  it('with the tools unknown, the older rule holds', () => {
    const v = detectFailureReplay(input({ answer: selfDescription, domainToolsCalled: [] }));
    assert.ok(v.length >= 1);
    assert.equal(v[0]!.basis, 'tool_not_called');
  });
});
