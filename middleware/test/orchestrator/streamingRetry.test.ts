import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { isRetryableStreamError } from '@omadia/orchestrator';

/**
 * Coverage for {@link isRetryableStreamError} — the predicate that decides
 * whether a streamed-iteration failure should be retried by
 * `streamMessageEvents`. The motivating case is a mid-stream
 * `overloaded_error`: Anthropic returns HTTP 200, begins the SSE stream, and
 * then injects an `error` event — which the SDK rethrows as a plain
 * `Error(<raw JSON body>)` during iteration.
 */
describe('isRetryableStreamError', () => {
  it('retries a mid-stream overloaded_error surfaced as a raw-JSON Error', () => {
    // Exactly the shape observed in production: the SDK rethrows the SSE
    // error event's body as the Error message, with no `status` field.
    const err = new Error(
      '{"type":"error","error":{"details":null,"type":"overloaded_error",' +
        '"message":"Overloaded"},"request_id":"req_011CbH2tebHZNU59XQAwrq2m"}',
    );
    assert.equal(isRetryableStreamError(err), true);
  });

  it('retries a rate_limit_error surfaced in the message text', () => {
    const err = new Error('{"type":"error","error":{"type":"rate_limit_error"}}');
    assert.equal(isRetryableStreamError(err), true);
  });

  it('retries when a nested error body carries a retryable type', () => {
    const err = Object.assign(new Error('stream failed'), {
      error: { type: 'error', error: { type: 'overloaded_error' } },
    });
    assert.equal(isRetryableStreamError(err), true);
  });

  it('retries when a flattened error body carries a retryable type', () => {
    const err = Object.assign(new Error('stream failed'), {
      error: { type: 'api_error' },
    });
    assert.equal(isRetryableStreamError(err), true);
  });

  it('retries on a retryable HTTP status', () => {
    for (const status of [408, 409, 429, 500, 502, 503, 529]) {
      const err = Object.assign(new Error(`HTTP ${String(status)}`), {
        status,
      });
      assert.equal(
        isRetryableStreamError(err),
        true,
        `status ${String(status)} should be retryable`,
      );
    }
  });

  it('does NOT retry a non-transient invalid_request_error', () => {
    const err = Object.assign(new Error('bad request'), {
      status: 400,
      error: { type: 'error', error: { type: 'invalid_request_error' } },
    });
    assert.equal(isRetryableStreamError(err), false);
  });

  it('does NOT retry an authentication_error', () => {
    const err = Object.assign(new Error('{"type":"authentication_error"}'), {
      status: 401,
    });
    assert.equal(isRetryableStreamError(err), false);
  });

  it('does NOT retry a generic non-provider error', () => {
    assert.equal(
      isRetryableStreamError(new Error('stream ended without a final message')),
      false,
    );
    assert.equal(isRetryableStreamError('plain string'), false);
    assert.equal(isRetryableStreamError(undefined), false);
  });
});
