/**
 * Issue #544 (server half) — MRTR `resultType: "input_required"` on the public
 * MCP endpoint.
 *
 * The client half shipped in PR #550: omadia parks a call when a REMOTE server
 * asks for mid-call input. Nothing in omadia's own MCP server path ever produced
 * that shape, so a tool that needed one more value from the human could only
 * fail with prose or guess.
 *
 * Two layers are covered, deliberately:
 *
 *  1. The pure module (`publicMcpInputRequired.ts`) — parsing, the bounce
 *     predicate, and the rendered body. Fast, no listener, no sandbox skip.
 *  2. The real endpoint, end-to-end through `startHarness` — the SAME
 *     `mountPublicMcp` production calls, so a guarantee proven here is a
 *     guarantee about the mounted route rather than about a hand-built app.
 *     (See the harness doc comment for why that distinction has already bitten
 *     this repo once.)
 *
 * The round trip is asserted whole: ask → the caller retries with
 * `inputResponses` → the tool receives them verbatim and finishes. A test that
 * only proved the ASK would pass against an endpoint whose retry leg is broken,
 * which is the half that makes the feature usable.
 */

import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { MCP_INVOKE_SCOPE, MCP_LIST_SCOPE } from '@omadia/api-key-auth';
import { AI_PROVENANCE_META_KEY } from '@omadia/channel-sdk';
import type { ToolDispatchResult } from '@omadia/orchestrator';

import {
  PENDING_INPUT_REQUEST_KEY,
  carriesInputResponses,
  parseToolEmittedInputRequest,
  renderInputRequiredResult,
} from '../../src/mcp/publicMcpInputRequired.js';
import {
  callToolRequest,
  callResultText,
  fakeDispatcher,
  isSandboxListenDenied,
  startHarness,
  type Harness,
  type HarnessOptions,
} from './harness.js';

const TOOL = 'book_room';
const KEY_TOKEN = 'omadia_ak_test_token_bbbbbbbbbbbbbbbb';
const KEY_ID = 'key-mrtr';

/** The in-band sentinel a tool emits to ask for more input. */
function askFor(
  fields: ReadonlyArray<Record<string, unknown>>,
  message?: string,
): ToolDispatchResult {
  return {
    content: JSON.stringify({
      [PENDING_INPUT_REQUEST_KEY]: {
        ...(message !== undefined ? { message } : {}),
        inputRequests: fields,
      },
    }),
  };
}

// ── 1. the pure module ──────────────────────────────────────────────────────

describe('#544 server half — parsing a tool-emitted input request', () => {
  it('MUTATION CHECK: accepts a well-formed request and clamps through the shared validator', () => {
    const outcome = parseToolEmittedInputRequest(
      askFor([{ name: 'roomId', label: 'Room' }, { name: 'pin', secret: true }], 'Which room?')
        .content,
    );
    assert.ok(outcome.ok, 'a well-formed request was rejected');
    assert.equal(outcome.request.message, 'Which room?');
    assert.deepEqual(
      outcome.request.inputRequests.map((f) => f.name),
      ['roomId', 'pin'],
    );
  });

  it('MUTATION CHECK: an ordinary result is absent, not malformed', () => {
    // The distinction matters: `absent` passes the result through untouched,
    // `unusable` turns it into a tool ERROR. Confusing the two would convert
    // every result that happens to be JSON into a failed call.
    for (const content of [
      'plain text',
      '{"rows":[1,2,3]}',
      '[]',
      '',
      'null',
      `{"${PENDING_INPUT_REQUEST_KEY}":"not an object"}`,
    ]) {
      const outcome = parseToolEmittedInputRequest(content);
      assert.equal(outcome.ok, false, `unexpectedly parsed: ${content}`);
      assert.equal(
        outcome.ok === false && outcome.rejection.kind,
        'absent',
        `should be absent, not a rejection: ${content}`,
      );
    }
  });

  it('MUTATION CHECK: a malformed request is reported, never silently shipped', () => {
    const tooMany = Array.from({ length: 9 }, (_, i) => ({ name: `f${String(i)}` }));
    const outcome = parseToolEmittedInputRequest(askFor(tooMany).content);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.rejection.kind, 'unusable');

    const empty = parseToolEmittedInputRequest(askFor([]).content);
    assert.equal(empty.ok, false);
    assert.equal(empty.ok === false && empty.rejection.kind, 'unusable');
  });

  it('MUTATION CHECK: carriesInputResponses identifies the retry leg only', () => {
    assert.equal(carriesInputResponses({ inputResponses: { pin: '1234' } }), true);
    // An EMPTY object is not an answer — treating it as one would let a caller
    // suppress the request without ever answering it.
    assert.equal(carriesInputResponses({ inputResponses: {} }), false);
    assert.equal(carriesInputResponses({ inputResponses: null }), false);
    assert.equal(carriesInputResponses({ inputResponses: ['pin'] }), false);
    assert.equal(carriesInputResponses({ roomId: 'r1' }), false);
    assert.equal(carriesInputResponses(undefined), false);
  });

  it('MUTATION CHECK: the rendered body is readable by a pre-MRTR client and never isError', () => {
    const rendered = renderInputRequiredResult({
      inputRequests: [{ name: 'pin', label: 'PIN' }],
    });
    assert.equal(rendered.resultType, 'input_required');
    // A client that predates MRTR ignores `resultType` and shows `content`; an
    // empty `content` would make the endpoint look broken to it.
    assert.ok((rendered.content[0]?.text ?? '').length > 0, 'no human-readable content');
    assert.equal((rendered as { isError?: boolean }).isError, undefined);
  });
});

