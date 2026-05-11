import { z } from 'zod';

import {
  RoutineNameConflictError,
  type Routine,
} from './routineStore.js';
import {
  RoutineNotFoundError,
  RoutineQuotaExceededError,
  UnknownChannelError,
  type RoutineRunner,
} from './routineRunner.js';

export const MANAGE_ROUTINE_TOOL_NAME = 'manage_routine';

const ActionSchema = z.enum(['create', 'list', 'pause', 'resume', 'delete']);
const ListFilterSchema = z.enum(['all', 'active', 'paused']);

const ManageRoutineInputSchema = z.object({
  action: ActionSchema,
  /** Required for `create`. Display name unique per (tenant, user). */
  name: z.string().min(1).max(120).optional(),
  /** Required for `create`. 5-field cron expression. */
  cron: z.string().min(1).max(120).optional(),
  /** Required for `create`. The user-facing prompt the agent will run. */
  prompt: z.string().min(1).max(4000).optional(),
  /** Required for `pause`, `resume`, `delete`. UUID returned by `create` /
   *  `list`. */
  id: z.string().uuid().optional(),
  /** Optional for `create`. Defaults to 60_000ms. */
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  /** Optional for `list`. Filters the rows the smart-card renders. */
  filter: ListFilterSchema.optional(),
});

export type RoutineListFilter = z.infer<typeof ListFilterSchema>;

export type ManageRoutineInput = z.infer<typeof ManageRoutineInputSchema>;

/**
 * Per-turn context the tool needs to attribute create() to the right user
 * and to capture the channel-native delivery handle. Bootstrap wires the
 * resolver to read from `turnContext.current()`; tests inject a stub.
 *
 * `undefined` from the resolver means "not in a channel turn" — the tool
 * surfaces a clear error to the model rather than silently failing.
 */
export interface ManageRoutineContext {
  tenant: string;
  userId: string;
  channel: string;
  conversationRef: unknown;
}

export type ManageRoutineContextResolver = () =>
  | ManageRoutineContext
  | undefined;

export const manageRoutineToolSpec = {
  name: MANAGE_ROUTINE_TOOL_NAME,
  description:
    'Lege wiederkehrende Routinen / Cronjobs für den User an, liste sie auf, pausiere, reaktiviere oder lösche sie. Der Agent ruft dieses Tool, wenn der User Wünsche wie "erinnere mich jeden Montag um 9 Uhr an X" oder "zeig mir meine Routinen" äußert.\n\n' +
    '**Aktionen:**\n' +
    '- `create` — neue Routine. Pflicht: `name` (eindeutig pro User), `cron` (5-Feld: Min Std DOM Mon DOW), `prompt` (was der Agent zur Trigger-Zeit ausführen soll). Optional: `timeoutMs` (Default 10 min = 600000).\n' +
    '- `list` — alle Routinen des aktuellen Users (aktiv + pausiert).\n' +
    '- `pause` / `resume` / `delete` — Pflicht: `id` aus einer vorigen `list`-Antwort.\n\n' +
    '**Cron-Regeln:**\n' +
    '- Standard 5-Feld-Format. Beispiele: `0 9 * * 1` (Montag 9:00), `*/30 * * * *` (alle 30min), `0 8 1 * *` (Monatlich am 1.).\n' +
    '- Minimum-Tick-Rate: 60s (kein Sub-Minuten-Cron).\n' +
    '- Bei mehrdeutigen Zeitangaben des Users (z.B. "morgens"): nachfragen via `ask_user_choice`, nicht raten.\n\n' +
    '**Quota:** max 50 aktive Routinen pro User.\n\n' +
    '**Fehlerverhalten:** Tool-Antwort beginnt bei Fehler mit `Error: …` (Cron malformed, Quota erreicht, Name kollidiert, id nicht gefunden). Das Modell erklärt dem User in eigenen Worten, was schief lief.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'pause', 'resume', 'delete'],
        description: 'Welche Operation auf die Routinen ausgeführt wird.',
      },
      name: {
        type: 'string',
        description:
          'Display-Name. Pflicht bei `create`. Eindeutig pro User. 1–120 Zeichen.',
      },
      cron: {
        type: 'string',
        description:
          '5-Feld-Cron-Ausdruck. Pflicht bei `create`. Beispiel: "0 9 * * 1".',
      },
      prompt: {
        type: 'string',
        description:
          'Prompt, den der Agent bei jedem Trigger ausführt. Pflicht bei `create`. 1–4000 Zeichen.',
      },
      id: {
        type: 'string',
        description:
          'UUID einer existierenden Routine. Pflicht bei `pause`, `resume`, `delete`.',
      },
      timeoutMs: {
        type: 'integer',
        description:
          'Pro-Run-Timeout in ms. Optional bei `create`. 1000–600000 (1s–10min). Default 600000 (10min) — passt für Tool-heavy Routinen mit KG-Lookups oder Sub-Agent-Delegation.',
      },
      filter: {
        type: 'string',
        enum: ['all', 'active', 'paused'],
        description:
          'Optional bei `list`. Schränkt die Smart-Card auf eine Status-Gruppe ein. Default `all`.',
      },
    },
    required: ['action'],
  },
};

export interface ManageRoutineToolOptions {
  runner: RoutineRunner;
  resolveContext: ManageRoutineContextResolver;
}

