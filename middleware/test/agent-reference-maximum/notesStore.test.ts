import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'node:test';

import type {
  MemoryAccessor,
  MemoryEntryInfo,
} from '@omadia/plugin-api';

import {
  createNotesStore,
  type NotesStore,
} from '../../packages/agent-reference-maximum/notesStore.js';

function makeFakeMemory(): MemoryAccessor {
  const files = new Map<string, string>();
  return {
    async readFile(p) {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    async writeFile(p, c) {
      files.set(p, c);
    },
    async createFile(p, c) {
      if (files.has(p)) throw new Error(`EEXIST: ${p}`);
      files.set(p, c);
    },
    async delete(p) {
      for (const k of [...files.keys()]) {
        if (k === p || k.startsWith(`${p}/`)) files.delete(k);
      }
    },
    async list(p) {
      const out: MemoryEntryInfo[] = [];
      for (const [k, v] of files.entries()) {
        if (!k.startsWith(`${p}/`)) continue;
        const tail = k.slice(p.length + 1);
        if (tail.includes('/')) continue;
        out.push({ relPath: k, isDirectory: false, sizeBytes: v.length });
      }
      return out;
    },
    async exists(p) {
      if (files.has(p)) return true;
      for (const k of files.keys()) {
        if (k.startsWith(`${p}/`)) return true;
      }
      return false;
    },
  };
}

describe('agent-reference / NotesStore', () => {
  let memory: MemoryAccessor;
  let store: NotesStore;

  beforeEach(() => {
    memory = makeFakeMemory();
    store = createNotesStore({ memory, log: () => {} });
  });

  it('add → list returns notes newest-first', async () => {
    const a = await store.add({ title: 'first', body: 'aaa' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.add({ title: 'second', body: 'bbb' });

    const list = await store.list();
    assert.equal(list.length, 2);
    assert.equal(list[0]!.id, b.id);
    assert.equal(list[1]!.id, a.id);
  });

  it('add without title persists null title', async () => {
    const r = await store.add({ body: 'no-title note' });
    assert.equal(r.title, null);
    const got = await store.get(r.id);
    assert.ok(got);
    assert.equal(got!.title, null);
  });

  it('list on empty memory returns []', async () => {
    const list = await store.list();
    assert.deepEqual(list, []);
  });

  it('get on unknown id returns undefined', async () => {
    const got = await store.get('does-not-exist');
    assert.equal(got, undefined);
  });
});
