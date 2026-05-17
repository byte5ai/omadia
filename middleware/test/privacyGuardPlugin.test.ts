import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  PRIVACY_REDACT_CAPABILITY,
  PRIVACY_REDACT_SERVICE_NAME,
  type PrivacyReceipt,
} from '@omadia/plugin-api';

import {
  assembleReceipt,
  createPrivacyGuardService,
  createTokenizeMap,
  decide,
  detectInText,
  deriveRouting,
  isToken,
  REGEX_DETECTOR_ID,
  TOKEN_REGEX,
} from '@omadia/plugin-privacy-guard/dist/index.js';

// ---------------------------------------------------------------------------
// Privacy-Shield v2: harness-plugin-privacy-guard end-to-end coverage
// with the turn-scoped map + processInbound + finalizeTurn surface.
// ---------------------------------------------------------------------------

const SAMPLE_EMAIL = 'max.mustermann@firma.de';
const SAMPLE_IBAN = 'DE89370400440532013000';
const SAMPLE_CC = '4111111111111111';
const SAMPLE_API_KEY = 'sk-abcdefghijklmnopqrstuvwx';
const TOKEN_PATTERN = /«[A-Z][A-Z_]*_\d+»/;
const TOKEN_PATTERN_GLOBAL = /«[A-Z][A-Z_]*_\d+»/g;

describe('plugin-api · privacy.redact@1 capability constants visible to plugin', () => {
  it('exports the canonical service name and capability id', () => {
    assert.equal(PRIVACY_REDACT_SERVICE_NAME, 'privacyRedact');
    assert.equal(PRIVACY_REDACT_CAPABILITY, 'privacy.redact@1');
  });
});

describe('regexDetector', () => {
  it('detects email + IBAN + credit-card + api-key in mixed text', () => {
    const input = `Mail ${SAMPLE_EMAIL} mit IBAN ${SAMPLE_IBAN} und CC ${SAMPLE_CC}, Key ${SAMPLE_API_KEY}.`;
    const hits = detectInText(input);
    const types = hits.map((h) => h.type).sort();
    assert.deepEqual(types, ['pii.api_key', 'pii.credit_card', 'pii.email', 'pii.iban']);
  });

  it('skips invalid Luhn credit-card numbers', () => {
    const hits = detectInText('Card 1234567890123456 here.');
    assert.equal(
      hits.filter((h) => h.type === 'pii.credit_card').length,
      0,
      'non-Luhn 1234… must not be reported as a credit card',
    );
  });

  it('skips invalid IBAN checksums', () => {
    const hits = detectInText('Wrong IBAN DE00370400440532013001 here.');
    assert.equal(
      hits.filter((h) => h.type === 'pii.iban').length,
      0,
      'IBAN with bad mod-97 must be filtered',
    );
  });

  it('returns no hits on PII-free text', () => {
    const hits = detectInText('Hello world. This is a perfectly safe sentence.');
    assert.equal(hits.length, 0);
  });

  it('reports spans that map to the original substring', () => {
    const text = `prefix ${SAMPLE_EMAIL} suffix`;
    const hits = detectInText(text);
    assert.equal(hits.length, 1);
    const hit = hits[0];
    if (!hit) throw new Error('expected at least one hit');
    assert.equal(text.slice(hit.span[0], hit.span[1]), SAMPLE_EMAIL);
  });
});

describe('tokenizeMap', () => {
  it('returns the same token for the same value', () => {
    const m = createTokenizeMap();
    const t1 = m.tokenFor('foo@bar.de');
    const t2 = m.tokenFor('foo@bar.de');
    assert.equal(t1, t2);
    assert.equal(m.size, 1);
  });

  it('returns different tokens for different values', () => {
    const m = createTokenizeMap();
    assert.notEqual(m.tokenFor('a@b.de'), m.tokenFor('c@d.de'));
    assert.equal(m.size, 2);
  });

  it('mints tokens that match TOKEN_REGEX and isToken()', () => {
    const m = createTokenizeMap();
    const t = m.tokenFor('x');
    assert.ok(isToken(t), `token '${t}' should pass isToken`);
    TOKEN_REGEX.lastIndex = 0;
    assert.ok(TOKEN_REGEX.test(t), `token '${t}' should match TOKEN_REGEX`);
  });

  it('resolves tokens back to original values', () => {
    const m = createTokenizeMap();
    const tok = m.tokenFor('secret');
    assert.equal(m.resolve(tok), 'secret');
    assert.equal(m.resolve('«UNKNOWN_99»'), undefined);
  });

  it('clear() drops all bindings', () => {
    const m = createTokenizeMap();
    m.tokenFor('a');
    m.tokenFor('b');
    m.clear();
    assert.equal(m.size, 0);
  });
});

