// -----------------------------------------------------------------------------
// Agent-Builder types. Mirrors middleware/src/plugins/builder/types.ts +
// middleware/src/routes/builder*.ts response shapes.
// Keep in sync manually until the admin API gets a shared type package.
// -----------------------------------------------------------------------------

import type { PersonaConfig } from './personaTypes';

export type DraftStatus = 'draft' | 'installed' | 'archived';

/** Phase-1 Kemia. TS-mirror of middleware QualityConfigSchema. */
export type SycophancyLevel = 'off' | 'low' | 'medium' | 'high';

export interface QualityConfig {
  sycophancy?: SycophancyLevel;
  boundaries?: {
    presets?: string[];
    custom?: string[];
  };
}

export type BuilderModelId = 'haiku' | 'sonnet' | 'opus';

export interface BuilderModelInfo {
  id: BuilderModelId;
  label: string;
  description: string;
  max_tokens: number;
}

export interface ListBuilderModelsResponse {
  models: BuilderModelInfo[];
  default: BuilderModelId;
}

export interface DraftQuotaSnapshot {
  used: number;
  cap: number;
  warnAt: number;
  remaining: number;
  warning: boolean;
  exceeded: boolean;
}

export interface DraftSummary {
  id: string;
  name: string;
  status: DraftStatus;
  codegenModel: BuilderModelId;
  previewModel: BuilderModelId;
  installedAgentId: string | null;
  updatedAt: number;
  createdAt: number;
}

export interface ListDraftsResponse {
  items: DraftSummary[];
  quota: DraftQuotaSnapshot;
}

// -----------------------------------------------------------------------------
// AgentSpec — mirror of middleware/src/plugins/builder/agentSpec.ts +
// the loose-skeleton fallback in types.ts (a fresh draft has the structural
// fields populated with empty defaults so the frontend can render every pane
// without crashing on missing keys).
// -----------------------------------------------------------------------------

export interface ToolSpec {
  id: string;
  description: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

/** B.11-6: Mirror of middleware TestCaseSchema. Nominal until B.10's
 *  behavior-eval-runner consumes them. Created via
 *  ToolTestModal → "Save as test case". */
export interface ToolTestCase {
  toolId: string;
  description?: string;
  input: unknown;
  expected: unknown;
}

export interface SetupField {
  key: string;
  label?: string;
  description?: string;
  type?: 'string' | 'secret' | 'url' | 'number' | 'boolean';
  required?: boolean;
}

export interface AgentSpecSkeleton {
  template?: string;
  id: string;
  name: string;
  version: string;
  description: string;
  category: string;
  /** OB-77 (Palaia Phase 8) — first-class plugin Domain. Required at the
   *  manifest level; the spec form surfaces it next to category. Same
   *  PLUGIN_DOMAIN_REGEX validation as middleware. */
  domain: string;
  depends_on: string[];
  tools: ToolSpec[];
  skill: { role: string; tonality?: string };
  setup_fields: SetupField[];
  playbook: {
    when_to_use: string;
    not_for: string[];
    example_prompts: string[];
  };
  network: { outbound: string[] };
  slots: Record<string, string | undefined>;
  /** Option-C, C-3: per-draft operator preferences. Optional in the
   *  type because legacy drafts predate the field; readers default the
   *  flags to `false`. Mirrors middleware AgentSpecSkeleton. */
  builder_settings?: { auto_fix_enabled: boolean };
  /** B.11-6: Operator-promoted tool-test records. */
  test_cases?: ToolTestCase[];
  /** Phase-1 Kemia: optional response-quality block (sycophancy +
   *  boundary presets / custom lines). Mirrors middleware
   *  QualityConfigSchema. */
  quality?: QualityConfig;
  /** Phase-3 Kemia (OB-67): optional persona block (template + 12 axes
   *  0–100 + custom_notes). Mirrors middleware PersonaConfigSchema —
   *  see personaTypes.ts for the canonical TS-shape used by the
   *  Browser-View. */
  persona?: PersonaConfig;
}

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface Draft extends DraftSummary {
  userEmail: string;
  spec: AgentSpecSkeleton;
  slots: Record<string, string>;
  transcript: TranscriptEntry[];
  previewTranscript: TranscriptEntry[];
  deletedAt: number | null;
}

export interface DraftEnvelope {
  draft: Draft;
}

export type DraftListScope = 'active' | 'all' | 'deleted';

// -----------------------------------------------------------------------------
// JSON-Patch + SpecEventBus shapes (B.4 backend contract). The Workspace
// subscribes to these via the SSE event stream (B.5-4) to drive multi-tab
// sync of agent + user mutations.
// -----------------------------------------------------------------------------

export type JsonPatch =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'remove'; path: string };

export type SpecBusCause = 'agent' | 'user';

