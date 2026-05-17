import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

// ---------------------------------------------------------------------------
// Privacy-Shield v2 (Slice S-6) — Egress Filter.
//
// Three reaction modes against the SAME bug class (spontaneous PII the
// LLM produced that the shield never tokenised):
//
//   - `mark`:  receipt records the hits, channel-bound text unchanged.
//   - `mask`:  spans rewritten inline as `«TYPE_N»` tokens (default).
//   - `block`: routing flips to `blocked`; host swaps the payload.
//
// Each test pre-tokenises a "known" value via `processOutbound` so the
// turn-map can distinguish restored PII (legit, stays untouched at
// egress) from spontaneous PII (caught at egress).
// ---------------------------------------------------------------------------

const KNOWN_EMAIL = 'alice@example.com';
const SPONTANEOUS_EMAIL = 'fabricated@example.com';

describe('PrivacyGuardService · egressFilter (Slice S-6)', () => {
  it('returns allow + zero hits when egress sees only restored values from the turn-map', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    // Tokenise an email on outbound — the turn-map now knows it.
    await service.processOutbound({
      sessionId: 's-allow',
      turnId: 't-allow',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Mail to ${KNOWN_EMAIL}.` }],
    });
    // Final answer references the SAME (already restored) email.
    const result = await service.egressFilter({
      sessionId: 's-allow',
      turnId: 't-allow',
      texts: [{ id: 'answer', text: `OK, sent to ${KNOWN_EMAIL}.` }],
    });
    assert.equal(result.routing, 'allow');
    assert.equal(result.spontaneousHits, 0);
    assert.equal(result.maskedCount, 0);
    assert.equal(result.texts[0]?.text, `OK, sent to ${KNOWN_EMAIL}.`);
  });

  it('masks spontaneous PII inline by default (mask mode)', async () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      egressFilterMode: 'mask',
    });
    await service.processOutbound({
      sessionId: 's-mask',
      turnId: 't-mask',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Hi from ${KNOWN_EMAIL}.` }],
    });
    // The LLM "fabricated" a fresh email the shield never saw.
    const result = await service.egressFilter({
      sessionId: 's-mask',
      turnId: 't-mask',
      texts: [
        {
          id: 'answer',
          text: `OK — for follow-up please contact ${SPONTANEOUS_EMAIL}.`,
        },
      ],
    });
    assert.equal(result.routing, 'masked');
    assert.equal(result.spontaneousHits, 1);
    assert.equal(result.maskedCount, 1);
    assert.equal(result.mode, 'mask');
    assert.match(result.texts[0]?.text ?? '', /«EMAIL_\d+»/);
    assert.ok(!(result.texts[0]?.text ?? '').includes(SPONTANEOUS_EMAIL));
  });

  it('flags spontaneous PII without altering text in mark mode', async () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      egressFilterMode: 'mark',
    });
    await service.processOutbound({
      sessionId: 's-mark',
      turnId: 't-mark',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Hi from ${KNOWN_EMAIL}.` }],
    });
    const before = `Please email me at ${SPONTANEOUS_EMAIL}.`;
    const result = await service.egressFilter({
      sessionId: 's-mark',
      turnId: 't-mark',
      texts: [{ id: 'answer', text: before }],
    });
    assert.equal(result.routing, 'allow');
    assert.equal(result.spontaneousHits, 1);
    assert.equal(result.maskedCount, 0);
    assert.equal(result.mode, 'mark');
    assert.equal(result.texts[0]?.text, before);
  });

  it('returns blocked routing in block mode without mutating original text', async () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      egressFilterMode: 'block',
    });
    await service.processOutbound({
      sessionId: 's-block',
      turnId: 't-block',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Hi from ${KNOWN_EMAIL}.` }],
    });
    const before = `Forward to ${SPONTANEOUS_EMAIL}.`;
    const result = await service.egressFilter({
      sessionId: 's-block',
      turnId: 't-block',
      texts: [
        { id: 'answer', text: before },
        { id: 'attachment.0.altText', text: 'unrelated text' },
      ],
    });
    assert.equal(result.routing, 'blocked');
    assert.equal(result.spontaneousHits, 1);
    assert.equal(result.maskedCount, 0);
    // Block mode preserves originals; the host is responsible for the swap.
    assert.equal(result.texts[0]?.text, before);
  });

  it('honours per-call mode override', async () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      egressFilterMode: 'mask',
    });
    await service.processOutbound({
      sessionId: 's-override',
      turnId: 't-override',
      systemPrompt: '',
      messages: [{ role: 'user', content: `From ${KNOWN_EMAIL}.` }],
    });
    const result = await service.egressFilter({
      sessionId: 's-override',
      turnId: 't-override',
      mode: 'mark',
      texts: [{ id: 'answer', text: `Please reach me at ${SPONTANEOUS_EMAIL}.` }],
    });
    assert.equal(result.mode, 'mark');
    assert.equal(result.maskedCount, 0);
  });

  it('walks every slot in the texts array (multi-slot mask)', async () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      egressFilterMode: 'mask',
    });
    await service.processOutbound({
      sessionId: 's-multi',
      turnId: 't-multi',
      systemPrompt: '',
      messages: [{ role: 'user', content: `From ${KNOWN_EMAIL}.` }],
    });
    const result = await service.egressFilter({
      sessionId: 's-multi',
      turnId: 't-multi',
      texts: [
        { id: 'answer', text: `Sent — see ${KNOWN_EMAIL}.` },
        { id: 'followUp.0.prompt', text: `Mail second copy to ${SPONTANEOUS_EMAIL}` },
      ],
    });
    assert.equal(result.routing, 'masked');
    assert.equal(result.texts[0]?.text, `Sent — see ${KNOWN_EMAIL}.`);
    assert.match(result.texts[1]?.text ?? '', /«EMAIL_\d+»/);
    assert.equal(result.texts[1]?.maskedCount, 1);
  });

  it('finalizeTurn folds the egress summary into the receipt', async () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      egressFilterMode: 'mask',
    });
    await service.processOutbound({
      sessionId: 's-receipt',
      turnId: 't-receipt',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Hi from ${KNOWN_EMAIL}.` }],
    });
    await service.egressFilter({
      sessionId: 's-receipt',
      turnId: 't-receipt',
      texts: [{ id: 'answer', text: `Mail to ${SPONTANEOUS_EMAIL}.` }],
    });
    const receipt = await service.finalizeTurn('t-receipt');
    if (!receipt) throw new Error('expected a receipt');
    assert.ok(receipt.egress, 'expected receipt.egress to be present');
    assert.equal(receipt.egress.routing, 'masked');
    assert.equal(receipt.egress.spontaneousHits, 1);
    assert.equal(receipt.egress.maskedCount, 1);
    assert.equal(receipt.egress.mode, 'mask');
    assert.ok(receipt.egress.detectorRuns.length > 0);
  });

  it('getEgressConfig surfaces the operator-configured defaults', () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      egressFilterMode: 'block',
      egressFilterEnabled: false,
      egressBlockPlaceholderText: 'Custom refusal text',
    });
    const cfg = service.getEgressConfig();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.mode, 'block');
    assert.equal(cfg.blockPlaceholderText, 'Custom refusal text');
  });

  it('getEgressConfig defaults: enabled true, mode mask, English placeholder', () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const cfg = service.getEgressConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.mode, 'mask');
    assert.match(cfg.blockPlaceholderText, /privacy filter/i);
  });

  it('honours the allowlist at egress — terms suppressed inbound stay suppressed outbound', async () => {
    // Regression for the `Kr«ADDRESS_9»` bug seen live on 2026-05-14:
    // the inbound pipeline's allowlist filter dropped Presidio's
    // false-positive on the German topic-noun "Krankheit", but the
    // egress filter ran detectors independently and re-fired on the
    // same span. With shared allowlist semantics the egress pass
    // should now agree with inbound and let the term through.
    const ALLOWLISTED_EMAIL = 'topic-noun@example.com';
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      egressFilterMode: 'mask',
      allowlist: { repoDefaultTerms: [ALLOWLISTED_EMAIL] },
    });
    await service.processOutbound({
      sessionId: 's-allowlist',
      turnId: 't-allowlist',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Hi from ${KNOWN_EMAIL}.` }],
    });
    const before = `Reference: ${ALLOWLISTED_EMAIL} (allowlisted as topic noun).`;
    const result = await service.egressFilter({
      sessionId: 's-allowlist',
      turnId: 't-allowlist',
      texts: [{ id: 'answer', text: before }],
    });
    assert.equal(result.routing, 'allow');
    assert.equal(result.spontaneousHits, 0);
    assert.equal(result.maskedCount, 0);
    assert.equal(result.texts[0]?.text, before);
  });

  it('block mode short-circuits remaining slots after the first spontaneous hit', async () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      egressFilterMode: 'block',
    });
    await service.processOutbound({
      sessionId: 's-short',
      turnId: 't-short',
      systemPrompt: '',
      messages: [{ role: 'user', content: `From ${KNOWN_EMAIL}.` }],
    });
    const result = await service.egressFilter({
      sessionId: 's-short',
      turnId: 't-short',
      texts: [
        { id: 'a', text: `Reply to ${SPONTANEOUS_EMAIL}` },
        { id: 'b', text: `And also alice2@example.com` },
      ],
    });
    assert.equal(result.routing, 'blocked');
    // Only the first slot's hits are counted because block short-circuits.
    assert.equal(result.spontaneousHits, 1);
  });
});
