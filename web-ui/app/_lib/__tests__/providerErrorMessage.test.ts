import { describe, expect, it } from 'vitest';

import {
  classifyProviderError,
  extractProviderErrorMessage,
  humanizeProviderError,
  isProviderAuthError,
} from '../providerErrorMessage';

/**
 * The chat surfaces used to render the raw provider error verbatim — HTTP
 * status, JSON envelope and all (issue #403). `extractProviderErrorMessage`
 * peels that wrapping off and returns the embedded human sentence, or null so
 * the caller can fall back to a translated generic notice.
 */
describe('extractProviderErrorMessage', () => {
  it('strips the status prefix from an OpenAI plain-text error', () => {
    const raw =
      '429 You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.';
    expect(extractProviderErrorMessage(raw)).toBe(
      'You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.',
    );
  });

  it('returns null for a status-less rate-limit envelope (no raw JSON leak)', () => {
    // A real path: streamingRetry surfaces exactly this status-less envelope.
    // The old brace-substring hunt leaked it verbatim to the chat surfaces.
    expect(
      extractProviderErrorMessage(
        '{"type":"error","error":{"type":"rate_limit_error"}}',
      ),
    ).toBeNull();
  });

  it('leaves a status-less application message that embeds a JSON object untouched', () => {
    const raw = 'Agent stopped: {"message":"waiting"}';
    expect(extractProviderErrorMessage(raw)).toBe(raw);
  });

  it('mines error.message from a status-less JSON envelope', () => {
    expect(
      extractProviderErrorMessage('{"error":{"message":"Overloaded"}}'),
    ).toBe('Overloaded');
  });

  it('extracts error.message from an Anthropic JSON envelope', () => {
    const raw =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011Ccf9tf8Q1EgNHAcSZF7zP"}';
    expect(extractProviderErrorMessage(raw)).toBe(
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
    );
  });

  it('extracts error.message from a status-prefixed credit-balance envelope', () => {
    expect(
      extractProviderErrorMessage(
        '400 {"error":{"message":"Your credit balance is too low."}}',
      ),
    ).toBe('Your credit balance is too low.');
  });

  it('strips the status prefix from a short plain-text quota error', () => {
    expect(
      extractProviderErrorMessage('429 You exceeded your current quota.'),
    ).toBe('You exceeded your current quota.');
  });

  it('returns a top-level message when there is no nested error', () => {
    expect(
      extractProviderErrorMessage('500 {"message":"internal error"}'),
    ).toBe('internal error');
  });

  it('returns null for a JSON envelope carrying no message', () => {
    expect(
      extractProviderErrorMessage('503 {"error":{"type":"overloaded_error"}}'),
    ).toBeNull();
  });

  it('still returns null for a status-prefixed envelope with no surfaceable message', () => {
    expect(extractProviderErrorMessage('400 {"type":"error"}')).toBeNull();
  });

  it('leaves a status-less application message that contains valid JSON braces untouched', () => {
    const raw = 'Build failed with diagnostics {"code":"TS2304","file":"slot.ts"}';
    expect(extractProviderErrorMessage(raw)).toBe(raw);
  });

  it('leaves a status-less application message with non-JSON braces untouched', () => {
    const raw = 'Validation failed for {field: name}';
    expect(extractProviderErrorMessage(raw)).toBe(raw);
  });

  it('leaves a plain application message with no braces untouched', () => {
    const raw = 'Connection to the middleware was lost.';
    expect(extractProviderErrorMessage(raw)).toBe(raw);
  });

  it('returns null for an empty string', () => {
    expect(extractProviderErrorMessage('')).toBeNull();
    expect(extractProviderErrorMessage('   ')).toBeNull();
  });

  it('leaves an already-clean human message untouched', () => {
    const clean = 'This build is paused on issue #12 — resolve it to continue.';
    expect(extractProviderErrorMessage(clean)).toBe(clean);
  });
});

describe('humanizeProviderError', () => {
  it('returns the extracted message when one is present', () => {
    expect(humanizeProviderError('429 quota exceeded', 'fallback')).toBe(
      'quota exceeded',
    );
  });

  it('returns the fallback when nothing can be extracted', () => {
    expect(
      humanizeProviderError('503 {"error":{"type":"overloaded_error"}}', 'fallback'),
    ).toBe('fallback');
  });
});

describe('isProviderAuthError', () => {
  // Real strings observed in the wild (v0.58.0 field test + 2026-08-20
  // packaged-app retest). The classifier keys on the error's SHAPE — status,
  // error type, key-phrasings — never on full-sentence equality.
  it.each([
    ['bare middleware sentence', 'API key is invalid.'],
    ['Anthropic raw 401 envelope', '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'],
    ['extracted Anthropic sentence', 'invalid x-api-key'],
    ['expired key phrasing', 'The provided API key has expired'],
    ['German admin phrasing', 'Der Provider hat diesen API-Key abgelehnt'],
  ])('classifies as auth: %s', (_label, raw) => {
    expect(isProviderAuthError(raw)).toBe(true);
  });

  it.each([
    ['rate limit envelope', '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}'],
    ['overloaded', '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'],
    ['generic transport', 'HTTP 502'],
    ['app message mentioning a key innocently', 'Der Skill beschreibt, wie ein API-Key sicher gespeichert wird.'],
    ['empty', ''],
  ])('does NOT classify as auth: %s', (_label, raw) => {
    expect(isProviderAuthError(raw)).toBe(false);
  });
});


describe('classifyProviderError', () => {
  it.each([
    ['429 with envelope', '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}', 'rate_limit'],
    ['status-less rate limit envelope', '{"type":"error","error":{"type":"rate_limit_error","message":"..."}}', 'rate_limit'],
    ['extracted rate-limit sentence', 'Number of requests has exceeded your rate limit', 'rate_limit'],
    ['529 overloaded', '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'overloaded'],
    ['bare Overloaded sentence', 'Overloaded', 'overloaded'],
    ['auth stays auth', '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', 'auth'],
    ['generic 502', 'HTTP 502', 'generic'],
    ['app text mentioning rates innocently (hyphenated, no provider shape)', 'Die Wechselkurse werden im Rate-Limit-Report erklärt.', 'generic'],
  ] as const)('classifies %s', (_label, raw, expected) => {
    expect(classifyProviderError(raw)).toBe(expected);
  });

  it('a 429 quota/billing exhaustion is NOT a transient rate limit — stays generic', () => {
    // OpenAI's insufficient_quota arrives as 429; "wait and retry" would be
    // wrong advice. The provider's own sentence names the real next step.
    expect(
      classifyProviderError(
        '429 You exceeded your current quota, please check your plan and billing details.',
      ),
    ).toBe('generic');
  });

  it('overloaded matches ONLY the bare provider sentence, not prose containing the word', () => {
    expect(classifyProviderError('The system feels overloaded today')).toBe('generic');
  });
});
