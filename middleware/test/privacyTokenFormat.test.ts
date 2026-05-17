import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createPrivacyGuardService,
  createTokenizeMap,
  displayTypeFor,
  isToken,
  TOKEN_REGEX,
} from '@omadia/plugin-privacy-guard/dist/index.js';
import { streamingTokenBoundary } from '@omadia/orchestrator/dist/privacyHandle.js';

// ---------------------------------------------------------------------------
// Privacy-Shield v2 — readable `«TYPE_N»` token format.
//
// Replaces the v1 `tok_<8 hex>_<type>` format which the LLM paraphrased
// in Markdown-table cells (HR-routine failure, 2026-05-14). The new
// shape reads like a normal cell value, so the LLM keeps it verbatim
// instead of inventing a plausible-looking name.
// ---------------------------------------------------------------------------

describe('displayTypeFor (Privacy-Shield v2)', () => {
  it('maps known PII namespaces to canonical display names', () => {
    assert.equal(displayTypeFor('pii.name'), 'PERSON');
    assert.equal(displayTypeFor('pii.email'), 'EMAIL');
    assert.equal(displayTypeFor('pii.phone'), 'PHONE');
    assert.equal(displayTypeFor('pii.phone_de'), 'PHONE');
    assert.equal(displayTypeFor('pii.iban'), 'IBAN');
    assert.equal(displayTypeFor('pii.credit_card'), 'CARD');
    assert.equal(displayTypeFor('pii.address'), 'ADDRESS');
    assert.equal(displayTypeFor('pii.location'), 'ADDRESS');
    assert.equal(displayTypeFor('pii.organization'), 'ORG');
    assert.equal(displayTypeFor('pii.api_key'), 'APIKEY');
    assert.equal(displayTypeFor('pii.ip_address'), 'IP');
  });

  it('passes unknown tail through as cleaned uppercase', () => {
    assert.equal(displayTypeFor('business.contract_clause'), 'CONTRACT_CLAUSE');
    assert.equal(displayTypeFor('custom.tenant_id'), 'TENANT_ID');
  });

  it('uppercases and replaces non-alphanum with underscore', () => {
    assert.equal(displayTypeFor('PII.Email'), 'EMAIL');
    assert.equal(displayTypeFor('pii.MIXED-Case'), 'MIXED_CASE');
  });

  it('caps display name at 30 chars', () => {
    const long = 'pii.' + 'a'.repeat(50);
    assert.ok(displayTypeFor(long).length <= 30);
  });

  it('falls back to "PII" for missing / empty / non-derivable input', () => {
    assert.equal(displayTypeFor(undefined), 'PII');
    assert.equal(displayTypeFor(''), 'PII');
    assert.equal(displayTypeFor('pii.'), 'PII');
    assert.equal(displayTypeFor('---'), 'PII');
  });

  it('handles bare type with no namespace', () => {
    assert.equal(displayTypeFor('email'), 'EMAIL');
    assert.equal(displayTypeFor('name'), 'PERSON');
  });
});

