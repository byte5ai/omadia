import type { Pool } from 'pg';
import {
  TRANSCRIPTION_MINUTES_QUOTA_CONFIG_KEY,
  type PluginContext,
} from '@omadia/plugin-api';
import {
  createAttachmentReader,
  toolUsage,
  turnContext,
  type AttachmentByteStore,
  type ChatAgentBundle,
  type OrchestratorRegistry,
} from '@omadia/orchestrator';
import {
  TRANSCRIPTION_METERING_SERVICE_NAME,
  type TranscriptionMeteringConfig,
  type TranscriptionService,
} from '@omadia/transcription-api';
import {
  flushTranscriptionUsage,
  recordTranscriptionUsage,
  sumTranscriptionBilledMinutesThisMonth,
} from '@omadia/usage-telemetry';

import type { TranscriptionUsageMeter } from './metering.js';
import {
  handleTranscribeRecording,
  transcribeRecordingToolSpec,
  type TranscriptArtifactStore,
  type TranscriptTurnLogger,
} from './transcribeRecordingTool.js';
import {
  createTranscriptionUploadRouter,
  type TranscriptionUploadStore,
} from './uploadRouter.js';

/**
 * @omadia/plugin-transcription — audio ingestion for the `transcription@1`
 * capability (#584, Workstream I).
 *
 * Two surfaces, one package (core stays untouched, ADR-0003 spirit):
 * - the operator-only multipart upload endpoint under `/transcriptions`
 *   (`uploadRouter.ts`), and
 * - the explicit `transcribe_recording` native tool
 *   (`transcribeRecordingTool.ts`) — Transcript Artifact, chunk projection
 *   and privacy wiring included. No auto-transcription anywhere.
 *
 * Every kernel service (blob store, transcription provider, session logger)
 * is resolved LAZILY (per request / per tool call), never captured at
 * activate(): activation order is not guaranteed, providers (de)register at
 * runtime, and this plugin must degrade instead of failing activation on a
 * storage- or provider-less install.
 */

const TRANSCRIBE_PROMPT_DOC = `\`transcribe_recording\`: Wandelt eine hochgeladene Audio-Aufnahme (Meeting, Sprachnotiz) in ein Transkript um und macht den Inhalt als Session-Wissen recallbar. Nutze es, wenn der User den Inhalt einer Audio-Datei will (Protokoll, Zusammenfassung, "was wurde gesagt") — der \`storage_key\` steht im [attachments-info]-Block des Turns. Es gibt KEINE automatische Transkription: dieses Tool ist der einzige Weg von Audio zu Text. Nennt der User den Aufnahmezeitpunkt, gib ihn als \`recording_start\` (ISO 8601) mit. Das Tool ist idempotent pro Aufnahme; nach dem Aufruf ist das Transkript im Scope \`transcript-<recordingId>\` recallbar.`;

export interface TranscriptionPluginHandle {
  close(): Promise<void>;
}

/**
 * The session logger of the Agent running the current turn (multi-orch
 * registry, keyed by the turn's agent slug), falling back to the default
 * `chatAgent` bundle — the same logger the orchestrator itself writes turns
 * through, so the chunk projection lands agent-qualified in the graph.
 */
function resolveSessionLogger(ctx: PluginContext): TranscriptTurnLogger | undefined {
  const slug = turnContext.current()?.agentSlug;
  if (slug !== undefined) {
    const registry = ctx.services.get<OrchestratorRegistry>('orchestratorRegistry');
    const logger = registry?.get(slug)?.built.bundle.sessionLogger;
    if (logger) return logger;
  }
  return ctx.services.get<ChatAgentBundle>('chatAgent')?.sessionLogger;
}

/**
 * #584 — the usage-ledger seam. `record` closes over the owning agent id
 * (`ctx.agentId` — the dimension the quota is keyed on) and the current
 * turn; it delegates to the fire-and-forget recorder, which drops rows
 * without a pool (in-memory KG ⇒ quota structurally unenforced, warned once
 * there). The month sum resolves `graphPool` lazily per call: `undefined`
 * pool = no metering store (quota unenforceable, not an error), while a DB
 * error propagates so the tool can fail OPEN with its audit warning.
 */
