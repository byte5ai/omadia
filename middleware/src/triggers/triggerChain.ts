/**
 * #2082 / #2085 — running a trigger's action chain, cheapest first
 * (spec 2042 §5.12 "What a firing does", §5.13).
 *
 *   check    no model: is there anything new, is the context still live, does
 *            a data action return rows or something changed? Finding nothing
 *            ends the chain as a success: monitoring continues.
 *   post     no model: a template filled with values from the engine.
 *   deliver  no model: a data action whose result goes through the side
 *            channel to the recipients; no model sees the rows.
 *   turn     a model turn under the agent's policy and budget, only where
 *            judgement or language is needed. It gets a status of what the
 *            checks found, never the rows.
 *   batch    a registered batch job (system only): due items are found
 *            without a model; nothing due ends the firing quietly; else a
 *            bounded batch runs under the same meters as a turn.
 */

import { createHash } from 'node:crypto';

import type { DataActionSpec, Occurrence, Trigger, TriggerStep } from './types.js';

/** What a data action returned. Rows stay in the harness. */
export type DataActionResult =
  | {
      readonly ok: true;
      readonly rows: readonly unknown[];
      readonly columns: readonly string[];
      /** The raw result the side channel renders. */
      readonly raw: unknown;
    }
  | { readonly ok: false; readonly error: string };

export type DeliveryOutcome =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly reason: string };

/** What the model sees of the firing: status, never data. */
export interface FiringStatus {
  readonly purpose: string;
  readonly occurrence: { readonly dueAt: string; readonly event?: Readonly<Record<string, unknown>> };
  readonly checks: readonly { readonly check: string; readonly rows?: number; readonly columns?: readonly string[] }[];
  readonly delivered: readonly string[];
}

export interface TurnOutcome {
  /** The turn produced an answer that reached its recipients. */
  readonly delivered: boolean;
  readonly costUsd: number;
  readonly modelCalls: number;
  readonly error?: string;
}

export interface BatchOutcome {
  /** Items due before the run (found without a model). */
  readonly due: number;
  readonly processed: number;
  readonly costUsd: number;
  readonly modelCalls: number;
  readonly error?: string;
}

export interface StepExecutors {
  /** Anything new in the trigger's context since its last firing. */
  newActivity(trigger: Trigger, occurrence: Occurrence): Promise<boolean>;
  /** Whether the trigger's context is still live; undefined = unknown. */
  contextLive(trigger: Trigger): Promise<boolean | undefined>;
  runDataAction(trigger: Trigger, action: DataActionSpec): Promise<DataActionResult>;
  post(trigger: Trigger, text: string): Promise<DeliveryOutcome>;
  deliver(trigger: Trigger, result: Extract<DataActionResult, { ok: true }>, title: string | undefined): Promise<DeliveryOutcome>;
  turn(trigger: Trigger, instruction: string, status: FiringStatus): Promise<TurnOutcome>;
  batch(trigger: Trigger, job: string): Promise<BatchOutcome>;
}

export interface ChainResult {
  readonly outcome: 'acted' | 'nothing' | 'failed';
  readonly turnRan: boolean;
  readonly turnEffective: boolean;
  readonly costUsd: number;
  readonly modelCalls: number;
  readonly fingerprint?: string;
  /** The context ended: the trigger ends with this firing. */
  readonly contextEnded: boolean;
  readonly error?: string;
  readonly steps: readonly string[];
}

/** A stable fingerprint of a data result, for `changed` checks. */
export function fingerprintRows(rows: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 32);
}

const PLACEHOLDER = /\{\{\s*([a-z_]+(?:\.[A-Za-z0-9_]+)?)\s*\}\}/g;

export interface TemplateValues {
  readonly purpose: string;
  readonly runs: number;
  readonly remainingRuns: number | null;
  readonly until: Date;
  readonly now: Date;
  readonly rows: number | null;
  readonly event: Readonly<Record<string, unknown>> | null;
  readonly timezone: string | null;
}

function formatDate(d: Date, timezone: string | null): string {
  return new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: timezone ?? 'UTC',
  }).format(d);
}

/** Fill a post template. Unknown or non-scalar values render empty. */
export function renderTemplate(template: string, v: TemplateValues): string {
  return template.replace(PLACEHOLDER, (_m, name: string) => {
    switch (name) {
      case 'purpose':
        return v.purpose;
      case 'runs':
        return String(v.runs);
      case 'remaining_runs':
        return v.remainingRuns === null ? '' : String(v.remainingRuns);
      case 'until':
        return formatDate(v.until, v.timezone);
      case 'minutes_left':
        return String(Math.max(0, Math.round((v.until.getTime() - v.now.getTime()) / 60_000)));
      case 'rows':
        return v.rows === null ? '' : String(v.rows);
      case 'now':
        return formatDate(v.now, v.timezone);
      default: {
        if (!name.startsWith('event.') || !v.event) return '';
        const value = v.event[name.slice('event.'.length)];
        return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
      }
    }
  });
}

const sameAction = (a: DataActionSpec, b: DataActionSpec): boolean =>
  a.tool === b.tool && JSON.stringify(a.input) === JSON.stringify(b.input);

