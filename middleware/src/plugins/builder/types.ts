/**
 * Shared type contracts for the Agent-Builder (Phase B.0).
 *
 * The full AgentSpec + ToolSpec + SlotMap Zod schemas land in Phase B.1; B.0
 * only needs a loose shape so drafts can be created with an empty skeleton.
 * Everything spec-related is persisted as JSON in SQLite — the runtime
 * parses/validates on load in later phases.
 */

export type DraftStatus = 'draft' | 'installed' | 'archived';

export type BuilderModelId = 'haiku' | 'sonnet' | 'opus';

export interface BuilderModel {
  id: BuilderModelId;
  label: string;
  anthropicModelId: string;
  maxTokens: number;
  /** Short hint shown under the dropdown option. */
  description: string;
}

/** Generic chat-transcript entry. Refined in B.4 with tool-use events. */
export interface TranscriptEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/**
 * Placeholder for the full AgentSpec (B.1). A freshly created draft gets an
 * empty skeleton with just the structural fields so the frontend can render
 * the live manifest pane without crashing on missing keys.
 */
export interface AgentSpecSkeleton {
  /** Template id from the boilerplate registry (e.g. `agent-integration`).
   *  Optional in the skeleton because legacy drafts predate the field;
   *  Zod parse fills the schema default. */
  template?: string;
  id: string;
  name: string;
  version: string;
  description: string;
  category: string;
  /** OB-77 (Palaia Phase 8) — first-class plugin Domain. Optional in the
   *  skeleton because legacy drafts predate the field; parseAgentSpec
   *  injects an `unknown.<id>` fallback at parse-time before the Zod
   *  schema enforces the regex. New drafts always carry a real domain. */
  domain?: string;
  depends_on: string[];
  tools: unknown[];
  skill: { role: string; tonality?: string };
  setup_fields: unknown[];
  playbook: {
    when_to_use: string;
    not_for: string[];
    example_prompts: string[];
  };
  network: { outbound: string[] };
  /** Theme A: declarative cross-integration data-pulls. Optional in the
   *  skeleton because legacy drafts predate the field; Zod parse fills
   *  the default `[]`. */
  external_reads?: unknown[];
  slots: Record<string, string | undefined>;
  /** Option-C, C-3: per-draft operator preferences not emitted to
   *  manifest.yaml. Optional in the skeleton because legacy drafts
   *  predate the field; readers must default to `false`. */
  builder_settings?: { auto_fix_enabled: boolean };
  /** B.11-6: Operator-promoted tool-test records. Nominal until B.10
   *  consumes them via the behavior-eval-runner; optional in the
   *  skeleton because legacy drafts predate the field. `input` and
   *  `expected` mirror the zod-inferred types — `z.unknown()` is
   *  optional in zod, so the fields stay optional here too. */
  test_cases?: Array<{
    toolId: string;
    description?: string;
    input?: unknown;
    expected?: unknown;
  }>;
  /** Phase-1 Kemia: optional response-quality block (sycophancy +
   *  boundary presets / custom lines). Mirrors `QualityConfig` from
   *  agentSpec.ts. Optional in the skeleton because legacy drafts
   *  predate the field; the runtime provider plugin falls back to its
   *  own configured defaults when omitted. */
  quality?: {
    sycophancy?: 'off' | 'low' | 'medium' | 'high';
    boundaries?: {
      presets?: string[];
      custom?: string[];
    };
  };
  /** Phase-3 Kemia (OB-67): optional persona block (template + 12 axes
   *  0–100 + free-text custom_notes). Mirrors `PersonaConfig` from
   *  agentSpec.ts. Optional in the skeleton because legacy drafts
   *  predate the field; Phase 4's `personaCompose@1` provider (conditional)
   *  is the eventual runtime consumer. Phase 3 only reads/writes the
   *  field via the Browser-View. */
  persona?: {
    template?: string;
    axes?: {
      formality?: number;
      directness?: number;
      warmth?: number;
      humor?: number;
      sarcasm?: number;
      conciseness?: number;
      proactivity?: number;
      autonomy?: number;
      risk_tolerance?: number;
      creativity?: number;
      drama?: number;
      philosophy?: number;
    };
    custom_notes?: string;
  };
}

export interface Draft {
  id: string;
  userEmail: string;
  name: string;
  spec: AgentSpecSkeleton;
  slots: Record<string, string>;
  transcript: TranscriptEntry[];
  previewTranscript: TranscriptEntry[];
  codegenModel: BuilderModelId;
  previewModel: BuilderModelId;
  status: DraftStatus;
  installedAgentId: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/** Row returned by the dashboard list — stripped of heavy JSON blobs. */
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

export function emptyAgentSpec(): AgentSpecSkeleton {
  return {
    id: '',
    name: '',
    version: '0.1.0',
    description: '',
    category: 'other',
    // OB-77 — placeholder, the Builder agent is required to elicit a real
    // domain via patch_spec before fill_slot runs. Validated on save via
    // PLUGIN_DOMAIN_REGEX.
    domain: '',
    depends_on: [],
    tools: [],
    skill: { role: '' },
    setup_fields: [],
    playbook: { when_to_use: '', not_for: [], example_prompts: [] },
    network: { outbound: [] },
    slots: {},
    builder_settings: { auto_fix_enabled: false },
  };
}
