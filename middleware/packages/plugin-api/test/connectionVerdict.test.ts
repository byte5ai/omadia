/**
 * Issue #1453 — `classifyHttpAuthFailure` holds the HTTP half of the
 * "what counts as a refused credential" rule, so every plugin gets the same
 * answer instead of re-deriving it.
 *
 * The rules are the ones `providerCredentialVerifier.ts` paid for on the LLM
 * side: 401 is the verdict, a plain 403 is not, and nothing else ever is.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyHttpAuthFailure } from '../src/pluginContext.js';

describe('classifyHttpAuthFailure', () => {
  it('reads 401 as an explicit credential refusal', () => {
    assert.equal(classifyHttpAuthFailure(401), 'http_401');
    assert.equal(classifyHttpAuthFailure(401, 'anything'), 'http_401');
  });

  it('refuses to read a plain 403 as a credential verdict', () => {
    // OpenAI answers 403 for "Country, region, or territory not supported";
    // Atlassian for a missing scope. Neither means the key is wrong.
    assert.equal(
      classifyHttpAuthFailure(403, 'Country, region, or territory not supported'),
      undefined,
    );
    assert.equal(classifyHttpAuthFailure(403), undefined);
    assert.equal(classifyHttpAuthFailure(403, ''), undefined);
  });

  it('accepts a 403 that names authentication itself', () => {
    assert.equal(
      classifyHttpAuthFailure(403, '{"error":"invalid_token"}'),
      'http_403_auth',
    );
    assert.equal(
      classifyHttpAuthFailure(403, 'Unauthenticated request'),
      'http_403_auth',
    );
    assert.equal(
      classifyHttpAuthFailure(403, 'Invalid API key provided'),
      'http_403_auth',
    );
  });

  it('never turns an outage or a success into a refusal', () => {
    for (const status of [200, 204, 301, 400, 404, 429, 500, 502, 503, 504]) {
      assert.equal(
        classifyHttpAuthFailure(status, 'authentication'),
        undefined,
        `status ${String(status)} must not read as a credential refusal`,
      );
    }
  });
});
