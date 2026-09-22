import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import type { ChatStreamEvent } from '../../packages/harness-channel-sdk/src/chatAgent.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import {
  Orchestrator,
  type SessionLogEntry,
} from '../../packages/harness-orchestrator/src/orchestrator.js';

// #644 — the streaming `done` event's `answer` now carries the AI-Act Art. 50
// marking, folded at the delivery boundary; the session log records the RAW
// model answer (persist-raw, disclose-at-boundary, symmetric with the
// non-streaming path). So `logged.assistantAnswer` equals `done.answer` only
// after the marking is stripped. The marking itself is covered by
// test/aiDisclosure644.test.ts.
const AI_DISCLOSURE_LINE = 'Diese Antwort wurde von einem KI-System erzeugt.';
function withoutDisclosure(text: string): string {
  const suffix = `\n\n${AI_DISCLOSURE_LINE}`;
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}

/**
 * Issue #506 — the one-click repro. `chatStreamInner` wraps its whole
 * per-turn iteration loop in a single try/catch: an exception thrown by a
 * LATER iteration's model call (after an EARLIER iteration's tool call
 * already committed a real side effect and yielded a successful
 * `tool_result`) used to fall into the same catch-all that reports a bare
 * `{ type: 'error' }` — discarding the fact that the action already
 * succeeded. These tests exercise the fix: a committed tool result changes
 * the catch block's outcome to a `done` event; a genuine failure with no
 * prior committed tool result is unaffected.
 *
 * Imported from SOURCE, not the `@omadia/orchestrator` barrel — the barrel
 * resolves to `dist/`, so a mutation in `src/` would otherwise be invisible
 * without a rebuild and a mutation check could report GREEN over stale code
 * (same reasoning as turnErrorCorrelation.test.ts).
 *
 * Review follow-up: the original version of this file never constructed a
 * `sessionLogger`, so it couldn't have caught the emergency-`done` path
 * skipping `sessionLogger.log()` — the ONE thing every other `done`
 * emission site in `chatStreamInner` does before yielding. Every test here
 * now builds the orchestrator WITH a recording session logger and asserts
 * on what it did (or didn't) receive.
 */

/** Records every `SessionLogEntry` passed to `log()`, mirroring the stub
 *  pattern from turnHooks.test.ts (`{ turnExternalId }` return shape). */
function recordingSessionLogger(): {
  sessionLogger: ConstructorParameters<typeof Orchestrator>[0]['sessionLogger'];
  calls: SessionLogEntry[];
} {
  const calls: SessionLogEntry[] = [];
  const sessionLogger = {
    log: async (entry: SessionLogEntry): Promise<{ turnExternalId: string }> => {
      calls.push(entry);
      return { turnExternalId: `turn:${entry.scope}:stub` };
    },
  } as unknown as ConstructorParameters<typeof Orchestrator>[0]['sessionLogger'];
  return { sessionLogger, calls };
}

interface ScriptedStream {
  events: LlmStreamEvent[];
}

/** A scripted stream entry that fails immediately (no events at all), the
 *  way a non-retryable provider error surfaces before any text/tool delta —
 *  see `streamMessageEvents`'s `forwardedText` retry gate in streaming.ts. */
interface ThrowingStream {
  throws: Error;
}

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

/** Mirrors parallelTool.test.ts's fakeStreamProvider, extended with the
 *  ability to script a call that throws instead of streaming events — the
 *  shape needed to reproduce a post-tool-dispatch model failure. */
function fakeStreamProvider(
  scripts: Array<ScriptedStream | ThrowingStream>,
): LlmProvider {
  let idx = 0;
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (): Promise<LlmResponse> => {
      throw new Error('fakeStreamProvider: complete() not scripted');
    },
    stream: (_req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      if (idx >= scripts.length) {
        throw new Error(
          `fakeStreamProvider: no scripted stream for call ${String(idx + 1)}`,
        );
      }
      const script = scripts[idx]!;
      idx += 1;
      if ('throws' in script) {
        return {
          async *[Symbol.asyncIterator]() {
            throw script.throws;
          },
        };
      }
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of script.events) yield ev;
        },
      };
    },
    // Non-retryable — the second scripted call's failure must propagate
    // straight to `chatStreamInner`'s outer catch, exactly like a genuine
    // hard failure would (see isRetryableStreamError for the transient set).
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

