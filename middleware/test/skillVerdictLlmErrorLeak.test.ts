import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmErrorClassification,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';

import { createLlmVerifier } from '../src/services/skillVerdictLlmVerifier.js';

/**
 * OM-26 — a provider request id must never reach the UI.
 *
 * A customer saw this rendered in the skill editor:
 *
 *   Tiefen-Scan-Hinweis: llm completion failed: 401 {"type":"error","error":
 *   {"type":"authentication_error","message":"invalid x-api-key"},
 *   "request_id":"req_011CdcPnpMTB8iyAmMBnbem8"}
 *
 * The verifier interpolated the raw provider payload into `rationale`, which is
 * persisted and rendered verbatim. These tests assert on the ABSENCE of that
 * payload — that is the actual regression guard. Asserting only "the code is
 * `auth`" would still pass if someone appended the raw message to it.
 */

/** The exact payload from the bug report. */
const RAW_401_BODY =
  '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011CdcPnpMTB8iyAmMBnbem8"}';

function throwingProvider(kind: LlmErrorClassification['kind']): LlmProvider {
  return {
    id: 'stub',
    capabilities: {
      tools: false,
      vision: false,
      streaming: false,
      promptCaching: false,
      forcedToolChoice: false,
      parallelToolCalls: false,
    },
    complete(_req: LlmRequest): Promise<LlmResponse> {
      return Promise.reject(new Error(RAW_401_BODY));
    },
    async *stream(_req: LlmRequest): AsyncIterable<LlmStreamEvent> {
      return;
    },
    classifyError(_err: unknown): LlmErrorClassification {
      return { retryable: false, kind };
    },
  };
}

describe('OM-26 — a failed deep scan leaks no provider internals', () => {
  it('a 401 yields the `auth` code and NONE of the raw payload', async () => {
    const verifier = createLlmVerifier({
      provider: throwingProvider('auth'),
      model: 'stub-model',
    });

    const verdict = await verifier.verify({ name: 'Some Skill' }, 'body');

    assert.equal(verdict.severity, 'scan_failed');
    assert.equal(verdict.rationale, 'scan_failed:auth');

    // THE regression guard. Each of these appearing anywhere in the rationale
    // means the raw payload found a new way back onto the screen.
    assert.ok(
      !verdict.rationale.includes('request_id'),
      'rationale must not carry a provider request id',
    );
    assert.ok(
      !verdict.rationale.includes('req_011CdcPnpMTB8iyAmMBnbem8'),
      'rationale must not carry the request id value',
    );
    assert.ok(
      !verdict.rationale.includes('x-api-key'),
      'rationale must not carry credential-header names',
    );
    assert.ok(
      !verdict.rationale.includes('401'),
      'rationale must not carry the raw status line',
    );
    assert.ok(
      !verdict.rationale.includes(RAW_401_BODY),
      'rationale must not carry the raw provider body',
    );
    assert.ok(
      !verdict.rationale.includes('authentication_error'),
      'rationale must not carry vendor error types',
    );
  });

  it('maps rate_limit and overloaded to their own codes', async () => {
    for (const [kind, expected] of [
      ['rate_limit', 'scan_failed:rate_limit'],
      ['overloaded', 'scan_failed:overloaded'],
      ['other', 'scan_failed:provider_error'],
    ] as const) {
      const verifier = createLlmVerifier({
        provider: throwingProvider(kind),
        model: 'stub-model',
      });
      const verdict = await verifier.verify({ name: 'S' }, 'body');
      assert.equal(verdict.rationale, expected);
      assert.ok(!verdict.rationale.includes('request_id'));
    }
  });

  it('a provider whose classifyError itself throws still yields a safe code', async () => {
    const provider = throwingProvider('other');
    const hostile: LlmProvider = {
      ...provider,
      classifyError(): LlmErrorClassification {
        throw new Error('classifier exploded');
      },
    };
    const verifier = createLlmVerifier({ provider: hostile, model: 'm' });
    const verdict = await verifier.verify({ name: 'S' }, 'body');
    assert.equal(verdict.rationale, 'scan_failed:provider_error');
  });
});
