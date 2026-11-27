/**
 * #2082 — the harness rules for agent-owned triggers (spec 2042 §5.12,
 * acceptance criterion 20, first sentence): a trigger without deadline, a
 * recurring trigger without max_runs, or an interval below the minimum is
 * refused; recurring chains that reach a model get a model-free pre-check.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DEFAULT_TRIGGER_LIMITS,
  parseIntervalSeconds,
  unknownPlaceholders,
  validateTriggerRequest,
  type TriggerEnvelope,
} from '../src/triggers/triggerPolicy.js';
import { renderTemplate } from '../src/triggers/triggerChain.js';
import { firstDue, nextDue } from '../src/triggers/triggerSchedule.js';
import type { TriggerKind } from '../src/triggers/types.js';

const NOW = new Date('2026-11-20T10:00:00Z');
const inMinutes = (m: number): string => new Date(NOW.getTime() + m * 60_000).toISOString();
const inDays = (d: number): string => new Date(NOW.getTime() + d * 86_400_000).toISOString();

const env = (over: Partial<TriggerEnvelope> = {}): TriggerEnvelope => ({
  agentId: '00000000-0000-0000-0000-000000000001',
  agentSlug: 'erika',
  origin: 'agent',
  ownerKey: null,
  contextKind: 'conversation',
  contextId: 'teams:19:abc',
  liveContext: false,
  deliveryChannel: 'teams',
  deliveryRef: { conversationId: '19:abc' },
  discretion: null,
  createdBy: 'agent:erika',
  ...over,
});

const validate = (kind: TriggerKind, raw: Record<string, unknown>, e: TriggerEnvelope = env()) =>
  validateTriggerRequest(kind, raw, e, DEFAULT_TRIGGER_LIMITS, NOW);

const post = [{ type: 'post', template: 'Erinnerung: {{purpose}}' }];

describe('#2082 trigger policy (criterion 20)', () => {
  it('refuses a trigger without a deadline', () => {
    for (const kind of ['wake_at', 'wake_every', 'on_event'] as const) {
      const res = validate(kind, { purpose: 'x', time: inMinutes(30), interval: '15m', max_runs: 3, event: 'e', actions: post });
      assert.equal(res.ok, false);
      assert.equal(!res.ok && res.code, 'deadline_missing', kind);
    }
  });

  it('refuses a recurring trigger without max_runs and a hook without max_fires', () => {
    const every = validate('wake_every', { purpose: 'x', until: inDays(1), interval: '15m', actions: post });
    assert.equal(!every.ok && every.code, 'max_runs_missing');
    const hook = validate('on_event', { purpose: 'x', until: inDays(1), event: 'teams.message.posted', actions: post });
    assert.equal(!hook.ok && hook.code, 'max_runs_missing');
  });

  it('refuses an interval below the minimum: 15 minutes, 1 minute in a live meeting', () => {
    const short = validate('wake_every', { purpose: 'x', until: inDays(1), interval: '5m', max_runs: 10, actions: post });
    assert.equal(!short.ok && short.code, 'interval_too_short');
    const live = env({ contextKind: 'meeting', liveContext: true });
    const meeting = validate('wake_every', { purpose: 'x', until: inMinutes(60), interval: '5m', max_runs: 12, actions: post }, live);
    assert.equal(meeting.ok, true);
    const tooFast = validate('wake_every', { purpose: 'x', until: inMinutes(60), interval: '30s', max_runs: 12, actions: post }, live);
    assert.equal(!tooFast.ok && tooFast.code, 'interval_too_short');
  });

  it('measures a cron pattern by its shortest gap', () => {
    const everyFive = validate('wake_every', { purpose: 'x', until: inDays(1), cron: '*/5 * * * *', max_runs: 10, actions: post });
    assert.equal(!everyFive.ok && everyFive.code, 'interval_too_short');
    const daily = validate('wake_every', { purpose: 'x', until: inDays(20), cron: '0 8 * * 1-5', timezone: 'Europe/Berlin', max_runs: 20, actions: post });
    assert.equal(daily.ok, true);
  });

  it('caps the deadline: one-shot 90 days, recurring and hooks 30 days', () => {
    const far = validate('wake_at', { purpose: 'x', time: inDays(80), until: inDays(91), actions: post });
    assert.equal(!far.ok && far.code, 'deadline_too_far');
    assert.equal(validate('wake_at', { purpose: 'x', time: inDays(80), until: inDays(89), actions: post }).ok, true);
    const hook = validate('on_event', { purpose: 'x', until: inDays(31), event: 'e', max_fires: 3, actions: post });
    assert.equal(!hook.ok && hook.code, 'deadline_too_far');
  });

  it('refuses a budget above the instance caps', () => {
    const res = validate('wake_at', { purpose: 'x', time: inMinutes(30), until: inMinutes(60), actions: post, budget: { total_usd: 1000 } });
    assert.equal(!res.ok && res.code, 'budget_too_high');
  });

  it('puts a deterministic pre-check in front of a recurring model turn', () => {
    const res = validate('wake_every', {
      purpose: 'Zeit im Blick',
      until: inMinutes(60),
      interval: '5m',
      max_runs: 12,
      actions: [{ type: 'turn', instruction: 'Fasse zusammen' }],
    }, env({ contextKind: 'meeting', liveContext: true }));
    assert.ok(res.ok);
    assert.deepEqual(res.value.actions.map((a) => (a.type === 'check' ? `check:${a.check}` : a.type)), [
      'check:context_live',
      'check:new_activity',
      'turn',
    ]);
  });

  it('keeps an explicit check and a one-shot turn as they are', () => {
    const res = validate('wake_at', { purpose: 'x', time: inMinutes(30), until: inMinutes(60), actions: [{ type: 'turn', instruction: 'go' }] });
    assert.ok(res.ok);
    assert.deepEqual(res.value.actions.map((a) => a.type), ['turn']);
  });

  it('refuses unknown template placeholders', () => {
    // #2082 review — an event's content (a title, an amount) is no placeholder.
    assert.deepEqual(unknownPlaceholders('{{purpose}} {{secret}} {{event.title}} {{event.status}}'), ['secret', 'event.title']);
    const res = validate('wake_at', { purpose: 'x', time: inMinutes(30), until: inMinutes(60), actions: [{ type: 'post', template: '{{password}}' }] });
    assert.equal(!res.ok && res.code, 'invalid');
  });

  it('parses intervals', () => {
    assert.equal(parseIntervalSeconds('5m'), 300);
    assert.equal(parseIntervalSeconds('2h'), 7200);
    assert.equal(parseIntervalSeconds('5 minutes'), undefined);
    assert.equal(parseIntervalSeconds(0), undefined);
  });
});

