import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createAllowlist,
  createPrivacyGuardService,
  filterHitsByAllowlist,
} from '@omadia/plugin-privacy-guard/dist/index.js';

// ---------------------------------------------------------------------------
// Privacy-Shield v2 (Slice S-3) — pre-detector allowlist.
//
// Two layers of coverage:
//   1. Unit: createAllowlist + scan + filterHitsByAllowlist behave
//      according to contract (case-insensitive, word-boundary aware,
//      source-priority, longest-first alternation).
//   2. Service-integration: the 2026-05-13 "Urlaubsregeln bei byte5?"
//      cascade is reproduced — with tenant-self={"byte5"} and the
//      repo-default list containing "Urlaubsregeln", the detector
//      pool no longer maskes either term and the receipt records the
//      pass-throughs in `allowlist.bySource`.
// ---------------------------------------------------------------------------

describe('createAllowlist · empty config (Slice S-3)', () => {
  it('returns a no-op allowlist when all sources are empty', () => {
    const a = createAllowlist({});
    assert.deepEqual(a.scan('any text'), []);
  });

  it('treats whitespace-only terms as empty', () => {
    const a = createAllowlist({
      tenantSelfTerms: ['   ', '\t\n'],
      repoDefaultTerms: [],
    });
    assert.deepEqual(a.scan('some text with byte5'), []);
  });
});

describe('createAllowlist · scan (Slice S-3)', () => {
  it('finds a single tenant-self term in the middle of text', () => {
    const a = createAllowlist({ tenantSelfTerms: ['byte5'] });
    const matches = a.scan('Frage an byte5 zur Architektur');
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.source, 'tenantSelf');
    const [start, end] = matches[0]?.span ?? [0, 0];
    assert.equal('Frage an byte5 zur Architektur'.slice(start, end), 'byte5');
  });

  it('is case-insensitive but preserves the matched span', () => {
    const a = createAllowlist({ tenantSelfTerms: ['byte5'] });
    const matches = a.scan('Frage an BYTE5 zur Architektur');
    assert.equal(matches.length, 1);
    const [start, end] = matches[0]?.span ?? [0, 0];
    assert.equal('Frage an BYTE5 zur Architektur'.slice(start, end), 'BYTE5');
  });

  it('respects word boundaries — no substring match inside a larger word', () => {
    const a = createAllowlist({ tenantSelfTerms: ['Urlaub'] });
    assert.deepEqual(a.scan('Urlaubsregeln'), [], 'must NOT match inside Urlaubsregeln');
    assert.equal(a.scan('Mein Urlaub.').length, 1);
  });

  it('handles German umlauts and ß at word boundaries', () => {
    const a = createAllowlist({ repoDefaultTerms: ['Überstunden', 'Größe'] });
    const r1 = a.scan('Hat Überstunden gemacht.');
    assert.equal(r1.length, 1);
    assert.equal(r1[0]?.source, 'repoDefault');
    const r2 = a.scan('Die Größe stimmt.');
    assert.equal(r2.length, 1);
  });

  it('prefers tenantSelf > operatorOverride > repoDefault when the same term is configured in multiple sources', () => {
    const a = createAllowlist({
      tenantSelfTerms: ['byte5'],
      operatorOverrideTerms: ['byte5'],
      repoDefaultTerms: ['byte5'],
    });
    const matches = a.scan('Hello byte5');
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.source, 'tenantSelf');
  });

  it('longest-first alternation — longer term wins over shorter prefix', () => {
    const a = createAllowlist({ repoDefaultTerms: ['Urlaub', 'Urlaubsregeln'] });
    const matches = a.scan('Frage zu Urlaubsregeln im Team');
    assert.equal(matches.length, 1);
    const [start, end] = matches[0]?.span ?? [0, 0];
    assert.equal('Frage zu Urlaubsregeln im Team'.slice(start, end), 'Urlaubsregeln');
  });

  it('returns multiple matches in left-to-right order', () => {
    const a = createAllowlist({
      tenantSelfTerms: ['byte5'],
      repoDefaultTerms: ['Urlaubsregeln'],
    });
    const matches = a.scan('Urlaubsregeln bei byte5?');
    assert.equal(matches.length, 2);
    assert.equal(matches[0]?.source, 'repoDefault');
    assert.equal(matches[1]?.source, 'tenantSelf');
    assert.ok((matches[0]?.span[0] ?? 0) < (matches[1]?.span[0] ?? 0));
  });

  it('returns [] for empty input', () => {
    const a = createAllowlist({ tenantSelfTerms: ['byte5'] });
    assert.deepEqual(a.scan(''), []);
  });
});