describe('TokenizeMap · readable `«TYPE_N»` tokens (Privacy-Shield v2)', () => {
  it('mints tokens with the canonical display type', () => {
    const m = createTokenizeMap();
    const tEmail = m.tokenFor('foo@bar.de', 'pii.email');
    const tName = m.tokenFor('John Doe', 'pii.name');
    assert.match(tEmail, /^«EMAIL_\d+»$/);
    assert.match(tName, /^«PERSON_\d+»$/);
  });

  it('falls back to `«PII_N»` when no type hint is given', () => {
    const m = createTokenizeMap();
    const t = m.tokenFor('something');
    assert.match(t, /^«PII_\d+»$/);
  });

  it('returns the same token for the same value regardless of typeHint on subsequent calls', () => {
    const m = createTokenizeMap();
    const first = m.tokenFor('John Doe', 'pii.name');
    const second = m.tokenFor('John Doe', 'pii.email');
    assert.equal(second, first, 'value→token mapping is by value, type only steers initial mint');
  });

  it('counter increments per type independently', () => {
    const m = createTokenizeMap();
    assert.equal(m.tokenFor('a@b.de', 'pii.email'), '«EMAIL_1»');
    assert.equal(m.tokenFor('c@d.de', 'pii.email'), '«EMAIL_2»');
    assert.equal(m.tokenFor('Marcel', 'pii.name'), '«PERSON_1»');
    assert.equal(m.tokenFor('Stefan', 'pii.name'), '«PERSON_2»');
    assert.equal(m.tokenFor('e@f.de', 'pii.email'), '«EMAIL_3»');
  });

  it('clear() resets bindings and counters', () => {
    const m = createTokenizeMap();
    m.tokenFor('Marcel', 'pii.name');
    m.tokenFor('Stefan', 'pii.name');
    m.clear();
    assert.equal(m.tokenFor('Tina', 'pii.name'), '«PERSON_1»');
    assert.equal(m.size, 1);
  });

  it('TOKEN_REGEX matches the new format and rejects the v1 format', () => {
    TOKEN_REGEX.lastIndex = 0;
    assert.ok(TOKEN_REGEX.test('«PERSON_1»'));
    TOKEN_REGEX.lastIndex = 0;
    assert.ok(TOKEN_REGEX.test('«EMAIL_42»'));
    TOKEN_REGEX.lastIndex = 0;
    assert.ok(TOKEN_REGEX.test('«CONTRACT_CLAUSE_3»'));
    TOKEN_REGEX.lastIndex = 0;
    assert.ok(!TOKEN_REGEX.test('tok_a1b2c3d4_name'), 'v1 format must not match');
    TOKEN_REGEX.lastIndex = 0;
    assert.ok(!TOKEN_REGEX.test('«person_1»'), 'lowercase type must not match');
    TOKEN_REGEX.lastIndex = 0;
    assert.ok(!TOKEN_REGEX.test('«PERSON»'), 'missing counter must not match');
    TOKEN_REGEX.lastIndex = 0;
    assert.ok(!TOKEN_REGEX.test('«PERSON_»'), 'empty counter must not match');
  });

  it('isToken accepts the new format only', () => {
    assert.ok(isToken('«PERSON_1»'));
    assert.ok(isToken('«EMAIL_42»'));
    assert.ok(isToken('«CONTRACT_CLAUSE_3»'));
    assert.ok(!isToken('tok_a1b2c3d4_name'));
    assert.ok(!isToken('«person_1»'));
    assert.ok(!isToken('«PERSON»'));
    assert.ok(!isToken('PERSON_1'));
  });
});

describe('PrivacyGuardService · tokens carry detector type (Privacy-Shield v2)', () => {
  it('tokenises an e-mail with an EMAIL display type', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const out = await service.processOutbound({
      sessionId: 'sx1',
      turnId: 'tx1',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'Mail to alice@example.com' }],
    });
    const tok = out.messages[0]?.content.match(/«[A-Z][A-Z_]*_\d+»/)?.[0];
    if (!tok) throw new Error('expected a token');
    assert.match(tok, /^«EMAIL_\d+»$/);
  });

  it('tokenises an IBAN with an IBAN display type', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const out = await service.processOutbound({
      sessionId: 'sx2',
      turnId: 'tx2',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'IBAN DE89370400440532013000' }],
    });
    const tok = out.messages[0]?.content.match(/«[A-Z][A-Z_]*_\d+»/)?.[0];
    if (!tok) throw new Error('expected a token');
    assert.match(tok, /^«IBAN_\d+»$/);
  });
});

describe('streamingTokenBoundary (Privacy-Shield v2)', () => {
  it('emits everything when no `«` is present', () => {
    const r = streamingTokenBoundary('Plain text without any markers.');
    assert.equal(r.safe, 'Plain text without any markers.');
    assert.equal(r.hold, '');
  });

  it('holds from the last opening `«` when no closing `»` has arrived', () => {
    const r = streamingTokenBoundary('Prefix «PERS');
    assert.equal(r.safe, 'Prefix ');
    assert.equal(r.hold, '«PERS');
  });

  it('holds when only the bare opening guillemet is present', () => {
    const r = streamingTokenBoundary('Prefix «');
    assert.equal(r.safe, 'Prefix ');
    assert.equal(r.hold, '«');
  });

  it('emits when both opening and closing guillemets are present', () => {
    const r = streamingTokenBoundary('Prefix «PERSON_1» tail');
    assert.equal(r.safe, 'Prefix «PERSON_1» tail');
    assert.equal(r.hold, '');
  });

  it('holds the trailing incomplete token but emits earlier complete tokens', () => {
    const r = streamingTokenBoundary('«PERSON_1» said hi to «EMAI');
    assert.equal(r.safe, '«PERSON_1» said hi to ');
    assert.equal(r.hold, '«EMAI');
  });

  it('emits when guillemets close cleanly even if content looks malformed', () => {
    // A stray `«…»` that does not match TOKEN_REGEX flushes as-is; the
    // restore regex simply leaves it alone. The streaming boundary's job
    // is only to avoid splitting a token across chunks.
    const r = streamingTokenBoundary('Quoted «not a token» here');
    assert.equal(r.safe, 'Quoted «not a token» here');
    assert.equal(r.hold, '');
  });
});