// ── 2. the real endpoint ────────────────────────────────────────────────────

describe('#544 server half — the mounted endpoint', () => {
  // EVERY harness, not just the last one. Each test starts its own listener, so
  // keeping a single slot leaks the earlier ones and the FILE hangs to the test
  // timeout while every assertion inside it passed — a green run that reports as
  // a red file, which is the least useful failure mode there is.
  const started: Harness[] = [];
  after(async () => {
    for (const h of started) {
      try {
        await h.close();
      } catch {
        /* teardown must not mask a test failure */
      }
    }
  });

  function options(handle: (input: unknown) => Promise<ToolDispatchResult>): HarnessOptions {
    return {
      keys: [{ token: KEY_TOKEN, id: KEY_ID, scopes: [MCP_LIST_SCOPE, MCP_INVOKE_SCOPE] }],
      bindingRows: [
        {
          key_id: KEY_ID,
          agent_id: 'ops',
          read_tools: [TOOL],
          write_tools: [],
          write_rate_limit_per_minute: 5,
          enabled: true,
        },
      ],
      dispatchers: { ops: fakeDispatcher([{ name: TOOL, handle }]) },
    };
  }

  async function start(
    opts: HarnessOptions,
    t: { skip: (m: string) => void },
  ): Promise<Harness | undefined> {
    try {
      const h = await startHarness(opts);
      started.push(h);
      return h;
    } catch (error) {
      if (isSandboxListenDenied(error)) {
        t.skip('sandbox blocks loopback listeners on 127.0.0.1');
        return undefined;
      }
      throw error;
    }
  }

  function resultOf(payload: Record<string, unknown>): {
    resultType?: string;
    inputRequests?: Array<{ name: string; secret?: boolean }>;
    message?: string;
    isError?: boolean;
    _meta?: Record<string, unknown>;
  } {
    return (payload['result'] ?? {}) as never;
  }

  it('MUTATION CHECK: a tool asking for input answers with resultType input_required', async (t) => {
    const h = await start(
      options(async () =>
        askFor([{ name: 'pin', label: 'PIN', secret: true }], 'PIN required for this room.'),
      ),
      t,
    );
    if (!h) return;

    const res = await h.rpc(callToolRequest(TOOL, { roomId: 'r1' }, 20), { token: KEY_TOKEN });
    assert.equal(res.status, 200, JSON.stringify(res.payload));
    const result = resultOf(res.payload);

    assert.equal(result.resultType, 'input_required', 'not rendered as MRTR');
    assert.deepEqual(result.inputRequests?.map((f) => f.name), ['pin']);
    assert.equal(result.inputRequests?.[0]?.secret, true, 'the secret flag was dropped');
    assert.equal(result.message, 'PIN required for this room.');
    // An `input_required` answer is NOT a failure — the client half's
    // `isInputRequiredResult` refuses to read an isError result as a card.
    assert.equal(result.isError, undefined, 'input_required must not be flagged as an error');
    // The internal sentinel is an implementation detail; a caller must never see
    // the raw JSON we parse.
    assert.equal(
      (callResultText(res.payload) ?? '').includes(PENDING_INPUT_REQUEST_KEY),
      false,
      'the internal sentinel leaked to the caller',
    );
    // #647 regression — provenance still rides the new body shape.
    assert.ok(result._meta?.[AI_PROVENANCE_META_KEY], 'provenance _meta lost on the MRTR body');
  });

  it('MUTATION CHECK: the retry delivers inputResponses to the tool verbatim and completes', async (t) => {
    const seen: unknown[] = [];
    const h = await start(
      options(async (input) => {
        seen.push(input);
        const args = input as { inputResponses?: Record<string, string> };
        if (!args.inputResponses) return askFor([{ name: 'pin', secret: true }], 'PIN?');
        return { content: `booked with pin ${args.inputResponses['pin'] ?? '?'}` };
      }),
      t,
    );
    if (!h) return;

    const ask = await h.rpc(callToolRequest(TOOL, { roomId: 'r1' }, 21), { token: KEY_TOKEN });
    assert.equal(resultOf(ask.payload).resultType, 'input_required');

    // MRTR: the CALLER retries the original request with the collected values.
    // Nothing was parked server-side, which is what keeps the endpoint stateless.
    const retry = await h.rpc(
      callToolRequest(TOOL, { roomId: 'r1', inputResponses: { pin: '4711' } }, 22),
      { token: KEY_TOKEN },
    );
    assert.equal(retry.status, 200, JSON.stringify(retry.payload));
    assert.equal(resultOf(retry.payload).resultType, undefined, 'retry still asked for input');
    assert.equal(callResultText(retry.payload), 'booked with pin 4711');

    const retryArgs = seen[1] as { roomId?: string; inputResponses?: Record<string, string> };
    assert.equal(retryArgs.roomId, 'r1', 'the original arguments were not replayed');
    assert.deepEqual(retryArgs.inputResponses, { pin: '4711' });
  });

  it('MUTATION CHECK: a tool that asks again after being answered is refused, not looped', async (t) => {
    const h = await start(
      options(async () => askFor([{ name: 'pin', secret: true }], 'PIN?')),
      t,
    );
    if (!h) return;

    const retry = await h.rpc(
      callToolRequest(TOOL, { roomId: 'r1', inputResponses: { pin: '4711' } }, 23),
      { token: KEY_TOKEN },
    );
    assert.equal(retry.status, 200, JSON.stringify(retry.payload));
    const result = resultOf(retry.payload);
    assert.equal(result.resultType, undefined, 'a second request was rendered — this is the loop');
    assert.equal(result.isError, true, 'the bounce was not reported as a failed call');
    assert.match(callResultText(retry.payload) ?? '', /endless input loop/);
  });

  it('MUTATION CHECK: a malformed request becomes a tool error, and never leaks the sentinel', async (t) => {
    const h = await start(
      options(async () => askFor(Array.from({ length: 9 }, (_, i) => ({ name: `f${String(i)}` })))),
      t,
    );
    if (!h) return;

    const res = await h.rpc(callToolRequest(TOOL, {}, 24), { token: KEY_TOKEN });
    const result = resultOf(res.payload);
    assert.equal(result.resultType, undefined);
    assert.equal(result.isError, true, 'an unrenderable request was reported as success');
    const text = callResultText(res.payload) ?? '';
    assert.match(text, /too_many_fields/, 'the reason was not named');
    assert.equal(
      text.includes(PENDING_INPUT_REQUEST_KEY),
      false,
      'the raw sentinel leaked to the caller',
    );
  });

  it('MUTATION CHECK: a failed call carrying the sentinel is not turned into a question', async (t) => {
    const h = await start(
      options(async () => ({ ...askFor([{ name: 'pin' }], 'PIN?'), isError: true })),
      t,
    );
    if (!h) return;

    const res = await h.rpc(callToolRequest(TOOL, {}, 25), { token: KEY_TOKEN });
    const result = resultOf(res.payload);
    assert.equal(result.resultType, undefined, 'a failure was rendered as an input request');
    assert.equal(result.isError, true);
  });

  it('an ordinary tool result is untouched', async (t) => {
    const h = await start(options(async () => ({ content: 'dispatched:ok' })), t);
    if (!h) return;

    const res = await h.rpc(callToolRequest(TOOL, {}, 26), { token: KEY_TOKEN });
    const result = resultOf(res.payload);
    assert.equal(result.resultType, undefined);
    assert.equal(result.isError, undefined);
    assert.equal(callResultText(res.payload), 'dispatched:ok');
    assert.ok(result._meta?.[AI_PROVENANCE_META_KEY], 'provenance _meta lost on the ordinary body');
  });
});
