/**
 * `processMemory@1` — capability contract für strukturierte Workflows.
 *
 * Phase-7 der Palaia-Integration (OB-76). Der Orchestrator bekommt vier
 * native Tools (`write_process`, `edit_process`, `query_processes`,
 * `run_stored_process`), die gegen diese Service-Surface laufen. Ziel ist,
 * dass Agenten Workflows EINMAL einlernen, finden + ausführen — statt sie
 * jedes Mal aus dem Turn-Stream neu abzuleiten.
 *
 * HARD-INVARIANTS (siehe HANDOFF-2026-05-08-palaia-phase-7):
 * 1. **Naming-Convention enforced**: title matcht `/^[A-Z][^:]+: .+/`
 *    (z.B. `"Backend: Deploy to staging"`). Server-side validiert.
 * 2. **Dedup-First-Write ist HARD-BLOCK**: bei cosine-similarity ≥ 0.9
 *    gegen einen bestehenden Process im Tenant lehnt der Service ab und
 *    liefert `{ ok: false, reason: 'duplicate', conflictingId }`.
 * 3. **Versioning via history-Tabelle**: `edit` snapshotet den alten
 *    Zustand BEFORE UPDATE; `version` monoton steigend pro id.
 * 4. **`id` ist deterministisch**: `process:<scope>:<slugify(title)>` —
 *    stabil über Edits (title-Änderungen ändern die ID nicht; nur die
 *    Embedding-/title-Spalte).
 * 5. **Embedding-Pflicht für Dedup**: Provider OHNE EmbeddingClient lehnt
 *    `write` ab mit `{ ok: false, reason: 'embedding-unavailable' }`.
 *    Kein silent-bypass.
 *
 * Provider: `harness-knowledge-graph-neon` (durable, tenant-scoped).
 * Eine `NoopProcessMemoryService`-Implementierung lebt mit hier — Backends
 * ohne persistente Schicht (in-memory-KG) können sie publishen, damit
 * Konsumenten keinen Sonderfall-Branch brauchen.
 */

export const PROCESS_MEMORY_SERVICE_NAME = 'processMemory';
export const PROCESS_MEMORY_CAPABILITY = 'processMemory@1';

/** Naming-Convention-Regex — exportiert, damit Tool-Layer die gleiche Quelle nutzen kann. */
export const PROCESS_TITLE_REGEX = /^[A-Z][^:]+: .+/;

/** Default cosine-similarity threshold für Dedup-First-Write. Tunable via Setup-Field `process_dedup_threshold`. */
export const PROCESS_DEDUP_DEFAULT_THRESHOLD = 0.9;

/** Persisted Process-Record (eine Version). */
export interface ProcessRecord {
  /** `process:<scope>:<slug>` — deterministisch aus title abgeleitet. Stabil über Edits. */
  readonly id: string;
  /** Session/Project-Scope, in dem der Process erzeugt wurde. */
  readonly scope: string;
  /** Naming-Convention `[Domain]: [What it does]`. */
  readonly title: string;
  /** Workflow-Steps. Phase 7 nur `string[]`; strukturierte Objekte deferred auf 7.5. */
  readonly steps: readonly string[];
  /** Visibility-Vererbung von der Session (`team` default; Operator kann auf `private`/`shared:<project>` heben). */
  readonly visibility: string;
  /** Monoton steigend pro id. Initial 1; +1 pro `edit`. */
  readonly version: number;
  /** ISO-8601-String. */
  readonly createdAt: string;
  /** ISO-8601-String. */
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
 * Discriminated union — Caller muss explizit auf `ok` switchen. Conflict
 * (Variante 2) liefert die ID des bestehenden Process zurück, sodass der
 * Agent direkt `edit_process(conflictingId, …)` aufrufen kann statt blind
 * zu mergen.
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
  /** Existing `process:<scope>:<slug>` ID — muss in `processes` für den Tenant existieren. */
  readonly id: string;
  /** Wenn gesetzt: Regex-validation; wenn leer/undefined: alter title bleibt. */
  readonly title?: string;
  /** Wenn gesetzt: ersetzt steps komplett. */
  readonly steps?: readonly string[];
  /** Operator-Override z.B. `'private'`. */
  readonly visibility?: string;
}

export type EditProcessResult =
  | { ok: true; record: ProcessRecord }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'invalid-title'; message: string }
  | { ok: false; reason: 'embedding-unavailable'; message: string };

export interface QueryProcessesInput {
  /** Natural-language query — wird via embedding + BM25 gegen title+steps gesucht. */
  readonly query: string;
  /** Optional: limit auf einen Scope. */
  readonly scope?: string;
  /** Default 10. */
  readonly limit?: number;
}

export interface ProcessQueryHit {
  readonly record: ProcessRecord;
  /** Hybrid-Score in [0,1]. */
  readonly score: number;
}

/**
 * Service-Surface, die ein `processMemory@1`-Provider published.
 *
 * Tenant-scoping ist *implementations-intern* (Provider hält den `tenantId`
 * aus dem Boot-Context); Konsumenten sehen nur die Domänen-Felder.
 */
export interface ProcessMemoryService {
  /** Dedup-First-Write. Embedding-Pflicht für Dedup-Garantie. */
  write(input: WriteProcessInput): Promise<WriteProcessResult>;

  /** Versionierter Update. Snapshot in `process_history` BEFORE UPDATE. */
  edit(input: EditProcessInput): Promise<EditProcessResult>;

  /** Hybrid-Retrieval (cosine + BM25). Reuse OB-72-Pattern. */
  query(input: QueryProcessesInput): Promise<readonly ProcessQueryHit[]>;

  /** Single-record lookup by ID. Null wenn nicht (mehr) vorhanden. */
  get(id: string): Promise<ProcessRecord | null>;

  /** Versions-History (descending by version). Leer wenn id unbekannt. */
  history(id: string): Promise<readonly ProcessRecord[]>;
}

/**
 * No-op Default — published von Backends ohne persistente Schicht
 * (in-memory-KG, Boot-ohne-Migration). Alle Writes lehnen mit
 * `embedding-unavailable` ab; Reads liefern leer. Konsumenten brauchen
 * keinen Sonderfall-Branch.
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
 * Slug-Helper: deterministische Ableitung aus dem title — lowercase,
 * non-alphanumerisch → `-`, runs-of-`-` collapsed, leading/trailing `-`
 * gestripped. Exportiert, damit Tools + Tests die gleiche Quelle nutzen.
 *
 * Beispiele:
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
 * Komplementär zu `slugifyProcessTitle` — baut die deterministische
 * Process-ID. Konsumenten (Tools, Tests, ProcessMemoryService-Provider)
 * MÜSSEN diese Funktion verwenden, damit IDs cross-package konsistent sind.
 */
export function buildProcessId(scope: string, title: string): string {
  return `process:${scope}:${slugifyProcessTitle(title)}`;
}
