/**
 * #2082 — the harness tools an agent uses to set itself hooks, wakeups and
 * timers (spec 2042 §5.12), plus `list_triggers` (what it is watching, and
 * which events it could hook) and `cancel_trigger`.
 *
 * Offered only on a turn with a person's conversation context: the trigger
 * belongs to that conversation, its messages go there, and it carries that
 * context's labels. The harness, not the model, decides agent, context,
 * delivery target and limits; the model chooses purpose, time, actions.
 */

import { createHash } from 'node:crypto';

import { checkFlow, fieldClassesFromList } from '@omadia/orchestrator';

import type { NativeToolSpec } from '@omadia/plugin-api';

import type { TriggerEnvelope } from './triggerPolicy.js';
import type { CreateTriggerResult, TriggerService } from './triggerService.js';
import { conversationContextId } from './triggerService.js';
import type { Trigger, TriggerDiscretion, TriggerKind } from './types.js';

export const TRIGGER_TOOL_NAMES = ['on_event', 'wake_at', 'wake_every', 'list_triggers', 'cancel_trigger'] as const;
export type TriggerToolName = (typeof TRIGGER_TOOL_NAMES)[number];

/** The person's turn the tool was called in. */
export interface TriggerToolTurn {
  readonly agentId: string;
  readonly agentSlug: string;
  readonly tenant: string;
  readonly userId: string;
  readonly channel: string;
  readonly conversationRef: unknown;
  /** The conversation's discretion as this turn has it (INV-9): its context
   *  key and everything the turn read. Null outside a labelled turn. */
  readonly discretion: () => Promise<TriggerDiscretion | null>;
}

const ACTIONS_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: 8,
  description:
    'What each firing does, cheapest first. `check` (no model): `new_activity` (anything new here since the last firing), `context_live` (meeting still running), `data` (run one of your read tools; `condition` `rows` = go on if it returns rows, `changed` = go on if the result changed). `post` (no model): a template, placeholders {{purpose}} {{runs}} {{remaining_runs}} {{until}} {{minutes_left}} {{rows}} {{now}}, and for a hook the ids and kind of the event ({{event.kind}} {{event.status}} {{event.id}} {{event.messageId}}; never its content). `deliver` (no model): run one of your read tools and send the result as a table — you never see the rows. `turn` (model, costs budget): only where judgement or language is needed; you get a status of the checks, not the data. A check that finds nothing ends the firing quietly.',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['check', 'post', 'deliver', 'turn'] },
      check: { type: 'string', enum: ['new_activity', 'context_live', 'data'] },
      condition: { type: 'string', enum: ['rows', 'changed'] },
      action: {
        type: 'object',
        properties: { tool: { type: 'string' }, input: { type: 'object' } },
        required: ['tool'],
      },
      template: { type: 'string' },
      title: { type: 'string' },
      instruction: { type: 'string' },
    },
    required: ['type'],
  },
} as const;

const COMMON = {
  purpose: { type: 'string', description: 'Why you watch or wake, in one sentence (shown to operators and users).' },
  until: { type: 'string', description: 'Mandatory deadline (ISO date-time). The trigger is deleted then. At most 90 days ahead for wake_at, 30 days otherwise, 12 hours in a live meeting.' },
  context: {
    type: 'string',
    enum: ['conversation', 'meeting'],
    description: "What the trigger belongs to: this conversation (default) or this conversation as a live meeting (1-minute minimum interval; ends with the meeting).",
  },
  delivery: { type: 'string', enum: ['droppable', 'essential'], description: "'droppable' (default): reminders and nudges, never repeated after an unknown outcome. 'essential': retried until confirmed." },
  budget: {
    type: 'object',
    description: 'Optional, within the instance caps: per_firing_usd, total_usd, model_calls_per_firing. Only `turn` actions spend.',
    properties: {
      per_firing_usd: { type: 'number' },
      total_usd: { type: 'number' },
      model_calls_per_firing: { type: 'integer' },
    },
  },
  actions: ACTIONS_SCHEMA,
} as const;

