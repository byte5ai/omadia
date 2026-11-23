import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import type { NativeToolSpec, PluginContext } from '@omadia/plugin-api';

import type { NotesStore } from '../../packages/agent-reference-maximum/notesStore.js';
import { registerToolkit } from '../../packages/agent-reference-maximum/registerTools.js';
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

/** Runs a toolkit tool and returns its result as the tool runtime sends it. */
async function callTool(toolkit: Toolkit, id: string, input: unknown): Promise<string> {
  const tool = toolkit.getTool(id);
  assert.ok(tool, `tool ${id} present`);
  return JSON.stringify(await tool.run(input));
}

describe('agent-reference / Toolkit add_note', () => {
  let toolkit: Toolkit;

  beforeEach(() => {
    toolkit = createToolkit({ notes: makeFakeNotesStore(), log: () => {} });
  });

  it('returns JSON with noteId and buffers a note-card attachment', async () => {
    const result = await callTool(toolkit, 'add_note', { body: 'hello' });
    const parsed = JSON.parse(result) as { noteId: string };
    assert.match(parsed.noteId, /^n\d+$/);

    const attachments = toolkit.getTool('add_note')!.attachmentSink!();
    assert.ok(attachments);
    assert.equal(attachments!.length, 1);
    assert.equal(attachments![0]!.kind, 'note-card');
  });

  it('the attachment sink returns undefined when the buffer is empty', () => {
    assert.equal(toolkit.getTool('add_note')!.attachmentSink!(), undefined);
  });

  it('the attachment sink drains the buffer', async () => {
    await callTool(toolkit, 'add_note', { body: 'one' });
    toolkit.getTool('add_note')!.attachmentSink!();
    assert.equal(toolkit.getTool('add_note')!.attachmentSink!(), undefined);
  });

  it('reports each stored note to onNoteAdded', async () => {
    const seen: string[] = [];
    const withHook = createToolkit({
      notes: makeFakeNotesStore(),
      log: () => {},
      onNoteAdded: (record) => seen.push(record.body),
    });
    await callTool(withHook, 'add_note', { body: 'hello' });
    assert.deepEqual(seen, ['hello']);
  });

  it('rejects empty body', async () => {
    await assert.rejects(() => callTool(toolkit, 'add_note', { body: '' }));
  });

  it('rejects missing body', async () => {
    await assert.rejects(() => callTool(toolkit, 'add_note', { title: 'foo' }));
  });
});

describe('agent-reference / registerToolkit — tool-runtime contract (#2049)', () => {
  it('registers every tool with a JSON schema derived from its Zod input and disposes them all', async () => {
    const toolkit = createToolkit({ notes: makeFakeNotesStore(), log: () => {} });
    const registered = new Map<
      string,
      { spec: NativeToolSpec; handler: (input: unknown) => Promise<string>; hasSink: boolean }
    >();
    let disposed = 0;
    const ctx = {
      tools: {
        register(
          spec: NativeToolSpec,
          handler: (input: unknown) => Promise<string>,
          options?: { attachmentSink?: unknown },
        ) {
          registered.set(spec.name, { spec, handler, hasSink: options?.attachmentSink !== undefined });
          return () => {
            disposed += 1;
          };
        },
      },
    } as unknown as PluginContext;

    const dispose = registerToolkit(ctx, toolkit);
    assert.deepEqual([...registered.keys()], ['add_note', 'smart_extract_entities', 'query_notes_by_person']);

    const addNote = registered.get('add_note')!;
    assert.equal(addNote.spec.input_schema.type, 'object');
    assert.deepEqual(addNote.spec.input_schema.required, ['body']);
    assert.deepEqual(Object.keys(addNote.spec.input_schema.properties).sort(), ['body', 'title']);
    assert.equal(addNote.hasSink, true);
    assert.equal(registered.get('query_notes_by_person')!.hasSink, false);

    const out = JSON.parse(await addNote.handler({ body: 'via runtime' })) as { noteId: string };
    assert.match(out.noteId, /^n\d+$/);
    await assert.rejects(() => addNote.handler({ body: '' }), { name: 'ZodError' });

    dispose();
    assert.equal(disposed, 3);
  });
});

describe('agent-reference / no delegation to other agents (#2049)', () => {
  it('offers no analyze_url tool: a capability plugin never asks an agent', () => {
    const toolkit = createToolkit({ notes: makeFakeNotesStore(), log: () => {} });
    assert.equal(toolkit.getTool('analyze_url'), undefined);
  });
});
