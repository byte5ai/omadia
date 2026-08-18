import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TranscriptionError,
  type TranscriptionErrorCode,
  type TranscriptionUsage,
} from '../src/index.js';

describe('TranscriptionError', () => {
  it('is an Error with a stable name and the given code', () => {
    const err = new TranscriptionError('auth', 'API key rejected');
    assert.ok(err instanceof Error);
    assert.ok(err instanceof TranscriptionError);
    assert.equal(err.name, 'TranscriptionError');
    assert.equal(err.code, 'auth');
    assert.equal(err.message, 'API key rejected');
  });

  it('carries partial usage on the error path', () => {
    const usage: TranscriptionUsage = {
      attempts: 2,
      attemptDurationsMs: [61_000, 4_500],
    };
    const err = new TranscriptionError('session-limit', 'provider closed the stream', {
      usage,
    });
    assert.deepEqual(err.usage, usage);
  });

  it('leaves usage undefined when the failure happened before any provider call', () => {
    const err = new TranscriptionError('unsupported-format', 'no decoder for .xyz');
    assert.equal(err.usage, undefined);
  });

  it('propagates a cause', () => {
    const cause = new Error('socket hang up');
    const err = new TranscriptionError('provider', 'upstream failed', { cause });
    assert.equal(err.cause, cause);
  });

  it('accepts every contract error code', () => {
    const codes: TranscriptionErrorCode[] = [
      'auth',
      'unsupported-format',
      'too-large',
      'session-limit',
      'provider',
      'aborted',
    ];
    for (const code of codes) {
      assert.equal(new TranscriptionError(code, 'x').code, code);
    }
  });
});
