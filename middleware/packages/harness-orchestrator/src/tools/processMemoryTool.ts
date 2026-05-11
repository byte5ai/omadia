import { z } from 'zod';

import type {
  NativeToolHandler,
  NativeToolSpec,
  ProcessMemoryService,
  ProcessRecord,
} from '@omadia/plugin-api';
import { PROCESS_TITLE_REGEX } from '@omadia/plugin-api';

/**
 * Palaia Phase 7 (OB-76) — vier native Orchestrator-Tools, die gegen die
 * `processMemory@1`-Capability laufen.
 *
 * Naming-Convention im Title (`/^[A-Z][^:]+: .+/`) ist server-side enforced
 * (Zod hier + DB-CHECK in `processes`-Tabelle). Dedup-First-Write-Block ist
 * ein expliziter Tool-Result-Branch — der Agent sieht Conflict-ID + Title +
 * Similarity und entscheidet zwischen Überschreiben (via `edit_process`) oder
 * Reformulieren.
 */

export const WRITE_PROCESS_TOOL_NAME = 'write_process';
export const EDIT_PROCESS_TOOL_NAME = 'edit_process';
export const QUERY_PROCESSES_TOOL_NAME = 'query_processes';
export const RUN_STORED_PROCESS_TOOL_NAME = 'run_stored_process';

const TITLE_MAX = 200;
const STEP_MAX = 1000;
const STEPS_MAX = 32;

const TitleSchema = z
  .string()
  .min(3)
  .max(TITLE_MAX)
  .regex(
    PROCESS_TITLE_REGEX,
    'title muss dem Schema "[Domain]: [What it does]" folgen (z.B. "Backend: Deploy to staging").',
  );

const StepsSchema = z
  .array(z.string().min(1).max(STEP_MAX))
  .min(1, 'mindestens ein Step erforderlich.')
  .max(STEPS_MAX, `maximal ${String(STEPS_MAX)} Steps.`);

const WriteProcessInputSchema = z.object({
  title: TitleSchema,
  steps: StepsSchema,
  scope: z.string().min(1).max(200),
  visibility: z.string().min(1).max(50).optional(),
});

const EditProcessInputSchema = z
  .object({
    id: z.string().min(1).max(400),
    title: TitleSchema.optional(),
    steps: StepsSchema.optional(),
    visibility: z.string().min(1).max(50).optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.title === undefined &&
      data.steps === undefined &&
      data.visibility === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'edit_process: mindestens eines von title/steps/visibility muss gesetzt sein.',
        path: [],
      });
    }
  });

const QueryProcessesInputSchema = z.object({
  query: z.string().min(1).max(500),
  scope: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

const RunStoredProcessInputSchema = z.object({
  id: z.string().min(1).max(400),
});

export const writeProcessToolSpec: NativeToolSpec = {
  name: WRITE_PROCESS_TOOL_NAME,
  description:
    'Persistiere einen mehrschrittigen Workflow als wiederverwendbaren Process. Vor jedem Aufruf erst `query_processes` benutzen — wenn ein semantisch ähnlicher Process bereits existiert (cosine ≥ 0.9), lehnt dieses Tool mit `duplicate` ab und liefert die ID des bestehenden Process zurück. Title MUSS dem Schema `[Domain]: [What it does]` folgen (z.B. `"Backend: Deploy to staging"`).',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'Format `[Domain]: [What it does]`, z.B. `"Backend: Deploy to staging"`. Erstes Zeichen Großbuchstabe, ein Doppelpunkt, dann Beschreibung.',
      },
      steps: {
        type: 'array',
        description:
          'Geordnete Workflow-Steps als Strings. 1–32 Steps; jeder Step soll für sich verständlich sein, kein impliziter Vor-Kontext.',
        items: { type: 'string' },
      },
      scope: {
        type: 'string',
        description:
          'Session/Project-Scope, in dem der Process erzeugt wird. Üblicherweise der aktuelle Session-Scope.',
      },
      visibility: {
        type: 'string',
        description:
          'Optional. `team` (default), `private`, oder `shared:<project-id>`.',
      },
    },
    required: ['title', 'steps', 'scope'],
  },
};

