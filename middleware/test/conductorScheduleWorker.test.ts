import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { ConductorScheduleWorker } from '../src/conductor/scheduleWorker.js';
import type { ConductorSchedule, ConductorScheduleStore } from '../src/conductor/scheduleStore.js';
import type { ConductorRunExecutor } from '../src/conductor/runExecutor.js';

// Conductor US4 (cron) — the schedule worker fires workflows on their cron triggers.
// Tick logic exercised with fakes (no Postgres); per-minute exactly-once lives in the SQL claim.

const NOON = new Date('2026-06-29T12:00:00.000Z');

function sched(id: string, slug: string, cron: string, workflowEnabled = true): ConductorSchedule {
  return {
    id, workflowId: `w-${id}`, workflowSlug: slug, workflowEnabled, cron, timezone: 'UTC',
    pollMinute: NOON, lastCheckedAt: new Date(NOON.getTime() - 60_000), lastRunAt: null,
  };
}

function fakes(opts: {
  schedules: ConductorSchedule[];
  claimWins?: boolean;
}): { store: ConductorScheduleStore; executor: ConductorRunExecutor; fired: string[]; claims: Array<{ id: string; willFire: boolean }> } {
  const fired: string[] = [];
  const claims: Array<{ id: string; willFire: boolean }> = [];
  const store = {
    async listForPoll() { return opts.schedules; },
    async claimPoll(schedule: ConductorSchedule, _claimer: string, willFire: boolean) {
      claims.push({ id: schedule.id, willFire });
      return opts.claimWins ?? true;
    },
  } as unknown as ConductorScheduleStore;
  const executor = {
    async startRun(input: { slug: string; triggerKind?: string }) {
      fired.push(`${input.slug}:${input.triggerKind}`);
      return { id: 'r1' } as never;
    },
  } as unknown as ConductorRunExecutor;
  return { store, executor, fired, claims };
}

describe('ConductorScheduleWorker.tick', () => {
  it('fires a matching, enabled, claim-won schedule as a cron run', async () => {
    const { store, executor, fired } = fakes({ schedules: [sched('s1', 'daily-report', '0 12 * * *')] });
    const worker = new ConductorScheduleWorker({ scheduleStore: store, executor });
    await worker.tick();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(fired, ['daily-report:cron']);
  });

  it('skips a schedule whose workflow is disabled', async () => {
    const { store, executor, fired, claims } = fakes({ schedules: [sched('s1', 'wf', '0 12 * * *', false)] });
    const logs: string[] = [];
    const worker = new ConductorScheduleWorker({ scheduleStore: store, executor, log: (msg) => logs.push(msg) });
    await worker.tick();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(fired, []);
    assert.deepEqual(claims, [{ id: 's1', willFire: false }]);
    assert.match(logs[0] ?? '', /workflow_or_schedule_disabled/);
  });

  it('does not fire when the cron does not match the current minute', async () => {
    const { store, executor, fired, claims } = fakes({ schedules: [sched('s1', 'wf', '0 13 * * *')] });
    const worker = new ConductorScheduleWorker({ scheduleStore: store, executor });
    await worker.tick();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(fired, []);
    assert.deepEqual(claims, [{ id: 's1', willFire: false }]);
  });

  it('does not fire when the per-minute claim is lost (another replica won)', async () => {
    const { store, executor, fired, claims } = fakes({
      schedules: [sched('s1', 'wf', '0 12 * * *')],
      claimWins: false,
    });
    const worker = new ConductorScheduleWorker({ scheduleStore: store, executor });
    await worker.tick();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(claims, [{ id: 's1', willFire: true }]);
    assert.deepEqual(fired, []); // but lost, so no run
  });

  it('fires in the stored zone and logs missed slots without replaying them', async () => {
    const schedule = {
      ...sched('s1', 'zoned', '*/2 14 * * *'),
      timezone: 'Europe/Berlin',
      lastCheckedAt: new Date('2026-06-29T11:54:00Z'),
      pollMinute: new Date('2026-06-29T12:06:00Z'),
    };
    const { store, executor, fired } = fakes({ schedules: [schedule] });
    const logs: string[] = [];
    const worker = new ConductorScheduleWorker({ scheduleStore: store, executor, log: (msg) => logs.push(msg) });
    await worker.tick();
    assert.deepEqual(fired, ['zoned:cron']);
    assert.match(logs.find((entry) => entry.includes('missed_slots_expired')) ?? '', /Europe\/Berlin.*matchingSlots=3/);
  });
});
