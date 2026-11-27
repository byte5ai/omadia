/**
 * ADR-0195 (#2239) — the subscription-CLI path runs under the Privacy Shield
 * instead of being refused: prompt and recalled context are masked before the
 * spawn, the handle sits on the turn context for the loopback dispatch, the
 * streamed text is restored (a surrogate split across chunks included), the
 * final answer is released through the shield and the receipt is drained
 * once. A guarded turn without a handle is still refused (fail closed).
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';

import {
  CLI_CALLER_MASK_BLOCKED_ANSWER,
  CLI_PRIVACY_SHIELD_REQUIRED_ANSWER_DE,
  CliChatAgent,
  isCliPrivacyRefusal,
} from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import type { CliChatAgentDeps } from '../../packages/harness-orchestrator/src/cliChatAgent.js';
import {
  STREAM_RESTORE_HOLDBACK,
  StreamSurrogateRestorer,
  type CliTurnPrivacy,
} from '../../packages/harness-orchestrator/src/cliTurnPrivacy.js';
import type { PrivacyTurnHandle } from '../../packages/harness-orchestrator/src/privacyHandle.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';
import { REPLAYED_ANSWER_MASKED_NOTE } from '../../packages/harness-orchestrator/src/replayedAnswerNote.js';
import type { ChatStreamEvent } from '../../packages/harness-channel-sdk/src/chatAgent.js';

const REAL = 'Marc Demo';
const SURROGATE = 'PLATZHALTER-NAME-1';
const restore = (text: string): string => text.split(SURROGATE).join(REAL);
const mask = (text: string): string => text.split(REAL).join(SURROGATE);

describe('StreamSurrogateRestorer', () => {
  it('restores a surrogate split across chunks as a whole', () => {
    const restorer = new StreamSurrogateRestorer(restore);
    const chunks = ['Hallo PLATZHAL', 'TER-NAME-', '1, wie geht es?\nZweite Zeile'];
    const shown = chunks.map((c) => restorer.push(c)).join('') + restorer.flush();
    assert.equal(shown, `Hallo ${REAL}, wie geht es?\nZweite Zeile`);
    assert.ok(!shown.includes('PLATZHAL'));
  });

  it('never cuts a long line inside a multi-word surrogate', () => {
    const real = 'Anna Beispiel';
    const surrogate = 'Lena Muster';
    const multi = (text: string): string => text.split(surrogate).join(real);
    const restorer = new StreamSurrogateRestorer(multi);
    const filler = 'wort '.repeat(Math.ceil(STREAM_RESTORE_HOLDBACK / 5) + 4);
    const text = `${filler}${surrogate} und ${filler}${surrogate} Ende`;
    let shown = '';
    for (const char of text) shown += restorer.push(char);
    shown += restorer.flush();
    assert.equal(shown, multi(text));
  });

  it('releases text before the holdback on long lines (streaming stays live)', () => {
    const restorer = new StreamSurrogateRestorer(restore);
    const out = restorer.push('a '.repeat(STREAM_RESTORE_HOLDBACK * 2));
    assert.ok(out.length > 0);
  });
});

interface Spawned {
  stdin: string;
  argv: readonly string[];
}

function fakeSpawn(spawned: Spawned[], deltas: readonly string[], result: string) {
  return ((_bin: string, argv: string[]) => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const chunks: Buffer[] = [];
    stdin.on('data', (c: Buffer) => chunks.push(c));
    const child = Object.assign(new PassThrough(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: () => true,
    });
    stdin.on('finish', () => {
      spawned.push({ stdin: Buffer.concat(chunks).toString('utf8'), argv });
      const lines = [
        JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] }),
        ...deltas.map((text) =>
          JSON.stringify({
            type: 'stream_event',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
          }),
        ),
        JSON.stringify({ type: 'result', is_error: false, result, num_turns: 1 }),
      ];
      stdout.end(lines.map((l) => `${l}\n`).join(''));
      setTimeout(() => {
        child.exitCode = 0;
        child.emit('close', 0, null);
      }, 5);
    });
    return child;
  }) as unknown as CliChatAgentDeps['spawnFn'];
}

function fakePrivacy(log: string[], opts: { blocked?: boolean } = {}): CliTurnPrivacy {
  const handle = { name: 'turn-handle' } as unknown as PrivacyTurnHandle;
  const blockedError = new Error('blocked');
  return {
    handle,
    tools: [],
    directive: 'DIRECTIVE',
    maskUserMessage: async (text) => {
      log.push(`installed:${String(turnContext.current()?.privacyHandle === handle)}`);
      if (opts.blocked === true) throw blockedError;
      return mask(text);
    },
    maskRecalled: async (text) => mask(text),
    wrapDispatch: (base) => base,
    streamRestorer: async () => restore,
    releaseAnswer: async (answer) => {
      log.push('release');
      return { answer: restore(answer) };
    },
    finalize: async () => {
      log.push('finalize');
      return { receiptId: 'cli-turn' };
    },
    refusalFor: (error) => (error === blockedError ? 'BLOCKED-NOTICE' : undefined),
  };
}

function agentWith(deps: Partial<CliChatAgentDeps>, spawned: Spawned[], deltas: string[], result: string) {
  return new CliChatAgent({
    dispatch: { listDispatchableToolSpecs: () => [] } as unknown as CliChatAgentDeps['dispatch'],
    policyEnv: {},
    resolveCliVersion: async () => '2.1.312',
    logger: { info: () => {}, warn: () => {} },
    buildEnv: () => ({ PATH: '/usr/bin', HOME: '/home/tester' }),
    spawnFn: fakeSpawn(spawned, deltas, result),
    ...deps,
  });
}

async function collect(agent: CliChatAgent, userMessage: string): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of agent.chatStream({ userMessage })) events.push(event);
  return events;
}

describe('CliChatAgent under a privacy guard (ADR-0195)', () => {
  it('masks the prompt before the spawn and restores the stream and the answer', async () => {
    const spawned: Spawned[] = [];
    const log: string[] = [];
    const recorded: Array<{ answer: string; wireView?: { userMessage: string; answer: string } }> = [];
    const agent = agentWith(
      {
        privacyGuarded: () => true,
        turnPrivacy: () => fakePrivacy(log),
        recordTurn: async (_input, turn) => {
          recorded.push(turn);
          return {};
        },
      },
      spawned,
      ['Das ist PLATZHAL', 'TER-NAME-1.'],
      `Das ist ${SURROGATE}.`,
    );
    const events = await collect(agent, `Wer ist ${REAL}?`);
    assert.equal(spawned.length, 1);
    assert.ok(!spawned[0]!.stdin.includes(REAL), spawned[0]!.stdin);
    assert.ok(spawned[0]!.stdin.includes(SURROGATE));
    const streamed = events
      .filter((e): e is Extract<ChatStreamEvent, { type: 'text_delta' }> => e.type === 'text_delta')
      .map((e) => e.text)
      .join('');
    assert.equal(streamed, `Das ist ${REAL}.`);
    const done = events.find((e) => e.type === 'done') as Extract<ChatStreamEvent, { type: 'done' }>;
    assert.equal(done.answer, `Das ist ${REAL}.`);
    assert.equal(done.receiptId, 'cli-turn');
    assert.deepEqual(log, ['installed:true', 'release', 'finalize']);
    // The row stores the restored answer and keeps the wire texts as its masked view.
    assert.equal(recorded[0]?.answer, `Das ist ${REAL}.`);
    assert.deepEqual(recorded[0]?.wireView, {
      userMessage: `Wer ist ${SURROGATE}?`,
      answer: `Das ist ${SURROGATE}.`,
    });
  });

  it('#2341 — a masked recall block alone brings the replayed-answer note', async () => {
    const run = async (recalledText: string) => {
      const spawned: Spawned[] = [];
      const agent = agentWith(
        {
          privacyGuarded: () => true,
          turnPrivacy: () => fakePrivacy([]),
          recallContext: async () => ({ text: recalledText }),
        },
        spawned,
        ['ok'],
        'ok',
      );
      for await (const _event of agent.chatStream({ userMessage: 'und weiter?', sessionScope: 'sess-2341' })) {
        // drain
      }
      return spawned[0]!.stdin;
    };
    const head = REPLAYED_ANSWER_MASKED_NOTE.split('\n')[0]!;
    const masked = await run(`Letzte Antwort: ${REAL} gründete die Stadt.`);
    assert.ok(!masked.includes(REAL), masked);
    assert.ok(masked.includes(head), masked);
    assert.equal((await run('Letzte Antwort: die Stadt ist alt.')).includes(head), false);
  });

  it('ends a turn with a blocked mask with the notice, before any spawn, and finalizes', async () => {
    const spawned: Spawned[] = [];
    const log: string[] = [];
    const agent = agentWith(
      { privacyGuarded: () => true, turnPrivacy: () => fakePrivacy(log, { blocked: true }) },
      spawned,
      [],
      'x',
    );
    const answer = await agent.chat({ userMessage: REAL });
    assert.equal(answer.text, 'BLOCKED-NOTICE');
    assert.equal(spawned.length, 0);
    assert.deepEqual(log, ['installed:true', 'finalize']);
  });

  it('refuses a guarded turn that gets no handle (fail closed)', async () => {
    const spawned: Spawned[] = [];
    const agent = agentWith(
      { privacyGuarded: () => true, turnPrivacy: () => undefined },
      spawned,
      [],
      'x',
    );
    const answer = await agent.chat({ userMessage: REAL });
    assert.equal(answer.text, CLI_PRIVACY_SHIELD_REQUIRED_ANSWER_DE);
    assert.ok(isCliPrivacyRefusal(answer.text));
    assert.equal(spawned.length, 0);
  });

  it('refuses when building the handle throws', async () => {
    const spawned: Spawned[] = [];
    const agent = agentWith(
      {
        privacyGuarded: () => true,
        turnPrivacy: () => {
          throw new Error('guard gone');
        },
      },
      spawned,
      [],
      'x',
    );
    const answer = await agent.chat({ userMessage: REAL });
    assert.equal(answer.text, CLI_PRIVACY_SHIELD_REQUIRED_ANSWER_DE);
    assert.equal(spawned.length, 0);
  });

  it('a sub-agent asked inside a guarded turn masks through the caller handle and does not restore', async () => {
    const spawned: Spawned[] = [];
    const caller = {
      maskUserPrompt: async (text: string) => ({
        outcome: 'masked' as const,
        maskedText: mask(text),
        spans: [],
        degraded: false,
      }),
    } as unknown as PrivacyTurnHandle;
    const agent = agentWith({}, spawned, [`Antwort ${SURROGATE}`], `Antwort ${SURROGATE}`);
    const answer = await turnContext.run(
      { turnId: 'parent', turnDate: '2026-11-26', privacyHandle: caller },
      () => agent.chat({ userMessage: `Frage zu ${REAL}` }),
    );
    assert.ok(!spawned[0]!.stdin.includes(REAL));
    // The answer goes back to the calling model: surrogates stay.
    assert.equal(answer.text, `Antwort ${SURROGATE}`);
  });

  it('a sub-agent under a caller handle with the v4 data plane gets the sub-agent directive (#2301)', async () => {
    const spawned: Spawned[] = [];
    const caller = {
      maskUserPrompt: async (text: string) => ({
        outcome: 'masked' as const,
        maskedText: mask(text),
        spans: [],
        degraded: false,
      }),
      v4ToolSpecs: () => [{ name: 'v4_count', description: 'count', input_schema: { type: 'object' } }],
    } as unknown as PrivacyTurnHandle;
    const agent = agentWith({}, spawned, ['ok'], 'ok');
    await turnContext.run(
      { turnId: 'parent', turnDate: '2026-11-26', privacyHandle: caller },
      // The fake CLI reports no MCP server; only the spawn arguments matter.
      () => agent.chat({ userMessage: 'Wie viele?' }).catch(() => undefined),
    );
    const prompt = spawned[0]!.argv[spawned[0]!.argv.indexOf('--system-prompt') + 1] ?? '';
    assert.match(prompt, /DATENSCHUTZ \(Privacy Shield\)/);
  });

  it('a sub-agent whose prompt the caller handle cannot mask is not spawned', async () => {
    const spawned: Spawned[] = [];
    const caller = {
      maskUserPrompt: async () => ({ outcome: 'blocked' as const, reason: 'C0 failed' }),
    } as unknown as PrivacyTurnHandle;
    const agent = agentWith({}, spawned, [], 'x');
    const answer = await turnContext.run(
      { turnId: 'parent', turnDate: '2026-11-26', privacyHandle: caller },
      () => agent.chat({ userMessage: REAL }),
    );
    assert.equal(answer.text, CLI_CALLER_MASK_BLOCKED_ANSWER);
    assert.equal(spawned.length, 0);
  });

  it('an operator tool outside any turn keeps the org policy as its only gate (ADR-0196)', async () => {
    const spawned: Spawned[] = [];
    const agent = agentWith({}, spawned, ['ok'], 'ok');
    const answer = await agent.chat({ userMessage: 'Entwurf prüfen' });
    assert.equal(answer.text, 'ok');
    const forced = agentWith({ policyEnv: { OMADIA_PRIVACY_FORCE_GUARDED: 'true' } }, spawned, [], 'x');
    assert.equal((await forced.chat({ userMessage: 'x' })).text, CLI_PRIVACY_SHIELD_REQUIRED_ANSWER_DE);
    assert.equal(spawned.length, 1);
  });
});
