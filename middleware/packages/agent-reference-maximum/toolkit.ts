import { z } from 'zod';

import type {
  KnowledgeGraphAccessor,
  LlmAccessor,
  NativeToolAttachment,
  NativeToolSpec,
  SubAgentAccessor,
} from '@omadia/plugin-api';

import { buildNoteCardAttachment } from './attachments.js';
import { extractFromNote, extractWithLlm } from './extractor.js';
import type { NotesStore } from './notesStore.js';
import type { AddNoteResult } from './types.js';

const SEO_ANALYST_AGENT_ID = '@omadia/agent-seo-analyst';

/**
 * Sub-agent-tool shape, mirror of the seo-analyst-Toolkit contract that
 * `dynamicAgentRuntime.activate()` expects for `kind: agent` plugins.
 * The Reference-Plugin runs as kind:agent + is_reference_only:true:
 * `tools` is intentionally EMPTY in v1 because Reference exposes its tools
 * as top-level Orchestrator-tools via `ctx.tools.register` (see plugin.ts),
 * not as sub-agent-internal-tools. Shape-compliance is defensive — if
 * someone bypasses the is_reference_only guard (custom runtime, future
 * refactor), a clean "0 sub-agent-tools" result comes out instead of an
 * "undefined.map" crash.
 */
export interface ToolDescriptor<I, O> {
  readonly id: string;
  readonly description: string;
  readonly input: z.ZodType<I>;
  run(input: I): Promise<O>;
}

export interface Toolkit {
  readonly specs: {
    readonly addNote: NativeToolSpec;
    readonly analyzeUrl: NativeToolSpec;
    readonly smartExtractEntities: NativeToolSpec;
    readonly queryNotesByPerson: NativeToolSpec;
  };
  readonly handlers: {
    readonly addNote: (input: unknown) => Promise<string>;
    readonly analyzeUrl: (input: unknown) => Promise<string>;
    readonly smartExtractEntities: (input: unknown) => Promise<string>;
    readonly queryNotesByPerson: (input: unknown) => Promise<string>;
  };
  /** Sub-agent-tool array (seo-analyst-Pattern). Empty for Reference
   *  plugins — see the comment block above. */
  readonly tools: readonly ToolDescriptor<unknown, unknown>[];
  /** Sub-agent-tool lookup; always returns undefined for the Reference
   *  plugin (`tools` is empty). */
  getTool<I = unknown, O = unknown>(
    id: string,
  ): ToolDescriptor<I, O> | undefined;
  /** Toolkit-close-hook. No-op for Reference; actual cleanup
   *  happens in plugin.ts's outer AgentHandle.close(). */
  close(): Promise<void>;
  takeAddNoteAttachments(): NativeToolAttachment[] | undefined;
  takeAnalyzeUrlAttachments(): NativeToolAttachment[] | undefined;
}

export interface ToolkitOptions {
  readonly notes: NotesStore;
  readonly log: (...args: unknown[]) => void;
  /** OB-29-1 — present when manifest declares permissions.subAgents.calls.
   *  When undefined, `analyze_url` returns a clear permission-error result
   *  instead of throwing, so the boilerplate-builder can still introspect
   *  the tool spec without an active sub-agent. */
  readonly subAgent?: SubAgentAccessor;
  /** OB-29-2 — present when manifest declares permissions.graph.entity_systems
   *  AND a knowledgeGraph provider is registered. When undefined, `add_note`
   *  skips the KG-ingest leg silently (the note is still written to memory).
   *  Lets the plugin run in environments without a KG (e.g. in unit tests
   *  with no provider). */
  readonly knowledgeGraph?: KnowledgeGraphAccessor;
  /** OB-29-3 — present when manifest declares permissions.llm.models_allowed
   *  AND host has 'llm' provider registered. When undefined,
   *  `smart_extract_entities` returns a permission-error result instead of
   *  throwing. */
  readonly llm?: LlmAccessor;
}

const addNoteInput = z
  .object({
    title: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(10_000),
  })
  .strict();

const analyzeUrlInput = z
  .object({
    url: z.string().url().max(2048),
  })
  .strict();

const addNoteSpec: NativeToolSpec = {
  name: 'add_note',
  description:
    'Speichert eine kurze Freiform-Notiz im Plugin-Memory-Scope. Liefert ' +
    'die noteId zurück und rendert eine note-card als Smart-Card-Attachment ' +
    'in den aktuellen Channel-Render-Buffer.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Optionaler Titel der Notiz.' },
      body: {
        type: 'string',
        description: 'Pflicht. Notiz-Inhalt als Markdown.',
      },
    },
    required: ['body'],
  },
};