describe('#2082 schedule and templates', () => {
  it('anchors an interval at the previous due time and skips missed slots', () => {
    const t = { kind: 'wake_every' as const, fireAt: null, intervalSeconds: 300, cron: null, timezone: null, until: new Date(inMinutes(60)) };
    assert.equal(firstDue(t, NOW)?.toISOString(), inMinutes(5));
    assert.equal(nextDue(t, new Date(inMinutes(5)), new Date(inMinutes(6)))?.toISOString(), inMinutes(10));
    // A 22-minute outage: the next slot is the next one ahead, not three back to back.
    assert.equal(nextDue(t, new Date(inMinutes(5)), new Date(inMinutes(27)))?.toISOString(), inMinutes(30));
    assert.equal(nextDue(t, new Date(inMinutes(60)), new Date(inMinutes(60))), undefined);
  });

  it('fills a post template from engine values only', () => {
    const text = renderTemplate('Noch {{minutes_left}} Minuten für „{{purpose}}" ({{event.status}}){{event.title}}{{event.nested}}', {
      purpose: 'Schritt 2',
      runs: 3,
      remainingRuns: 9,
      until: new Date(inMinutes(5)),
      now: NOW,
      rows: null,
      event: { status: 'offen', title: 'Rechnung Müller GmbH', nested: { a: 1 } },
      timezone: 'Europe/Berlin',
    });
    assert.equal(text, 'Noch 5 Minuten für „Schritt 2" (offen)', 'ids and kinds only, never content');
  });
});

