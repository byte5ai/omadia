/**
 * Issue #641 — a failed turn must hand the user something they can act on.
 *
 * #506 narrowed *when* an error is shown. It did not change *what* an error
 * carries: no code, no id, nothing to give to support. The technical detail was
 * `console.error`d server-side, so the information existed — it just never
 * reached the person who hit the problem, whose only anchor was a wall-clock
 * timestamp.
 *
 * The load-bearing invariant is NOT "an id is present". It is that **the token
 * the user is shown is the token in the server log**. A correlation id that
 * does not join the log entry is decoration, and a test asserting only its
 * presence would pass over exactly that defect — which is why the central test
 * here captures `console.error` and compares the two values.
 *
 * Deliberately reuses the turn id the orchestrator already mints per turn
 * rather than introducing a second identifier: it is the same value the session
 * logger and MCP call auditing key on, so the token joins records that already
 * exist.
 *
 * Imported from SOURCE, not the `@omadia/orchestrator` barrel — the barrel
 * resolves to `dist/`, so a mutation in `src/` would otherwise be invisible
 * without a rebuild and a mutation check could report GREEN over stale code.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { LlmProvider, LlmStreamEvent } from '@omadia/llm-provider';
import type { ChatStreamEvent } from '@omadia/channel-sdk';

import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { Orchestrator } from '../../packages/harness-orchestrator/src/orchestrator.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

/** A provider whose stream throws on the FIRST call, so the failure reaches
 *  `chatStreamInner`'s outer catch exactly like a genuine hard failure. */
function throwingProvider(err: unknown): LlmProvider {
  return {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async () => {
      throw err;
    },
    stream: (): AsyncIterable<LlmStreamEvent> => ({
      async *[Symbol.asyncIterator]() {
        throw err;
      },
    }),
    // Non-retryable, or the orchestrator would retry instead of failing.
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function buildOrchestrator(provider: LlmProvider): Orchestrator {
  return new Orchestrator({
    provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
  });
}

async function runStream(orchestrator: Orchestrator): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const ev of orchestrator.chatStream({
    userMessage: 'hallo',
    sessionScope: 'sess-641',
    userId: 'u641',
  })) {
    events.push(ev);
  }
  return events;
}

function errorEvent(
  events: readonly ChatStreamEvent[],
): { type: 'error'; message: string; correlationId?: string } {
  const found = events.find((e) => e.type === 'error');
  assert.ok(found, `no error event in stream: ${events.map((e) => e.type).join(', ')}`);
  return found as never;
}

/** Runs `fn` with `console.error` captured. Always restores, including on throw
 *  — a leaked stub would silently swallow every later test's diagnostics. */
async function withCapturedConsoleError<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.error = original;
  }
}

describe('#641 — a failed turn carries a correlation handle', () => {
  it('MUTATION CHECK: the error event carries a correlation id', async () => {
    const orchestrator = buildOrchestrator(throwingProvider(new Error('provider exploded')));
    const { result: events } = await withCapturedConsoleError(() => runStream(orchestrator));
    const error = errorEvent(events);

    assert.ok(
      error.correlationId !== undefined && error.correlationId !== '',
      'the error reached the user with nothing to hand to support (#641)',
    );
    assert.match(
      error.correlationId,
      UUID_RE,
      `correlationId is not the turn id: ${error.correlationId}`,
    );
  });

  it('MUTATION CHECK: the token the user sees is the token in the server log', async () => {
    // THE invariant. An id that does not join the log entry is decoration: the
    // user can quote it and nobody can find anything. Asserting only presence
    // would pass straight over that.
    const orchestrator = buildOrchestrator(throwingProvider(new Error('provider exploded')));
    const { result: events, lines } = await withCapturedConsoleError(() =>
      runStream(orchestrator),
    );
    const id = errorEvent(events).correlationId;
    assert.ok(id, 'no correlationId to correlate');

    const logged = lines.filter((l) => l.includes('[orchestrator] turn failed'));
    assert.equal(logged.length, 1, `expected exactly one failure log line, got ${logged.length}`);
    assert.ok(
      logged[0]?.includes(id),
      `the log line does not carry the user's token '${id}': ${logged[0] ?? '<none>'}`,
    );
    // And the technical detail is still logged — #506 deliberately keeps it
    // server-side, so the token is the join key TO something, not a replacement.
    assert.ok(
      logged[0]?.includes('provider exploded'),
      `the failure detail vanished from the log: ${logged[0] ?? '<none>'}`,
    );
  });

  it('MUTATION CHECK: two turns get different tokens', async () => {
    // A constant or per-process id would satisfy "an id is present" while being
    // useless for finding ONE failure.
    const first = buildOrchestrator(throwingProvider(new Error('boom one')));
    const second = buildOrchestrator(throwingProvider(new Error('boom two')));
    const { result: e1 } = await withCapturedConsoleError(() => runStream(first));
    const { result: e2 } = await withCapturedConsoleError(() => runStream(second));

    const a = errorEvent(e1).correlationId;
    const b = errorEvent(e2).correlationId;
    assert.ok(a && b);
    assert.notEqual(a, b, 'both turns reported the same correlation id');
  });

  it('the user-facing message itself is unchanged — the id is additive', async () => {
    const orchestrator = buildOrchestrator(throwingProvider(new Error('provider exploded')));
    const { result: events } = await withCapturedConsoleError(() => runStream(orchestrator));
    assert.equal(errorEvent(events).message, 'provider exploded');
  });
});
