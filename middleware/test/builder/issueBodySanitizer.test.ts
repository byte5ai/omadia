import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  hasSensitiveContent,
  sanitizeIssueBody,
} from '../../src/plugins/builder/issueBodySanitizer.js';

describe('issueBodySanitizer — secrets scanner', () => {
  it('redacts AWS access keys', () => {
    const result = sanitizeIssueBody(
      'config: AKIAIOSFODNN7EXAMPLE was used during the run',
    );
    assert.match(result.body, /\[REDACTED:aws-access-key\]/);
    assert.equal(result.redactions.length, 1);
    assert.equal(result.redactions[0]?.kind, 'aws-access-key');
  });

  it('redacts classic and fine-grained GitHub PATs', () => {
    const classic = sanitizeIssueBody(
      'PAT: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    );
    assert.match(classic.body, /\[REDACTED:github-pat\]/);
    assert.ok(classic.redactions.some((r) => r.kind === 'github-pat'));

    const fine = sanitizeIssueBody(
      'token=github_pat_11ABCDEFGHIJKLMNOPQRSTUV_0123456789abcdefghijklmnopqrstuvwxyz0123456789',
    );
    assert.match(fine.body, /\[REDACTED:github-pat\]/);
  });

  it('redacts Slack tokens', () => {
    // Token-shaped string only; intentionally not a real Slack token so the
    // GitHub push-protection scanner does not flag the fixture.
    const slackTokenFixture =
      'xoxb-' + 'NOT-' + 'A-REAL-TOKEN-' + 'FIXTURE-ONLY';
    const result = sanitizeIssueBody(
      `webhook used ${slackTokenFixture} in payload`,
    );
    assert.match(result.body, /\[REDACTED:slack-token\]/);
  });

  it('redacts bearer tokens in Authorization headers', () => {
    const result = sanitizeIssueBody(
      'curl -H "Authorization: Bearer abc123.def456.ghi789" https://api.example.com',
    );
    assert.match(result.body, /\[REDACTED:bearer-token\]/);
  });

  it('redacts email addresses', () => {
    const result = sanitizeIssueBody('Operator notes: contact alice@byte5.de');
    assert.match(result.body, /\[REDACTED:email\]/);
  });

  it('redacts IBANs', () => {
    const result = sanitizeIssueBody(
      'transfer to DE89 3704 0044 0532 0130 00 fails',
    );
    assert.match(result.body, /\[REDACTED:iban\]/);
  });
});

describe('issueBodySanitizer — URL redaction', () => {
  it('redacts internal hosts (.internal, .local)', () => {
    const r1 = sanitizeIssueBody(
      'request to http://api.staging.internal/orders failed',
    );
    assert.match(r1.body, /\[REDACTED:internal-url\]/);

    const r2 = sanitizeIssueBody('open https://printer.local for status');
    assert.match(r2.body, /\[REDACTED:internal-url\]/);
  });

  it('redacts RFC1918 IPs in URLs', () => {
    for (const url of [
      'http://10.0.0.1/admin',
      'http://172.16.0.5:8080/health',
      'http://192.168.1.100/api',
    ]) {
      const r = sanitizeIssueBody(`call ${url} to repro`);
      assert.match(r.body, /\[REDACTED:internal-url\]/, `failed on ${url}`);
    }
  });

  it('redacts localhost URLs', () => {
    const r = sanitizeIssueBody('curl http://localhost:3000/api/v1/test');
    assert.match(r.body, /\[REDACTED:internal-url\]/);
  });

  it('leaves public URLs intact', () => {
    const r = sanitizeIssueBody(
      'see https://github.com/byte5ai/omadia/issues for context',
    );
    assert.equal(r.redactions.length, 0);
    assert.equal(
      r.body,
      'see https://github.com/byte5ai/omadia/issues for context',
    );
  });
});

describe('issueBodySanitizer — truncation', () => {
  it('truncates bodies larger than the maxBytes budget and appends a marker', () => {
    const big = 'a'.repeat(64 * 1024 + 500);
    const result = sanitizeIssueBody(big);
    assert.equal(result.truncated, true);
    assert.ok(result.truncatedBytes >= 500);
    assert.match(result.body, /\[…\] \d+ bytes truncated/);
  });

  it('respects a custom maxBytes setting', () => {
    const result = sanitizeIssueBody('a'.repeat(200), { maxBytes: 100 });
    assert.equal(result.truncated, true);
    assert.match(result.body, /truncated/);
  });

  it('does NOT truncate bodies within the budget', () => {
    const result = sanitizeIssueBody('a'.repeat(100), { maxBytes: 1024 });
    assert.equal(result.truncated, false);
    assert.equal(result.truncatedBytes, 0);
  });
});

describe('issueBodySanitizer — combined patterns', () => {
  it('applies multiple redactions in one body', () => {
    const result = sanitizeIssueBody(
      'AWS=AKIAIOSFODNN7EXAMPLE plus PAT=ghp_abcdefghijklmnopqrstuvwxyz0123456789 plus email alice@byte5.de plus http://10.0.0.1/x',
    );
    assert.equal(result.redactions.length, 4);
    const kinds = new Set(result.redactions.map((r) => r.kind));
    assert.ok(kinds.has('aws-access-key'));
    assert.ok(kinds.has('github-pat'));
    assert.ok(kinds.has('email'));
    assert.ok(kinds.has('internal-url'));
  });

  it('hasSensitiveContent flips true when anything was redacted or truncated', () => {
    const clean = sanitizeIssueBody('totally fine plain text');
    assert.equal(hasSensitiveContent(clean), false);

    const redacted = sanitizeIssueBody('hi alice@example.com');
    assert.equal(hasSensitiveContent(redacted), true);

    const truncated = sanitizeIssueBody('a'.repeat(70_000));
    assert.equal(hasSensitiveContent(truncated), true);
  });
});
