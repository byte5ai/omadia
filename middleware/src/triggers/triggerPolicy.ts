/**
 * #2082 — the harness rules every trigger request must pass (spec 2042 §5.12).
 * Pure: no database, no clock of its own. Not overridable by any prompt or
 * plugin; the values come from the kernel config.
 *
 *   - Mandatory deadline: no trigger without `until`, within the instance caps
 *     (one-shot 90 days, recurring and hooks 30 days by default).
 *   - A recurring trigger needs `max_runs`, a hook `max_fires`.
 *   - Minimum interval: 1 minute during a live meeting, 15 minutes otherwise.
 *   - Cheap first: a recurring or hook trigger that ends in a model `turn`
 *     gets a deterministic pre-check in front of it when it has none.
 *   - Budgets: per firing and per trigger, never above the instance maximum.
 */

import { isValidCron } from '../scheduler/cron.js';
import { EVENT_FIELDS } from './triggerChain.js';
import { createCron } from '../scheduler/cronerCompat.js';
import type {
  DataActionSpec,
  DeliveryClass,
  NewTrigger,
  TriggerContextKind,
  TriggerDiscretion,
  TriggerKind,
  TriggerOrigin,
  TriggerRefusal,
  TriggerRefusalCode,
  TriggerStep,
  TriggerTarget,
} from './types.js';

const DAY_MS = 86_400_000;
const MAX_PURPOSE = 500;
const MAX_TEMPLATE = 2_000;
const MAX_INSTRUCTION = 4_000;
const MAX_STEPS = 8;
const MAX_TOOL_NAME = 128;
const MAX_INPUT_JSON = 8_000;
const MAX_EVENT_ID = 200;
const CRON_SAMPLE = 12;

export interface TriggerLimits {
  readonly oneShotMaxDays: number;
  readonly recurringMaxDays: number;
  /** A trigger bound to a live meeting ends within this many hours. */
  readonly liveContextMaxHours: number;
  readonly minIntervalSecondsLive: number;
  readonly minIntervalSeconds: number;
  readonly maxActivePerAgent: number;
  readonly maxRunsCap: number;
  readonly perFiringUsdDefault: number;
  readonly perFiringUsdMax: number;
  readonly perTriggerUsdDefault: number;
  readonly perTriggerUsdMax: number;
  readonly modelCallsPerFiringDefault: number;
  readonly modelCallsPerFiringMax: number;
  readonly monthlyAgentUsd: number;
  readonly monthlyInstanceUsd: number;
  readonly breakerFailures: number;
  readonly breakerIneffective: number;
}

export const DEFAULT_TRIGGER_LIMITS: TriggerLimits = {
  oneShotMaxDays: 90,
  recurringMaxDays: 30,
  liveContextMaxHours: 12,
  minIntervalSecondsLive: 60,
  minIntervalSeconds: 15 * 60,
  maxActivePerAgent: 50,
  maxRunsCap: 10_000,
  perFiringUsdDefault: 0.1,
  perFiringUsdMax: 1,
  perTriggerUsdDefault: 2,
  perTriggerUsdMax: 20,
  modelCallsPerFiringDefault: 8,
  modelCallsPerFiringMax: 30,
  monthlyAgentUsd: 25,
  monthlyInstanceUsd: 200,
  breakerFailures: 3,
  breakerIneffective: 3,
};

/** What the harness knows about the request, never taken from the model. */
export interface TriggerEnvelope {
  readonly agentId: string;
  readonly agentSlug: string;
  readonly origin: TriggerOrigin;
  readonly ownerKey: string | null;
  readonly contextKind: TriggerContextKind;
  readonly contextId: string;
  /** The context is a live meeting: the shorter minimum interval applies. */
  readonly liveContext: boolean;
  readonly deliveryChannel: string | null;
  readonly deliveryRef: unknown;
  readonly discretion: TriggerDiscretion | null;
  readonly createdBy: string;
}