export type SpecBusEvent =
  | { type: 'spec_patch'; patches: JsonPatch[]; cause: SpecBusCause }
  | { type: 'slot_patch'; slotKey: string; source: string; cause: SpecBusCause }
  | {
      type: 'lint_result';
      issues: ReadonlyArray<unknown>;
      cause: SpecBusCause;
    }
  | {
      type: 'build_status';
      phase: 'building' | 'ok' | 'failed';
      buildN?: number;
      reason?: string;
      errorCount?: number;
      /** Structured tsc errors (per-file, per-line) — used by the Slot
       *  editor to hang Monaco markers on the exact source lines. Mirrors
       *  the BuildErrorRow shape so the Preview-pane and the Slot-editor
       *  consume the same record. */
      errors?: ReadonlyArray<BuildErrorRow>;
    }
  | {
      /**
       * B.7-6: Builder-Agent could not fix a slot after 3 retries within
       * one turn. The PreviewChatPane hangs an orange banner asking the
       * operator to inspect the slot manually. Auto-clears on next
       * successful slot_patch for the same slotKey or at next turn start.
       */
      type: 'agent_stuck';
      slotKey: string;
      attempts: number;
      lastReason: string;
      lastSummary: string;
      lastErrorCount: number;
    }
  | {
      /**
       * B.9-3: Runtime-smoke status surfaced after every successful
       * preview build. Fires asynchronously — `running` immediately
       * after build_status:ok, then `ok` / `failed` once each tool was
       * invoked with a synthetic input.
       */
      type: 'runtime_smoke_status';
      phase: 'running' | 'ok' | 'failed';
      buildN: number;
      reason?: 'ok' | 'activate_failed' | 'tool_failures' | 'no_tools';
      activateError?: string;
      results?: ReadonlyArray<{
        toolId: string;
        status: 'ok' | 'timeout' | 'threw' | 'validation_failed';
        durationMs: number;
        errorMessage?: string;
      }>;
    }
  | {
      /**
       * Option-C, C-4: AutoFixOrchestrator lifecycle frame.
       * `triggered` — backend just fired a synthetic Builder turn.
       * `stopped_loop` — same fingerprint hit `MAX_IDENTICAL_ATTEMPTS`
       *                  consecutive auto-attempts; toggle was flipped
       *                  back to off; operator needs to step in.
       */
      type: 'auto_fix_status';
      phase: 'triggered' | 'stopped_loop';
      kind: 'build_failed' | 'smoke_failed';
      buildN: number;
      identicalCount?: number;
    };

// -----------------------------------------------------------------------------
// Install-Commit response — POST /drafts/:id/install (B.6-1).
// Mirror of middleware/src/plugins/builder/installCommit.ts InstallResult.
// On HTTP 200 the body is InstallSuccess; on 4xx/5xx the body is
// InstallFailure with `reason` matching the orchestrator's discriminator.
// -----------------------------------------------------------------------------

export interface InstallSuccess {
  ok: true;
  installedAgentId: string;
  version: string;
  packageBytes: number;
}

export type InstallFailureReason =
  | 'draft_not_found'
  | 'spec_invalid'
  | 'codegen_failed'
  | 'pipeline_failed'
  | 'build_failed'
  | 'conflict'
  | 'too_large'
  | 'manifest_invalid'
  | 'ingest_failed';

export interface InstallFailure {
  ok: false;
  reason: InstallFailureReason;
  code: string;
  message: string;
  details?: unknown;
}

export type InstallResponse = InstallSuccess | InstallFailure;

// -----------------------------------------------------------------------------
// Boilerplate types — GET /drafts/:id/types (B.6-11).
// Each `lib.path` is a virtual filesystem path Monaco's `addExtraLib` uses
// to anchor the lib so import resolution + Cmd+Click work.
// -----------------------------------------------------------------------------

export interface BuilderLib {
  path: string;
  content: string;
}

export interface DraftLibsResponse {
  template: string;
  libs: BuilderLib[];
}

// -----------------------------------------------------------------------------
// Template list — GET /drafts/templates (B.6-9).
// -----------------------------------------------------------------------------

export interface BuilderTemplateInfo {
  id: string;
  description: string;
}

export interface ListBuilderTemplatesResponse {
  templates: BuilderTemplateInfo[];
}

// -----------------------------------------------------------------------------
// Edit-from-Store response — POST /drafts/from-installed/:agentId (B.6-3).
// Mirror of middleware/src/plugins/builder/cloneFromInstalled.ts CloneResult.
// -----------------------------------------------------------------------------

export interface CloneFromInstalledSuccess {
  ok: true;
  draftId: string;
  sourceDraftId: string;
  installedAgentId: string;
}

export type CloneFromInstalledFailureReason =
  | 'source_not_found'
  | 'quota_exceeded';

export interface CloneFromInstalledFailure {
  ok: false;
  reason: CloneFromInstalledFailureReason;
  code: string;
  message: string;
  details?: unknown;
}

export type CloneFromInstalledResponse =
  | CloneFromInstalledSuccess
  | CloneFromInstalledFailure;