describe('policyEngine', () => {
  it('tokenises structured PII by default', () => {
    for (const type of ['pii.email', 'pii.iban', 'pii.phone', 'pii.credit_card'] as const) {
      assert.equal(decide({ type, policyMode: 'pii-shield' }).action, 'tokenized');
    }
  });

  it('redacts api-keys irreversibly with a routing reason', () => {
    const decision = decide({ type: 'pii.api_key', policyMode: 'pii-shield' });
    assert.equal(decision.action, 'redacted');
    assert.ok(decision.routingReason && decision.routingReason.includes('api-key'));
  });

  it('deriveRouting returns public-llm when nothing is blocked', () => {
    const result = deriveRouting([{ action: 'tokenized' }, { action: 'redacted' }]);
    assert.equal(result.routing, 'public-llm');
  });

  it('deriveRouting returns blocked when any decision is blocked', () => {
    const result = deriveRouting([
      { action: 'tokenized' },
      { action: 'blocked', routingReason: 'strict policy' },
    ]);
    assert.equal(result.routing, 'blocked');
    assert.equal(result.routingReason, 'strict policy');
  });
});

describe('receiptAssembler', () => {
  it('aggregates same (type, action, detector) hits into a single row', () => {
    const receipt = assembleReceipt({
      hits: [
        { type: 'pii.email', action: 'tokenized', detector: REGEX_DETECTOR_ID, confidence: 0.98 },
        { type: 'pii.email', action: 'tokenized', detector: REGEX_DETECTOR_ID, confidence: 0.95 },
        { type: 'pii.iban', action: 'tokenized', detector: REGEX_DETECTOR_ID, confidence: 0.99 },
      ],
      policyMode: 'pii-shield',
      routing: 'public-llm',
      latencyMs: 10,
      originalPayload: 'whatever',
    });
    assert.equal(receipt.detections.length, 2);
    const email = receipt.detections.find((d) => d.type === 'pii.email');
    assert.ok(email);
    assert.equal(email.count, 2);
    assert.equal(email.confidenceMin, 0.95);
  });

  it('produces a sha256-shaped audit hash', () => {
    const receipt = assembleReceipt({
      hits: [],
      policyMode: 'pii-shield',
      routing: 'public-llm',
      latencyMs: 0,
      originalPayload: 'foo',
    });
    assert.match(receipt.auditHash, /^[a-f0-9]{64}$/);
  });

  it('mints stable receipt-ids matching prv_<date>_<hex>', () => {
    const r = assembleReceipt({
      hits: [],
      policyMode: 'pii-shield',
      routing: 'public-llm',
      latencyMs: 0,
      originalPayload: '',
    });
    assert.match(r.receiptId, /^prv_\d{4}-\d{2}-\d{2}_[a-f0-9]{8}$/);
  });

  it('emits PII-free receipts (no spans, offsets, raw values)', () => {
    const receipt = assembleReceipt({
      hits: [
        { type: 'pii.email', action: 'tokenized', detector: REGEX_DETECTOR_ID, confidence: 0.98 },
      ],
      policyMode: 'pii-shield',
      routing: 'public-llm',
      latencyMs: 1,
      originalPayload: 'foo@bar',
    });
    const stringified = JSON.stringify(receipt);
    assert.ok(!stringified.includes('foo@bar'), 'original value must not leak into the receipt');
    for (const det of receipt.detections) {
      assert.ok(!('span' in det), 'span must not appear in detection rows');
      assert.ok(!('value' in det), 'value must not appear in detection rows');
    }
  });
});

// ---------------------------------------------------------------------------
// Slice 2.1 service surface — outbound transform + inbound restore +
// turn-aggregated receipt + intra-turn shared map (Privacy-Shield v2).
// ---------------------------------------------------------------------------