export const triggerToolSpecs: Record<TriggerToolName, NativeToolSpec> = {
  on_event: {
    name: 'on_event',
    description:
      'Preferred way to act unasked: hook an event (new message here, meeting ended, a poll answered, an integration event). Use `list_triggers` to see which events your channels and capabilities offer. Fires at most max_fires times and ends at `until` or when its context ends. Do not ask the user for permission to watch; decide from context.',
    input_schema: {
      type: 'object',
      properties: {
        event: { type: 'string', description: 'An event id from the event-source catalogue.' },
        filter: { type: 'object', description: 'Optional predicate on the event payload, e.g. {"op":"eq","path":"ctx.kind","value":"question"}.' },
        max_fires: { type: 'integer', minimum: 1 },
        ...COMMON,
      },
      required: ['event', 'purpose', 'until', 'max_fires', 'actions'],
    },
  },
  wake_at: {
    name: 'wake_at',
    description:
      'One-shot wakeup at a time, e.g. "three working days before month end, look at the open expense reports". Fires once, then it is gone.',
    input_schema: {
      type: 'object',
      properties: {
        time: { type: 'string', description: 'When to wake (ISO date-time, in the future).' },
        ...COMMON,
      },
      required: ['time', 'purpose', 'until', 'actions'],
    },
  },
  wake_every: {
    name: 'wake_every',
    description:
      'Recurring timer, only while needed, e.g. time-keeping every 5 minutes during a meeting. Needs max_runs and until. Minimum interval 15 minutes, 1 minute in a live meeting. Prefer on_event where an event exists.',
    input_schema: {
      type: 'object',
      properties: {
        interval: { type: 'string', description: "Interval like '5m', '1h', '1d'." },
        cron: { type: 'string', description: 'Alternative to interval: a 5-field cron pattern.' },
        timezone: { type: 'string', description: 'IANA zone for cron, e.g. Europe/Berlin.' },
        max_runs: { type: 'integer', minimum: 1 },
        ...COMMON,
      },
      required: ['purpose', 'until', 'max_runs', 'actions'],
    },
  },
  list_triggers: {
    name: 'list_triggers',
    description:
      'What you are currently watching or waiting for in this conversation (your hooks, wakeups and timers with purpose, deadline and cost so far), and the events you could hook. Use it when someone asks what you are watching for them.',
    input_schema: { type: 'object', properties: {} },
  },
  cancel_trigger: {
    name: 'cancel_trigger',
    description: 'End one of your triggers in this conversation early (id from list_triggers).',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A conversation id from a channel's opaque conversation reference. */
export function conversationIdOf(ref: unknown): string {
  if (isRecord(ref)) {
    for (const key of ['conversationId', 'sessionId', 'chatId', 'channelId', 'threadId']) {
      const v = ref[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    const conv = ref['conversation'];
    if (isRecord(conv) && typeof conv['id'] === 'string' && conv['id'].length > 0) return conv['id'];
  }
  return `ref-${createHash('sha256').update(JSON.stringify(ref ?? null)).digest('hex').slice(0, 24)}`;
}

/** Teams meeting chats carry `meeting` in their conversation id. */
const isMeetingConversation = (conversationId: string): boolean => /meeting/i.test(conversationId);

export function triggerSummary(t: Trigger): Record<string, unknown> {
  return {
    id: t.id,
    kind: t.kind,
    purpose: t.purpose,
    state: t.state,
    ...(t.pauseReason ? { pausedBecause: t.pauseReason } : {}),
    context: t.contextKind,
    until: t.until.toISOString(),
    ...(t.eventId ? { event: t.eventId } : {}),
    ...(t.fireAt ? { at: t.fireAt.toISOString() } : {}),
    ...(t.intervalSeconds ? { everySeconds: t.intervalSeconds } : {}),
    ...(t.cron ? { cron: t.cron, timezone: t.timezone ?? 'UTC' } : {}),
    runs: t.runs,
    ...(t.maxRuns !== null ? { maxRuns: t.maxRuns } : {}),
    actions: t.actions.map((a) => (a.type === 'check' ? `check:${a.check}` : a.type)),
    spentUsd: t.spentUsd,
    budgetUsd: t.budgetTotalUsd,
    ...(t.lastOutcome ? { lastOutcome: t.lastOutcome } : {}),
  };
}

const errorText = (res: Extract<CreateTriggerResult, { ok: false }>): string => `Error (${res.code}): ${res.message}`;

export interface TriggerToolDeps {
  readonly service: TriggerService;
  /** The person's turn, or undefined outside one (the tool is not offered). */
  readonly currentTurn: () => TriggerToolTurn | undefined;
}

/** May the trigger's own conversation know everything its creating turn had read? */
export function discretionAllowsRoom(discretion: TriggerDiscretion): boolean {
  return checkFlow(discretion.labels, {
    kind: 'people',
    contextKey: discretion.contextKey,
    readers: discretion.readers,
    fieldClasses: fieldClassesFromList(discretion.fieldClasses),
  }).allowed;
}

export function createTriggerToolHandler(name: TriggerToolName, deps: TriggerToolDeps): (input: unknown) => Promise<string> {
  return async (input: unknown): Promise<string> => {
    const turn = deps.currentTurn();
    if (!turn) return 'Error (no_context): triggers can only be set in a conversation with a person.';
    const raw = isRecord(input) ? input : {};

    const conversationId = conversationIdOf(turn.conversationRef);
    // The agent sees and ends only what it set itself in THIS conversation:
    // not other conversations' hooks, not a person's routine, not the
    // system's schedules or batch jobs.
    const here = conversationContextId(turn.channel, conversationId);
    const ownHere = (t: Trigger): boolean => t.agentId === turn.agentId && t.origin === 'agent' && t.contextId === here;

    if (name === 'list_triggers') {
      const mine = (await deps.service.listForContext('conversation', here)).concat(
        await deps.service.listForContext('meeting', here),
      );
      return JSON.stringify({
        triggers: mine.filter(ownHere).map(triggerSummary),
        eventSources: deps.service.eventSourcesFor(turn.agentSlug),
      });
    }
    if (name === 'cancel_trigger') {
      const id = typeof raw['id'] === 'string' ? raw['id'] : '';
      const t = /^[0-9a-f-]{36}$/i.test(id) ? await deps.service.get(id) : undefined;
      if (!t || !ownHere(t)) return 'Error (invalid): no such trigger of yours in this conversation.';
      await deps.service.end(t.id, 'cancelled', { by: `agent:${turn.agentSlug}` });
      return JSON.stringify({ cancelled: t.id });
    }

    const wantsMeeting = raw['context'] === 'meeting';
    if (wantsMeeting && !isMeetingConversation(conversationId)) {
      return 'Error (invalid): this conversation is not a meeting; use context "conversation".';
    }
    const env: TriggerEnvelope = {
      agentId: turn.agentId,
      agentSlug: turn.agentSlug,
      origin: 'agent',
      ownerKey: null,
      contextKind: wantsMeeting ? 'meeting' : 'conversation',
      contextId: conversationContextId(turn.channel, conversationId),
      liveContext: wantsMeeting,
      deliveryChannel: turn.channel,
      deliveryRef: turn.conversationRef,
      discretion: await turn.discretion(),
      createdBy: `agent:${turn.agentSlug} for ${turn.tenant}/${turn.userId}`,
    };
    // INV-9 — a post or delivery this conversation may not receive would be
    // withheld on every firing; say so now instead.
    const sends = Array.isArray(raw['actions']) && raw['actions'].some((a) => isRecord(a) && (a['type'] === 'post' || a['type'] === 'deliver'));
    if (sends && env.discretion && !discretionAllowsRoom(env.discretion)) {
      return 'Error (discretion): this conversation has touched information not everyone here may know, so a post or delivery from this trigger would be withheld. Set it where everyone may know what it refers to.';
    }
    const res = await deps.service.create(name as TriggerKind, raw, env);
    return res.ok ? JSON.stringify({ created: triggerSummary(res.trigger) }) : errorText(res);
  };
}
