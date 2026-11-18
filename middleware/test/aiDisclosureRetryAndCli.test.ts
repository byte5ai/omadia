import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';

import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import { NativeToolRegistry, Orchestrator, ToolReplayLedger } from '@omadia/orchestrator';
import type { ChatStreamEvent, ChatTurnInput } from '@omadia/channel-sdk';

import { CliChatAgent } from '../packages/harness-orchestrator/src/cliChatAgent.js';
import type { CliChatAgentDeps } from '../packages/harness-orchestrator/src/cliChatAgent.js';

/**
 * #1578 — the first answer a user receives in a conversation carries the AI
 * disclosure line, however many passes the verifier ran: a correction retry
 * of the first turn folds it again. #1582 — subscription-CLI turns carry the
 * line and the structured carrier like API-key turns.
 */

const LINE = 'Diese Antwort wurde von einem KI-System erzeugt.';

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } as const;

function textProvider(answerText: string): LlmProvider {
  const response = {
    content: [{ type: 'text', text: answerText }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
  return {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
    },
    complete: async (): Promise<LlmResponse> => response,
    stream: (_req: LlmRequest): AsyncIterable<LlmStreamEvent> => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text_delta', text: answerText };
        yield { type: 'final', response };
      },
    }),
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function orchestrator(answer = 'Antwort.'): Orchestrator {
  return new Orchestrator({
    provider: textProvider(answer),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
  });
}

async function streamDone(
  o: Orchestrator,
  input: ChatTurnInput,
): Promise<Extract<ChatStreamEvent, { type: 'done' }>> {
  let done: Extract<ChatStreamEvent, { type: 'done' }> | undefined;
  for await (const ev of o.chatStream(input)) {
    if (ev.type === 'done') done = ev;
  }
  assert.ok(done, 'no done event');
  return done;
}

/** One verifier request: a first pass and a correction retry on one ledger. */
async function firstPassAndRetry(
  o: Orchestrator,
  scope: string,
): Promise<{ first: string; retry: string }> {
  const input: ChatTurnInput = { userMessage: 'Frage', sessionScope: scope };
  const ledger = new ToolReplayLedger();
  const release = o.bindToolReplayLedger(input, ledger);
  const first = await streamDone(o, input);
  ledger.beginReentry();
  const retryInput: ChatTurnInput = { ...input, extraSystemHint: 'Korrigiere die Aussage.' };
  const releaseRetry = o.bindToolReplayLedger(retryInput, ledger);
  const retry = await streamDone(o, retryInput);
  release();
  releaseRetry();
  return { first: first.answer, retry: retry.answer };
}

describe('#1578 — a verifier retry of the first turn keeps the disclosure line', () => {
  it('folds the line into the retry answer the user receives', async () => {
    const o = orchestrator();
    const { first, retry } = await firstPassAndRetry(o, 'conv-1578-a');
    assert.ok(first.endsWith(LINE), first);
    assert.ok(retry.endsWith(LINE), `retry answer lacks the line: ${retry}`);
  });

  it('still shows the line only on the first turn of the conversation', async () => {
    const o = orchestrator();
    await firstPassAndRetry(o, 'conv-1578-b');
    const next = await streamDone(o, { userMessage: 'ok', sessionScope: 'conv-1578-b' });
    assert.equal(next.answer.includes(LINE), false, next.answer);
    assert.ok(next.aiDisclosure, 'the structured carrier rides every turn');
  });

  it('adds no line to a retry of a later turn', async () => {
    const o = orchestrator();
    await streamDone(o, { userMessage: 'hallo', sessionScope: 'conv-1578-c' });
    const { first, retry } = await firstPassAndRetry(o, 'conv-1578-c');
    assert.equal(first.includes(LINE), false);
    assert.equal(retry.includes(LINE), false);
  });
});

// ── #1582 — the subscription CLI ────────────────────────────────────────────

function line(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

const RESULT = [line({ type: 'result', subtype: 'success', is_error: false, result: 'Paris.', num_turns: 1 })];

function cliAgent(extra: Partial<CliChatAgentDeps>): CliChatAgent {
  return new CliChatAgent({
    dispatch: { listDispatchableToolSpecs: () => [] } as unknown as CliChatAgentDeps['dispatch'],
    createLoopbackServer: () =>
      ({
        start: async () => ({ url: 'http://127.0.0.1:1/mcp', port: 1, bearer: 'bearer' }),
        stop: async () => {},
      }) as never,
    resolveCliVersion: async () => '2.1.187',
    logger: { info: () => undefined, warn: () => undefined },
    spawnFn: (() => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      const child = Object.assign(new PassThrough(), {
        stdin,
        stdout,
        stderr,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: () => true,
      });
      stdin.resume();
      stdin.on('finish', () => {
        stdout.end(RESULT.join(''));
        stderr.end('');
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
      return child;
    }) as unknown as CliChatAgentDeps['spawnFn'],
    ...extra,
  });
}

describe('#1582 — subscription-CLI turns carry the AI disclosure', () => {
  it('folds the line on the first streamed turn and attaches the carrier on every turn', async () => {
    const o = orchestrator();
    const recorded: string[] = [];
    const agent = cliAgent({
      discloseAnswer: (answer, input) => o.discloseCliAnswer(answer, input),
      recordTurn: async (_input, turn) => {
        recorded.push(turn.answer);
        return {};
      },
    });
    const dones: Array<Extract<ChatStreamEvent, { type: 'done' }>> = [];
    for (const message of ['Hauptstadt von Frankreich?', 'Und von Italien?']) {
      for await (const ev of agent.chatStream({ userMessage: message, sessionScope: 'cli-1582' })) {
        if (ev.type === 'done') dones.push(ev);
      }
    }
    assert.equal(dones.length, 2);
    assert.equal(dones[0]!.answer, `Paris.\n\n${LINE}`);
    assert.equal(dones[1]!.answer, 'Paris.', 'only the first turn of the conversation');
    assert.ok(dones[0]!.aiDisclosure && dones[1]!.aiDisclosure);
    assert.ok(recorded.every((a) => !a.includes(LINE)), 'the recorded turn stays unmarked');
  });

  it('folds the line on the non-streaming path too', async () => {
    const o = orchestrator();
    const agent = cliAgent({ discloseAnswer: (answer, input) => o.discloseCliAnswer(answer, input) });
    const answer = await agent.chat({ userMessage: 'Hauptstadt?', sessionScope: 'cli-1582-chat' });
    assert.equal(answer.text, `Paris.\n\n${LINE}`);
    assert.equal(answer.aiDisclosure?.level, 'standard');
  });

  it('leaves the answer alone when unwired (the sub-agent runtime)', async () => {
    const answer = await cliAgent({}).chat({ userMessage: 'Hauptstadt?' });
    assert.equal(answer.text, 'Paris.');
  });
});