/** Run the chain of one firing. Never throws: an error is a `failed` result. */
export async function runChain(
  trigger: Trigger,
  occurrence: Occurrence,
  exec: StepExecutors,
  now: Date,
): Promise<ChainResult> {
  const steps: string[] = [];
  const checks: { check: string; rows?: number; columns?: readonly string[] }[] = [];
  const delivered: string[] = [];
  let lastData: { action: DataActionSpec; result: Extract<DataActionResult, { ok: true }> } | undefined;
  let fingerprint: string | undefined;
  let acted = false;
  let turnRan = false;
  let turnEffective = false;
  let costUsd = 0;
  let modelCalls = 0;

  const result = (
    outcome: ChainResult['outcome'],
    extra: { error?: string; contextEnded?: boolean } = {},
  ): ChainResult => ({
    outcome,
    turnRan,
    turnEffective,
    costUsd,
    modelCalls,
    contextEnded: extra.contextEnded ?? false,
    steps,
    ...(fingerprint ? { fingerprint } : {}),
    ...(extra.error ? { error: extra.error } : {}),
  });

  const fetchData = async (action: DataActionSpec): Promise<Extract<DataActionResult, { ok: true }> | string> => {
    if (lastData && sameAction(lastData.action, action)) return lastData.result;
    const res = await exec.runDataAction(trigger, action);
    if (!res.ok) return res.error;
    lastData = { action, result: res };
    return res;
  };

  try {
    for (const step of trigger.actions) {
      steps.push(step.type === 'check' ? `check:${step.check}` : step.type);
      const stop = await runStep(step);
      if (stop) return stop;
    }
    return result(acted ? 'acted' : 'nothing');
  } catch (err) {
    return result('failed', { error: err instanceof Error ? err.message : String(err) });
  }

  async function runStep(step: TriggerStep): Promise<ChainResult | undefined> {
    switch (step.type) {
      case 'check': {
        if (step.check === 'new_activity') {
          // A hook's occurrence IS the new thing.
          if (trigger.kind === 'on_event') return undefined;
          const fresh = await exec.newActivity(trigger, occurrence);
          checks.push({ check: 'new_activity' });
          return fresh ? undefined : result(acted ? 'acted' : 'nothing');
        }
        if (step.check === 'context_live') {
          const live = await exec.contextLive(trigger);
          checks.push({ check: 'context_live' });
          return live === false ? result(acted ? 'acted' : 'nothing', { contextEnded: true }) : undefined;
        }
        const data = await fetchData(step.action);
        if (typeof data === 'string') return result('failed', { error: data });
        checks.push({ check: `data:${step.condition}`, rows: data.rows.length, columns: data.columns });
        if (step.condition === 'rows') return data.rows.length > 0 ? undefined : result(acted ? 'acted' : 'nothing');
        const fp = fingerprintRows(data.rows);
        const changed = fp !== trigger.lastFingerprint;
        fingerprint = fp;
        return changed ? undefined : result(acted ? 'acted' : 'nothing');
      }
      case 'post': {
        const text = renderTemplate(step.template, {
          purpose: trigger.purpose,
          runs: trigger.runs + 1,
          remainingRuns: trigger.maxRuns === null ? null : Math.max(0, trigger.maxRuns - trigger.runs - 1),
          until: trigger.until,
          now,
          rows: lastData ? lastData.result.rows.length : null,
          event: occurrence.payload,
          timezone: trigger.timezone,
        });
        const out = await exec.post(trigger, text);
        if (!out.delivered) return result('failed', { error: `post not delivered: ${out.reason}` });
        acted = true;
        delivered.push('post');
        return undefined;
      }
      case 'deliver': {
        const data = await fetchData(step.action);
        if (typeof data === 'string') return result('failed', { error: data });
        const out = await exec.deliver(trigger, data, step.title);
        if (!out.delivered) return result('failed', { error: `delivery failed: ${out.reason}` });
        acted = true;
        delivered.push(`deliver:${step.action.tool}`);
        return undefined;
      }
      case 'batch': {
        const out = await exec.batch(trigger, step.job);
        costUsd += out.costUsd;
        modelCalls += out.modelCalls;
        checks.push({ check: `batch:${step.job}`, rows: out.due });
        if (out.error) return result('failed', { error: out.error });
        if (out.due === 0) return result(acted ? 'acted' : 'nothing');
        turnRan = true;
        if (out.processed > 0) {
          turnEffective = true;
          acted = true;
        }
        return undefined;
      }
      case 'turn': {
        turnRan = true;
        const status: FiringStatus = {
          purpose: trigger.purpose,
          occurrence: {
            dueAt: occurrence.dueAt.toISOString(),
            ...(occurrence.payload ? { event: occurrence.payload } : {}),
          },
          checks,
          delivered,
        };
        const out = await exec.turn(trigger, step.instruction, status);
        costUsd += out.costUsd;
        modelCalls += out.modelCalls;
        if (out.error) return result('failed', { error: out.error });
        if (out.delivered) {
          turnEffective = true;
          acted = true;
          delivered.push('turn');
        }
        return undefined;
      }
    }
  }
}
