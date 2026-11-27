import {
  JobValidationError,
  buildEmailColdStartTarget,
  modelReadableToolErrorMessage,
  toolErrorFromException,
} from '@omadia/plugin-api';
import { turnContext } from '@omadia/orchestrator';
import { z } from 'zod';

import { formatInTimeZone, nextCronRun, resolveTimeZone, UTC_ZONE } from '../../scheduler/zonedCron.js';
import { DEFAULT_ROUTINE_TIMEOUT_MS, MIN_ROUTINE_TIMEOUT_MS } from './routineRunControl.js';
import {
  RoutineNameConflictError,
  type Routine,
} from './routineStore.js';
import {
  RoutineNotFoundError,
  RoutineQuotaExceededError,
  UnknownChannelError,
  type RoutineActorScope,
  type RoutineRunner,
} from './routineRunner.js';
import { WEB_ROUTINE_CHANNEL } from './webChatProactiveSender.js';

/**
 * #2316 (ADR-0279) — the conversation a channel routine delivers into, as the
 * session scope its turns run under, so those turns can see the deliveries.
 * Only for a routine that writes back into the creating conversation (no
 * `targetEmail`) on a channel; the web chat reads its own document.
 */
function originScopeFor(channel: string, deliversHere: boolean): string | undefined {
  if (!deliversHere || channel === WEB_ROUTINE_CHANNEL) return undefined;
  const scope = turnContext.current()?.sessionScope?.trim();
  return scope ? scope : undefined;
}

export const MANAGE_ROUTINE_TOOL_NAME = 'manage_routine';

/**
 * Shown when the per-turn user context is missing.
 *
 * #1086 — this used to call it "a runtime wiring issue" and send the user to
 * their operator (OM-82 / #993 phrasing, when the context was lost crossing the
 * CLI loopback boundary; #993 fixed that transport). What is left is almost
 * always a channel no producer covers: the web chat and every channel that
 * drives its turn through `CoreApi.handleTurnStream` install a context, but an
 * adapter that calls the `chatAgent` capability directly (Telegram, Slack,
 * Discord, WhatsApp as of 2026-09) does not. There is nothing an operator can
 * configure for that, so say what is true and point at the path that works.
 * Keeps the `Error:` prefix: it is the tool-error convention the orchestrator
 * and the privacy shield key on.
 */
export const ROUTINE_NO_CONTEXT_ERROR =
  'Error: routines are not available in this conversation — this channel does ' +
  'not pass your identity to the routines tool yet, so routines cannot be ' +
  'created, listed or changed from here. The Routines page can view, pause ' +
  'or delete existing routines.';

const ActionSchema = z.enum(['create', 'list', 'pause', 'resume', 'renew', 'delete']);
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
  /** Optional for `create`. Defaults to 600_000 ms; #1747 — at least 30 s. */
  timeoutMs: z.number().int().min(MIN_ROUTINE_TIMEOUT_MS).max(DEFAULT_ROUTINE_TIMEOUT_MS).optional(),
  /**
   * Optional for `create`. Email of ANOTHER person this routine should
   * proactively message (cold-start 1:1 outreach — e.g. an HR review
   * reminder). Omitted ⇒ the routine delivers to the current user's
   * conversation (default, unchanged). Requires the caller to be
   * authorized to target others (see ManageRoutineContext.canTargetOthers).
   */
  targetEmail: z.string().min(3).max(254).optional(),
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
  /**
   * Cold-start authorization (default `false`). When `true`, the caller may
   * create routines that proactively message OTHER people via `targetEmail`.
   * Populated by the channel adapter from its governance source (e.g. an
   * operator-configured allowlist). Self-targeting routines never consult
   * this flag.
   */
  canTargetOthers?: boolean;
  /**
   * #1743 — the creator's IANA zone when the channel reported one
   * (`ChatTurnInput.userTimeZone`). A routine is evaluated in it.
   */
  timeZone?: string;
  /**
   * #1598 — slug of the orchestrator handling the creating turn. Stored on the
   * routine so it runs with that orchestrator's plugin grants.
   */
  agentSlug?: string;
  /**
   * #1907 / ADR-0206 — the creating turn's MCP OAuth user key. Stored on the
   * routine so it acts as its owner on `per_user` MCP servers.
   */
  mcpUserKey?: string;
}

