import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createPrivacyGuardService,
  createTokenizeMap,
  isToken,
  sanitizeTypeHint,
  TOKEN_REGEX,
} from '@omadia/plugin-privacy-guard/dist/index.js';
import { streamingTokenBoundary } from '@omadia/orchestrator/dist/privacyHandle.js';

// ---------------------------------------------------------------------------
// Slice 2.2 (Option B) — token format with inline type suffix.
//
// Why this matters: pre-Option-B tokens were opaque (`tok_<8 hex>`), which
// caused the public LLM to refuse tool calls when a user-typed name was
// tokenised — Anthropic saw `tok_a3f9` and asked back "wer ist das?". With
// type-suffixed tokens (`tok_<8 hex>_<type>`) the LLM can recognise the
// placeholder kind from the suffix and pass it through as a tool argument.
// Privacy is unchanged: the type only repeats information the user already
// disclosed by writing the value (e.g. typing an e-mail tells the LLM the
// shape was an e-mail).
// ---------------------------------------------------------------------------

describe('sanitizeTypeHint (Slice 2.2 Option B)', () => {
  it('strips `pii.` namespace prefix', () => {
    assert.equal(sanitizeTypeHint('pii.email'), 'email');
    assert.equal(sanitizeTypeHint('pii.name'), 'name');
    assert.equal(sanitizeTypeHint('pii.iban'), 'iban');
    assert.equal(sanitizeTypeHint('pii.credit_card'), 'credit_card');
    assert.equal(sanitizeTypeHint('pii.api_key'), 'api_key');
  });

  it('strips arbitrary namespaces, keeping only the tail', () => {
    assert.equal(sanitizeTypeHint('business.contract_clause'), 'contract_clause');
    assert.equal(sanitizeTypeHint('custom.tenant_id'), 'tenant_id');
  });

  it('lowercases and replaces non-alphanum with underscore', () => {
    assert.equal(sanitizeTypeHint('PII.Email'), 'email');
    assert.equal(sanitizeTypeHint('pii.MIXED-Case'), 'mixed_case');
  });

  it('caps suffix at 20 chars', () => {
    const long = 'pii.' + 'a'.repeat(50);
    assert.equal(sanitizeTypeHint(long).length, 20);
  });

  it('falls back to "value" for missing / empty / non-derivable input', () => {
    assert.equal(sanitizeTypeHint(undefined), 'value');
    assert.equal(sanitizeTypeHint(''), 'value');
    assert.equal(sanitizeTypeHint('pii.'), 'value');
    assert.equal(sanitizeTypeHint('---'), 'value');
  });

  it('handles bare type with no namespace', () => {
    assert.equal(sanitizeTypeHint('email'), 'email');
    assert.equal(sanitizeTypeHint('name'), 'name');
  });
});

describe('TokenizeMap · type-suffixed tokens (Slice 2.2 Option B)', () => {
  it('mints tokens with the suffix derived from the type hint', () => {
    const m = createTokenizeMap();
    const tEmail = m.tokenFor('foo@bar.de', 'pii.email');
    const tName = m.tokenFor('John Doe', 'pii.name');
    assert.match(tEmail, /^tok_[0-9a-f]{8}_email$/);
    assert.match(tName, /^tok_[0-9a-f]{8}_name$/);
  });

  it('falls back to `_value` suffix when no type hint is given', () => {
    const m = createTokenizeMap();
    const t = m.tokenFor('something');
    assert.match(t, /^tok_[0-9a-f]{8}_value$/);
  });

  it('returns the same token for the same value regardless of typeHint on subsequent calls', () => {
    const m = createTokenizeMap();
    const first = m.tokenFor('John Doe', 'pii.name');
    const second = m.tokenFor('John Doe', 'pii.email');
    assert.equal(second, first, 'value→token mapping is by value, type only steers initial mint');
  });

  it('TOKEN_REGEX matches the type-suffixed format and rejects bare tokens', () => {
    TOKEN_REGEX.lastIndex = 0;
    assert.ok(TOKEN_REGEX.test('tok_a1b2c3d4_name'));
    TOKEN_REGEX.lastIndex = 0;
    assert.ok(TOKEN_REGEX.test('tok_e5f6a7b8_email'));
    TOKEN_REGEX.lastIndex = 0;
    assert.ok(!TOKEN_REGEX.test('tok_a1b2c3d4'), 'bare pre-2.2 format must not match');
    TOKEN_REGEX.lastIndex = 0;
    assert.ok(!TOKEN_REGEX.test('tok_xyz'), 'non-hex prefix must not match');
  });

  it('isToken accepts the type-suffixed format', () => {
    assert.ok(isToken('tok_a1b2c3d4_name'));
    assert.ok(isToken('tok_e5f6a7b8_credit_card'));
    assert.ok(!isToken('tok_a1b2c3d4'));
    assert.ok(!isToken('tok_a1b2c3d4_'));
  });
});

