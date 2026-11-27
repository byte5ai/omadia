/**
 * #1753 (ADR-0322) — a routine delivery and a transcript turn are appended,
 * never written back whole: deliveries go to an append-only journal next to
 * the chat document, the day's transcript grows through `appendFile`.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { InMemoryMemoryStore } from '@omadia/memory';
import { ChatSessionStore, SessionLogger } from '@omadia/orchestrator';
import type { ChatSession } from '@omadia/orchestrator';
import { appendToMemoryFile, type MemoryStore } from '@omadia/plugin-api';

const T0 = 1_700_000_000_000;
const DOC = '/memories/chat-sessions/c1.json';
const JOURNAL = '/memories/chat-sessions/c1.deliveries.jsonl';

/** Records every write-side call by path; reads pass through. */
function spyStore(): { store: MemoryStore; writes: string[]; reads: string[] } {
  const inner = new InMemoryMemoryStore();
  const writes: string[] = [];
  const reads: string[] = [];
  const store: MemoryStore = {
    list: (p) => inner.list(p),
    fileExists: (p) => inner.fileExists(p),
    directoryExists: (p) => inner.directoryExists(p),
    readFile: (p) => {
      reads.push(p);
      return inner.readFile(p);
    },
    createFile: (p, c) => {
      writes.push(`create ${p}`);
      return inner.createFile(p, c);
    },
    writeFile: (p, c) => {
      writes.push(`write ${p}`);
      return inner.writeFile(p, c);
    },
    appendFile: (p, c) => {
      writes.push(`append ${p}`);
      return inner.appendFile(p, c);
    },
    delete: (p) => {
      writes.push(`delete ${p}`);
      return inner.delete(p);
    },
    rename: (a, b) => inner.rename(a, b),
  };
  return { store, writes, reads };
}

function chat(): ChatSession {
  return {
    id: 'c1',
    title: 'Chat',
    createdAt: T0,
    updatedAt: T0,
    messages: [{ id: 'u1', role: 'user', content: 'hi', startedAt: T0 }],
  };
}

const delivery = (at: number) => ({ content: `report ${String(at)}`, deliveredAt: at, routineId: 'r1' });

describe('#1753 — delivery journal', () => {
  it('a delivery appends to the journal; the document is neither read nor written', async () => {
    const { store, writes, reads } = spyStore();
    const chats = new ChatSessionStore(store);
    await chats.save(chat());
    writes.length = 0;
    reads.length = 0;
    assert.equal(await chats.appendProactiveMessage('c1', delivery(T0 + 1)), 'appended');
    assert.equal(await chats.appendProactiveMessage('c1', delivery(T0 + 2)), 'appended');
    assert.deepEqual(writes, [`append ${JOURNAL}`, `append ${JOURNAL}`]);
    assert.deepEqual(reads, []);
  });

  it('get and list show the document with its deliveries', async () => {
    const chats = new ChatSessionStore(new InMemoryMemoryStore());
    await chats.save(chat());
    await chats.appendProactiveMessage('c1', delivery(T0 + 1));
    const got = await chats.get('c1');
    assert.deepEqual(
      got?.messages.map((m) => m.id),
      ['u1', 'proactive-r1-1700000000001'],
    );
    assert.equal(got?.messages[1]?.proactive?.routineId, 'r1');
    assert.ok((got?.updatedAt ?? 0) > T0, 'a delivery bumps updatedAt');
    const [summary] = await chats.list();
    assert.equal(summary?.messageCount, 2);
    assert.equal(summary?.updatedAt, got?.updatedAt);
  });

  it('the next save folds the journal into the document and drops it', async () => {
    const memory = new InMemoryMemoryStore();
    const chats = new ChatSessionStore(memory);
    await chats.save(chat());
    await chats.appendProactiveMessage('c1', delivery(T0 + 1));
    // A client PUT without the delivery keeps it (server-owned) and compacts.
    await chats.saveFromClient(chat());
    assert.equal(await memory.fileExists(JOURNAL), false);
    const stored = JSON.parse(await memory.readFile(DOC)) as ChatSession;
    assert.deepEqual(
      stored.messages.map((m) => m.id),
      ['u1', 'proactive-r1-1700000000001'],
    );
  });

  it('a reset drops journaled deliveries; a delete removes the journal', async () => {
    const memory = new InMemoryMemoryStore();
    const chats = new ChatSessionStore(memory);
    await chats.save(chat());
    await chats.appendProactiveMessage('c1', delivery(T0 + 1));
    await chats.resetMessages('c1');
    assert.deepEqual((await chats.get('c1'))?.messages, []);
    await chats.appendProactiveMessage('c1', delivery(T0 + 2));
    await chats.delete('c1');
    assert.equal(await memory.fileExists(JOURNAL), false);
    assert.equal(await memory.fileExists(DOC), false);
  });

  it('a delivery into a missing chat creates nothing', async () => {
    const memory = new InMemoryMemoryStore();
    const chats = new ChatSessionStore(memory);
    assert.equal(await chats.appendProactiveMessage('c1', delivery(T0)), 'not_found');
    assert.equal(await memory.fileExists(JOURNAL), false);
  });

  it('an unreadable journal line is skipped, the rest still shows', async () => {
    const memory = new InMemoryMemoryStore();
    const chats = new ChatSessionStore(memory);
    await chats.save(chat());
    await chats.appendProactiveMessage('c1', delivery(T0 + 1));
    await memory.appendFile(JOURNAL, '{broken\n');
    const got = await chats.get('c1');
    assert.equal(got?.messages.length, 2);
  });
});

describe('#1753 — transcripts are appended', () => {
  it('the day’s transcript gets one header and is never read back', async () => {
    const { store, writes, reads } = spyStore();
    const logger = new SessionLogger(store);
    await logger.log({ scope: 'routine:r1', userMessage: 'run', assistantAnswer: 'one', toolCalls: 0, iterations: 1 });
    await logger.log({ scope: 'routine:r1', userMessage: 'run', assistantAnswer: 'two', toolCalls: 0, iterations: 1 });
    const transcriptWrites = writes.filter((w) => w.includes('/memories/sessions/'));
    assert.equal(transcriptWrites.length, 2);
    assert.ok(transcriptWrites.every((w) => w.startsWith('append ')), transcriptWrites.join(', '));
    assert.equal(reads.filter((r) => r.includes('/memories/sessions/')).length, 0);
    const path = transcriptWrites[0]!.slice('append '.length);
    const text = await store.readFile(path);
    assert.equal(text.match(/^# /gm)?.length ?? 0, 1, 'one header');
    assert.ok(text.indexOf('one') < text.indexOf('two'));
  });

  it('appendToMemoryFile falls back to read + write for a store without appendFile', async () => {
    const inner = new InMemoryMemoryStore();
    const legacy: MemoryStore = {
      list: (p) => inner.list(p),
      fileExists: (p) => inner.fileExists(p),
      directoryExists: (p) => inner.directoryExists(p),
      readFile: (p) => inner.readFile(p),
      createFile: (p, c) => inner.createFile(p, c),
      writeFile: (p, c) => inner.writeFile(p, c),
      delete: (p) => inner.delete(p),
      rename: (a, b) => inner.rename(a, b),
    };
    await appendToMemoryFile(legacy, '/memories/x/a.md', 'a');
    await appendToMemoryFile(legacy, '/memories/x/a.md', 'b');
    assert.equal(await inner.readFile('/memories/x/a.md'), 'ab');
  });
});
