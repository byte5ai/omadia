/**
 * `processMemory@1` — capability contract for structured workflows.
 *
 * Phase 7 of the Palaia integration (OB-76). The Orchestrator gets four
 * native tools (`write_process`, `edit_process`, `query_processes`,
 * `run_stored_process`) that run against this service surface. The goal
 * is for agents to learn workflows ONCE, find + execute them — instead
 * of re-deriving them from the turn stream every time.
 *
 * HARD INVARIANTS (see HANDOFF-2026-05-08-palaia-phase-7):
 * 1. **Naming convention enforced**: title matches `/^[A-Z][^:]+: .+/`
 *    (e.g. `"Backend: Deploy to staging"`). Validated server-side.
 * 2. **Dedup-First-Write is a HARD BLOCK**: at cosine-similarity ≥ 0.9
 *    against an existing process in the tenant the service rejects and
 *    returns `{ ok: false, reason: 'duplicate', conflictingId }`.
 * 3. **Versioning via history table**: `edit` snapshots the old state
 *    BEFORE UPDATE; `version` monotonically increases per id.
 * 4. **`id` is deterministic**: `process:<scope>:<slugify(title)>` —
 *    stable across edits (title changes do not change the ID; only the
 *    embedding/title column).
 * 5. **Embedding mandatory for dedup**: providers WITHOUT an EmbeddingClient
 *    reject `write` with `{ ok: false, reason: 'embedding-unavailable' }`.
 *    No silent bypass.
 *
 * Provider: `harness-knowledge-graph-neon` (durable, tenant-scoped).
 * A `NoopProcessMemoryService` implementation lives alongside — backends
 * without a persistent layer (in-memory-KG) can publish it so consumers
 * do not need a special-case branch.
 */

export const PROCESS_MEMORY_SERVICE_NAME = 'processMemory';
export const PROCESS_MEMORY_CAPABILITY = 'processMemory@1';

/** Naming-Convention regex — exported so the tool layer can use the same source. */
export const PROCESS_TITLE_REGEX = /^[A-Z][^:]+: .+/;

/** Default cosine-similarity threshold for Dedup-First-Write. Tunable via setup-field `process_dedup_threshold`. */
export const PROCESS_DEDUP_DEFAULT_THRESHOLD = 0.9;

/** Persisted process record (one version). */
export interface ProcessRecord {
  /** `process:<scope>:<slug>` — deterministically derived from title. Stable across edits. */
  readonly id: string;
  /** Session/project scope in which the process was created. */
  readonly scope: string;
  /** Naming convention `[Domain]: [What it does]`. */
  readonly title: string;
  /** Workflow steps. Phase 7 only `string[]`; structured objects deferred to 7.5. */
  readonly steps: readonly string[];
  /** Visibility inheritance from the session (`team` default; operator can raise to `private`/`shared:<project>`). */
  readonly visibility: string;
  /** Monotonically increasing per id. Initial 1; +1 per `edit`. */
  readonly version: number;
  /** ISO-8601 string. */
  readonly createdAt: string;
  /** ISO-8601 string. */
  readonly updatedAt: string;
}

export interface WriteProcessInput {
  /** Server-side enforced via PROCESS_TITLE_REGEX. */
  readonly title: string;
  readonly steps: readonly string[];
  readonly scope: string;
  /** Default `'team'`. */
  readonly visibility?: string;
}

/**
 * Discriminated union — the caller must explicitly switch on `ok`. Conflict
 * (variant 2) returns the ID of the existing process so the agent can
 * directly call `edit_process(conflictingId, …)` instead of blindly merging.
 */
export type WriteProcessResult =
  | { ok: true; record: ProcessRecord }
  | { ok: false; reason: 'invalid-title'; message: string }
  | {
      ok: false;
      reason: 'duplicate';
      conflictingId: string;
      conflictingTitle: string;
      similarity: number;
    }
  | { ok: false; reason: 'embedding-unavailable'; message: string };

export interface EditProcessInput {
  /** Existing `process:<scope>:<slug>` ID — must exist in `processes` for the tenant. */
  readonly id: string;
  /** If set: regex-validation; if empty/undefined: the old title remains. */
  readonly title?: string;
  /** If set: replaces steps entirely. */
  readonly steps?: readonly string[];
  /** Operator override, e.g. `'private'`. */
  readonly visibility?: string;
}

export type EditProcessResult =
  | { ok: true; record: ProcessRecord }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'invalid-title'; message: string }
  | { ok: false; reason: 'embedding-unavailable'; message: string };

export interface QueryProcessesInput {
  /** Natural-language query — searched via embedding + BM25 against title+steps. */
  readonly query: string;
  /** Optional: limit to a single scope. */
  readonly scope?: string;
  /** Default 10. */
  readonly limit?: number;
}

export interface ProcessQueryHit {
  readonly record: ProcessRecord;
  /** Hybrid score in [0,1]. */
  readonly score: number;
}

/**
 * Service surface that a `processMemory@1` provider publishes.
 *
 * Tenant scoping is *implementation-internal* (the provider holds the
 * `tenantId` from the boot context); consumers see only the domain fields.
 */
export interface ProcessMemoryService {
  /** Dedup-First-Write. Embedding mandatory for the dedup guarantee. */
  write(input: WriteProcessInput): Promise<WriteProcessResult>;

  /** Versioned update. Snapshot in `process_history` BEFORE UPDATE. */
  edit(input: EditProcessInput): Promise<EditProcessResult>;

  /** Hybrid retrieval (cosine + BM25). Reuses the OB-72 pattern. */
  query(input: QueryProcessesInput): Promise<readonly ProcessQueryHit[]>;

  /** Single-record lookup by ID. Null when no longer present. */
  get(id: string): Promise<ProcessRecord | null>;

  /** Version history (descending by version). Empty when id is unknown. */
  history(id: string): Promise<readonly ProcessRecord[]>;
}

/**
 * No-op default — published by backends without a persistent layer
 * (in-memory-KG, boot-without-migration). All writes reject with
 * `embedding-unavailable`; reads return empty. Consumers do not need
 * a special-case branch.
 */
export class NoopProcessMemoryService implements ProcessMemoryService {
  async write(_input: WriteProcessInput): Promise<WriteProcessResult> {
    return {
      ok: false,
      reason: 'embedding-unavailable',
      message:
        'Process-Memory ist auf diesem Backend nicht verfügbar (kein durable KG-Provider).',
    };
  }

  async edit(_input: EditProcessInput): Promise<EditProcessResult> {
    return { ok: false, reason: 'not-found' };
  }

  async query(_input: QueryProcessesInput): Promise<readonly ProcessQueryHit[]> {
    return [];
  }

  async get(_id: string): Promise<ProcessRecord | null> {
    return null;
  }

  async history(_id: string): Promise<readonly ProcessRecord[]> {
    return [];
  }
}

/**
 * Slug helper: deterministic derivation from the title — lowercase,
 * non-alphanumeric → `-`, runs of `-` collapsed, leading/trailing `-`
 * stripped. Exported so tools + tests share the same source.
 *
 * Examples:
 *  - `"Backend: Deploy to staging"` → `"backend-deploy-to-staging"`
 *  - `"Frontend: Re-render the list  "` → `"frontend-re-render-the-list"`
 */
export function slugifyProcessTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Complementary to `slugifyProcessTitle` — builds the deterministic
 * process ID. Consumers (tools, tests, ProcessMemoryService providers)
 * MUST use this function so IDs are consistent cross-package.
 */
export function buildProcessId(scope: string, title: string): string {
  return `process:${scope}:${slugifyProcessTitle(title)}`;
}
