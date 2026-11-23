import { weeklyDigestJob } from './jobs/weeklyDigest.js';
import { createNotesStore } from './notesStore.js';
import { registerToolkit } from './registerTools.js';
import { createHealthRouter } from './routes/healthRouter.js';
import { createUiRouter } from './routes/uiRouter.js';
import { createToolkit } from './toolkit.js';
import type { NoteRecord, PluginContext } from './types.js';

export const PLUGIN_ID = '@omadia/agent-reference-maximum' as const;

const DEFAULT_DIGEST_CRON = '0 8 * * MON';
const NOTIFICATION_PREVIEW_CHARS = 140;

/**
 * Capability plugin of kind `integration` (spec 2042 §5.10, ADR-0014) and
 * the Plugin Builder's pattern source (`is_reference_only: true`).
 *
 * Runtime contract (tool runtime), the same as the Builder boilerplates:
 *   - every toolkit tool is registered via `ctx.tools.register`
 *     (`registerTools.ts`); the kernel offers the tools to the agents the
 *     operator granted this plugin to;
 *   - the plugin has no persona, no system prompt and no model loop of its
 *     own — the former persona ships as agent templates in manifest.yaml;
 *   - every register()/provide() disposer is called in `close()`.
 */
export interface PluginHandle {
  close(): Promise<void>;
}

export async function activate(ctx: PluginContext): Promise<PluginHandle> {
  ctx.log('activating');

  if (!ctx.memory) {
    throw new Error(
      'agent-reference: ctx.memory accessor missing — manifest must declare permissions.memory',
    );
  }

  const notes = createNotesStore({ memory: ctx.memory, log: ctx.log });

  // Cross-channel notification after a note was stored. Fire-and-forget:
  // delivery must never block (or fail) the tool result.
  const onNoteAdded = (record: NoteRecord): void => {
    const bodyPreview =
      record.body.length > NOTIFICATION_PREVIEW_CHARS
        ? `${record.body.slice(0, NOTIFICATION_PREVIEW_CHARS)}…`
        : record.body;
    ctx.notifications
      .send({
        title: 'Note added',
        body: bodyPreview,
        deepLink: '/p/agent-reference-maximum/dashboard',
      })
      .catch((err: unknown) => {
        ctx.log('notify failed:', err instanceof Error ? err.message : String(err));
      });
  };

  // OB-29-2 — knowledgeGraph (when present) lets add_note ingest Person/Topic
  // entities into the personal-notes namespace; permissions.graph.entity_systems
  // governs presence. OB-29-3 — llm (when present) lets smart_extract_entities
  // call Haiku; permissions.llm.models_allowed governs presence.
  const toolkit = createToolkit({
    notes,
    log: ctx.log,
    onNoteAdded,
    knowledgeGraph: ctx.knowledgeGraph,
    llm: ctx.llm,
  });

  // Every toolkit tool goes to the kernel's tool runtime.
  const disposeTools = registerToolkit(ctx, toolkit);

  const healthRouter = createHealthRouter({ notes });
  const disposeRoute = ctx.routes.register('/agents/reference', healthRouter);

  const uiRouter = createUiRouter({ notes });
  const disposeUi = ctx.routes.register('/p/agent-reference-maximum', uiRouter);
  const disposeUiDescriptor = ctx.uiRoutes.register({
    routeId: 'dashboard',
    path: '/dashboard',
    title: 'Reference — Dashboard',
    description:
      'Pattern-Source-Plugin: live notes counter + recent-notes list. Self-refreshes every 30 s.',
    order: 50,
  });

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
    async close() {
      ctx.log('deactivating');
      disposeTools();
      disposeRoute();
      disposeUi();
      disposeUiDescriptor();
      disposeJob();
      disposeService();
      await toolkit.close();
    },
  };
}

export default { PLUGIN_ID, activate };