export const POST_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'purpose',
  'runs',
  'remaining_runs',
  'until',
  'minutes_left',
  'rows',
  'now',
]);

const PLACEHOLDER = /\{\{\s*([a-z_]+(?:\.[A-Za-z0-9_]+)?)\s*\}\}/g;

type Result<T> = { readonly ok: true; readonly value: T } | TriggerRefusal;

const refuse = (code: TriggerRefusalCode, message: string): TriggerRefusal => ({ ok: false, code, message });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const text = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : undefined;

function parseDate(v: unknown): Date | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * A moment for `time` / `until`: an ISO date-time, or a duration from now
 * (`'3m'`, `'+2h'`, `'in 1d'`). The model knows today's date but not the
 * clock, so "in two minutes" must not depend on it guessing the time.
 */
export function parseMoment(v: unknown, now: Date): Date | undefined {
  if (typeof v === 'string') {
    const rel = /^\s*(?:in\s+|\+)?(\d{1,6}\s*[smhd])\s*$/i.exec(v);
    if (rel) {
      const seconds = parseIntervalSeconds(rel[1]!.toLowerCase());
      return seconds === undefined ? undefined : new Date(now.getTime() + seconds * 1000);
    }
  }
  return parseDate(v);
}

/** Said with every time refusal, so the model can correct itself. */
const nowNote = (now: Date): string => ` (server time now: ${now.toISOString()}; a duration like '3m' counts from now)`;

/** `90s`, `5m`, `2h`, `1d` → seconds. */
export function parseIntervalSeconds(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const m = /^\s*(\d{1,6})\s*([smhd])\s*$/.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = { s: 1, m: 60, h: 3_600, d: 86_400 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return n > 0 ? n * unit : undefined;
}

function parsePositiveInt(v: unknown, cap: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= cap ? v : undefined;
}

function parseUsd(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** The placeholders a template uses that the harness cannot fill. */
export function unknownPlaceholders(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1] ?? '';
    if (name.startsWith('event.') && EVENT_FIELDS.has(name.slice('event.'.length))) continue;
    if (!POST_PLACEHOLDERS.has(name)) out.push(name);
  }
  return out;
}

function parseDataAction(v: unknown): DataActionSpec | undefined {
  if (!isRecord(v)) return undefined;
  const tool = text(v['tool'], MAX_TOOL_NAME);
  if (!tool) return undefined;
  const input = v['input'] === undefined ? {} : v['input'];
  if (!isRecord(input)) return undefined;
  if (JSON.stringify(input).length > MAX_INPUT_JSON) return undefined;
  return { tool, input };
}

function parseStep(v: unknown): Result<TriggerStep> {
  if (!isRecord(v)) return refuse('invalid', 'every action must be an object with a type');
  switch (v['type']) {
    case 'check': {
      const check = v['check'];
      if (check === 'new_activity') return { ok: true, value: { type: 'check', check } };
      if (check === 'context_live') return { ok: true, value: { type: 'check', check } };
      if (check === 'data') {
        const action = parseDataAction(v['action']);
        const condition = v['condition'] ?? 'rows';
        if (!action) return refuse('invalid', 'a data check needs action { tool, input }');
        if (condition !== 'rows' && condition !== 'changed') {
          return refuse('invalid', "a data check's condition is 'rows' or 'changed'");
        }
        return { ok: true, value: { type: 'check', check: 'data', action, condition } };
      }
      return refuse('invalid', "check is one of 'new_activity', 'context_live', 'data'");
    }
    case 'post': {
      const template = text(v['template'], MAX_TEMPLATE);
      if (!template) return refuse('invalid', `a post needs a template (at most ${String(MAX_TEMPLATE)} characters)`);
      const unknown = unknownPlaceholders(template);
      if (unknown.length > 0) {
        return refuse(
          'invalid',
          `unknown placeholder(s) ${unknown.map((u) => `{{${u}}}`).join(', ')}; allowed: ${[...POST_PLACEHOLDERS].map((p) => `{{${p}}}`).join(', ')}, ${[...EVENT_FIELDS].map((f) => `{{event.${f}}}`).join(', ')}`,
        );
      }
      return { ok: true, value: { type: 'post', template } };
    }
    case 'deliver': {
      const action = parseDataAction(v['action']);
      if (!action) return refuse('invalid', 'deliver needs action { tool, input }');
      const title = v['title'] === undefined ? undefined : text(v['title'], 200);
      return { ok: true, value: { type: 'deliver', action, ...(title ? { title } : {}) } };
    }
    case 'turn': {
      const instruction = text(v['instruction'], MAX_INSTRUCTION);
      if (!instruction) return refuse('invalid', 'a turn needs an instruction');
      return { ok: true, value: { type: 'turn', instruction } };
    }
    case 'batch': {
      const job = text(v['job'], 120);
      if (!job) return refuse('invalid', 'a batch needs a job id');
      return { ok: true, value: { type: 'batch', job } };
    }
    default:
      return refuse('invalid', "an action's type is one of 'check', 'post', 'deliver', 'turn'");
  }
}

