/**
 * S3-C — what the privacy receipt tells the user is what happened.
 *
 *  - #1541: values masked in recalled / replayed earlier conversations are
 *    booked as earlier context, never as "masked in your message"; each
 *    distinct value counts once however many model calls carried it.
 *  - #1549: "you named a person" counts only person-shaped values the user
 *    wrote as whole words — not a department, a column name or a fragment.
 *  - #1557: a bypass marks the receipt `unprotected` (the turn flag, #1507).
 *  - #1562: the receipt reports the C1 name detector's state; the service
 *    reports it for the operator's posture.
 *  - #1599: the sub-agent bridge keeps a sub-agent's scope refusal.
 *
 * Everything runs against the REAL service; values are synthetic.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PromptPiiDetector, PrivacyReceipt } from '@omadia/plugin-api';
import { createPrivacyTurnHandle } from '@omadia/orchestrator/dist/privacyHandle.js';
import { mergePrivacyReceipts } from '@omadia/orchestrator/dist/requestReceipts.js';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import {
  countIdentityValuesNamed,
  isPersonIdentifierValue,
  namesValue,
} from '@omadia/plugin-privacy-guard/dist/identityOnWire.js';
import { probeC1Health } from '@omadia/plugin-privacy-guard/dist/c1Detector.js';

const MAIL = 'jana.beispiel@firma.example';
const OTHER_MAIL = 'tom.muster@firma.example';

const maskOn = (key: string): unknown => (key === 'mask_user_prompt' ? 'on' : undefined);

function failingC1(): PromptPiiDetector {
  return {
    id: 'c1-test',
    detect: async () => {
      throw new Error('sidecar down');
    },
  };
}

describe('#1541 — earlier conversations are not "your message"', () => {
  it('books a recalled / replayed answer as context with mask_user_prompt off', async () => {
    const svc = createPrivacyGuardService();
    const turn = { sessionId: 's', turnId: 't-ctx-off' };
    const user = await svc.maskUserPrompt!({ ...turn, text: 'Wer ist die Ansprechpartnerin?' });
    assert.equal(user.outcome, 'disabled');
    const recalled = await svc.maskReplayedAnswer!({ ...turn, text: `Ansprechpartnerin: ${MAIL}` });
    assert.equal(recalled.outcome, 'masked');

    const receipt = await svc.finalizeTurn(turn.turnId, 'Wer ist die Ansprechpartnerin?');
    assert.ok(receipt);
    assert.equal(receipt.maskedPromptSpans, undefined, 'nothing was masked in the message');
    assert.deepEqual(receipt.maskedContextSpans?.map((s) => s.type), ['email']);
  });

  it('counts a value of the message once, however many calls carried it', async () => {
    const svc = createPrivacyGuardService({ readConfig: maskOn });
    const turn = { sessionId: 's', turnId: 't-dedupe' };
    const text = `Schreib an ${MAIL} und ${OTHER_MAIL}`;
    // Screener bundle, pre-hook mask, main call — the same message three times.
    for (let i = 0; i < 3; i++) {
      const r = await svc.maskUserPrompt!({ ...turn, text });
      assert.equal(r.outcome, 'masked');
    }
    const receipt = await svc.finalizeTurn(turn.turnId, text);
    assert.equal(receipt?.maskedPromptSpans?.length, 2, JSON.stringify(receipt));
  });

  it('a value in both the message and the recalled context counts as the message', async () => {
    const svc = createPrivacyGuardService({ readConfig: maskOn });
    const turn = { sessionId: 's', turnId: 't-both' };
    await svc.maskReplayedAnswer!({ ...turn, text: `Frühere Antwort: ${MAIL} und ${OTHER_MAIL}` });
    await svc.maskUserPrompt!({ ...turn, text: `Ist ${MAIL} noch aktuell?` });

    const receipt = await svc.finalizeTurn(turn.turnId);
    assert.equal(receipt?.maskedPromptSpans?.length, 1, JSON.stringify(receipt));
    assert.equal(receipt?.maskedContextSpans?.length, 1, JSON.stringify(receipt));
  });

  it('a replayed user message (origin context) books as context', async () => {
    const svc = createPrivacyGuardService({ readConfig: maskOn });
    const turn = { sessionId: 's', turnId: 't-origin' };
    const handle = createPrivacyTurnHandle({ service: svc, ...turn });
    await handle.maskUserPrompt(`Mail an ${MAIL}`, { origin: 'context' });
    await handle.maskUserPrompt('Und jetzt?');
    const receipt = await handle.finalize('Und jetzt?');
    assert.equal(receipt?.maskedPromptSpans, undefined, JSON.stringify(receipt));
    assert.equal(receipt?.maskedContextSpans?.length, 1);
  });
});

describe('#1549 — a named person is a person', () => {
  it('only person-shaped values count', () => {
    assert.equal(isPersonIdentifierValue('Anna Schmidt'), true);
    assert.equal(isPersonIdentifierValue('Jean-Luc O’Neil'), true);
    assert.equal(isPersonIdentifierValue(MAIL), true);
    assert.equal(isPersonIdentifierValue('+49 89 1234567'), true);
    assert.equal(isPersonIdentifierValue('Research & Development'), false);
    assert.equal(isPersonIdentifierValue('Sales'), false);
    assert.equal(isPersonIdentifierValue('Name'), false);
    assert.equal(isPersonIdentifierValue('2026'), false);
    assert.equal(isPersonIdentifierValue('Lena van der Berg'), true);
    assert.equal(isPersonIdentifierValue('Jan de Vries'), true);
    assert.equal(isPersonIdentifierValue('van der Berg'), false);
  });

  it('matches whole words only, case-insensitively', () => {
    assert.equal(namesValue('Wie viel Urlaub hat anna  schmidt?', 'Anna Schmidt'), true);
    assert.equal(namesValue('Magdalena Lenz', 'Lena Lenz'), false);
    assert.equal(namesValue('Spalte __k_Anna Schmidt', 'Anna Schmidt'), false);
    assert.equal(countIdentityValuesNamed('Anna Schmidt und ANNA SCHMIDT', ['Anna Schmidt', 'ANNA SCHMIDT']), 1);
  });

  it('a department or a column name in the message does not turn the receipt red', async () => {
    const svc = createPrivacyGuardService({
      // The classifier marks the many2one department as personal data, as Haiku did live.
      llmComplete: async () => ({ text: '["name","department_id"]' }),
    });
    const turnId = 't-dept';
    await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'hr.employee',
      rawResult: JSON.stringify([
        { id: 1, name: 'Anna Schmidt', department_id: [3, 'Research & Development'] },
        { id: 2, name: 'Max Müller', department_id: [4, 'Sales'] },
      ]),
    });
    const receipt = await svc.finalizeTurn(
      turnId,
      'Welche Mitarbeiter gehören zur Abteilung Research & Development oder Sales? Filtere auf __k_Name.',
    );
    assert.equal(receipt?.identityValuesOnWire, 0);
  });

  it('a full name the user typed still counts', async () => {
    const svc = createPrivacyGuardService({ llmComplete: async () => ({ text: '["name"]' }) });
    const turnId = 't-named';
    await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'hr.employee',
      rawResult: JSON.stringify([{ id: 1, name: 'Anna Schmidt' }, { id: 2, name: 'Max Müller' }]),
    });
    const receipt = await svc.finalizeTurn(turnId, 'Wie viel Urlaub hat Anna Schmidt?');
    assert.equal(receipt?.identityValuesOnWire, 1);
  });
});

describe('#1557 — a bypassed turn is marked unprotected', () => {
  it('the handle stamps the turn flag on the receipt', async () => {
    const svc = createPrivacyGuardService();
    const handle = createPrivacyTurnHandle({
      service: svc,
      sessionId: 's',
      turnId: 't-bypass',
      resolveBypass: () => ({ pluginId: '@omadia/agent-x' }),
    });
    assert.ok(handle.checkBypass('x_tool'));
    await handle.recordBypassedTool({
      toolName: 'x_tool',
      pluginId: '@omadia/agent-x',
      reason: 'operator_setting',
      bytes: 10,
    });
    const receipt = await handle.finalize('frage');
    assert.equal(receipt?.unprotected, true);
    assert.equal(receipt?.datasetsInterned, 0);
  });

  it('a guarded turn carries no flag', async () => {
    const svc = createPrivacyGuardService();
    const handle = createPrivacyTurnHandle({ service: svc, sessionId: 's', turnId: 't-guarded' });
    await handle.internToolResultV4({ toolName: 'x', rawResult: JSON.stringify([{ a: 'b' }]) });
    const receipt = await handle.finalize('frage');
    assert.equal(receipt?.unprotected, undefined);
  });
});

describe('#1562 — the name detector state', () => {
  it('reports unconfigured on a turn that masked free text without C1', async () => {
    const svc = createPrivacyGuardService({ readConfig: maskOn });
    const turn = { sessionId: 's', turnId: 't-c1-off' };
    await svc.maskUserPrompt!({ ...turn, text: `Jonas Weber, ${MAIL}` });
    const receipt = await svc.finalizeTurn(turn.turnId);
    assert.equal(receipt?.nameDetector, 'unconfigured');
  });

  it('reports a failed C1, also when nothing else was masked', async () => {
    const svc = createPrivacyGuardService({ readConfig: maskOn, c1Detector: failingC1() });
    const turn = { sessionId: 's', turnId: 't-c1-failed' };
    const r = await svc.maskUserPrompt!({ ...turn, text: 'Schreib Jonas Weber eine Begrüßung' });
    assert.equal(r.outcome, 'masked');
    const receipt = await svc.finalizeTurn(turn.turnId);
    assert.ok(receipt, 'a failed name detector alone is worth a receipt');
    assert.equal(receipt.nameDetector, 'failed');
    assert.equal(receipt.maskedPromptSpans, undefined);

    const status = await svc.nameDetectorStatus!();
    assert.ok(status.lastFailureAt !== null, 'the failure time reaches the posture');
  });

  it('reports active on a turn with a working C1', async () => {
    const svc = createPrivacyGuardService({
      readConfig: maskOn,
      c1Detector: { id: 'c1-test', detect: async () => [] },
    });
    const turn = { sessionId: 's', turnId: 't-c1-on' };
    await svc.maskUserPrompt!({ ...turn, text: `Mail ${MAIL}` });
    assert.equal((await svc.finalizeTurn(turn.turnId))?.nameDetector, 'active');
  });

  it('nameDetectorStatus follows the probe', async () => {
    const c1 = { id: 'c1-test', detect: async () => [] };
    const off = createPrivacyGuardService({ c1Detector: c1, c1CacheScope: () => undefined });
    assert.equal((await off.nameDetectorStatus!()).state, 'unconfigured');

    const down = createPrivacyGuardService({
      c1Detector: c1,
      c1CacheScope: () => 'http://pii-detector:8812',
      probeC1: async () => ({ source: 'env', reachable: false }),
    });
    assert.deepEqual(await down.nameDetectorStatus!(), {
      state: 'unreachable',
      source: 'env',
      lastFailureAt: null,
      promptMasking: false,
    });

    const up = createPrivacyGuardService({
      c1Detector: c1,
      c1CacheScope: () => 'http://pii-detector:8812',
      probeC1: async () => ({ source: 'setup', reachable: true }),
    });
    assert.equal((await up.nameDetectorStatus!()).state, 'active');
  });

  it('a merged request receipt keeps the worst detector state and the new lists', () => {
    const base: PrivacyReceipt = {
      datasetsInterned: 0,
      fieldsMasked: 0,
      fieldsCleartext: 0,
      verbsExecuted: [],
      pseudonymProjectionUsed: false,
    };
    const merged = mergePrivacyReceipts([
      { ...base, nameDetector: 'active', maskedContextSpans: [{ type: 'email', detector: 'c0' }] },
      { ...base, nameDetector: 'failed', unprotected: true },
    ]);
    assert.equal(merged?.nameDetector, 'failed');
    assert.equal(merged?.unprotected, true);
    assert.equal(merged?.maskedContextSpans?.length, 1);
  });
});

describe('#1599 — the sub-agent bridge keeps scope refusals', () => {
  it('tells the model to pass on limitations other than masked values', async () => {
    const svc = createPrivacyGuardService();
    const turnId = 't-bridge';
    const { datasetId } = await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'confluence_search',
      rawResult: JSON.stringify([{ title: 'Seite A', space: 'DEV' }]),
    });
    const { resultText } = await svc.subAgentResultV4!({
      turnId,
      narration: 'Der Space PLAY liegt nicht in meinem Scope; nur DEV ist konfiguriert.',
      datasetIds: [datasetId],
    });
    assert.doesNotMatch(resultText, /do NOT repeat any "cannot/);
    assert.match(resultText, /outside its scope/);
    assert.match(resultText, /MUST reach the user/);
    assert.match(resultText, /Der Space PLAY liegt nicht in meinem Scope/);
  });
});

describe('#1562 — probeC1Health', () => {
  const fetchReturning = (status: number, body: string): typeof fetch =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;

  it('is healthy only on 200 with ok: true', async () => {
    assert.equal(await probeC1Health('http://c1/', { fetchFn: fetchReturning(200, '{"ok":true}') }), true);
    assert.equal(await probeC1Health('http://c1', { fetchFn: fetchReturning(200, '{"ok":false}') }), false);
    assert.equal(await probeC1Health('http://c1', { fetchFn: fetchReturning(503, '{"ok":true}') }), false);
    assert.equal(await probeC1Health('http://c1', { fetchFn: fetchReturning(200, 'not json') }), false);
  });

  it('calls /health once, without a doubled slash', async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    await probeC1Health('http://pii-detector:8812//', { fetchFn });
    assert.deepEqual(urls, ['http://pii-detector:8812/health']);
  });

  it('times out instead of hanging', async () => {
    const hang = (() => new Promise(() => undefined)) as unknown as typeof fetch;
    assert.equal(await probeC1Health('http://c1', { fetchFn: hang, timeoutMs: 20 }), false);
  });
});
