import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

// ---------------------------------------------------------------------------
// Slice 2.2 — tool-roundtrip surface coverage.
//
// Background: the privacy proxy tokenises PII in user inputs before they
// reach the public LLM. Without a roundtrip, when the LLM emits a tool_use
// block referencing a token (e.g. `query_odoo_hr({ name: "tok_a3f9" })`)
// the downstream domain tool would receive the placeholder and fail.
//
// `processToolInput` walks the LLM's tool-use input recursively, restores
// every `tok_<hex>` substring against the session's tokenize-map, and
// counts how many string fields had a restoration (telemetry surfaced on
// the receipt as `toolRoundtrip.argsRestored`).
//
// `processToolResult` runs the detector pipeline over the tool's text
// result, so any plaintext PII the tool surfaced (Marcel Wege, an e-mail,
// an IBAN) is tokenised before it goes back to the LLM as a `tool_result`
// content block. Hits land in the SAME turn-accumulator as
// `processOutbound`, so the user sees one unified receipt.
// ---------------------------------------------------------------------------

const SAMPLE_EMAIL = 'max.mustermann@firma.de';
const SAMPLE_IBAN = 'DE89370400440532013000';

describe('PrivacyGuardService · processToolInput (Slice 2.2)', () => {
  it('restores tokens in a top-level string argument', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const out = await service.processOutbound({
      sessionId: 'tr1',
      turnId: 'tt1',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Send mail to ${SAMPLE_EMAIL}.` }],
    });
    const tokenised = out.messages[0]?.content ?? '';
    const tok = tokenised.match(/tok_[0-9a-f]{8}_[a-z0-9_]+/)?.[0];
    if (!tok) throw new Error('expected a token in the outbound message');

    const r = await service.processToolInput({
      sessionId: 'tr1',
      turnId: 'tt1',
      toolName: 'send_mail',
      input: { recipient: tok, subject: 'Hello' },
    });
    const inputObj = r.input as { recipient: string; subject: string };
    assert.equal(inputObj.recipient, SAMPLE_EMAIL);
    assert.equal(inputObj.subject, 'Hello');
    assert.equal(r.tokensRestored, 1);
  });

  it('walks nested objects and arrays', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    await service.processOutbound({
      sessionId: 'tr2',
      turnId: 'tt2',
      systemPrompt: '',
      messages: [
        {
          role: 'user',
          content: `Mail ${SAMPLE_EMAIL}, IBAN ${SAMPLE_IBAN}.`,
        },
      ],
    });
    const tokens = (
      await service.processOutbound({
        sessionId: 'tr2',
        turnId: 'tt2',
        systemPrompt: '',
        messages: [
          {
            role: 'user',
            content: `Mail ${SAMPLE_EMAIL}, IBAN ${SAMPLE_IBAN}.`,
          },
        ],
      })
    ).messages[0]?.content.match(/tok_[0-9a-f]{8}_[a-z0-9_]+/g);
    if (!tokens || tokens.length < 2) throw new Error('expected two tokens');
    const [emailTok, ibanTok] = tokens;
    const r = await service.processToolInput({
      sessionId: 'tr2',
      turnId: 'tt2',
      toolName: 'multi',
      input: {
        recipients: [emailTok, 'static-string'],
        nested: { iban: ibanTok, count: 42, active: true },
      },
    });
    const inputObj = r.input as {
      recipients: string[];
      nested: { iban: string; count: number; active: boolean };
    };
    assert.equal(inputObj.recipients[0], SAMPLE_EMAIL);
    assert.equal(inputObj.recipients[1], 'static-string');
    assert.equal(inputObj.nested.iban, SAMPLE_IBAN);
    assert.equal(inputObj.nested.count, 42);
    assert.equal(inputObj.nested.active, true);
    assert.equal(r.tokensRestored, 2);
  });

  it('passes through unchanged when no tokens are present', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const r = await service.processToolInput({
      sessionId: 'tr3',
      turnId: 'tt3',
      toolName: 'noop',
      input: { greeting: 'hello world', count: 7 },
    });
    assert.deepEqual(r.input, { greeting: 'hello world', count: 7 });
    assert.equal(r.tokensRestored, 0);
  });

  it('passes through unchanged when no outbound was ever processed for the session', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const r = await service.processToolInput({
      sessionId: 'tr4',
      turnId: 'tt4',
      toolName: 'noop',
      input: { token: 'tok_deadbeef' },
    });
    // No session map was minted ⇒ the unknown token is left in place.
    assert.deepEqual(r.input, { token: 'tok_deadbeef' });
    assert.equal(r.tokensRestored, 0);
  });
});

describe('PrivacyGuardService · processToolResult (Slice 2.2)', () => {
  it('tokenises PII in the result text', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    // Touch the session map so the tokenize-map exists.
    await service.processOutbound({
      sessionId: 'tr5',
      turnId: 'tt5',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'unrelated' }],
    });
    const r = await service.processToolResult({
      sessionId: 'tr5',
      turnId: 'tt5',
      toolName: 'query_hr',
      text: `Mitarbeiter: ${SAMPLE_EMAIL} (IBAN ${SAMPLE_IBAN})`,
    });
    assert.ok(!r.text.includes(SAMPLE_EMAIL));
    assert.ok(!r.text.includes(SAMPLE_IBAN));
    assert.ok(/tok_[0-9a-f]{8}_[a-z0-9_]+/.test(r.text));
    assert.equal(r.transformed, true);
  });

  it('returns byte-identical text + transformed=false when the result is PII-free', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    await service.processOutbound({
      sessionId: 'tr6',
      turnId: 'tt6',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'unrelated' }],
    });
    const cleanText = 'No PII here. Move along.';
    const r = await service.processToolResult({
      sessionId: 'tr6',
      turnId: 'tt6',
      toolName: 'query_hr',
      text: cleanText,
    });
    assert.equal(r.text, cleanText);
    assert.equal(r.transformed, false);
  });

  it('result hits land in the same turn receipt as outbound hits', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    await service.processOutbound({
      sessionId: 'tr7',
      turnId: 'tt7',
      systemPrompt: '',
      messages: [{ role: 'user', content: `IBAN ${SAMPLE_IBAN}.` }],
    });
    await service.processToolResult({
      sessionId: 'tr7',
      turnId: 'tt7',
      toolName: 'lookup',
      text: `Confirm IBAN ${SAMPLE_IBAN} for ${SAMPLE_EMAIL}.`,
    });
    const receipt = await service.finalizeTurn('tt7');
    if (!receipt) throw new Error('expected a receipt');
    const ibanCount = receipt.detections
      .filter((d) => d.type === 'pii.iban')
      .reduce((s, d) => s + d.count, 0);
    const emailCount = receipt.detections
      .filter((d) => d.type === 'pii.email')
      .reduce((s, d) => s + d.count, 0);
    assert.ok(ibanCount >= 2, 'IBAN must be aggregated across outbound + tool-result');
    assert.equal(emailCount, 1, 'email detected only in tool-result');
  });
});

describe('PrivacyGuardService · receipt.toolRoundtrip telemetry (Slice 2.2)', () => {
  it('omits toolRoundtrip when no tool roundtrip ran', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    await service.processOutbound({
      sessionId: 'tr8',
      turnId: 'tt8',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const receipt = await service.finalizeTurn('tt8');
    if (!receipt) throw new Error('expected a receipt');
    assert.equal(receipt.toolRoundtrip, undefined);
  });

  it('reports argsRestored + resultsTokenized + callCount when both fired', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const out = await service.processOutbound({
      sessionId: 'tr9',
      turnId: 'tt9',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Mail to ${SAMPLE_EMAIL}.` }],
    });
    const tok = out.messages[0]?.content.match(/tok_[0-9a-f]{8}_[a-z0-9_]+/)?.[0];
    if (!tok) throw new Error('expected a token');
    await service.processToolInput({
      sessionId: 'tr9',
      turnId: 'tt9',
      toolName: 'send_mail',
      input: { to: tok },
    });
    await service.processToolResult({
      sessionId: 'tr9',
      turnId: 'tt9',
      toolName: 'send_mail',
      text: `Mail sent to ${SAMPLE_EMAIL}.`,
    });
    const receipt = await service.finalizeTurn('tt9');
    if (!receipt) throw new Error('expected a receipt');
    assert.ok(receipt.toolRoundtrip);
    assert.equal(receipt.toolRoundtrip.argsRestored, 1);
    assert.equal(receipt.toolRoundtrip.resultsTokenized, 1);
    assert.equal(receipt.toolRoundtrip.callCount, 2);
  });
});