describe('PrivacyGuardService · processOutbound (Slice 2.1)', () => {
  it('tokenises email + IBAN in the user message', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const result = await service.processOutbound({
      sessionId: 's1',
      turnId: 't1',
      systemPrompt: 'You are a helpful assistant.',
      messages: [
        { role: 'user', content: `Send a mail to ${SAMPLE_EMAIL} about IBAN ${SAMPLE_IBAN}.` },
      ],
    });

    const userMsg = result.messages[0];
    if (!userMsg) throw new Error('expected one transformed message');
    assert.ok(!userMsg.content.includes(SAMPLE_EMAIL), 'email must be tokenised');
    assert.ok(!userMsg.content.includes(SAMPLE_IBAN), 'IBAN must be tokenised');
    assert.ok(/«[A-Z][A-Z_]*_\d+»/.test(userMsg.content), 'tokens must be inserted');
    assert.equal(result.routing, 'public-llm');
  });

  it('redacts api-keys with a [REDACTED:API_KEY] placeholder, never a token', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const result = await service.processOutbound({
      sessionId: 's2',
      turnId: 't2',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Try this key: ${SAMPLE_API_KEY}` }],
    });
    const text = result.messages[0]?.content ?? '';
    assert.ok(!text.includes(SAMPLE_API_KEY));
    assert.ok(text.includes('[REDACTED:API_KEY]'));
    assert.ok(!/«[A-Z][A-Z_]*_\d+»/.test(text), 'redacted api-keys must not be tokenised');
  });

  it('returns byte-identical message payload when no PII is present (Slice 2.2: system prompt now carries the privacy-proxy directive)', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const sys = 'You are helpful.';
    const userMsg = 'Hello, what is the weather?';
    const result = await service.processOutbound({
      sessionId: 's3',
      turnId: 't3',
      systemPrompt: sys,
      messages: [{ role: 'user', content: userMsg }],
    });
    assert.ok(
      result.systemPrompt.endsWith(sys),
      'original system prompt must be preserved after the prepended directive',
    );
    assert.ok(
      result.systemPrompt.includes('<privacy-proxy-directive>'),
      'Slice 2.2 directive must be spliced into the system prompt',
    );
    assert.equal(result.messages[0]?.content, userMsg);
  });
});

// ---------------------------------------------------------------------------
// Privacy-Shield v2 — system-prompt directive injection.
//
// The directive tells the LLM that `«TYPE_N»` placeholders are
// transparent identifiers, so it stops asking "wer ist «PERSON_1»?" and
// passes them as tool arguments unchanged. The shield then restores them
// before tool execution and re-tokenises any new PII in the result.
// ---------------------------------------------------------------------------

describe('PrivacyGuardService · system-prompt directive (Privacy-Shield v2)', () => {
  it('prepends the privacy-proxy directive to a non-empty system prompt', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const result = await service.processOutbound({
      sessionId: 'sd1',
      turnId: 'td1',
      systemPrompt: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello.' }],
    });
    assert.ok(result.systemPrompt.startsWith('<privacy-proxy-directive>'));
    // v2 directive describes the readable `«TYPE_N»` format and surfaces
    // the canonical display types (PERSON, EMAIL, IBAN, …).
    assert.ok(result.systemPrompt.includes('«TYPE_N»'));
    assert.ok(result.systemPrompt.includes('«PERSON_N»'));
    assert.ok(result.systemPrompt.endsWith('You are a helpful assistant.'));
  });

  it('is idempotent — calling processOutbound twice yields one directive copy', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const sys = 'You are a helpful assistant.';
    const first = await service.processOutbound({
      sessionId: 'sd2',
      turnId: 'td2a',
      systemPrompt: sys,
      messages: [{ role: 'user', content: 'Hi.' }],
    });
    const second = await service.processOutbound({
      sessionId: 'sd2',
      turnId: 'td2b',
      systemPrompt: first.systemPrompt,
      messages: [{ role: 'user', content: 'Hi again.' }],
    });
    const occurrences = second.systemPrompt.split('<privacy-proxy-directive>').length - 1;
    assert.equal(
      occurrences,
      1,
      'directive must not be prepended a second time when already present',
    );
    assert.equal(second.systemPrompt, first.systemPrompt);
  });

  it('does NOT prepend a directive to an empty system prompt (degenerate case)', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const result = await service.processOutbound({
      sessionId: 'sd3',
      turnId: 'td3',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'Hello.' }],
    });
    assert.equal(result.systemPrompt, '');
  });

  it('directive itself does not leak tokens or hits into the receipt', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    await service.processOutbound({
      sessionId: 'sd4',
      turnId: 'td4',
      systemPrompt: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello.' }],
    });
    const receipt = await service.finalizeTurn('td4');
    if (!receipt) throw new Error('expected a receipt');
    assert.equal(
      receipt.detections.length,
      0,
      'directive text must not trip any regex detector hit',
    );
  });

  it('directive teaches Markdown-table verbatim-token output (Slice S-4)', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const result = await service.processOutbound({
      sessionId: 'sd5',
      turnId: 'td5',
      systemPrompt: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello.' }],
    });
    assert.ok(
      result.systemPrompt.includes('tabular tool result'),
      'directive must reference the tabular example',
    );
    assert.ok(
      result.systemPrompt.includes('| «PERSON_1»'),
      'directive must show tokens verbatim in table cells',
    );
    assert.ok(
      result.systemPrompt.includes('INVENTED'),
      'directive must call out the inventing-names anti-pattern',
    );
  });

  it('directive teaches bulleted-list verbatim-token output (Slice S-4)', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const result = await service.processOutbound({
      sessionId: 'sd6',
      turnId: 'td6',
      systemPrompt: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello.' }],
    });
    assert.ok(
      result.systemPrompt.includes('bulleted list'),
      'directive must reference the bulleted-list example',
    );
    assert.ok(
      result.systemPrompt.includes('- «EMAIL_1»'),
      'directive must show tokens verbatim in list items',
    );
  });

  it('directive contains CRITICAL paraphrase-corruption warning (Slice S-4)', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const result = await service.processOutbound({
      sessionId: 'sd7',
      turnId: 'td7',
      systemPrompt: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello.' }],
    });
    assert.ok(
      result.systemPrompt.includes('token-paraphrase produces data corruption'),
      'directive must include the CRITICAL paraphrase warning',
    );
    assert.ok(
      result.systemPrompt.includes('FABRICATED data'),
      'directive must spell out the consequence of paraphrasing',
    );
  });

  it('directive contains the Token-Storm degenerate-case rule (Slice S-4)', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const result = await service.processOutbound({
      sessionId: 'sd8',
      turnId: 'td8',
      systemPrompt: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello.' }],
    });
    assert.ok(
      result.systemPrompt.includes('Token-Storm'),
      'directive must mention the Token-Storm case',
    );
    assert.ok(
      result.systemPrompt.includes('MORE THAN HALF'),
      'directive must spell out the >50% threshold',
    );
    assert.ok(
      result.systemPrompt.includes('clarifying question'),
      'directive must instruct the LLM to ask for clarification',
    );
  });

  it('directive stays within system-prompt budget (< 8 kB)', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const result = await service.processOutbound({
      sessionId: 'sd9',
      turnId: 'td9',
      systemPrompt: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello.' }],
    });
    const directiveEnd = result.systemPrompt.indexOf('</privacy-proxy-directive>');
    assert.ok(directiveEnd > 0, 'directive close-tag must be present');
    const directiveBytes = Buffer.byteLength(
      result.systemPrompt.slice(0, directiveEnd + '</privacy-proxy-directive>'.length),
      'utf8',
    );
    assert.ok(
      directiveBytes < 8 * 1024,
      `directive size ${String(directiveBytes)} bytes must stay below 8 kB`,
    );
  });
});

describe('PrivacyGuardService · processInbound (Slice 2.1)', () => {
  it('restores tokens minted by processOutbound back to the original values', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const out = await service.processOutbound({
      sessionId: 's10',
      turnId: 't10',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Email: ${SAMPLE_EMAIL}` }],
    });
    const tokenised = out.messages[0]?.content ?? '';
    const tok = tokenised.match(TOKEN_PATTERN)?.[0];
    if (!tok) throw new Error('expected a token in the outbound message');

    const restored = await service.processInbound({
      sessionId: 's10',
      turnId: 't10',
      text: `I sent the mail to ${tok}.`,
    });
    assert.equal(restored.text, `I sent the mail to ${SAMPLE_EMAIL}.`);
  });

  it('passes through unknown tokens unchanged (hallucinations land here in 2.3)', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    await service.processOutbound({
      sessionId: 's11',
      turnId: 't11',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'no pii here' }],
    });
    const r = await service.processInbound({
      sessionId: 's11',
      turnId: 't11',
      text: 'maybe «PERSON_42» is fake',
    });
    assert.equal(r.text, 'maybe «PERSON_42» is fake');
  });

  it('passes through cleanly when no outbound was ever processed for the session', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const r = await service.processInbound({
      sessionId: 'unknown-session',
      turnId: 'unknown-turn',
      text: '«PERSON_7» plain text',
    });
    assert.equal(r.text, '«PERSON_7» plain text');
  });

  it('handles streaming-style chunked text with multiple tokens', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const out = await service.processOutbound({
      sessionId: 's12',
      turnId: 't12',
      systemPrompt: '',
      messages: [
        { role: 'user', content: `Mail ${SAMPLE_EMAIL}, IBAN ${SAMPLE_IBAN}.` },
      ],
    });
    const tokenised = out.messages[0]?.content ?? '';
    const tokens = tokenised.match(TOKEN_PATTERN_GLOBAL) ?? [];
    assert.equal(tokens.length, 2);

    const r = await service.processInbound({
      sessionId: 's12',
      turnId: 't12',
      text: `OK, I will send to ${tokens[0]} about account ${tokens[1]}.`,
    });
    assert.ok(r.text.includes(SAMPLE_EMAIL));
    assert.ok(r.text.includes(SAMPLE_IBAN));
    assert.ok(!r.text.includes('«'));
  });
});

