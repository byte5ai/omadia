import { z } from 'zod';

import type {
  KnowledgeGraphAccessor,
  LlmAccessor,
  NativeToolAttachment,
} from '@omadia/plugin-api';

import { buildNoteCardAttachment } from './attachments.js';
import { extractFromNote, extractWithLlm } from './extractor.js';
import type { NotesStore } from './notesStore.js';
import type { AddNoteResult, NoteRecord } from './types.js';

/**
 * Toolkit = capability → executable handler with a Zod input schema, the
 * same shape as the Plugin Builder's boilerplates
 * (`middleware/assets/boilerplate/{integration,tool}/toolkit.ts`). Each tool
 * mirrors 1:1 a capability from manifest.yaml; `registerTools.ts` registers
 * every tool with the kernel's tool runtime under its `id`.
 *
 * One addition over the boilerplate: a tool may carry an `attachmentSink`
 * (Smart-Card pattern). The kernel calls it once at the end of the turn and
 * forwards the buffered attachments to the channel.
 */
export interface ToolDescriptor<I, O> {
  readonly id: string;
  readonly description: string;
  readonly input: z.ZodType<I>;
  run(input: I): Promise<O>;
  /** Smart-Card pattern: drained by the kernel at the end of each turn. */
  readonly attachmentSink?: () => NativeToolAttachment[] | undefined;
}

export interface Toolkit {
  readonly tools: readonly ToolDescriptor<unknown, unknown>[];
  getTool<I = unknown, O = unknown>(id: string): ToolDescriptor<I, O> | undefined;
  close(): Promise<void>;
}

export interface ToolkitOptions {
  readonly notes: NotesStore;
  readonly log: (...args: unknown[]) => void;
  /** Called after `add_note` stored a note (e.g. to send a notification).
   *  Must not throw; its failure never changes the tool result. */
  readonly onNoteAdded?: (record: NoteRecord) => void;
  /** OB-29-2 — present when manifest declares permissions.graph.entity_systems
   *  AND a knowledgeGraph provider is registered. When undefined, `add_note`
   *  skips the KG-ingest leg (the note is still written to memory), so the
   *  plugin runs in environments without a KG (e.g. unit tests). */
  readonly knowledgeGraph?: KnowledgeGraphAccessor;
  /** OB-29-3 — present when manifest declares permissions.llm.models_allowed
   *  AND host has 'llm' provider registered. When undefined,
   *  `smart_extract_entities` returns a permission-error result instead of
   *  throwing. */
  readonly llm?: LlmAccessor;
}

const addNoteInput = z
  .object({
    title: z.string().min(1).max(200).optional().describe('Optionaler Titel der Notiz.'),
    body: z.string().min(1).max(10_000).describe('Pflicht. Notiz-Inhalt als Markdown.'),
  })
  .strict();

const smartExtractInput = z
  .object({
    body: z.string().min(1).max(10_000).describe('Pflicht. Notiz-Text als Markdown.'),
  })
  .strict();

const queryNotesByPersonInput = z
  .object({
    personName: z.string().min(1).max(200).describe('Pflicht. Name oder Substring der Person.'),
  })
  .strict();

type SmartExtractResult =
  | { readonly ok: true; readonly entities: readonly unknown[] }
  | { readonly ok: false; readonly error: string };

interface PendingUserChoice {
  readonly question: string;
  readonly rationale: string;
  readonly options: { readonly label: string; readonly value: string }[];
}

type QueryNotesResult =
  | { readonly ok: true; readonly matches: { readonly noteId: string; readonly title: string | null }[] }
  | { readonly ok: true; readonly _pendingUserChoice: PendingUserChoice };