// -----------------------------------------------------------------------------
// BuilderEvent — NDJSON wire format from POST /drafts/:id/turn (B.4-3).
// Mirror of middleware/src/plugins/builder/builderAgent.ts BuilderEvent.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// PreviewStreamEvent — NDJSON wire format from POST /drafts/:id/preview/chat/turn
// (B.3-4). Mirrors middleware/src/routes/builderPreview.ts PreviewStreamEvent
// (PreviewChatEvent ∪ build_status ∪ error).
// -----------------------------------------------------------------------------

export interface BuildErrorRow {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

export interface CodegenIssueRow {
  code: string;
  detail: string;
}

export interface TemplateSlotDef {
  key: string;
  target_file: string;
  required: boolean;
  description?: string;
}

export interface TemplateSlotsResponse {
  template: string;
  slots: TemplateSlotDef[];
}

export type PreviewStreamEvent =
  | { type: 'chat_message'; role: 'user' | 'assistant'; text: string }
  | { type: 'tool_use'; useId: string; toolId: string; input: unknown }
  | {
      type: 'tool_result';
      useId: string;
      toolId: string;
      output: string;
      isError: boolean;
      durationMs: number;
    }
  | { type: 'turn_done'; turnId: string }
  | {
      type: 'build_status';
      phase: 'building' | 'ok' | 'failed';
      buildN?: number;
      reason?: string;
      errors?: ReadonlyArray<BuildErrorRow>;
      codegenIssues?: ReadonlyArray<CodegenIssueRow>;
    }
  | { type: 'error'; code: string; message: string };

export type BuilderTurnEvent = (
  | { type: 'turn_started'; turnId: string }
  | { type: 'chat_message'; role: 'user' | 'assistant'; text: string }
  | { type: 'tool_use'; useId: string; toolId: string; input: unknown }
  | {
      type: 'tool_result';
      useId: string;
      toolId: string;
      output: string;
      isError: boolean;
      durationMs: number;
    }
  | { type: 'spec_patch'; patches: JsonPatch[]; cause: SpecBusCause }
  | { type: 'slot_patch'; slotKey: string; source: string; cause: SpecBusCause }
  | {
      type: 'lint_result';
      issues: ReadonlyArray<unknown>;
      cause: SpecBusCause;
    }
  | {
      /**
       * Theme E0 — liveness pulse during an in-flight Builder turn. Emitted
       * every 2s by the middleware while the LLM stream is silent. Carries
       * no id (raw, never stamped) so it does not advance the resume
       * cursor — `streamBuilderTurn` only updates lastId when ev.id is a
       * number.
       *
       * Theme E1 — `phase` and `tokensStreamedThisIter` are populated once
       * the LocalSubAgent observer fires its first phase/token-chunk
       * callback. They stay optional so existing E0 fixtures and any
       * pre-E1 ring-buffer replays remain valid. Keep in lockstep with
       * the middleware-side BuilderEvent in builderAgent.ts.
       */
      type: 'heartbeat';
      sinceLastActivityMs: number;
      currentIteration: number;
      toolCallsThisIter: number;
      phase?: 'thinking' | 'streaming' | 'tool_running' | 'idle';
      tokensStreamedThisIter?: number;
    }
  | {
      /**
       * Theme E1 — live token-stream pulse, one per text/tool-input delta
       * the model emits. `tokensPerSec` is computed on a trailing 500ms
       * window in the middleware. Mirror of BuilderEvent.stream_token_chunk
       * in builderAgent.ts.
       */
      type: 'stream_token_chunk';
      iteration: number;
      deltaTokens: number;
      cumulativeOutputTokens: number;
      tokensPerSec: number;
    }
  | {
      /**
       * Theme E1 — authoritative usage block read off stream.finalMessage()
       * at iteration end. Carries cache_read/creation token counts so the
       * UI can render a 🟢 cache-hit indicator. Mirror of
       * BuilderEvent.iteration_usage in builderAgent.ts.
       */
      type: 'iteration_usage';
      iteration: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    }
  | {
      /**
       * OB-31 — per-iteration stop diagnostics. Carries the raw `stop_reason`
       * plus tool_use count + assistant-text length. The Frontend uses this
       * to detect "promise without delivery" (stop_reason: end_turn,
       * toolUseCount: 0 after a Build-Ankündigung) and surface a banner.
       * Mirror of BuilderEvent.iteration_finished in builderAgent.ts.
       */
      type: 'iteration_finished';
      iteration: number;
      stopReason: string;
      toolUseCount: number;
      textLength: number;
    }
  | { type: 'turn_done'; turnId: string }
  | { type: 'error'; code: string; message: string }
) & {
  /**
   * Monotonic per-turn frame id assigned by the route in `framePayload(...)`.
   * Always present on the wire; declared optional only so test fixtures
   * that hand-roll events without ids type-check.
   */
  id?: number;
};
