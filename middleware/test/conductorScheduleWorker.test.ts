import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { ConductorScheduleWorker } from '../src/conductor/scheduleWorker.js';
import type { ConductorSchedule, ConductorScheduleStore } from '../src/conductor/scheduleStore.js';
import type { ConductorRunExecutor } from '../src/conductor/runExecutor.js';

// Conductor US4 (cron) — the schedule worker fires workflows on their cron triggers.
// Tick logic exercised with fakes (no Postgres); per-minute exactly-once lives in the SQL claim.

const NOON = () => new Date('2026-06-29T12:00:00.000Z'); // UTC — cronMatches reads UTC parts

function sched(id: string, slug: string, cron: string, workflowEnabled = true): ConductorSchedule {
  return { id, workflowId: `w-${id}`, workflowSlug: slug, workflowEnabled, cron, timezone: 'UTC' };
}

function fakes(opts: {
  schedules: ConductorSchedule[];
  claimWins?: boolean;
}): { store: ConductorScheduleStore; executor: ConductorRunExecutor; fired: string[]; claims: string[] } {
  const fired: string[] = [];
  const claims: string[] = [];
  const store = {
    async listEnabled() { return opts.schedules; },
    async claimRun(scheduleId: string) { claims.push(scheduleId); return opts.claimWins ?? true; },
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
    const worker = new ConductorScheduleWorker({ scheduleStore: store, executor, now: NOON });
    await worker.tick();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(fired, ['daily-report:cron']);
  });

  it('skips a schedule whose workflow is disabled', async () => {
    const { store, executor, fired, claims } = fakes({ schedules: [sched('s1', 'wf', '0 12 * * *', false)] });
    const worker = new ConductorScheduleWorker({ scheduleStore: store, executor, now: NOON });
    await worker.tick();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(fired, []);
    assert.deepEqual(claims, []); // never even attempts the claim
  });

  it('does not fire when the cron does not match the current minute', async () => {
    const { store, executor, fired, claims } = fakes({ schedules: [sched('s1', 'wf', '0 13 * * *')] });
    const worker = new ConductorScheduleWorker({ scheduleStore: store, executor, now: NOON });
    await worker.tick();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(fired, []);
    assert.deepEqual(claims, []);
  });

  it('does not fire when the per-minute claim is lost (another replica won)', async () => {
    const { store, executor, fired, claims } = fakes({
      schedules: [sched('s1', 'wf', '0 12 * * *')],
      claimWins: false,
    });
    const worker = new ConductorScheduleWorker({ scheduleStore: store, executor, now: NOON });
    await worker.tick();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(claims, ['s1']); // attempted
    assert.deepEqual(fired, []); // but lost, so no run
  });
});