const smartExtractInput = z
  .object({
    body: z.string().min(1).max(10_000),
  })
  .strict();

const queryNotesByPersonInput = z
  .object({
    personName: z.string().min(1).max(200),
  })
  .strict();

const queryNotesByPersonSpec: NativeToolSpec = {
  name: 'query_notes_by_person',
  description:
    'OB-29-4 Tool-emittiertes-pendingUserChoice-Demo: sucht Notizen, die ' +
    'einen Personen-Namen erwähnen (case-insensitive substring auf Body + ' +
    'Title). Bei Mehrdeutigkeit (≥2 Matches) emittiert das Tool ' +
    '`_pendingUserChoice` statt zu raten — der Orchestrator short-circuitet ' +
    'die Turn und rendert eine Smart-Card.',
  input_schema: {
    type: 'object',
    properties: {
      personName: {
        type: 'string',
        description: 'Pflicht. Name oder Substring der Person.',
      },
    },
    required: ['personName'],
  },
};

const smartExtractSpec: NativeToolSpec = {
  name: 'smart_extract_entities',
  description:
    'OB-29-3 LLM-Service-Demo: extrahiert Personen/Topics aus einer ' +
    'ambigen Notiz via Haiku (ctx.llm.complete). Komplementär zur ' +
    'deterministischen Regex-Extraction in add_note: löst Mehrdeutigkeit, ' +
    'die Regex nicht erkennen kann (z.B. "John hat das gut gemacht" ' +
    'ohne Person:-Prefix).',
  input_schema: {
    type: 'object',
    properties: {
      body: {
        type: 'string',
        description: 'Pflicht. Notiz-Text als Markdown.',
      },
    },
    required: ['body'],
  },
};

const analyzeUrlSpec: NativeToolSpec = {
  name: 'analyze_url',
  description:
    'OB-29-1 Sub-Agent-Delegations-Demo: delegiert die SEO-Analyse einer ' +
    `URL an ${SEO_ANALYST_AGENT_ID} via ctx.subAgent.ask, persistiert die ` +
    'Antwort als Notiz im Plugin-Memory-Scope. Demonstriert das ' +
    'cross-agent-delegation-Pattern.',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Pflicht. Vollständige URL (https://...).',
      },
    },
    required: ['url'],
  },
};

