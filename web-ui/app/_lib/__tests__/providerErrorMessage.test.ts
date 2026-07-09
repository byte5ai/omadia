import { describe, expect, it } from 'vitest';

import {
  extractProviderErrorMessage,
  humanizeProviderError,
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

  it('extracts error.message from an Anthropic JSON envelope', () => {
    const raw =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011Ccf9tf8Q1EgNHAcSZF7zP"}';
    expect(extractProviderErrorMessage(raw)).toBe(
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
    );
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
