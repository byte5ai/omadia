/**
 * Shared type contracts for the Agent-Builder (Phase B.0).
 *
 * The full AgentSpec + ToolSpec + SlotMap Zod schemas land in Phase B.1; B.0
 * only needs a loose shape so drafts can be created with an empty skeleton.
 * Everything spec-related is persisted as JSON in SQLite — the runtime
 * parses/validates on load in later phases.
 */

export type DraftStatus = 'draft' | 'published' | 'archived';

export type BuilderModelId = string;

export interface BuilderModel {
  id: BuilderModelId;
  label: string;
  provider: string;
  modelId: string;
  modelClass: string;
  vision: boolean;
  maxTokens: number;
  description: string;
  aliases: readonly string[];
  /** #1033 — effort levels the model honours; absent = no effort knob. */
  effortLevels?: readonly string[];
  effortDefault?: string;
}

/** Generic chat-transcript entry. Refined in B.4 with tool-use events. */
export interface TranscriptEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  status?: 'declined';
}

/**
 * Placeholder for the full AgentSpec (B.1). A freshly created draft gets an
 * empty skeleton with just the structural fields so the frontend can render
 * the live manifest pane without crashing on missing keys.
 */
export interface AgentSpecSkeleton {
  /** Template id from the boilerplate registry (`integration` | `tool`;
   *  drafts stored before carry `agent-integration` / `agent-pure-llm`,
   *  read as aliases). Optional in the skeleton because legacy drafts
   *  predate the field; Zod parse fills the schema default. */
  template?: string;
  /** Manifest kind of the generated capability plugin. Absent = derived
   *  from the spec (`effectivePluginKind` in agentSpec.ts). */
  kind?: 'integration' | 'tool';
  id: string;
  name: string;
  version: string;
  description: string;
  category: string;
  /** #225 — operator-entered author/publisher. Optional in the skeleton
   *  because legacy drafts predate the field; Zod parse fills the default
   *  ''. Codegen maps it to `identity.authors[0].name` (AGENT_AUTHOR
   *  placeholder); empty → no author rendered on the store-detail page. */
  author?: string;
  /** OB-77 (Palaia Phase 8) — first-class plugin Domain. Optional in the
   *  skeleton because legacy drafts predate the field; parseAgentSpec
   *  injects an `unknown.<id>` fallback at parse-time before the Zod
   *  schema enforces the regex. New drafts always carry a real domain. */
  domain?: string;
  depends_on: string[];
  tools: unknown[];
  setup_fields: unknown[];
  /** Spec 005 (#371) — OAuth-provider descriptors (shape: `OAuthProvider` from
   *  agentSpec.ts). Optional in the skeleton because legacy drafts predate the
   *  field; Zod parse fills the default `[]`. */
  oauth_providers?: unknown[];
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
  /** B.12: declarative UI-Routes (Dashboard-Tabs). Optional in the
   *  skeleton because legacy drafts predate the field; Zod parse fills
   *  the default `[]`. Shape is `UiRoute` from uiRouteSchema.ts. */
  ui_routes?: unknown[];
  slots: Record<string, string | undefined>;
  /** Option-C, C-3: per-draft operator preferences not emitted to
   *  manifest.yaml. Optional in the skeleton because legacy drafts
   *  predate the field; readers must default to `false`. */
  builder_settings?: {
    auto_fix_enabled: boolean;
    /** Native issue-reporting (concept plan): immutable identity of every
     *  Workaround the draft acquired during build. Operational lifecycle
     *  state (`active`/`resolved`, `resolvedAt`, …) lives in the separate
     *  `agent_workaround_state` table so re-installing the same spec keeps
     *  the lifecycle. Persisted on install via installCommit and propagated
     *  into the generated agent manifest. */
    workarounds?: Workaround[];
    /** Native issue-reporting: when the operator chose `report_pause`,
     *  this field blocks the builder loop until the referenced issue is
     *  closed and the operator confirms resume via the
     *  resume-from-issue route. */
    paused_on_issue?: PausedOnIssue;
  };
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
  /** Multi-orchestrator runtime (US2) — manifest extension. Defaults are
   *  filled by the Zod parser (`multi_instance: true`, `privacy_class:
   *  'strict'`); codegen writes them into the generated `manifest.yaml`. */
  multi_instance?: boolean;
  multi_instance_justification?: string;
  privacy_class?: 'strict' | 'default';
}

/**
 * Native issue-reporting: reference to a GitHub issue we tracked as the
 * trigger for either a workaround or a pause. URL is precomputed by the
 * report tool so the UI does not need to re-derive it.
 */
export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

/**
 * Immutable workaround identity persisted in the spec. Operational
 * lifecycle (status, resolved_at, …) lives in `agent_workaround_state`.
 */
export interface Workaround {
  /** ULID/UUID generated when the workaround was first applied. */
  id: string;
  issueRef: IssueRef;
  /** Stacktrace-hash + error-code, also embedded in the issue body as
   *  `<!-- omadia-fingerprint: <hash> -->` so we can dedupe and validate
   *  operator-supplied issue numbers in browser-submit mode. */
  fingerprint: string;
  /** One- or two-sentence operator-facing summary of what the workaround
   *  does, generated by the builder agent. */
  summary: string;
  /** ms-epoch when the workaround was first applied. */
  createdAt: number;
}

/**
 * Native issue-reporting: pause-on-issue marker. Builder loop checks for
 * presence before queueing a new turn; the resume-from-issue route clears
 * the field and appends a synthetic resume-context turn.
 */
export interface PausedOnIssue {
  issueRef: IssueRef;
  fingerprint: string;
  pausedAt: number;
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
  publishedAgentId: string | null;
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
  publishedAgentId: string | null;
  updatedAt: number;
  createdAt: number;
}

export function emptyAgentSpec(): AgentSpecSkeleton {
  return {
    // A blank draft has no external system. The Builder chooses the
    // integration template when the operator's request calls for a client.
    template: 'tool',
    id: '',
    name: '',
    version: '0.1.0',
    description: '',
    // #225 — empty until the operator sets an author; replaces the old
    // hardcoded "byte5 GmbH" boilerplate attribution.
    author: '',
    category: 'other',
    // OB-77 — placeholder, the Builder agent is required to elicit a real
    // domain via patch_spec before fill_slot runs. Validated on save via
    // PLUGIN_DOMAIN_REGEX.
    domain: '',
    depends_on: [],
    tools: [],
    setup_fields: [],
    playbook: { when_to_use: '', not_for: [], example_prompts: [] },
    network: { outbound: [] },
    slots: {},
    builder_settings: { auto_fix_enabled: false },
    multi_instance: true,
    privacy_class: 'strict',
  };
}