describe('PrivacyGuardService · tokens carry detector type (Slice 2.2 Option B)', () => {
  it('tokenises an e-mail with a `_email` suffix', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const out = await service.processOutbound({
      sessionId: 'sx1',
      turnId: 'tx1',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'Mail to alice@example.com' }],
    });
    const tok = out.messages[0]?.content.match(/tok_[0-9a-f]{8}_[a-z0-9_]+/)?.[0];
    if (!tok) throw new Error('expected a token');
    assert.match(tok, /_email$/);
  });

  it('tokenises an IBAN with a `_iban` suffix', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const out = await service.processOutbound({
      sessionId: 'sx2',
      turnId: 'tx2',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'IBAN DE89370400440532013000' }],
    });
    const tok = out.messages[0]?.content.match(/tok_[0-9a-f]{8}_[a-z0-9_]+/)?.[0];
    if (!tok) throw new Error('expected a token');
    assert.match(tok, /_iban$/);
  });
});

describe('streamingTokenBoundary (Slice 2.2 Option B)', () => {
  it('emits everything when no `tok_` prefix is present', () => {
    const r = streamingTokenBoundary('Plain text without any markers.');
    assert.equal(r.safe, 'Plain text without any markers.');
    assert.equal(r.hold, '');
  });

  it('holds when only the `tok_` prefix is present (could grow into hex)', () => {
    const r = streamingTokenBoundary('Prefix tok_');
    assert.equal(r.safe, 'Prefix ');
    assert.equal(r.hold, 'tok_');
  });

  it('holds when fewer than 8 hex chars are present', () => {
    const r = streamingTokenBoundary('Prefix tok_a1b2');
    assert.equal(r.safe, 'Prefix ');
    assert.equal(r.hold, 'tok_a1b2');
  });

  it('holds with exactly 8 hex chars but no `_` separator yet', () => {
    const r = streamingTokenBoundary('Prefix tok_a1b2c3d4');
    assert.equal(r.safe, 'Prefix ');
    assert.equal(r.hold, 'tok_a1b2c3d4');
  });

  it('holds with `_` but unfinished suffix (could still grow)', () => {
    const r = streamingTokenBoundary('Prefix tok_a1b2c3d4_emai');
    assert.equal(r.safe, 'Prefix ');
    assert.equal(r.hold, 'tok_a1b2c3d4_emai');
  });

  it('emits when the suffix is followed by a word-boundary char', () => {
    const r = streamingTokenBoundary('Prefix tok_a1b2c3d4_email.');
    assert.equal(r.safe, 'Prefix tok_a1b2c3d4_email.');
    assert.equal(r.hold, '');
  });

  it('does not hold when the first 8 chars contain a non-hex character', () => {
    const r = streamingTokenBoundary('tok_zzzzzzzz');
    assert.equal(r.hold, '');
  });

  it('does not hold when the 9th char is not `_` (token shape broken)', () => {
    const r = streamingTokenBoundary('tok_a1b2c3d4xy');
    assert.equal(r.hold, '');
  });
});