export function createToolkit(opts: ToolkitOptions): Toolkit {
  const { notes, log, subAgent, knowledgeGraph, llm } = opts;
  let pendingAddNoteAttachments: NativeToolAttachment[] = [];
  let pendingAnalyzeAttachments: NativeToolAttachment[] = [];

  return {
    // OB-29-5 Toolkit-Shape-Compliance: empty `tools` array satisfies the
    // dynamicAgentRuntime contract. close() + getTool() are defensive
    // no-ops — the Reference-Plugin is never activated as a sub-agent
    // anyway thanks to the is_reference_only skip; if someone bypasses
    // the skip, the plugin stays shape-compliant instead of crashing
    // with "undefined.map".
    tools: [] as const,
    getTool<I = unknown, O = unknown>(
      _id: string,
    ): ToolDescriptor<I, O> | undefined {
      return undefined;
    },
    async close(): Promise<void> {
      /* no-op — see Toolkit-Shape-Compliance comment */
    },
    specs: {
      addNote: addNoteSpec,
      analyzeUrl: analyzeUrlSpec,
      smartExtractEntities: smartExtractSpec,
      queryNotesByPerson: queryNotesByPersonSpec,
    },
    handlers: {
      async addNote(raw): Promise<string> {
        const parsed = addNoteInput.parse(raw);
        const record = await notes.add(parsed);
        pendingAddNoteAttachments.push(buildNoteCardAttachment(record));

        // OB-29-2 — extract Person/Topic-Entities from the note body and
        // persist them as PluginEntity-Nodes via ctx.knowledgeGraph.
        // Best-effort: KG errors do NOT break the add_note flow — the
        // note itself is already written to memory.
        let kgInsertedEntities = 0;
        if (knowledgeGraph) {
          try {
            const extraction = extractFromNote({
              body: parsed.body,
              noteId: record.id,
            });
            if (extraction.entities.length > 0) {
              const result = await knowledgeGraph.ingestEntities(
                extraction.entities.map((e) => ({
                  system: e.system,
                  model: e.model,
                  id: e.id,
                  displayName: e.displayName,
                })),
              );
              kgInsertedEntities =
                result.inserted + result.updated;
            }
          } catch (err) {
            log('add_note: kg ingest failed (non-fatal)', {
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const result: AddNoteResult = {
          noteId: record.id,
          createdAt: record.createdAt,
          kgInsertedEntities,
        };
        log('add_note ok', {
          noteId: record.id,
          kgInsertedEntities,
        });
        return JSON.stringify(result);
      },
      async analyzeUrl(raw): Promise<string> {
        const parsed = analyzeUrlInput.parse(raw);
        if (!subAgent) {
          log('analyze_url denied: no subAgent on ctx');
          return JSON.stringify({
            ok: false,
            error:
              'subAgent accessor unavailable — manifest needs permissions.subAgents.calls',
          });
        }
        log('analyze_url delegating to seo-analyst', { url: parsed.url });
        const question =
          `Analysiere ${parsed.url} aus SEO-Sicht und liste ` +
          'die wichtigsten 3 Issues mit konkretem Hinweis. Kurz halten.';
        let answer: string;
        try {
          answer = await subAgent.ask(SEO_ANALYST_AGENT_ID, question);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          log('analyze_url subAgent.ask failed', { err: message });
          return JSON.stringify({ ok: false, error: message });
        }
        const record = await notes.add({
          title: `SEO analysis: ${parsed.url}`,
          body: answer,
        });
        pendingAnalyzeAttachments.push(buildNoteCardAttachment(record));
        log('analyze_url ok', { noteId: record.id });
        return JSON.stringify({
          ok: true,
          noteId: record.id,
          delegateAgent: SEO_ANALYST_AGENT_ID,
        });
      },
      async queryNotesByPerson(raw): Promise<string> {
        const parsed = queryNotesByPersonInput.parse(raw);
        const needle = parsed.personName.toLowerCase();
        const allNotes = await notes.list();
        const matches = allNotes.filter((n) => {
          const body = n.body.toLowerCase();
          const title = (n.title ?? '').toLowerCase();
          return body.includes(needle) || title.includes(needle);
        });
        if (matches.length === 0) {
          log('query_notes_by_person no matches', { needle });
          return JSON.stringify({ ok: true, matches: [] });
        }
        if (matches.length === 1) {
          log('query_notes_by_person single match', { noteId: matches[0]!.id });
          return JSON.stringify({
            ok: true,
            matches: [
              { noteId: matches[0]!.id, title: matches[0]!.title },
            ],
          });
        }
        // Ambiguity → emit _pendingUserChoice. The Orchestrator
        // short-circuits the turn and renders a Smart-Card. Clicking
        // fires a new turn with the chosen value as userMessage.
        log('query_notes_by_person ambiguous → _pendingUserChoice', {
          count: matches.length,
        });
        return JSON.stringify({
          ok: true,
          _pendingUserChoice: {
            question: `${matches.length} Notizen erwähnen "${parsed.personName}". Welche meinst du?`,
            rationale:
              'Mehrere Treffer; bitte exakte Notiz auswählen, statt zu raten.',
            options: matches.slice(0, 6).map((n) => ({
              label: n.title ?? n.body.slice(0, 60),
              value: `note:${n.id}`,
            })),
          },
        });
      },
      async smartExtractEntities(raw): Promise<string> {
        const parsed = smartExtractInput.parse(raw);
        if (!llm) {
          log('smart_extract_entities denied: no llm on ctx');
          return JSON.stringify({
            ok: false,
            error:
              'llm accessor unavailable — manifest needs permissions.llm.models_allowed',
          });
        }
        // Pick the first allowed model (the manifest pins us to Haiku).
        // A more sophisticated plugin would inspect req-context to pick.
        const model = llm.modelsAllowed[0] ?? 'claude-haiku-4-5';
        try {
          const entities = await extractWithLlm({
            body: parsed.body,
            llm,
            model: model.endsWith('*')
              ? model.slice(0, -1) + '20251001'
              : model,
          });
          log('smart_extract_entities ok', { count: entities.length });
          return JSON.stringify({ ok: true, entities });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          log('smart_extract_entities llm.complete failed', { err: message });
          return JSON.stringify({ ok: false, error: message });
        }
      },
    },
    takeAddNoteAttachments() {
      if (pendingAddNoteAttachments.length === 0) return undefined;
      const out = pendingAddNoteAttachments;
      pendingAddNoteAttachments = [];
      return out;
    },
    takeAnalyzeUrlAttachments() {
      if (pendingAnalyzeAttachments.length === 0) return undefined;
      const out = pendingAnalyzeAttachments;
      pendingAnalyzeAttachments = [];
      return out;
    },
  };
}