export const editProcessToolSpec: NativeToolSpec = {
  name: EDIT_PROCESS_TOOL_NAME,
  description:
    'Versionierter Update eines bestehenden Process. Snapshot der alten Version landet in `process_history`; die `id` bleibt stabil, `version` wird um +1 erhöht. Wenn `title` oder `steps` geändert werden, wird das Embedding neu berechnet.',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Bestehende Process-ID, z.B. `process:scope:backend-deploy-to-staging`. Aus `query_processes` oder einem vorherigen `write_process`-Result entnehmen.',
      },
      title: {
        type: 'string',
        description:
          'Neuer title (gleiches Schema wie write_process). Optional — leer lassen, um den Title beizubehalten.',
      },
      steps: {
        type: 'array',
        description:
          'Komplette Step-Liste, ersetzt die bestehende. Optional.',
        items: { type: 'string' },
      },
      visibility: {
        type: 'string',
        description: 'Optional. `team` / `private` / `shared:<project-id>`.',
      },
    },
    required: ['id'],
  },
};

export const queryProcessesToolSpec: NativeToolSpec = {
  name: QUERY_PROCESSES_TOOL_NAME,
  description:
    'Semantische Suche nach existierenden Processes (cosine + BM25 hybrid über title + steps). NUTZE DIESES TOOL ZUERST bevor du einen mehrschrittigen Workflow neu beschreibst. Liefert `[{id, title, scope, score, steps}]` als Markdown-Liste.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Free-text-Beschreibung des gesuchten Workflows. Kurz halten — 2–8 Wörter funktionieren am besten.',
      },
      scope: {
        type: 'string',
        description:
          'Optional: nur Processes aus diesem Scope durchsuchen. Default: alle.',
      },
      limit: {
        type: 'integer',
        description: 'Max Treffer. Default 10, Maximum 50.',
      },
    },
    required: ['query'],
  },
};

export const runStoredProcessToolSpec: NativeToolSpec = {
  name: RUN_STORED_PROCESS_TOOL_NAME,
  description:
    'Lädt einen Process per ID und liefert `{id, title, version, steps[]}` als JSON zurück. **Read-only** — führt keine Side-Effects aus. Du als orchestrierender Agent entscheidest welche Steps wie ausgeführt werden (eigene Tool-Calls, sub_call, etc.).',
  input_schema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description:
          'Process-ID (z.B. aus `query_processes`).',
      },
    },
    required: ['id'],
  },
};

export const PROCESS_MEMORY_SYSTEM_PROMPT_DOC = `### Process-Memory (\`processMemory@1\`)
Wenn du einen mehrschrittigen Workflow neu beschreiben würdest:
1. Suche zuerst mit \`query_processes\` nach existierenden ähnlichen Prozessen.
2. Wenn gefunden: nutze \`run_stored_process(id)\` für den Plan.
3. Wenn neu: schreibe via \`write_process\` (enforced Naming: \`"[Domain]: [What it does]"\`).
4. Wenn ein Process veraltet ist: \`edit_process(id, ...)\` versioniert den Update.

\`write_process\` blockt Duplikate (cosine ≥ 0.9). Bei Conflict siehst du die ID des Originals — entscheide ob du \`edit_process\` aufrufst statt eines neuen \`write_process\`.`;

function recordToBrief(record: ProcessRecord): {
  id: string;
  title: string;
  scope: string;
  visibility: string;
  version: number;
  stepsCount: number;
} {
  return {
    id: record.id,
    title: record.title,
    scope: record.scope,
    visibility: record.visibility,
    version: record.version,
    stepsCount: record.steps.length,
  };
}

