import type { MemoryAccessor } from '@omadia/plugin-api';

import type { NoteRecord } from './types.js';

export interface NotesStore {
  add(input: { title?: string; body: string }): Promise<NoteRecord>;
  list(): Promise<NoteRecord[]>;
  get(id: string): Promise<NoteRecord | undefined>;
}

export interface NotesStoreOptions {
  readonly memory: MemoryAccessor;
  readonly log: (...args: unknown[]) => void;
}

const NOTES_DIR = 'notes';

export function createNotesStore(opts: NotesStoreOptions): NotesStore {
  const { memory, log } = opts;
  return {
    async add({ title, body }) {
      const id = generateNoteId();
      const createdAt = new Date().toISOString();
      const record: NoteRecord = {
        id,
        title: title ?? null,
        body,
        createdAt,
      };
      await memory.writeFile(
        `${NOTES_DIR}/${id}.json`,
        JSON.stringify(record, null, 2),
      );
      log('note added', { id, createdAt });
      return record;
    },
    async list() {
      const exists = await memory.exists(NOTES_DIR);
      if (!exists) return [];
      const entries = await memory.list(NOTES_DIR);
      const out: NoteRecord[] = [];
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        try {
          const raw = await memory.readFile(entry.relPath);
          const parsed = JSON.parse(raw) as NoteRecord;
          out.push(parsed);
        } catch (err) {
          log('list: skipped unreadable note', { path: entry.relPath, err });
        }
      }
      out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return out;
    },
    async get(id) {
      try {
        const raw = await memory.readFile(`${NOTES_DIR}/${id}.json`);
        return JSON.parse(raw) as NoteRecord;
      } catch {
        return undefined;
      }
    },
  };
}

function generateNoteId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}
