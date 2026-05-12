import { weeklyDigestJob } from './jobs/weeklyDigest.js';
import { createNotesStore } from './notesStore.js';
import { createHealthRouter } from './routes/healthRouter.js';
import { createToolkit, type Toolkit } from './toolkit.js';
import type { PluginContext } from './types.js';

export const AGENT_ID = '@omadia/agent-reference-maximum' as const;

const DEFAULT_DIGEST_CRON = '0 8 * * MON';

export interface AgentHandle {
  readonly toolkit: Toolkit;
  close(): Promise<void>;
}

export async function activate(ctx: PluginContext): Promise<AgentHandle> {
  ctx.log('activating');

  if (!ctx.memory) {
    throw new Error(
      'agent-reference: ctx.memory accessor missing — manifest must declare permissions.memory',
    );
  }

  const notes = createNotesStore({ memory: ctx.memory, log: ctx.log });
  // OB-29-1 — pass subAgent (when present) into the toolkit so analyze_url
  // can delegate to seo-analyst. Manifest's permissions.subAgents.calls
  // governs whether ctx.subAgent is defined; the toolkit gracefully handles
  // both cases (undefined → permission-error result on call).
  // OB-29-2 — pass knowledgeGraph (when present) so add_note's extraction
  // pipeline can ingest Person/Topic-Entities into the personal-notes
  // namespace. Manifest's permissions.graph.entity_systems governs presence.
  // OB-29-3 — pass llm (when present) so smart_extract_entities can call
  // Haiku for ambiguous-note NER. Manifest's permissions.llm.models_allowed
  // governs presence; tool returns permission-error result when undefined.
  const toolkit = createToolkit({
    notes,
    log: ctx.log,
    subAgent: ctx.subAgent,
    knowledgeGraph: ctx.knowledgeGraph,
    llm: ctx.llm,
  });

  const disposeAddNote = ctx.tools.register(
    toolkit.specs.addNote,
    toolkit.handlers.addNote,
    {
      promptDoc:
        'Schreibt eine kurze Notiz in den Plugin-Memory-Scope. Nutzt die ' +
        'Smart-Card-Attachment-Pattern, um die gespeicherte Notiz inline ' +
        'als note-card im Channel zu rendern.',
      attachmentSink: () => toolkit.takeAddNoteAttachments(),
    },
  );

  // OB-29-1 — Sub-Agent-Delegation-Demo: analyze_url delegates to seo-analyst.
  const disposeAnalyzeUrl = ctx.tools.register(
    toolkit.specs.analyzeUrl,
    toolkit.handlers.analyzeUrl,
    {
      promptDoc:
        'OB-29-1 Sub-Agent-Delegations-Pattern. Delegiert eine SEO-Analyse ' +
        'einer URL an @omadia/agent-seo-analyst via ctx.subAgent.ask, ' +
        'persistiert die Antwort als Notiz und rendert sie als note-card.',
      attachmentSink: () => toolkit.takeAnalyzeUrlAttachments(),
    },
  );

  // OB-29-3 — LLM-Service-Demo: smart_extract_entities calls Haiku via
  // ctx.llm.complete. Manifest's permissions.llm.models_allowed governs
  // presence — without a whitelist the tool returns a permission-error result.
  const disposeSmartExtract = ctx.tools.register(
    toolkit.specs.smartExtractEntities,
    toolkit.handlers.smartExtractEntities,
    {
      promptDoc:
        'OB-29-3 LLM-Service-Pattern. Ruft Haiku via ctx.llm.complete für ' +
        'Entity-Extraction aus ambigen Notiz-Texten. Komplementär zur ' +
        'deterministischen Regex-Extraction in add_note.',
    },
  );

  // OB-29-4 — Tool-emitted pendingUserChoice. query_notes_by_person
  // emits `_pendingUserChoice` in the tool-result on ambiguity; the
  // Orchestrator short-circuits the turn and renders the Smart-Card.
  const disposeQueryNotes = ctx.tools.register(
    toolkit.specs.queryNotesByPerson,
    toolkit.handlers.queryNotesByPerson,
    {
      promptDoc:
        'OB-29-4 Tool-emittiertes-pendingUserChoice-Pattern. Sucht Notizen ' +
        'nach Personen-Substring. Bei mehreren Matches gibt das Tool ' +
        '`_pendingUserChoice` zurück — Orchestrator-Layer rendert eine ' +
        'Smart-Card statt zu raten.',
    },
  );

  const healthRouter = createHealthRouter({ notes });
  const disposeRoute = ctx.routes.register('/agents/reference', healthRouter);

  const disposeJob = ctx.jobs.register(
    {
      name: 'weekly-digest-programmatic',
      schedule: {
        cron: ctx.config.get<string>('digest_cron') ?? DEFAULT_DIGEST_CRON,
      },
      timeoutMs: 30_000,
      overlap: 'skip',
    },
    (signal) => weeklyDigestJob({ notes, signal, log: ctx.log }),
  );

  const disposeService = ctx.services.provide('referenceNotesQuery', {
    list: () => notes.list(),
  });

  ctx.log('ready');

  return {
    toolkit,
    async close() {
      ctx.log('deactivating');
      disposeAddNote();
      disposeAnalyzeUrl();
      disposeSmartExtract();
      disposeQueryNotes();
      disposeRoute();
      disposeJob();
      disposeService();
    },
  };
}

export default { AGENT_ID, activate };