describe('trigger times the model can state without a clock (E2E 2026-11-23)', () => {
  const post = [{ type: 'post', template: 'E2E-Ping' }];

  it('takes durations from now for time and until', () => {
    const res = validate('wake_at', { purpose: 'ping', time: '3m', until: 'in 30m', actions: post });
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.value.fireAt?.toISOString(), inMinutes(3));
    assert.equal(res.value.until.toISOString(), inMinutes(30));
    const plus = validate('wake_every', { purpose: 'tick', interval: '15m', max_runs: 2, until: '+2h', actions: post });
    assert.ok(plus.ok, JSON.stringify(plus));
    assert.equal(plus.value.until.toISOString(), inMinutes(120));
  });

  it('still takes ISO date-times and refuses garbage', () => {
    assert.ok(validate('wake_at', { purpose: 'p', time: inMinutes(5), until: inMinutes(10), actions: post }).ok);
    const bad = validate('wake_at', { purpose: 'p', time: 'soon', until: '30m', actions: post });
    assert.equal(bad.ok, false);
  });

  it('names the server time when a moment lies in the past', () => {
    const res = validate('wake_at', { purpose: 'p', time: '2026-11-20T06:08:00Z', until: '2026-11-20T06:35:00Z', actions: post });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.message, /until must lie in the future/);
    assert.match(res.message, /server time now: 2026-11-20T10:00:00\.000Z/);
  });
});

describe('#2339 a trigger takes the person\'s zone when it names none', () => {
  const post = [{ type: 'post', template: 'aktuelle Uhrzeit: {{now}}' }];

  it('a wake_at from a Berlin chat renders {{now}} in Berlin time', () => {
    const res = validateTriggerRequest('wake_at', { purpose: 'p', time: '1m', until: '30m', actions: post }, env({ timezone: 'Europe/Berlin' }), DEFAULT_TRIGGER_LIMITS, NOW);
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.value.timezone, 'Europe/Berlin');
    const text = renderTemplate('{{now}}', {
      purpose: 'p', runs: 1, remainingRuns: 0, until: res.value.until, now: NOW, rows: null, event: null, timezone: res.value.timezone,
    });
    assert.match(text, /11:00/, 'NOW is 10:00 UTC = 11:00 in Berlin');
  });

  it('a cron without its own zone runs in the person\'s zone; a named zone wins', () => {
    const daily = { purpose: 'x', until: inDays(20), cron: '0 8 * * 1-5', max_runs: 20, actions: post };
    const own = validateTriggerRequest('wake_every', daily, env({ timezone: 'Europe/Berlin' }), DEFAULT_TRIGGER_LIMITS, NOW);
    assert.ok(own.ok, JSON.stringify(own));
    assert.equal(own.value.timezone, 'Europe/Berlin');
    const named = validateTriggerRequest('wake_every', { ...daily, timezone: 'America/New_York' }, env({ timezone: 'Europe/Berlin' }), DEFAULT_TRIGGER_LIMITS, NOW);
    assert.ok(named.ok, JSON.stringify(named));
    assert.equal(named.value.timezone, 'America/New_York');
  });

  it('without a zone on the envelope it stays UTC, as before', () => {
    const res = validateTriggerRequest('wake_at', { purpose: 'p', time: '1m', until: '30m', actions: post }, env(), DEFAULT_TRIGGER_LIMITS, NOW);
    assert.ok(res.ok, JSON.stringify(res));
    assert.equal(res.value.timezone, null);
  });
});
