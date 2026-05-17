import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

// ---------------------------------------------------------------------------
// Privacy-Shield v2 (Slice S-5) — Output Validator.
//
// Two metrics, one recommendation:
//   1. Token-loss ratio — share of minted tokens the LLM did NOT
//      reference verbatim in its response. Catches paraphrase
//      (HR-routine bug, 2026-05-14): minted=3 employee tokens,
//      restored=0 → loss=1.0 → recommendation `retry`.
//   2. Spontaneous PII — PII detected in the assistant text whose
//      value was never tokenised this turn. Catches fabricated
//      values: LLM emits "Markus Brees" without that name ever
//      appearing in a tool result → recommendation `block`.
//
// Recommendation precedence: spontaneous PII (block) > token-loss
// over threshold (retry) > pass.
// ---------------------------------------------------------------------------

const SAMPLE_EMAIL = 'alice@example.com';
const SAMPLE_IBAN = 'DE89370400440532013000';

describe('PrivacyGuardService · validateOutput (Slice S-5)', () => {
  it('returns pass + zero-loss when the LLM emits every minted token verbatim', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const out = await service.processOutbound({
      sessionId: 's-pass',
      turnId: 't-pass',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Mail to ${SAMPLE_EMAIL}.` }],
    });
    const tok = out.messages[0]?.content.match(/«[A-Z][A-Z_]*_\d+»/)?.[0];
    if (!tok) throw new Error('expected a token');

    // Simulate the LLM's response containing the token verbatim — what
    // a well-behaved model emits per the privacy-proxy directive.
    await service.processInbound({
      sessionId: 's-pass',
      turnId: 't-pass',
      text: `OK, I sent the mail to ${tok}.`,
    });

    const result = await service.validateOutput({
      sessionId: 's-pass',
      turnId: 't-pass',
      assistantText: `OK, I sent the mail to ${SAMPLE_EMAIL}.`, // post-restore
    });

    assert.equal(result.tokensMinted, 1);
    assert.equal(result.tokensRestored, 1);
    assert.equal(result.tokenLossRatio, 0);
    assert.equal(result.spontaneousPiiHits.length, 0);
    assert.equal(result.recommendation, 'pass');
  });

  it('detects token loss when the LLM paraphrases all tokens (HR-routine failure mode)', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    // Mint three name tokens via a tool result so the turn has 3
    // distinct tokens. Use processToolResult so the names land in the
    // same turn map.
    await service.processOutbound({
      sessionId: 's-hr',
      turnId: 't-hr',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'Absences today?' }],
    });
    await service.processToolResult({
      sessionId: 's-hr',
      turnId: 't-hr',
      toolName: 'hr_absences',
      text: 'Mitarbeiter heute: Marcel Wege, Stefan Müller, Christoph Schmidt.',
    });
    // Simulate the LLM's paraphrasing failure: it received 3 tokens
    // but emitted plausible-looking names without referencing tokens.
    // processInbound is called on the LLM's RAW response; here the
    // raw response contains zero `«…»` markers because the model
    // paraphrased them all away.
    await service.processInbound({
      sessionId: 's-hr',
      turnId: 't-hr',
      text: 'Heute abwesend: Max Mustermann, Erika Beispiel, Hans Test.',
    });

    const result = await service.validateOutput({
      sessionId: 's-hr',
      turnId: 't-hr',
      assistantText: 'Heute abwesend: Max Mustermann, Erika Beispiel, Hans Test.',
    });

    assert.ok(result.tokensMinted >= 3, 'three names should have been minted');
    assert.equal(result.tokensRestored, 0, 'no tokens were referenced in response');
    assert.equal(result.tokenLossRatio, 1);
    // Plausible names are spontaneous PII detected by the regex /
    // future NER detectors. Even without NER (which is not configured
    // in this minimal test), the recommendation must NOT be `pass` —
    // it must at minimum escalate to `retry` based on the loss ratio.
    assert.notEqual(result.recommendation, 'pass');
  });

  it('returns block when output contains PII never tokenised this turn (spontaneous PII)', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    await service.processOutbound({
      sessionId: 's-spi',
      turnId: 't-spi',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'Hello there.' }],
    });
    // No tokens minted. The "assistant" text contains a regex-
    // detectable PII (email) that was NOT in the turn map.
    const result = await service.validateOutput({
      sessionId: 's-spi',
      turnId: 't-spi',
      assistantText: `Sure, ping me at ${SAMPLE_EMAIL}.`,
    });
    assert.equal(result.tokensMinted, 0);
    assert.ok(result.spontaneousPiiHits.length >= 1);
    assert.equal(result.recommendation, 'block');
    assert.ok(result.recommendationReason?.includes('spontaneous PII'));
  });

  it('does not flag restored-token values as spontaneous PII', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    await service.processOutbound({
      sessionId: 's-rest',
      turnId: 't-rest',
      systemPrompt: '',
      messages: [{ role: 'user', content: `My IBAN is ${SAMPLE_IBAN}.` }],
    });
    // Pretend the LLM emitted the token in its response (so it's
    // counted as restored in processInbound) and the post-restore
    // text now contains the real IBAN.
    const out = await service.processOutbound({
      sessionId: 's-rest',
      turnId: 't-rest',
      systemPrompt: '',
      messages: [{ role: 'user', content: `My IBAN is ${SAMPLE_IBAN}.` }],
    });
    const tok = out.messages[0]?.content.match(/«[A-Z][A-Z_]*_\d+»/)?.[0];
    if (!tok) throw new Error('expected a token');
    await service.processInbound({
      sessionId: 's-rest',
      turnId: 't-rest',
      text: `Confirmed: ${tok}.`,
    });
    const result = await service.validateOutput({
      sessionId: 's-rest',
      turnId: 't-rest',
      assistantText: `Confirmed: ${SAMPLE_IBAN}.`,
    });
    // The IBAN appears in the assistant text, but it was tokenised in
    // this turn → must NOT be flagged as spontaneous PII.
    assert.equal(result.spontaneousPiiHits.length, 0);
    assert.equal(result.recommendation, 'pass');
  });

  it('configurable threshold gates the retry recommendation', async () => {
    const strict = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      tokenLossThreshold: 0.1,
    });
    const lenient = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      tokenLossThreshold: 0.9,
    });
    for (const service of [strict, lenient]) {
      await service.processOutbound({
        sessionId: 's',
        turnId: 't',
        systemPrompt: '',
        messages: [{ role: 'user', content: `Mail to ${SAMPLE_EMAIL}.` }],
      });
      await service.processInbound({ sessionId: 's', turnId: 't', text: 'Done.' });
    }
    const strictResult = await strict.validateOutput({
      sessionId: 's',
      turnId: 't',
      assistantText: 'Done.',
    });
    const lenientResult = await lenient.validateOutput({
      sessionId: 's',
      turnId: 't',
      assistantText: 'Done.',
    });
    // Both have lossRatio = 1.0 (1 minted, 0 restored).
    assert.equal(strictResult.tokenLossRatio, 1);
    assert.equal(lenientResult.tokenLossRatio, 1);
    // Strict threshold (0.1) triggers retry (or block if spontaneous PII detected).
    assert.notEqual(strictResult.recommendation, 'pass');
    // Lenient threshold (0.9) — 1.0 still exceeds 0.9 → retry.
    assert.notEqual(lenientResult.recommendation, 'pass');
  });

  it('receipt.output is absent when validator never ran', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    await service.processOutbound({
      sessionId: 's-no',
      turnId: 't-no',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'no pii' }],
    });
    const receipt = await service.finalizeTurn('t-no');
    if (!receipt) throw new Error('expected a receipt');
    assert.equal(receipt.output, undefined);
  });

  it('receipt.output is present and PII-free when validator ran', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    await service.processOutbound({
      sessionId: 's-r',
      turnId: 't-r',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Mail ${SAMPLE_EMAIL}.` }],
    });
    await service.validateOutput({
      sessionId: 's-r',
      turnId: 't-r',
      assistantText: 'Acknowledged.',
    });
    const receipt = await service.finalizeTurn('t-r');
    if (!receipt) throw new Error('expected a receipt');
    assert.ok(receipt.output, 'output block must be present');
    const stringified = JSON.stringify(receipt);
    assert.ok(
      !stringified.includes(SAMPLE_EMAIL),
      'matched email must not leak into receipt',
    );
  });
});