describe('filterHitsByAllowlist (Slice S-3)', () => {
  it('drops detector hits that overlap an allowlist span', () => {
    const hits = [
      { span: [9, 14] as readonly [number, number] }, // overlaps byte5
      { span: [20, 30] as readonly [number, number] }, // elsewhere
    ];
    const allowlist = [
      { span: [9, 14] as readonly [number, number], source: 'tenantSelf' as const },
    ];
    const filtered = filterHitsByAllowlist(hits, allowlist);
    assert.equal(filtered.length, 1);
    assert.deepEqual(filtered[0]?.span, [20, 30]);
  });

  it('returns the original hits when allowlist is empty', () => {
    const hits = [{ span: [0, 5] as readonly [number, number] }];
    const filtered = filterHitsByAllowlist(hits, []);
    assert.equal(filtered, hits);
  });

  it('returns [] when hits is empty', () => {
    const filtered = filterHitsByAllowlist(
      [],
      [{ span: [0, 5] as readonly [number, number], source: 'tenantSelf' as const }],
    );
    assert.deepEqual(filtered, []);
  });
});

describe('PrivacyGuardService · allowlist integration (Slice S-3)', () => {
  it('reproduces the 2026-05-13 "Urlaubsregeln bei byte5?" fix: tenant-self + repo-default both pass through', async () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      allowlist: {
        tenantSelfTerms: ['byte5'],
        repoDefaultTerms: ['Urlaubsregeln'],
      },
    });

    const out = await service.processOutbound({
      sessionId: 's-fp',
      turnId: 't-fp',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'Urlaubsregeln bei byte5?' }],
    });

    // Both terms must reach the LLM as plaintext — no «…» token in the
    // outbound payload.
    const outboundContent = out.messages[0]?.content ?? '';
    assert.ok(
      outboundContent.includes('byte5'),
      'tenant-self term must pass through to the LLM',
    );
    assert.ok(
      outboundContent.includes('Urlaubsregeln'),
      'repo-default topic-noun must pass through to the LLM',
    );
    assert.ok(
      !/«[A-Z][A-Z_]*_\d+»/.test(outboundContent),
      'no tokens must be minted for allowlisted terms',
    );

    const receipt = await service.finalizeTurn('t-fp');
    if (!receipt) throw new Error('expected a receipt');
    assert.ok(receipt.allowlist, 'receipt must carry the allowlist block');
    assert.ok(
      receipt.allowlist.hitCount >= 2,
      'at least one tenant-self + one repo-default match expected',
    );
    assert.ok(receipt.allowlist.bySource.tenantSelf >= 1);
    assert.ok(receipt.allowlist.bySource.repoDefault >= 1);
    assert.equal(receipt.allowlist.bySource.operatorOverride, 0);
  });

  it('does not interfere when no allowlist term matches', async () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      allowlist: { tenantSelfTerms: ['byte5'] },
    });
    const out = await service.processOutbound({
      sessionId: 's-nm',
      turnId: 't-nm',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'Mail to alice@example.com' }],
    });
    // email still gets tokenised
    assert.ok(/«EMAIL_\d+»/.test(out.messages[0]?.content ?? ''));
    const receipt = await service.finalizeTurn('t-nm');
    if (!receipt) throw new Error('expected a receipt');
    // No allowlist block when nothing matched
    assert.equal(receipt.allowlist, undefined);
  });

  it('operator-override extends the allowlist additively', async () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      allowlist: {
        repoDefaultTerms: ['Urlaubsregeln'],
        operatorOverrideTerms: ['Spezialprojekt'],
      },
    });
    const out = await service.processOutbound({
      sessionId: 's-ov',
      turnId: 't-ov',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'Urlaubsregeln im Spezialprojekt' }],
    });
    const content = out.messages[0]?.content ?? '';
    assert.ok(content.includes('Urlaubsregeln'));
    assert.ok(content.includes('Spezialprojekt'));
    const receipt = await service.finalizeTurn('t-ov');
    if (!receipt) throw new Error('expected a receipt');
    assert.ok(receipt.allowlist);
    assert.equal(receipt.allowlist.bySource.repoDefault, 1);
    assert.equal(receipt.allowlist.bySource.operatorOverride, 1);
  });

  it('receipt block is PII-free — contains only counts, no matched values', async () => {
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      allowlist: { tenantSelfTerms: ['byte5'] },
    });
    await service.processOutbound({
      sessionId: 's-pf',
      turnId: 't-pf',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'byte5 byte5 byte5' }],
    });
    const receipt = await service.finalizeTurn('t-pf');
    if (!receipt) throw new Error('expected a receipt');
    const stringified = JSON.stringify(receipt);
    assert.ok(!stringified.includes('byte5'), 'matched term must not leak into receipt');
    assert.ok(receipt.allowlist);
    assert.equal(receipt.allowlist.bySource.tenantSelf, 3);
  });
});