/**
 * The chain as it runs: validated, and for recurring triggers and hooks with
 * a model turn, preceded by a deterministic pre-check when it has none (a
 * hook's own event counts as the "something new"; a timer needs
 * `new_activity`, a live context `context_live`).
 */
export function parseActions(
  raw: unknown,
  kind: TriggerKind,
  contextKind: TriggerContextKind,
  origin: TriggerOrigin = 'agent',
): Result<readonly TriggerStep[]> {
  if (!Array.isArray(raw) || raw.length === 0) return refuse('invalid', 'actions must be a non-empty list');
  if (raw.length > MAX_STEPS) return refuse('invalid', `at most ${String(MAX_STEPS)} actions`);
  const steps: TriggerStep[] = [];
  for (const item of raw) {
    const step = parseStep(item);
    if (!step.ok) return step;
    steps.push(step.value);
  }
  // A batch job is the kernel's own (learning, consolidation): no agent and
  // no routine owner can ask for one.
  if (origin !== 'system' && steps.some((s) => s.type === 'batch')) {
    return refuse('invalid', 'a batch action is reserved for the system');
  }
  const firstTurn = steps.findIndex((s) => s.type === 'turn');
  const hasCheckBeforeTurn = firstTurn > 0 && steps.slice(0, firstTurn).some((s) => s.type === 'check');
  // A routine's turn is what its owner asked for at that time: no pre-check
  // can tell "nothing new" for it, so it runs (within its budget).
  if (firstTurn >= 0 && !hasCheckBeforeTurn && kind !== 'wake_at' && origin === 'agent') {
    const prefix: TriggerStep[] = [];
    if (contextKind === 'meeting' || contextKind === 'facilitation') prefix.push({ type: 'check', check: 'context_live' });
    if (kind === 'wake_every') prefix.push({ type: 'check', check: 'new_activity' });
    return { ok: true, value: [...prefix, ...steps] };
  }
  return { ok: true, value: steps };
}