export function createToolkit(opts: ToolkitOptions): Toolkit {
  const { notes, log, knowledgeGraph, llm } = opts;
  let pendingAddNoteAttachments: NativeToolAttachment[] = [];

  /** OB-29-2 — extract Person/Topic entities and ingest them as PluginEntity
   *  nodes. Best-effort: a KG error never breaks add_note, the note itself
   *  is already written to memory. */
  async function ingestEntities(record: NoteRecord): Promise<number> {
    if (!knowledgeGraph) return 0;
    try {
      const extraction = extractFromNote({ body: record.body, noteId: record.id });
      if (extraction.entities.length === 0) return 0;
      const result = await knowledgeGraph.ingestEntities(
        extraction.entities.map((e) => ({
          system: e.system,
          model: e.model,
          id: e.id,
          displayName: e.displayName,
        })),
      );
      return result.inserted + result.updated;
    } catch (err) {
      log('add_note: kg ingest failed (non-fatal)', {
        err: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  const tools: ToolDescriptor<unknown, unknown>[] = [
    {
      id: 'add_note',
      description:
        'Speichert eine kurze Freiform-Notiz im Plugin-Memory-Scope. Liefert ' +
        'die noteId zurück und rendert eine note-card als Smart-Card-Attachment ' +
        'in den aktuellen Channel-Render-Buffer.',
      input: addNoteInput as z.ZodType<unknown>,
      async run(raw): Promise<AddNoteResult> {
        const parsed = addNoteInput.parse(raw);
        const record = await notes.add(parsed);
        pendingAddNoteAttachments.push(buildNoteCardAttachment(record));
        const kgInsertedEntities = await ingestEntities(record);
        opts.onNoteAdded?.(record);
        log('add_note ok', { noteId: record.id, kgInsertedEntities });
        return { noteId: record.id, createdAt: record.createdAt, kgInsertedEntities };
      },
      attachmentSink() {
        if (pendingAddNoteAttachments.length === 0) return undefined;
        const out = pendingAddNoteAttachments;
        pendingAddNoteAttachments = [];
        return out;
      },
    },
    {
      id: 'smart_extract_entities',
      description:
        'Extrahiert Personen und Topics aus einem Notiz-Text per LLM-Call. Nutze ' +
        'das Tool, wenn ein Text Personen oder Themen nur implizit nennt: ' +
        '`add_note` extrahiert selbst nur deterministisch per Regex und erkennt ' +
        'deshalb "John hat das gut gemacht" ohne `Person:`-Prefix nicht. Bei ' +
        'explizit markierten Entities ist der Aufruf unnötig.',
      input: smartExtractInput as z.ZodType<unknown>,
      async run(raw): Promise<SmartExtractResult> {
        const parsed = smartExtractInput.parse(raw);
        if (!llm) {
          log('smart_extract_entities denied: no llm on ctx');
          return {
            ok: false,
            error: 'llm accessor unavailable — manifest needs permissions.llm.models_allowed',
          };
        }
        // Pick the first allowed model (the manifest pins us to Haiku).
        const model = llm.modelsAllowed[0] ?? 'claude-haiku-4-5';
        try {
          const entities = await extractWithLlm({
            body: parsed.body,
            llm,
            model: model.endsWith('*') ? model.slice(0, -1) + '20251001' : model,
          });
          log('smart_extract_entities ok', { count: entities.length });
          return { ok: true, entities };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log('smart_extract_entities llm.complete failed', { err: message });
          return { ok: false, error: message };
        }
      },
    },
    {
      id: 'query_notes_by_person',
      description:
        'Sucht gespeicherte Notizen, die einen Personen-Namen erwähnen — ' +
        'case-insensitive Substring über Body und Title. Nutze das Tool, wenn der ' +
        'Nutzer nach Notizen zu einer Person fragt. Bei Mehrdeutigkeit (≥2 ' +
        'Matches) rät das Tool nicht, sondern meldet die Treffer als ' +
        '`_pendingUserChoice`. Ruft der Orchestrator das Tool selbst auf und ' +
        'interniert der Privacy Shield das Ergebnis nicht, beendet er den Turn ' +
        'und rendert eine Auswahl-Smart-Card. Kommt keine Karte, frag den Nutzer, ' +
        'welche Notiz er meint — rate nie.',
      input: queryNotesByPersonInput as z.ZodType<unknown>,
      async run(raw): Promise<QueryNotesResult> {
        const parsed = queryNotesByPersonInput.parse(raw);
        const needle = parsed.personName.toLowerCase();
        const matches = (await notes.list()).filter((n) => {
          const body = n.body.toLowerCase();
          const title = (n.title ?? '').toLowerCase();
          return body.includes(needle) || title.includes(needle);
        });
        if (matches.length <= 1) {
          log('query_notes_by_person', { needle, count: matches.length });
          return { ok: true, matches: matches.map((n) => ({ noteId: n.id, title: n.title })) };
        }
        // Ambiguity → emit _pendingUserChoice. The orchestrator short-circuits
        // the turn and renders a Smart-Card; a click fires a new turn with the
        // chosen value as the user message.
        log('query_notes_by_person ambiguous → _pendingUserChoice', { count: matches.length });
        return {
          ok: true,
          _pendingUserChoice: {
            question: `${matches.length} Notizen erwähnen "${parsed.personName}". Welche meinst du?`,
            rationale: 'Mehrere Treffer; bitte exakte Notiz auswählen, statt zu raten.',
            options: matches.slice(0, 6).map((n) => ({
              label: n.title ?? n.body.slice(0, 60),
              value: `note:${n.id}`,
            })),
          },
        };
      },
    },
  ];

  const byId = new Map(tools.map((t) => [t.id, t]));
  return {
    tools,
    getTool<I = unknown, O = unknown>(id: string) {
      return byId.get(id) as ToolDescriptor<I, O> | undefined;
    },
    async close() {
      pendingAddNoteAttachments = [];
    },
  };
}
