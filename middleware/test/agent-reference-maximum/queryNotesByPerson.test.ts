import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import type { NotesStore } from '../../packages/agent-reference-maximum/notesStore.js';
import {
  createToolkit,
  type Toolkit,
} from '../../packages/agent-reference-maximum/toolkit.js';
import type { NoteRecord } from '../../packages/agent-reference-maximum/types.js';

function makePopulatedStore(records: NoteRecord[]): NotesStore {
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

describe('agent-reference / Toolkit query_notes_by_person (OB-29-4)', () => {
  let toolkit: Toolkit;
  let store: NotesStore;
  let records: NoteRecord[];

  beforeEach(() => {
    records = [
      {
        id: 'n1',
        title: 'Gespräch mit John Doe',
        body: 'John Doe hat Theme F gut umgesetzt.',
        createdAt: '2026-05-01T10:00:00.000Z',
      },
      {
        id: 'n2',
        title: 'Kaffee mit John Müller',
        body: 'John Müller hatte Feedback zur Roadmap.',
        createdAt: '2026-05-02T09:30:00.000Z',
      },
      {
        id: 'n3',
        title: 'Sprintplanung',
        body: 'Anna war heute auch dabei.',
        createdAt: '2026-05-03T11:00:00.000Z',
      },
      {
        id: 'n4',
        title: 'Sprint-Review mit John Mueller',
        body: 'John Mueller hatte Bedenken zum Zeitplan.',
        createdAt: '2026-05-04T14:00:00.000Z',
      },
    ];
    store = makePopulatedStore(records);
    toolkit = createToolkit({ notes: store, log: () => {} });
  });

  it('single match → returns plain matches array', async () => {
    const result = await toolkit.handlers.queryNotesByPerson({
      personName: 'Anna',
    });
    const parsed = JSON.parse(result) as {
      ok: boolean;
      matches: { noteId: string }[];
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.matches.length, 1);
    assert.equal(parsed.matches[0]!.noteId, 'n3');
  });

  it('zero matches → empty array (no _pendingUserChoice)', async () => {
    const result = await toolkit.handlers.queryNotesByPerson({
      personName: 'Bob',
    });
    const parsed = JSON.parse(result) as {
      ok: boolean;
      matches: unknown[];
      _pendingUserChoice?: unknown;
    };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.matches.length, 0);
    assert.equal(parsed._pendingUserChoice, undefined);
  });

  it('multi match → emits _pendingUserChoice with question + options', async () => {
    const result = await toolkit.handlers.queryNotesByPerson({
      personName: 'John',
    });
    const parsed = JSON.parse(result) as {
      ok: boolean;
      _pendingUserChoice?: {
        question: string;
        rationale?: string;
        options: { label: string; value: string }[];
      };
    };
    assert.equal(parsed.ok, true);
    assert.ok(parsed._pendingUserChoice);
    assert.match(
      parsed._pendingUserChoice!.question,
      /3 Notizen erw.hnen "John"/,
    );
    assert.equal(parsed._pendingUserChoice!.options.length, 3);
    for (const o of parsed._pendingUserChoice!.options) {
      assert.match(o.value, /^note:n\d+$/);
      assert.ok(o.label.length > 0);
    }
  });

  it('caps options at 6 (covers many-matches case)', async () => {
    // Add 10 more "John"-records.
    for (let i = 0; i < 10; i++) {
      records.push({
        id: `extra${i}`,
        title: `John ${i}`,
        body: `extra John ${i}`,
        createdAt: '2026-05-05T00:00:00.000Z',
      });
    }
    const result = await toolkit.handlers.queryNotesByPerson({
      personName: 'John',
    });
    const parsed = JSON.parse(result) as {
      _pendingUserChoice?: { options: unknown[] };
    };
    assert.ok(parsed._pendingUserChoice);
    assert.equal(parsed._pendingUserChoice!.options.length, 6);
  });

  it('rejects empty personName', async () => {
    await assert.rejects(() =>
      toolkit.handlers.queryNotesByPerson({ personName: '' }),
    );
  });
});
