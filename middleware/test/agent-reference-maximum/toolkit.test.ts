import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import type { SubAgentAccessor } from '@omadia/plugin-api';

import type { NotesStore } from '../../packages/agent-reference-maximum/notesStore.js';
import {
  createToolkit,
  type Toolkit,
} from '../../packages/agent-reference-maximum/toolkit.js';
import type { NoteRecord } from '../../packages/agent-reference-maximum/types.js';

function makeFakeNotesStore(): NotesStore {
  const records: NoteRecord[] = [];
  return {
    async add({ title, body }) {
      const r: NoteRecord = {
        id: `n${records.length + 1}`,
        title: title ?? null,
        body,
        createdAt: new Date().toISOString(),
      };
      records.push(r);
      return r;
    },
    async list() {
      return [...records];
    },
    async get(id) {
      return records.find((r) => r.id === id);
    },
  };
}

describe('agent-reference / Toolkit add_note', () => {
  let toolkit: Toolkit;

  beforeEach(() => {
    toolkit = createToolkit({ notes: makeFakeNotesStore(), log: () => {} });
  });

  it('returns JSON with noteId and pushes a note-card attachment', async () => {
    const result = await toolkit.handlers.addNote({ body: 'hello' });
    const parsed = JSON.parse(result) as { noteId: string };
    assert.match(parsed.noteId, /^n\d+$/);

    const attachments = toolkit.takeAddNoteAttachments();
    assert.ok(attachments);
    assert.equal(attachments!.length, 1);
    assert.equal(attachments![0]!.kind, 'note-card');
  });

  it('takeAddNoteAttachments returns undefined when buffer is empty', () => {
    assert.equal(toolkit.takeAddNoteAttachments(), undefined);
  });

  it('takeAddNoteAttachments drains the buffer', async () => {
    await toolkit.handlers.addNote({ body: 'one' });
    toolkit.takeAddNoteAttachments();
    assert.equal(toolkit.takeAddNoteAttachments(), undefined);
  });

  it('rejects empty body', async () => {
    await assert.rejects(() => toolkit.handlers.addNote({ body: '' }));
  });

  it('rejects missing body', async () => {
    await assert.rejects(() => toolkit.handlers.addNote({ title: 'foo' }));
  });
});

describe('agent-reference / Toolkit analyze_url (OB-29-1)', () => {
  it('returns permission-error result when subAgent is undefined', async () => {
    const toolkit = createToolkit({
      notes: makeFakeNotesStore(),
      log: () => {},
    });
    const result = await toolkit.handlers.analyzeUrl({
      url: 'https://example.com',
    });
    const parsed = JSON.parse(result) as { ok: boolean; error: string };
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /subAgent accessor unavailable/);
  });

  it('delegates to ctx.subAgent.ask and persists answer as note', async () => {
    const askedQuestions: { target: string; question: string }[] = [];
    const fakeSubAgent: SubAgentAccessor = {
      async ask(targetAgentId: string, question: string) {
        askedQuestions.push({ target: targetAgentId, question });
        return 'Issue 1: missing meta description.\nIssue 2: H1 too short.\nIssue 3: no JSON-LD.';
      },
      has: () => true,
      list: () => ['@omadia/agent-seo-analyst'],
    };
    const notesStore = makeFakeNotesStore();
    const toolkit = createToolkit({
      notes: notesStore,
      log: () => {},
      subAgent: fakeSubAgent,
    });

    const result = await toolkit.handlers.analyzeUrl({
      url: 'https://example.com/page',
    });
    const parsed = JSON.parse(result) as {
      ok: boolean;
      noteId: string;
      delegateAgent: string;
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.delegateAgent, '@omadia/agent-seo-analyst');
    assert.match(parsed.noteId, /^n\d+$/);

    // Sub-agent saw the URL in the question.
    assert.equal(askedQuestions.length, 1);
    assert.equal(askedQuestions[0]!.target, '@omadia/agent-seo-analyst');
    assert.match(
      askedQuestions[0]!.question,
      /https:\/\/example\.com\/page/,
    );

    // Note was persisted.
    const list = await notesStore.list();
    assert.equal(list.length, 1);
    assert.match(list[0]!.body, /Issue 1: missing meta description/);

    // Smart-Card-Attachment was buffered.
    const attachments = toolkit.takeAnalyzeUrlAttachments();
    assert.ok(attachments);
    assert.equal(attachments![0]!.kind, 'note-card');
  });

  it('returns subAgent error in result instead of throwing', async () => {
    const fakeSubAgent: SubAgentAccessor = {
      async ask() {
        throw new Error('upstream offline');
      },
      has: () => true,
      list: () => [],
    };
    const toolkit = createToolkit({
      notes: makeFakeNotesStore(),
      log: () => {},
      subAgent: fakeSubAgent,
    });
    const result = await toolkit.handlers.analyzeUrl({
      url: 'https://example.com',
    });
    const parsed = JSON.parse(result) as { ok: boolean; error: string };
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /upstream offline/);
  });

  it('rejects non-URL input', async () => {
    const toolkit = createToolkit({
      notes: makeFakeNotesStore(),
      log: () => {},
    });
    await assert.rejects(() =>
      toolkit.handlers.analyzeUrl({ url: 'not-a-url' }),
    );
  });
});