/**
 * Native-tool handler for `manage_routine`. Translates validated input +
 * per-turn context into RoutineRunner operations, then formats the result
 * as a model-friendly string. Errors are returned as `Error: …` strings
 * (never thrown across the tool boundary) so the model can recover.
 */
export class ManageRoutineTool {
  private readonly runner: RoutineRunner;
  private readonly resolveContext: ManageRoutineContextResolver;

  constructor(opts: ManageRoutineToolOptions) {
    this.runner = opts.runner;
    this.resolveContext = opts.resolveContext;
  }

  async handle(input: unknown): Promise<string> {
    const parsed = ManageRoutineInputSchema.safeParse(input);
    if (!parsed.success) {
      return `Error: invalid manage_routine input — ${parsed.error.message}`;
    }
    const args = parsed.data;

    try {
      switch (args.action) {
        case 'create':
          return await this.handleCreate(args);
        case 'list':
          return await this.handleList(args);
        case 'pause':
          return await this.handlePause(args);
        case 'resume':
          return await this.handleResume(args);
        case 'delete':
          return await this.handleDelete(args);
      }
    } catch (err) {
      return formatError(err);
    }
  }

  private async handleCreate(args: ManageRoutineInput): Promise<string> {
    if (!args.name || !args.cron || !args.prompt) {
      return 'Error: `create` requires `name`, `cron`, and `prompt`.';
    }
    const ctx = this.resolveContext();
    if (!ctx) {
      return 'Error: cannot create routine outside a channel turn (no user context).';
    }
    const routine = await this.runner.createRoutine({
      tenant: ctx.tenant,
      userId: ctx.userId,
      name: args.name,
      cron: args.cron,
      prompt: args.prompt,
      channel: ctx.channel,
      conversationRef: ctx.conversationRef,
      timeoutMs: args.timeoutMs,
    });
    return JSON.stringify({
      action: 'created',
      routine: summariseRoutine(routine),
    });
  }

  private async handleList(args: ManageRoutineInput): Promise<string> {
    const ctx = this.resolveContext();
    if (!ctx) {
      return 'Error: cannot list routines outside a channel turn (no user context).';
    }
    const rows = await this.runner.listRoutines(ctx.tenant, ctx.userId);
    const filter: RoutineListFilter = args.filter ?? 'all';
    const filtered =
      filter === 'all' ? rows : rows.filter((r) => r.status === filter);
    const totals = {
      all: rows.length,
      active: rows.filter((r) => r.status === 'active').length,
      paused: rows.filter((r) => r.status === 'paused').length,
    };
    // The `_pendingRoutineList` marker piggybacks on the JSON return so the
    // orchestrator (parseToolEmittedRoutineList) can lift it into a
    // sidecar smart-card without us needing a kernel-internal tool ref.
    // The model still sees the same `routines[]` payload + counts and
    // narrates around the card.
    return JSON.stringify({
      action: 'list',
      count: filtered.length,
      filter,
      totals,
      routines: filtered.map(summariseRoutine),
      _pendingRoutineList: {
        filter,
        totals,
        routines: filtered.map((r) => ({
          id: r.id,
          name: r.name,
          cron: r.cron,
          prompt: r.prompt,
          status: r.status,
          lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
          lastRunStatus: r.lastRunStatus,
        })),
      },
    });
  }

  private async handlePause(args: ManageRoutineInput): Promise<string> {
    if (!args.id) return 'Error: `pause` requires `id`.';
    const updated = await this.runner.pauseRoutine(args.id);
    return JSON.stringify({
      action: 'paused',
      routine: summariseRoutine(updated),
    });
  }

  private async handleResume(args: ManageRoutineInput): Promise<string> {
    if (!args.id) return 'Error: `resume` requires `id`.';
    const updated = await this.runner.resumeRoutine(args.id);
    return JSON.stringify({
      action: 'resumed',
      routine: summariseRoutine(updated),
    });
  }

  private async handleDelete(args: ManageRoutineInput): Promise<string> {
    if (!args.id) return 'Error: `delete` requires `id`.';
    const ok = await this.runner.deleteRoutine(args.id);
    return JSON.stringify({
      action: ok ? 'deleted' : 'not_found',
      id: args.id,
    });
  }
}

interface SummarisedRoutine {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  status: string;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunError: string | null;
}

function summariseRoutine(r: Routine): SummarisedRoutine {
  return {
    id: r.id,
    name: r.name,
    cron: r.cron,
    prompt: r.prompt,
    status: r.status,
    timeoutMs: r.timeoutMs,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
    lastRunStatus: r.lastRunStatus,
    lastRunError: r.lastRunError,
  };
}

function formatError(err: unknown): string {
  if (err instanceof RoutineNameConflictError) {
    return `Error: ${err.message}`;
  }
  if (err instanceof RoutineQuotaExceededError) {
    return `Error: ${err.message}`;
  }
  if (err instanceof RoutineNotFoundError) {
    return `Error: ${err.message}`;
  }
  if (err instanceof UnknownChannelError) {
    return `Error: ${err.message}`;
  }
  if (err instanceof Error) {
    // Preserve JobValidationError messages (cron parse failures) and other
    // unexpected errors. Tag them so the model can distinguish from
    // success-payload JSON.
    return `Error: ${err.message}`;
  }
  return `Error: ${String(err)}`;
}