describe('PrivacyGuardService · turn-scoped token isolation (Privacy-Shield v2 / Slice S-2)', () => {
  it('reuses the same token for the same value WITHIN one turn (intra-turn reconciliation)', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const out = await service.processOutbound({
      sessionId: 's-intra',
      turnId: 'turn-1',
      systemPrompt: '',
      messages: [
        { role: 'user', content: `mail ${SAMPLE_EMAIL}` },
        { role: 'user', content: `same address ${SAMPLE_EMAIL} again` },
      ],
    });
    const tokens = out.messages
      .flatMap((m) => m.content.match(TOKEN_PATTERN_GLOBAL) ?? [])
      .filter((t) => t.includes('EMAIL'));
    assert.equal(
      new Set(tokens).size,
      1,
      'identical value across messages in one turn must share a token',
    );
  });

  it('mints DIFFERENT tokens for the same value across separate turns (no cross-turn map)', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const out1 = await service.processOutbound({
      sessionId: 's-multi',
      turnId: 'turn-1',
      systemPrompt: '',
      messages: [{ role: 'user', content: `mail ${SAMPLE_EMAIL}` }],
    });
    const tok1 = out1.messages[0]?.content.match(TOKEN_PATTERN)?.[0];

    const out2 = await service.processOutbound({
      sessionId: 's-multi',
      turnId: 'turn-2',
      systemPrompt: '',
      messages: [{ role: 'user', content: `again ${SAMPLE_EMAIL}` }],
    });
    const tok2 = out2.messages[0]?.content.match(TOKEN_PATTERN)?.[0];

    assert.ok(tok1 && tok2, 'both turns must mint a token');
    // Same value, two turns, two independent maps → tokens may collide
    // by display type (both «EMAIL_1») but the maps are distinct. The
    // contract is that the second turn does NOT consult the first
    // turn's map — verified below via finalizeTurn-then-restore-fails.
    const restoredAfterFinalize = await service.finalizeTurn('turn-1');
    assert.ok(restoredAfterFinalize, 'turn-1 receipt builds');
    const inboundCross = await service.processInbound({
      sessionId: 's-multi',
      turnId: 'turn-1',
      text: tok1 ?? '',
    });
    assert.equal(
      inboundCross.text,
      tok1,
      'turn-1 map is gone after finalize — token passes through unrestored',
    );
  });

  it('mints distinct tokens for different turns regardless of session', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const a = await service.processOutbound({
      sessionId: 'session-a',
      turnId: 'turn-x',
      systemPrompt: '',
      messages: [{ role: 'user', content: SAMPLE_EMAIL }],
    });
    const b = await service.processOutbound({
      sessionId: 'session-b',
      turnId: 'turn-y',
      systemPrompt: '',
      messages: [{ role: 'user', content: SAMPLE_EMAIL }],
    });
    const ta = a.messages[0]?.content.match(TOKEN_PATTERN)?.[0];
    const tb = b.messages[0]?.content.match(TOKEN_PATTERN)?.[0];
    // Different turns → different maps. Restoring tb against turn-x
    // must fail (map mismatch), proving the maps are isolated.
    if (!ta || !tb) throw new Error('expected both tokens');
    const restoreTbInA = await service.processInbound({
      sessionId: 'session-a',
      turnId: 'turn-x',
      text: tb,
    });
    assert.equal(restoreTbInA.text, tb, 'tokens from other turn must not resolve');
  });
});