export function createWriteProcessHandler(
  service: ProcessMemoryService,
): NativeToolHandler {
  return async (input) => {
    const parsed = WriteProcessInputSchema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return `Error: invalid write_process input — ${detail}`;
    }
    const writeInput: Parameters<ProcessMemoryService['write']>[0] = {
      title: parsed.data.title,
      steps: parsed.data.steps,
      scope: parsed.data.scope,
      ...(parsed.data.visibility !== undefined
        ? { visibility: parsed.data.visibility }
        : {}),
    };
    const result = await service.write(writeInput);
    if (result.ok) {
      return JSON.stringify({
        status: 'process_written',
        record: recordToBrief(result.record),
        note: `Process gespeichert als ${result.record.id} (Version ${String(result.record.version)}).`,
      });
    }
    if (result.reason === 'duplicate') {
      return JSON.stringify({
        status: 'duplicate_blocked',
        conflictingId: result.conflictingId,
        conflictingTitle: result.conflictingTitle,
        similarity: Number(result.similarity.toFixed(3)),
        note:
          'Ein semantisch nahezu identischer Process existiert bereits. Wenn du den bestehenden anpassen willst: nutze edit_process. Wenn dein Workflow tatsächlich anders ist: formuliere title/steps unterscheidbarer.',
      });
    }
    return `Error: write_process — ${result.reason}: ${'message' in result ? result.message : ''}`;
  };
}

export function createEditProcessHandler(
  service: ProcessMemoryService,
): NativeToolHandler {
  return async (input) => {
    const parsed = EditProcessInputSchema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return `Error: invalid edit_process input — ${detail}`;
    }
    const editInput: Parameters<ProcessMemoryService['edit']>[0] = {
      id: parsed.data.id,
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.steps !== undefined ? { steps: parsed.data.steps } : {}),
      ...(parsed.data.visibility !== undefined
        ? { visibility: parsed.data.visibility }
        : {}),
    };
    const result = await service.edit(editInput);
    if (result.ok) {
      return JSON.stringify({
        status: 'process_updated',
        record: recordToBrief(result.record),
        note: `Process ${result.record.id} aktualisiert auf Version ${String(result.record.version)} (Snapshot der vorherigen Version liegt in process_history).`,
      });
    }
    if (result.reason === 'not-found') {
      return `Error: edit_process — kein Process mit ID '${parsed.data.id}' im aktuellen Tenant.`;
    }
    return `Error: edit_process — ${result.reason}: ${'message' in result ? result.message : ''}`;
  };
}

export function createQueryProcessesHandler(
  service: ProcessMemoryService,
): NativeToolHandler {
  return async (input) => {
    const parsed = QueryProcessesInputSchema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return `Error: invalid query_processes input — ${detail}`;
    }
    const queryInput: Parameters<ProcessMemoryService['query']>[0] = {
      query: parsed.data.query,
      limit: parsed.data.limit,
      ...(parsed.data.scope !== undefined ? { scope: parsed.data.scope } : {}),
    };
    const hits = await service.query(queryInput);
    return JSON.stringify({
      query: parsed.data.query,
      mode: 'hybrid',
      hits: hits.map((h) => ({
        id: h.record.id,
        title: h.record.title,
        scope: h.record.scope,
        version: h.record.version,
        score: Number(h.score.toFixed(3)),
        stepsPreview: h.record.steps.slice(0, 3),
      })),
    });
  };
}

export function createRunStoredProcessHandler(
  service: ProcessMemoryService,
): NativeToolHandler {
  return async (input) => {
    const parsed = RunStoredProcessInputSchema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return `Error: invalid run_stored_process input — ${detail}`;
    }
    const record = await service.get(parsed.data.id);
    if (!record) {
      return `Error: run_stored_process — kein Process mit ID '${parsed.data.id}' im aktuellen Tenant.`;
    }
    return JSON.stringify({
      status: 'process_loaded',
      id: record.id,
      title: record.title,
      version: record.version,
      scope: record.scope,
      steps: record.steps,
      note: 'Read-only: keine Side-Effects ausgeführt. Entscheide jetzt welche Steps mit deinen anderen Tools umgesetzt werden.',
    });
  };
}