export type ManageRoutineContextResolver = () =>
  | ManageRoutineContext
  | undefined;

export const manageRoutineToolSpec = {
  name: MANAGE_ROUTINE_TOOL_NAME,
  description:
    'Lege wiederkehrende Routinen / Cronjobs für den User an, liste sie auf, pausiere, reaktiviere oder lösche sie. Der Agent ruft dieses Tool, wenn der User Wünsche wie "erinnere mich jeden Montag um 9 Uhr an X" oder "zeig mir meine Routinen" äußert.\n\n' +
    '**Aktionen:**\n' +
    '- `create` — neue Routine. Pflicht: `name` (eindeutig pro User), `cron` (5-Feld: Min Std DOM Mon DOW), `prompt` (was der Agent zur Trigger-Zeit ausführen soll). Optional: `timeoutMs` (Default 10 min = 600000). Eine Routine schreibt immer in die aktuelle Unterhaltung des Users.\n' +
    '- `list` — alle Routinen des aktuellen Users (aktiv + pausiert).\n' +
    '- `pause` / `resume` / `renew` / `delete` — Pflicht: `id` aus einer vorigen `list`-Antwort. `renew` verlängert eine Routine um einen weiteren Zeitraum (wenn der User das auf die Nachfrage vor dem Ablauf wünscht).\n\n' +
    '**Laufzeit:** Jede Routine läuft bis zu ihrer Frist (`until`, Standard 30 Tage). Vor dem Ablauf fragt der Kernel den User, ob sie weiterlaufen soll; danach ist sie pausiert, bis sie fortgesetzt oder verlängert wird.\n\n' +
    '**Cron-Regeln:**\n' +
    '- Standard 5-Feld-Format nur mit Zahlen, `*`, `,`, `-`, `/`. Beispiele: `0 9 * * 1` (Montag 9:00), `*/30 * * * *` (alle 30min), `0 8 1 * *` (Monatlich am 1.). Nicht erlaubt: `@daily` u.ä., `?`, `L`/`W`/`#`, Wochentags-/Monatsnamen, Muster, die nie oder nur einmal feuern.\n' +
    '- Die Uhrzeit gilt in der Zeitzone der Routine (`timeZone` im Ergebnis, die des Users bzw. der Instanz). Das Ergebnis nennt `nextRun` mit Zone — bestätige dem User diesen nächsten Lauf.\n' +
    '- Höchstens alle 15 Minuten (der Kernel lehnt engere Muster ab).\n' +
    '- Bei mehrdeutigen Zeitangaben des Users (z.B. "morgens"): nachfragen via `ask_user_choice`, nicht raten.\n\n' +
    '**Quota:** max 50 aktive Routinen pro User.\n\n' +
    '**Fehlerverhalten:** Tool-Antwort beginnt bei Fehler mit `Error: …` (Cron ungültig oder zu häufig, Quota erreicht, Name kollidiert, id nicht gefunden, keine Unterhaltung zum Zustellen). Das Modell erklärt dem User in eigenen Worten, was schief lief.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'pause', 'resume', 'renew', 'delete'],
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
          'Pro-Run-Timeout in ms. Optional bei `create`. 30000–600000 (30s–10min). Default 600000 (10min) — passt für Tool-heavy Routinen mit KG-Lookups oder Sub-Agent-Delegation.',
      },
      // #1751 — `targetEmail` is not advertised: no channel can grant
      // outreach to other people until recipient grants (ADR 0020) exist.
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
  /**
   * #1598 — `true` when a routine must name the orchestrator that runs it (an
   * orchestrator registry exists). A create on a turn whose orchestrator is
   * unknown is then refused instead of silently running on another one.
   */
  requiresAgentSlug?: () => boolean;
  /** #1743 — the instance zone (`PROACTIVE_TIMEZONE`), used when the creator's is unknown. */
  defaultTimeZone?: string;
  /** Clock seam for `nextRun` in results. */
  now?: () => Date;
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
  private readonly requiresAgentSlug: () => boolean;
  private readonly defaultTimeZone: string | undefined;
  private readonly now: () => Date;

  constructor(opts: ManageRoutineToolOptions) {
    this.runner = opts.runner;
    this.resolveContext = opts.resolveContext;
    this.requiresAgentSlug = opts.requiresAgentSlug ?? (() => false);
    this.defaultTimeZone = opts.defaultTimeZone;
    this.now = opts.now ?? (() => new Date());
  }

  private summarise(r: Routine): SummarisedRoutine {
    return summariseRoutine(r, this.now());
  }

  async handle(input: unknown): Promise<string> {
    const parsed = ManageRoutineInputSchema.safeParse(input);
    if (!parsed.success) {
      return `Error: invalid manage_routine input — ${describeInputIssues(parsed.error)}`;
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
        case 'renew':
          return await this.handleRenew(args);
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
      return ROUTINE_NO_CONTEXT_ERROR;
    }
    if (!ctx.agentSlug && this.requiresAgentSlug()) {
      return 'Error: a routine cannot be created on this turn — the orchestrator that would run it is unknown.';
    }

    // Cold-start 1:1 outreach: when the caller names another person via
    // `targetEmail`, deliver to that person's (yet-to-be-created) 1:1
    // conversation instead of the caller's own. This is gated on an
    // explicit authorization flag the channel populates — without it, a
    // routine could spam arbitrary tenant members.
    let conversationRef: unknown = ctx.conversationRef;
    if (args.targetEmail !== undefined && args.targetEmail.trim().length > 0) {
      if (!ctx.canTargetOthers) {
        // #1751 — no grant can be asked for here: recipient grants (ADR 0020)
        // do not exist for routines yet, so the honest answer is "not here".
        return 'Error: this deployment cannot send routine messages to other people; a routine can only write to you in this conversation. Create it without `targetEmail`.';
      }
      const target = buildEmailColdStartTarget({
        channel: ctx.channel,
        email: args.targetEmail,
        createdBy: { tenant: ctx.tenant, userId: ctx.userId },
      });
      if (!target) {
        return `Error: \`targetEmail\` is not a valid email address: ${args.targetEmail}`;
      }
      conversationRef = target;
    }

    const originScope = originScopeFor(ctx.channel, conversationRef === ctx.conversationRef);
    const routine = await this.runner.createRoutine({
      tenant: ctx.tenant,
      userId: ctx.userId,
      name: args.name,
      cron: args.cron,
      prompt: args.prompt,
      channel: ctx.channel,
      conversationRef,
      timeoutMs: args.timeoutMs,
      ...(ctx.agentSlug ? { agentSlug: ctx.agentSlug } : {}),
      // #1743 / ADR 0240 — the creator's zone, else the instance's.
      timezone: resolveTimeZone(ctx.timeZone, this.defaultTimeZone),
      ...(ctx.mcpUserKey ? { mcpUserKey: ctx.mcpUserKey } : {}),
      ...(originScope ? { originScope } : {}),
    });
    return JSON.stringify({
      action: 'created',
      routine: this.summarise(routine),
    });
  }

  private async handleList(args: ManageRoutineInput): Promise<string> {
    const ctx = this.resolveContext();
    if (!ctx) {
      return ROUTINE_NO_CONTEXT_ERROR;
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
    // #1768 / ADR 0241 — the model gets this result in clear minus the
    // user-entered free text (`prompt`, `lastRunError`) and the sidecar
    // (`INTERN_FIELD_EXEMPT_TOOLS`): names, schedules and status it can act on.
    return JSON.stringify({
      action: 'list',
      count: filtered.length,
      filter,
      totals,
      routines: filtered.map((r) => this.summarise(r)),
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
    const ctx = this.resolveContext();
    if (!ctx) return ROUTINE_NO_CONTEXT_ERROR;
    const updated = await this.runner.pauseRoutine(args.id, actorScope(ctx));
    return JSON.stringify({
      action: 'paused',
      routine: this.summarise(updated),
    });
  }

  private async handleResume(args: ManageRoutineInput): Promise<string> {
    if (!args.id) return 'Error: `resume` requires `id`.';
    const ctx = this.resolveContext();
    if (!ctx) return ROUTINE_NO_CONTEXT_ERROR;
    const updated = await this.runner.resumeRoutine(args.id, actorScope(ctx));
    return JSON.stringify({
      action: 'resumed',
      routine: this.summarise(updated),
    });
  }

  private async handleRenew(args: ManageRoutineInput): Promise<string> {
    if (!args.id) return 'Error: `renew` requires `id`.';
    const ctx = this.resolveContext();
    if (!ctx) return ROUTINE_NO_CONTEXT_ERROR;
    const updated = await this.runner.renewRoutine(args.id, actorScope(ctx));
    return JSON.stringify({
      action: 'renewed',
      routine: this.summarise(updated),
    });
  }

  private async handleDelete(args: ManageRoutineInput): Promise<string> {
    if (!args.id) return 'Error: `delete` requires `id`.';
    const ctx = this.resolveContext();
    if (!ctx) return ROUTINE_NO_CONTEXT_ERROR;
    const ok = await this.runner.deleteRoutine(args.id, actorScope(ctx));
    return JSON.stringify({
      action: ok ? 'deleted' : 'not_found',
      id: args.id,
    });
  }
}

/**
 * #1025 — the scope every mutating action runs under. `create` and `list`
 * always resolved the turn context; `pause`, `resume` and `delete` did not,
 * and passed a bare id to a runner that filtered on nothing, so knowing an
 * id was enough to act on another tenant's routine. Every action now
 * derives its scope from the same context, which is why this helper exists
 * rather than three inline literals that could drift.
 */
export function actorScope(ctx: ManageRoutineContext): RoutineActorScope {
  return { kind: 'channel-user', tenant: ctx.tenant, userId: ctx.userId };
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
  /** #2082 — the routine's deadline; null until it is first scheduled. */
  until: string | null;
  /** #1743 / #1750 — the zone the cron pattern is evaluated in. */
  timeZone: string;
  /** #1750 — the next run in that zone (`2026-11-27 09:00 (Europe/Berlin)`), null when paused or past its deadline. */
  nextRun: string | null;
}

function summariseRoutine(r: Routine, now: Date): SummarisedRoutine {
  const timeZone = r.timezone ?? UTC_ZONE;
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
    until: r.until ? r.until.toISOString() : null,
    timeZone,
    nextRun: nextRunText(r, timeZone, now),
  };
}

function nextRunText(r: Routine, timeZone: string, now: Date): string | null {
  if (r.status !== 'active') return null;
  try {
    const next = nextCronRun(r.cron, timeZone, now);
    if (!next || (r.until && next > r.until)) return null;
    return formatInTimeZone(next, timeZone);
  } catch {
    return null;
  }
}

/**
 * #1767 — the input problems as a short list the model can act on, instead of
 * zod's JSON dump (which echoes the input back). Field paths and zod's own
 * messages only; never the rejected values.
 */
function describeInputIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : 'input'}: ${i.message}`)
    .join('; ');
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
  if (err instanceof JobValidationError) {
    // Cron / schedule validation: the scheduler's own message about the
    // model's input — the hint it needs to correct the call.
    return `Error: ${err.message}`;
  }
  // #1767 — a refusal written for the model (a schedule the trigger engine
  // refuses, a web routine outside a saved chat, ADR 0078) reaches it.
  const refusal = modelReadableToolErrorMessage(err);
  if (refusal !== undefined) return `Error: ${refusal}`;
  // Anything else (a store or database failure, a bug) is exception text
  // nobody sanitized: withheld from the model, logged in full under a ref.
  return toolErrorFromException(MANAGE_ROUTINE_TOOL_NAME, err, { site: 'routines' });
}