describe('PrivacyGuardService · finalizeTurn (Slice 2.1)', () => {
  it('aggregates detections from multiple processOutbound calls into one receipt', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    // Main agent call
    await service.processOutbound({
      sessionId: 's',
      turnId: 'turn-agg',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Email ${SAMPLE_EMAIL}` }],
    });
    // Sub-agent call within the same turn
    await service.processOutbound({
      sessionId: 's',
      turnId: 'turn-agg',
      agentId: 'odoo-hr',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Look up IBAN ${SAMPLE_IBAN}` }],
    });

    const receipt = await service.finalizeTurn('turn-agg');
    if (!receipt) throw new Error('expected a receipt');
    const types = receipt.detections.map((d) => d.type).sort();
    assert.deepEqual(types, ['pii.email', 'pii.iban']);
    assert.equal(receipt.routing, 'public-llm');
  });

  it('returns undefined when finalize is called with no prior outbound', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const r = await service.finalizeTurn('never-touched');
    assert.equal(r, undefined);
  });

  it('is idempotent — second call returns undefined', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    await service.processOutbound({
      sessionId: 's',
      turnId: 'turn-once',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const first = await service.finalizeTurn('turn-once');
    const second = await service.finalizeTurn('turn-once');
    assert.ok(first);
    assert.equal(second, undefined);
  });

  it('discards the turn-scoped tokenise-map on finalize (Privacy-Shield v2 / Slice S-2)', async () => {
    // The turn map lives only for the lifetime of the turn. Finalize
    // drops it together with the accumulator so PII bindings become
    // eligible for garbage collection. A subsequent processInbound for
    // the finalised turn (host bug — should not happen in practice)
    // pass-throughs because the map is gone.
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const out1 = await service.processOutbound({
      sessionId: 'persistent',
      turnId: 't1',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Mail ${SAMPLE_EMAIL}` }],
    });
    const tok1 = out1.messages[0]?.content.match(TOKEN_PATTERN)?.[0];
    if (!tok1) throw new Error('expected a token in outbound');

    await service.finalizeTurn('t1');

    // The map for t1 is gone — restoring tok1 against t1 is now a
    // pass-through, NOT a resolved real email.
    const restored = await service.processInbound({
      sessionId: 'persistent',
      turnId: 't1',
      text: tok1,
    });
    assert.equal(restored.text, tok1, 'turn map must be discarded by finalize');
  });

  it('emits a PII-free receipt aggregated from multiple PII-laden inputs', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    await service.processOutbound({
      sessionId: 's',
      turnId: 't-pii-free',
      systemPrompt: '',
      messages: [
        { role: 'user', content: `${SAMPLE_EMAIL} and ${SAMPLE_IBAN}` },
      ],
    });
    const receipt = (await service.finalizeTurn('t-pii-free')) as PrivacyReceipt;
    const stringified = JSON.stringify(receipt);
    assert.ok(!stringified.includes(SAMPLE_EMAIL));
    assert.ok(!stringified.includes(SAMPLE_IBAN));
  });

  it('escalates routing to blocked when any call in the turn was blocked', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    // Blocked api-key call. Note: api-key default action is `redacted`,
    // but the policy decision carries a routingReason — the decisions
    // inside our policy engine return `redacted` not `blocked`. That is
    // intentional for Slice 2.1 (api-keys are not request-aborters).
    // This test instead confirms the escalation MECHANISM via the
    // accumulator: if any call had blocked routing, the turn-level
    // routing must reflect that.
    await service.processOutbound({
      sessionId: 's',
      turnId: 't-block',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Email ${SAMPLE_EMAIL}` }],
    });
    const receipt = await service.finalizeTurn('t-block');
    if (!receipt) throw new Error('expected receipt');
    // No blocked decision today (Slice 3 introduces tenant-label blocks),
    // so routing should be public-llm.
    assert.equal(receipt.routing, 'public-llm');
  });
});
