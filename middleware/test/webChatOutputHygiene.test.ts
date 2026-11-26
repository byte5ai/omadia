import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { InMemoryMemoryStore } from '@omadia/memory';
import { ChatSessionStore, SessionLogger } from '@omadia/orchestrator';
import { suppressNoReplyStream, type ChatStreamEvent } from '@omadia/channel-sdk';

/**
 * W15 — what the web chat shows:
 *  - #1896: a bare NO_REPLY never reaches the stream as text; `done` is silent.
 *  - #1956: the session mirror stores the answer without orchestrator notes.
 */

function done(answer: string): ChatStreamEvent {
  return { type: 'done', answer, toolCalls: 0, iterations: 1 };
}

async function collect(events: ChatStreamEvent[]): Promise<ChatStreamEvent[]> {
  async function* source(): AsyncGenerator<ChatStreamEvent> {
    for (const e of events) yield e;
  }
  const out: ChatStreamEvent[] = [];
  for await (const e of suppressNoReplyStream(source())) out.push(e);
  return out;
}

describe('suppressNoReplyStream (#1896)', () => {
  it('drops a streamed NO_REPLY and marks done silent', async () => {
    const out = await collect([
      { type: 'text_delta', text: 'NO_' },
      { type: 'text_delta', text: 'REPLY' },
      done('NO_REPLY'),
    ]);
    assert.deepEqual(out, [{ ...done(''), silent: true }]);
  });

  it('releases held text unchanged once it cannot be the sentinel', async () => {
    const out = await collect([
      { type: 'text_delta', text: 'NO' },
      { type: 'text_delta', text: 'pe, here it is' },
      { type: 'text_delta', text: '.' },
      done('NOpe, here it is.'),
    ]);
    assert.deepEqual(out, [
      { type: 'text_delta', text: 'NOpe, here it is' },
      { type: 'text_delta', text: '.' },
      done('NOpe, here it is.'),
    ]);
  });

  it('flushes a short held answer that is a sentinel prefix before done', async () => {
    const out = await collect([{ type: 'text_delta', text: 'NO' }, done('NO')]);
    assert.deepEqual(out, [{ type: 'text_delta', text: 'NO' }, done('NO')]);
  });

  it('absorbs a retract of held text and passes other events through', async () => {
    const out = await collect([
      { type: 'text_delta', text: 'N' },
      { type: 'text_retract', chars: 1 },
      { type: 'heartbeat' } as ChatStreamEvent,
      { type: 'text_delta', text: 'Hello' },
      done('Hello'),
    ]);
    assert.deepEqual(out, [
      { type: 'heartbeat' },
      { type: 'text_delta', text: 'Hello' },
      done('Hello'),
    ]);
  });

  it('marks a trailing-form NO_REPLY done silent', async () => {
    const out = await collect([
      { type: 'text_delta', text: 'Nothing to report.' },
      done('Nothing to report.\nNO_REPLY'),
    ]);
    assert.deepEqual(out, [
      { type: 'text_delta', text: 'Nothing to report.' },
      { type: 'text_retract', chars: 'Nothing to report.'.length },
      { ...done(''), silent: true },
    ]);
  });

  it('holds again after a retract back to zero (second iteration NO_REPLY)', async () => {
    const out = await collect([
      { type: 'text_delta', text: 'Let me check.' },
      { type: 'text_retract', chars: 'Let me check.'.length },
      { type: 'tool_use', id: 't1', name: 'x', input: {} } as ChatStreamEvent,
      { type: 'text_delta', text: 'NO_REPLY' },
      done('NO_REPLY'),
    ]);
    assert.deepEqual(out, [
      { type: 'text_delta', text: 'Let me check.' },
      { type: 'text_retract', chars: 'Let me check.'.length },
      { type: 'tool_use', id: 't1', name: 'x', input: {} },
      { ...done(''), silent: true },
    ]);
  });

  it('releases held text before a tool_use, keeping the order', async () => {
    const out = await collect([
      { type: 'text_delta', text: 'N' },
      { type: 'tool_use', id: 't1', name: 'x', input: {} } as ChatStreamEvent,
      done('N'),
    ]);
    assert.deepEqual(out.map((e) => e.type), ['text_delta', 'tool_use', 'done']);
  });
});

describe('web-chat mirror (#1956, #1896)', () => {
  const SESSION = '3f2a6c1e-8a4b-4c1d-9e2f-1a2b3c4d5e6f';

  async function setup(): Promise<{ logger: SessionLogger; chats: ChatSessionStore }> {
    const memory = new InMemoryMemoryStore();
    const chats = new ChatSessionStore(memory);
    await chats.save({ id: SESSION, title: 't', createdAt: 1, updatedAt: 1, messages: [] });
    const logger = new SessionLogger(memory, undefined, chats);
    return { logger, chats };
  }

  it('mirrors the answer without rendered_table / rendered_attachments notes', async () => {
    const { logger, chats } = await setup();
    const persisted = [
      '<!-- orchestrator:rendered_table',
      '  - source=odoo_query rows=3',
      '-->',
      'Here are the three open invoices.',
      '',
      '<!-- orchestrator:rendered_attachments',
      '  - kind=file producer=xlsx name="x.xlsx" bytes=10',
      '-->',
    ].join('\n');
    await logger.log({
      scope: SESSION,
      userMessage: 'open invoices?',
      assistantAnswer: persisted,
      entityRefs: [],
    });
    const session = await chats.get(SESSION);
    const answer = session?.messages.find((m) => m.role === 'assistant');
    assert.equal(answer?.content, 'Here are the three open invoices.');
  });

  it('does not duplicate a turn the client already PUT without the notes', async () => {
    const { logger, chats } = await setup();
    await chats.save({
      id: SESSION,
      title: 't',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { id: 'u1', role: 'user', content: 'q', startedAt: 1 },
        { id: 'a1', role: 'assistant', content: 'A.', startedAt: 1 },
      ],
    });
    await logger.log({
      scope: SESSION,
      userMessage: 'q',
      assistantAnswer: '<!-- orchestrator:rendered_table\n  - rows=1\n-->\nA.',
      entityRefs: [],
    });
    assert.equal((await chats.get(SESSION))?.messages.length, 2);
  });

  it('mirrors a trailing-form NO_REPLY as silent too, like the stream', async () => {
    const { logger, chats } = await setup();
    await logger.log({
      scope: SESSION,
      userMessage: 'status?',
      assistantAnswer: 'Nothing new.\nNO_REPLY',
      entityRefs: [],
    });
    const answer = (await chats.get(SESSION))?.messages.find((m) => m.role === 'assistant');
    assert.equal(answer?.silent, true);
    assert.equal(answer?.content, '');
  });

  it('mirrors a NO_REPLY turn as silent and empty', async () => {
    const { logger, chats } = await setup();
    await logger.log({
      scope: SESSION,
      userMessage: 'ok thanks',
      assistantAnswer: 'NO_REPLY',
      entityRefs: [],
    });
    const answer = (await chats.get(SESSION))?.messages.find((m) => m.role === 'assistant');
    assert.equal(answer?.content, '');
    assert.equal(answer?.silent, true);
  });
});