/** The shortest gap between consecutive runs of a cron pattern, in seconds. */
export function cronMinGapSeconds(cron: string, timezone: string | undefined, from: Date): number | undefined {
  try {
    const job = createCron(cron, timezone ? { timezone } : {});
    const runs = job.nextRuns(CRON_SAMPLE, from);
    if (runs.length < 2) return undefined;
    let min = Number.POSITIVE_INFINITY;
    for (let i = 1; i < runs.length; i += 1) {
      const gap = ((runs[i] as Date).getTime() - (runs[i - 1] as Date).getTime()) / 1000;
      if (gap < min) min = gap;
    }
    return min;
  } catch {
    return undefined;
  }
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseTarget(v: unknown): TriggerTarget | undefined {
  if (!isRecord(v)) return undefined;
  const channel = text(v['channel'], 64);
  if (!channel) return undefined;
  if (v['kind'] === 'conversation' && v['ref'] !== undefined) return { kind: 'conversation', channel, ref: v['ref'] };
  const principalId = text(v['principalId'], 256);
  if (v['kind'] === 'person' && principalId) return { kind: 'person', channel, principalId, ref: v['ref'] ?? null };
  return undefined;
}

/**
 * Validate a trigger request against the harness rules. `raw` is what the
 * agent (or the routine API) asked for; `env` is what the harness knows.
 */
export function validateTriggerRequest(
  kind: TriggerKind,
  raw: unknown,
  env: TriggerEnvelope,
  limits: TriggerLimits,
  now: Date,
): Result<NewTrigger> {
  if (!isRecord(raw)) return refuse('invalid', 'the request must be an object');
  const purpose = text(raw['purpose'], MAX_PURPOSE);
  if (!purpose) return refuse('invalid', `purpose is required (at most ${String(MAX_PURPOSE)} characters)`);

  if (raw['until'] === undefined || raw['until'] === null || raw['until'] === '') {
    return refuse('deadline_missing', 'every trigger needs a deadline (until)');
  }
  const until = parseMoment(raw['until'], now);
  if (!until) return refuse('invalid', `until must be an ISO date-time or a duration like '30m'${nowNote(now)}`);
  if (until.getTime() <= now.getTime()) return refuse('invalid', `until must lie in the future${nowNote(now)}`);
  const capDays = kind === 'wake_at' ? limits.oneShotMaxDays : limits.recurringMaxDays;
  if (until.getTime() - now.getTime() > capDays * DAY_MS) {
    return refuse('deadline_too_far', `until may lie at most ${String(capDays)} days ahead for ${kind}`);
  }
  if (env.liveContext && until.getTime() - now.getTime() > limits.liveContextMaxHours * 3_600_000) {
    return refuse('deadline_too_far', `a trigger in a live meeting ends within ${String(limits.liveContextMaxHours)} hours`);
  }

  let fireAt: Date | null = null;
  let intervalSeconds: number | null = null;
  let cron: string | null = null;
  let timezone: string | null = null;
  let eventId: string | null = null;
  let eventFilter: unknown = null;
  let maxRuns: number | null = null;

  const minInterval = env.liveContext ? limits.minIntervalSecondsLive : limits.minIntervalSeconds;

  if (kind === 'wake_at') {
    const time = parseMoment(raw['time'], now);
    if (!time) return refuse('invalid', `time must be an ISO date-time or a duration like '3m'${nowNote(now)}`);
    if (time.getTime() <= now.getTime()) return refuse('invalid', `time must lie in the future${nowNote(now)}`);
    if (time.getTime() > until.getTime()) return refuse('invalid', `time must not lie after until${nowNote(now)}`);
    fireAt = time;
  } else {
    const rawMax = kind === 'on_event' ? (raw['max_fires'] ?? raw['max_runs']) : raw['max_runs'];
    if (rawMax === undefined || rawMax === null) {
      return refuse('max_runs_missing', kind === 'on_event' ? 'a hook needs max_fires' : 'a recurring trigger needs max_runs');
    }
    const parsed = parsePositiveInt(rawMax, limits.maxRunsCap);
    if (parsed === undefined) return refuse('invalid', `max_runs must be a whole number from 1 to ${String(limits.maxRunsCap)}`);
    maxRuns = parsed;
  }

  if (kind === 'wake_every') {
    const tz = raw['timezone'];
    if (tz !== undefined) {
      if (typeof tz !== 'string' || !isValidTimezone(tz)) return refuse('invalid', 'timezone must be an IANA zone');
      timezone = tz;
    }
    if (typeof raw['cron'] === 'string' && raw['cron'].trim() !== '') {
      const c = raw['cron'].trim();
      if (!isValidCron(c)) return refuse('invalid', 'cron must be a valid 5-field expression');
      const gap = cronMinGapSeconds(c, timezone ?? undefined, now);
      if (gap === undefined) return refuse('invalid', 'cron must fire repeatedly');
      if (gap < minInterval) {
        return refuse('interval_too_short', `the interval must be at least ${String(minInterval / 60)} minute(s) here`);
      }
      cron = c;
    } else {
      const interval = parseIntervalSeconds(raw['interval']);
      if (interval === undefined) return refuse('invalid', "interval is required, for example '15m' or '1h'");
      if (interval < minInterval) {
        return refuse('interval_too_short', `the interval must be at least ${String(minInterval / 60)} minute(s) here`);
      }
      intervalSeconds = interval;
    }
  }

  if (kind === 'on_event') {
    const ev = text(raw['event'], MAX_EVENT_ID);
    if (!ev) return refuse('invalid', 'event is required (an id from the event-source catalogue)');
    eventId = ev;
    if (raw['filter'] !== undefined && raw['filter'] !== null) {
      if (!isRecord(raw['filter'])) return refuse('invalid', 'filter must be a predicate object');
      eventFilter = raw['filter'];
    }
  }

  const actions = parseActions(raw['actions'], kind, env.contextKind, env.origin);
  if (!actions.ok) return actions;

  const deliveryRaw = raw['delivery'] ?? 'droppable';
  if (deliveryRaw !== 'droppable' && deliveryRaw !== 'essential') {
    return refuse('invalid', "delivery is 'droppable' or 'essential'");
  }
  const deliveryClass: DeliveryClass = deliveryRaw;

  const budget = isRecord(raw['budget']) ? raw['budget'] : {};
  const perFiring = budget['per_firing_usd'] === undefined ? limits.perFiringUsdDefault : parseUsd(budget['per_firing_usd']);
  const total = budget['total_usd'] === undefined ? limits.perTriggerUsdDefault : parseUsd(budget['total_usd']);
  const calls =
    budget['model_calls_per_firing'] === undefined
      ? limits.modelCallsPerFiringDefault
      : parsePositiveInt(budget['model_calls_per_firing'], Number.MAX_SAFE_INTEGER);
  if (perFiring === undefined || total === undefined || calls === undefined) {
    return refuse('invalid', 'budget values must be non-negative numbers');
  }
  if (perFiring > limits.perFiringUsdMax || total > limits.perTriggerUsdMax || calls > limits.modelCallsPerFiringMax) {
    return refuse(
      'budget_too_high',
      `budget caps: ${String(limits.perFiringUsdMax)} USD per firing, ${String(limits.perTriggerUsdMax)} USD per trigger, ${String(limits.modelCallsPerFiringMax)} model calls per firing`,
    );
  }

  let target: TriggerTarget | null = null;
  if (raw['target'] !== undefined && raw['target'] !== null) {
    const parsed = parseTarget(raw['target']);
    if (!parsed) return refuse('invalid', 'target must be { kind: conversation|person, channel, ref | principalId }');
    target = parsed;
  }

  return {
    ok: true,
    value: {
      agentId: env.agentId,
      agentSlug: env.agentSlug,
      kind,
      origin: env.origin,
      ownerKey: env.ownerKey,
      purpose,
      contextKind: env.contextKind,
      contextId: env.contextId,
      deliveryChannel: env.deliveryChannel,
      deliveryRef: env.deliveryRef,
      target,
      discretion: env.discretion,
      eventId,
      eventFilter,
      fireAt,
      intervalSeconds,
      cron,
      timezone,
      liveContext: env.liveContext,
      actions: actions.value,
      deliveryClass,
      until,
      maxRuns,
      budgetPerFiringUsd: perFiring,
      budgetTotalUsd: total,
      modelCallsPerFiring: calls,
      createdBy: env.createdBy,
    },
  };
}

/** Whether a chain can reach a model at all: only a `turn` does. */
export function chainUsesModel(actions: readonly TriggerStep[]): boolean {
  return actions.some((s) => s.type === 'turn' || s.type === 'batch');
}