function buildUsageMeter(ctx: PluginContext): TranscriptionUsageMeter {
  return {
    record(row): void {
      recordTranscriptionUsage({
        ...row,
        agentId: ctx.agentId,
        turnId: turnContext.currentTurnId(),
      });
    },
    async sumBilledMinutesThisMonth(): Promise<number | undefined> {
      const pool = ctx.services.get<Pool>('graphPool');
      if (!pool) return undefined;
      // Drain the recorder buffer first: without this, calls landing inside
      // one flush window (≤5 s) would each read a stale sum and the spec's
      // "overshoot bounded by one duration-cap length" would silently become
      // N × cap. A flush failure is swallowed by the recorder (fire-and-
      // forget) — the sum then simply reads the committed state, which is
      // the same level-trigger tolerance the dev-job budget accepts.
      await flushTranscriptionUsage();
      return sumTranscriptionBilledMinutesThisMonth(pool, ctx.agentId);
    },
  };
}

/**
 * #584 — the agent's `_transcription_minutes_quota` (kernel-injected
 * synthetic install field, `installService`). Read live per call so an
 * operator edit takes effect on the next dispatch. Empty/absent/non-numeric
 * = unlimited (`undefined`); the field is an integer ≥ 0 — an explicit 0
 * blocks every call.
 */
function readQuotaMinutes(ctx: PluginContext): number | undefined {
  const raw = ctx.config.get<unknown>(TRANSCRIPTION_MINUTES_QUOTA_CONFIG_KEY);
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export async function activate(
  ctx: PluginContext,
): Promise<TranscriptionPluginHandle> {
  ctx.log('activating transcription ingestion plugin');

  const router = createTranscriptionUploadRouter({
    operatorAuth: ctx.operatorAuth,
    getStore: () => ctx.services.get<TranscriptionUploadStore>('tigrisStore'),
    log: (msg) => ctx.log(msg),
  });
  const disposeRoute = ctx.routes.register('/transcriptions', router);

  const disposeTool = ctx.tools.register(
    transcribeRecordingToolSpec,
    (input) =>
      handleTranscribeRecording(input, {
        getTranscription: () =>
          ctx.services.get<TranscriptionService>('transcription'),
        getArtifactStore: () =>
          ctx.services.get<TranscriptArtifactStore>('tigrisStore'),
        getRecordingReader: () =>
          createAttachmentReader(
            ctx.services.get<AttachmentByteStore>('tigrisStore'),
          ),
        getSessionLogger: () => resolveSessionLogger(ctx),
        currentUploader: () => {
          const turn = turnContext.current();
          if (!turn) return undefined;
          return {
            ...(turn.userId !== undefined ? { userId: turn.userId } : {}),
            ...(turn.resolvedOmadiaUserId !== undefined
              ? { omadiaUserId: turn.resolvedOmadiaUserId }
              : {}),
          };
        },
        getMeteringConfig: () =>
          ctx.services.get<TranscriptionMeteringConfig>(
            TRANSCRIPTION_METERING_SERVICE_NAME,
          ),
        getUsageMeter: () => buildUsageMeter(ctx),
        getQuotaMinutes: () => readQuotaMinutes(ctx),
        // Trace visibility (#584): the orchestrator opens a per-dispatch
        // capture scope; outside one this is a no-op and only the trace
        // field is lost — the ledger row above stays authoritative.
        reportUsage: (usage) => toolUsage.report(usage),
        log: (msg) => ctx.log(msg),
      }),
    { promptDoc: TRANSCRIBE_PROMPT_DOC },
  );

  ctx.log(
    `[transcription] upload endpoint mounted at /transcriptions (operatorAuth=${
      ctx.operatorAuth ? 'wired' : 'MISSING — serving 503 fail-closed'
    }), transcribe_recording tool registered`,
  );

  return {
    async close(): Promise<void> {
      ctx.log('deactivating transcription ingestion plugin');
      disposeTool();
      disposeRoute();
    },
  };
}