function streamWithTools(
  toolUses: Array<{ id: string; name: string; input: unknown }>,
): ScriptedStream {
  const events: LlmStreamEvent[] = [];
  toolUses.forEach((u) => {
    events.push(
      { type: 'tool_use_start' },
      { type: 'tool_input_delta', text: JSON.stringify(u.input) },
    );
  });
  events.push({
    type: 'final',
    response: {
      content: toolUses.map((u) => ({
        type: 'tool_call',
        id: u.id,
        name: u.name,
        input: u.input,
      })),
      finishReason: 'tool_calls',
      providerFinishReason: 'tool_use',
      model: 'test',
      usage: {
        inputTokens: 50,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
  });
  return { events };
}

function buildOrchestrator(
  provider: LlmProvider,
  registry: NativeToolRegistry,
  sessionLogger: ConstructorParameters<typeof Orchestrator>[0]['sessionLogger'],
): Orchestrator {
  return new Orchestrator({
    provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: registry,
    sessionLogger,
  });
}

const minimalSpec = (name: string): Record<string, unknown> => ({
  name,
  description: `${name} for testing`,
  input_schema: { type: 'object' as const, properties: {}, required: [] },
});

/** Runs `fn` with `console.error` captured. Always restores, including on throw
 *  — a leaked stub would silently swallow every later test's diagnostics.
 *  Same shape as turnErrorCorrelation.test.ts's helper. */
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

describe('Issue #506 — report success when a tool already committed', () => {
  it('ends with `done` (not `error`) when a tool committed in an earlier iteration and a later model call throws', async () => {
    const registry = new NativeToolRegistry();
    registry.register('manage_widget', {
      handler: async (): Promise<string> => 'widget-created',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('manage_widget') as any,
    });

    // Iteration 0: model calls the tool, which succeeds and commits.
    const stream0 = streamWithTools([
      { id: 'use-1', name: 'manage_widget', input: {} },
    ]);
    // Iteration 1: the follow-up model call (generating the natural-language
    // confirmation) fails hard — the exact shape a mid-stream, non-retryable
    // provider error takes, or what's left once internal retries in
    // streamMessageEvents are exhausted.
    const stream1: ThrowingStream = {
      throws: Object.assign(new Error('boom: provider hard-failed'), {
        status: 400,
      }),
    };
    const provider = fakeStreamProvider([stream0, stream1]);
    const { sessionLogger, calls } = recordingSessionLogger();
    const orchestrator = buildOrchestrator(provider, registry, sessionLogger);

    const events: ChatStreamEvent[] = [];
    for await (const ev of orchestrator.chatStream({
      userMessage: 'create a widget',
      sessionScope: 'sess-506-committed',
    })) {
      events.push(ev);
    }

    const errorEvents = events.filter((e) => e.type === 'error');
    const doneEvents = events.filter((e) => e.type === 'done');
    assert.equal(
      errorEvents.length,
      0,
      `expected no error event, got ${JSON.stringify(errorEvents)}`,
    );
    assert.equal(doneEvents.length, 1, 'expected exactly one done event');

    const done = doneEvents[0];
    assert.ok(done && done.type === 'done');
    if (done && done.type === 'done') {
      // #1094 — the terminal event stays `done` (the committed call must not
      // be reported as failed, or the next turn re-invokes it), but it is now
      // RECOGNIZABLY degraded instead of indistinguishable from a real answer.
      assert.equal(
        done.degraded,
        true,
        'the degraded turn is reported as an ordinary success (#1094)',
      );
      assert.deepEqual(
        done.committedTools,
        ['manage_widget'],
        'the committed tool names are not machine-readable on the event',
      );
      assert.ok(
        done.correlationId !== undefined && done.correlationId !== '',
        'a degraded turn carries no support token, so the user cannot correlate it',
      );
      assert.equal(
        done.runTrace?.status,
        'error',
        'the run trace still claims success for a turn that threw',
      );
      // No hardcoded prose in the orchestrator: the catch block emits a
      // language-free marker and the DELIVERED wording is composed at the
      // boundary in the turn's locale (German is the shipping default), the
      // same mechanism the AI-Act marking uses. The marker itself never
      // reaches a channel.
      assert.doesNotMatch(
        done.answer,
        /completed successfully/i,
        'the hardcoded English pseudo-success is back in the orchestrator',
      );
      assert.doesNotMatch(
        done.answer,
        /<turn-incomplete/,
        'the raw marker was delivered to the channel instead of the notice',
      );
      assert.match(done.answer, /Dieser Turn wurde nicht abgeschlossen/);
      assert.match(done.answer, /manage_widget/);
      assert.equal(done.toolCalls, 1);
      // Two iterations were entered (0 and 1) before the failure.
      assert.equal(done.iterations, 2);
    }

    // Review follow-up: the emergency-`done` path must persist the
    // exchange exactly like every other `done` emission site does —
    // otherwise the committed `manage_widget` call is invisible to the
    // next turn and the model could re-invoke it, duplicating the side
    // effect. Assert the logger actually ran, with fields matching what
    // was yielded to the caller.
    assert.equal(calls.length, 1, 'expected sessionLogger.log to be called once');
    const logged = calls[0];
    assert.ok(logged);
    if (logged) {
      assert.equal(logged.scope, 'sess-506-committed');
      assert.equal(logged.userMessage, 'create a widget');
      // NOT equal to the delivered answer here — #1094 splits the two on this
      // path only: the channel gets the localized notice, the log keeps the
      // neutral marker (asserted below). Every other `done` site still
      // persists exactly what it yields, minus the disclosure line.
      assert.equal(logged.toolCalls, 1);
      assert.equal(logged.iterations, 2);
      // #1094 — what lands in the session log (and from there in the KG turn
      // node, and in the next turn's context) must not read as a success.
      assert.doesNotMatch(
        logged.assistantAnswer,
        /completed successfully/i,
        'the next turn reads a fake success as context (#1094)',
      );
      // PERSISTED is the language-free marker, not the delivered prose: the
      // session log feeds the KG turn node and the next turn's context, which
      // must not carry a locale-specific sentence (nor a fake success).
      assert.match(logged.assistantAnswer, /^<turn-incomplete\b/);
      assert.ok(
        logged.assistantAnswer.includes('tools="manage_widget"'),
        `persisted form lost the tool names: ${logged.assistantAnswer}`,
      );
      assert.notEqual(
        logged.assistantAnswer,
        withoutDisclosure(done.answer),
        'the localized notice was persisted instead of the neutral marker',
      );
    }
  });

  it('still ends with `error` when no tool committed before the failure (genuine failure, unchanged behavior)', async () => {
    const registry = new NativeToolRegistry();

    // Iteration 0: the very first model call fails hard, before any tool ran.
    const stream0: ThrowingStream = {
      throws: Object.assign(new Error('boom: provider hard-failed'), {
        status: 400,
      }),
    };
    const provider = fakeStreamProvider([stream0]);
    const { sessionLogger, calls } = recordingSessionLogger();
    const orchestrator = buildOrchestrator(provider, registry, sessionLogger);

    const events: ChatStreamEvent[] = [];
    for await (const ev of orchestrator.chatStream({
      userMessage: 'do something',
      sessionScope: 'sess-506-genuine-failure',
    })) {
      events.push(ev);
    }

    const errorEvents = events.filter((e) => e.type === 'error');
    const doneEvents = events.filter((e) => e.type === 'done');
    assert.equal(doneEvents.length, 0, 'expected no done event');
    assert.equal(errorEvents.length, 1, 'expected exactly one error event');
    const error = errorEvents[0];
    assert.ok(error && error.type === 'error');
    if (error && error.type === 'error') {
      assert.match(error.message, /boom: provider hard-failed/);
    }

    // A genuine failure with nothing committed must NOT persist a session
    // log entry — unchanged behavior, same as every other `error` emission
    // site in chatStreamInner.
    assert.equal(
      calls.length,
      0,
      'expected sessionLogger.log NOT to be called on a genuine failure',
    );
  });

  it('reports done even when a later intended action never ran (accepted tradeoff, see code comment)', async () => {
    // This test PINS the maintainer-reviewed, deliberate tradeoff documented
    // on `committedToolNames` and the catch-block done-vs-error branch in
    // orchestrator.ts — it does NOT assert that this behavior is correct in
    // all cases. A read-only-style tool (`list_routines`) succeeds in
    // iteration 0. Iteration 1's model call — which, had it succeeded, would
    // have requested a SECOND, different, mutating tool call (e.g. a
    // `manage_routine` create) — throws before it can request that second
    // tool call at all. The committed-tool tracking is tool-agnostic: it
    // cannot distinguish "a harmless read succeeded" from "the consequential
    // write the user actually wanted never ran." The turn still reports
    // `done`, naming only the read-only tool that actually committed — this
    // is the accepted residual risk, not a guarantee that the user's
    // intended action happened.
    const registry = new NativeToolRegistry();
    registry.register('list_routines', {
      handler: async (): Promise<string> => 'routine-a, routine-b',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('list_routines') as any,
    });

    // Iteration 0: model calls the read-only tool, which succeeds and
    // commits (per the generic, tool-agnostic tracking).
    const stream0 = streamWithTools([
      { id: 'use-1', name: 'list_routines', input: {} },
    ]);
    // Iteration 1: the model call that would have gone on to request a
    // second, mutating tool call (never scripted here — it never gets that
    // far) fails hard instead.
    const stream1: ThrowingStream = {
      throws: Object.assign(
        new Error('boom: provider hard-failed before requesting the mutating tool'),
        { status: 400 },
      ),
    };
    const provider = fakeStreamProvider([stream0, stream1]);
    const { sessionLogger, calls } = recordingSessionLogger();
    const orchestrator = buildOrchestrator(provider, registry, sessionLogger);

    const events: ChatStreamEvent[] = [];
    for await (const ev of orchestrator.chatStream({
      userMessage: 'list my routines, then create a new one',
      sessionScope: 'sess-506-later-action-skipped',
    })) {
      events.push(ev);
    }

    const errorEvents = events.filter((e) => e.type === 'error');
    const doneEvents = events.filter((e) => e.type === 'done');
    assert.equal(
      errorEvents.length,
      0,
      `expected no error event (accepted tradeoff), got ${JSON.stringify(errorEvents)}`,
    );
    assert.equal(doneEvents.length, 1, 'expected exactly one done event');

    const done = doneEvents[0];
    assert.ok(done && done.type === 'done');
    if (done && done.type === 'done') {
      // Only the read-only tool that actually committed is named — the
      // never-requested mutating tool is (correctly, per the generic
      // tracking) absent from the answer. Nothing here claims the intended
      // create actually happened.
      assert.match(done.answer, /list_routines/);
      assert.equal(done.toolCalls, 1);
      assert.equal(done.iterations, 2);
    }

    // The emergency-done path still persists the (partial) exchange, same
    // as the single-tool case above — that part of the behavior is not
    // being challenged by this test.
    assert.equal(calls.length, 1, 'expected sessionLogger.log to be called once');
  });
  it('MUTATION CHECK: the degraded turn carries the token that is in the server log', async () => {
    // #1094 — the whole point of the token is that support can join it to the
    // `[orchestrator] turn failed (correlationId=…)` line. The `error` branch
    // has had this since #641; the degraded `done` branch did not, so a user
    // hitting it had nothing to quote. Asserting mere presence would pass over
    // a token that joins nothing, so compare against the captured log line.
    const registry = new NativeToolRegistry();
    registry.register('manage_widget', {
      handler: async (): Promise<string> => 'widget-created',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('manage_widget') as any,
    });
    const provider = fakeStreamProvider([
      streamWithTools([{ id: 'use-1', name: 'manage_widget', input: {} }]),
      {
        throws: Object.assign(new Error('boom: provider hard-failed'), {
          status: 400,
        }),
      },
    ]);
    const { sessionLogger } = recordingSessionLogger();
    const orchestrator = buildOrchestrator(provider, registry, sessionLogger);

    const { result: events, lines } = await withCapturedConsoleError(async () => {
      const collected: ChatStreamEvent[] = [];
      for await (const ev of orchestrator.chatStream({
        userMessage: 'create a widget',
        sessionScope: 'sess-1094-correlation',
      })) {
        collected.push(ev);
      }
      return collected;
    });

    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done');
    const id = done.type === 'done' ? done.correlationId : undefined;
    assert.ok(id, 'the degraded done carries no correlation id');

    const logged = lines.filter((l) => l.includes('[orchestrator] turn failed'));
    assert.equal(
      logged.length,
      1,
      `expected exactly one failure log line, got ${String(logged.length)}`,
    );
    assert.ok(
      logged[0]?.includes(id),
      `the log line does not carry the user's token '${id}': ${logged[0] ?? '<none>'}`,
    );
    // The notice the channels render carries the same token, so a text-only
    // channel (Telegram, email) is as correlatable as a rich client.
    if (done.type === 'done') {
      assert.ok(
        done.answer.includes(id),
        `the delivered notice does not carry the token: ${done.answer}`,
      );
    }
  });

  it('names every DISTINCT committed tool, deduplicated, in first-commit order', async () => {
    // The dedup is deliberate (orchestrator.ts, `committedToolNames.includes`),
    // and `committedTools` inherits it: distinct NAMES, not a call count. Two
    // calls to the same tool appear once — pinned here so a consumer counting
    // entries as calls fails loudly rather than silently miscounting.
    const registry = new NativeToolRegistry();
    registry.register('manage_widget', {
      handler: async (): Promise<string> => 'widget-created',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('manage_widget') as any,
    });
    registry.register('memory', {
      handler: async (): Promise<string> => 'recalled',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('memory') as any,
    });
    const provider = fakeStreamProvider([
      streamWithTools([
        { id: 'use-1', name: 'memory', input: {} },
        { id: 'use-2', name: 'manage_widget', input: {} },
        { id: 'use-3', name: 'memory', input: {} },
      ]),
      {
        throws: Object.assign(new Error('boom: provider hard-failed'), {
          status: 400,
        }),
      },
    ]);
    const { sessionLogger, calls } = recordingSessionLogger();
    const orchestrator = buildOrchestrator(provider, registry, sessionLogger);

    const events: ChatStreamEvent[] = [];
    for await (const ev of orchestrator.chatStream({
      userMessage: 'remember this and create a widget',
      sessionScope: 'sess-1094-dedup',
    })) {
      events.push(ev);
    }

    const done = events.find((e) => e.type === 'done');
    assert.ok(done && done.type === 'done');
    if (done.type === 'done') {
      assert.deepEqual(done.committedTools, ['memory', 'manage_widget']);
      assert.equal(done.toolCalls, 3, 'three calls, two distinct names');
      assert.ok(
        done.answer.includes('memory, manage_widget'),
        `the notice does not name both tools: ${done.answer}`,
      );
    }
    assert.ok(
      calls[0]?.assistantAnswer.includes('tools="memory,manage_widget"'),
      `unexpected persisted marker: ${calls[0]?.assistantAnswer ?? '<none>'}`,
    );
  });

  it('composes the delivered notice in the operator locale, not hardcoded English', async () => {
    // #1094 — the old behaviour was an English sentence hardcoded in the
    // orchestrator, shown verbatim in a German UI. The wording now goes through
    // the same locale mechanism as the AI-Act marking, so an `en` deployment
    // gets English and the default (`de`) German — pinned in both directions,
    // because a composer that ignores the locale would still pass a one-sided
    // assertion.
    const registry = new NativeToolRegistry();
    registry.register('manage_widget', {
      handler: async (): Promise<string> => 'widget-created',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spec: minimalSpec('manage_widget') as any,
    });
    const scripted = (): Array<ScriptedStream | ThrowingStream> => [
      streamWithTools([{ id: 'use-1', name: 'manage_widget', input: {} }]),
      {
        throws: Object.assign(new Error('boom: provider hard-failed'), {
          status: 400,
        }),
      },
    ];
    const answerFor = async (locale: string | undefined): Promise<string> => {
      const { sessionLogger } = recordingSessionLogger();
      const orchestrator = new Orchestrator({
        provider: fakeStreamProvider(scripted()),
        model: 'test',
        maxTokens: 1024,
        maxToolIterations: 5,
        domainTools: [],
        nativeToolRegistry: registry,
        sessionLogger,
        ...(locale ? { aiDisclosure: { level: 'standard' as const, locale } } : {}),
      });
      const events: ChatStreamEvent[] = [];
      for await (const ev of orchestrator.chatStream({
        userMessage: 'create a widget',
        sessionScope: `sess-1094-locale-${locale ?? 'default'}`,
      })) {
        events.push(ev);
      }
      const done = events.find((e) => e.type === 'done');
      assert.ok(done && done.type === 'done');
      return done.type === 'done' ? done.answer : '';
    };

    const english = await answerFor('en');
    assert.match(english, /This turn did not finish/);
    assert.match(english, /manage_widget/);

    const german = await answerFor(undefined);
    assert.match(german, /Dieser Turn wurde nicht abgeschlossen/);
  });
});
