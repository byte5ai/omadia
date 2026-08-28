import { describe, expect, it } from 'vitest';

import type { UpdateStatus } from '../../../_lib/api';
import {
  decodeFailure,
  deriveOutcome,
  describesThisRun,
  stepStates,
  UPDATE_STEPS,
  type InflightUpdate,
} from '../_components/updateFailure';

/**
 * The pure half of the update dialog: which row is lit, how a failure is
 * decoded, and — the one that bites — whether the sidecar's status describes
 * THIS run or a previous one.
 */

function status(overrides: Partial<UpdateStatus> = {}, executor: Partial<UpdateStatus['executor']> = {}): UpdateStatus {
  return {
    current: { version: 'v0.90.1', source: 'release' },
    latest: null,
    updateAvailable: true,
    check: { checkedAt: 1, stale: false },
    executor: { configured: true, reachable: true, state: 'idle', steps: [], ...executor },
    auditAvailable: true,
    ...overrides,
  };
}

const RUN: InflightUpdate = { target: 'v0.120.0', previous: 'v0.90.1', startedAt: 1_000_000 };

describe('stepStates', () => {
  it('lights the current phase and finishes everything before it', () => {
    const s = stepStates('replace', null, false);
    expect(s.resolve).toBe('done');
    expect(s.preflight).toBe('done');
    expect(s.pin).toBe('done');
    expect(s.replace).toBe('current');
    expect(s.health_gate).toBe('pending');
  });

  it('marks nothing current while the sidecar has not reported a phase', () => {
    const s = stepStates(null, null, false);
    expect(Object.values(s).every((v) => v === 'pending')).toBe(true);
  });

  it('marks every row done on success', () => {
    const s = stepStates('done', null, true);
    expect(UPDATE_STEPS.every((step) => s[step] === 'done')).toBe(true);
  });

  it('marks the health gate failed and the rows before it done after a rollback', () => {
    const s = stepStates('rollback', { kind: 'health_gate', reason: 'never_reachable', observedVersion: null }, true);
    expect(s.replace).toBe('done');
    expect(s.health_gate).toBe('failed');
  });

  it('marks the row the job was in as failed when it threw without a structured failure', () => {
    // Unpullable image: the sidecar lands in state=failed, failure=null, phase=preflight.
    const s = stepStates('preflight', null, true, true);
    expect(s.resolve).toBe('done');
    expect(s.preflight).toBe('failed');
    expect(s.pin).toBe('pending');
    expect(s.health_gate).toBe('pending');
  });

  it('does not invent a failed row on success even with the flag unset', () => {
    const s = stepStates('done', null, true, false);
    expect(UPDATE_STEPS.every((step) => s[step] === 'done')).toBe(true);
  });

  it('marks the replace row failed and leaves the gate pending when a service could not be moved', () => {
    const s = stepStates('rollback', { kind: 'replace', service: 'web-ui' }, true);
    expect(s.pin).toBe('done');
    expect(s.replace).toBe('failed');
    expect(s.health_gate).toBe('pending');
  });
});

describe('decodeFailure', () => {
  it('prefers the structured failure', () => {
    expect(decodeFailure({ kind: 'health_gate', reason: 'never_reachable', observedVersion: null }, 'whatever'))
      .toEqual({ kind: 'never_reachable', service: null });
    expect(decodeFailure({ kind: 'health_gate', reason: 'version_never_matched', observedVersion: 'v0.90.1' }, ''))
      .toEqual({ kind: 'version_never_matched', observedVersion: 'v0.90.1', service: null });
    expect(decodeFailure({ kind: 'replace', service: 'middleware' }, ''))
      .toEqual({ kind: 'replace', service: 'middleware' });
  });

  // Two services are gated now, so "which one" is part of the answer. An
  // older sidecar reports no service at all, and null must stay distinguishable
  // from a named one — guessing "middleware" would be a fabrication.
  it('carries the failing service through, and null when none was reported', () => {
    expect(
      decodeFailure(
        { kind: 'health_gate', service: 'web-ui', reason: 'never_reachable', observedVersion: null },
        '',
      ),
    ).toEqual({ kind: 'never_reachable', service: 'web-ui' });
    expect(
      decodeFailure(
        {
          kind: 'health_gate',
          service: 'web-ui',
          reason: 'version_never_matched',
          observedVersion: 'v0.74.0',
        },
        '',
      ),
    ).toEqual({ kind: 'version_never_matched', observedVersion: 'v0.74.0', service: 'web-ui' });
  });

  it('falls back to the trail line for a sidecar that predates `failure`', () => {
    expect(decodeFailure(null, 'health gate failed: never_reachable (observed version: none)'))
      .toEqual({ kind: 'never_reachable', service: null });
    expect(decodeFailure(undefined, 'something else')).toEqual({ kind: 'unknown', message: 'something else' });
  });

  it('does not invent a reason for an unknown health verdict', () => {
    expect(decodeFailure({ kind: 'health_gate', reason: 'future_verdict', observedVersion: null }, 'msg'))
      .toEqual({ kind: 'unknown', message: 'msg' });
  });
});

describe('describesThisRun', () => {
  it('rejects a status for a different target', () => {
    expect(describesThisRun(status({}, { targetVersion: 'v0.119.0', startedAt: '2026-08-21T10:00:00Z' }).executor, RUN)).toBe(false);
  });

  it('rejects a job that started long before this click — last week\'s rollback must not close a fresh dialog', () => {
    const old = new Date(RUN.startedAt - 10 * 60_000).toISOString();
    expect(describesThisRun(status({}, { targetVersion: RUN.target, state: 'rolled_back', startedAt: old }).executor, RUN)).toBe(false);
  });

  it('rejects a job that FINISHED before the click even inside the skew window — fast retry after a replace failure', () => {
    const started = new Date(RUN.startedAt - 20_000).toISOString();
    const finished = new Date(RUN.startedAt - 5_000).toISOString();
    expect(describesThisRun(status({}, { targetVersion: RUN.target, state: 'rolled_back', startedAt: started, finishedAt: finished }).executor, RUN)).toBe(false);
  });

  it('accepts a job that started shortly before the click (clock skew)', () => {
    const skewed = new Date(RUN.startedAt - 30_000).toISOString();
    expect(describesThisRun(status({}, { targetVersion: RUN.target, startedAt: skewed }).executor, RUN)).toBe(true);
  });

  it('accepts a matching target when the sidecar does not stamp startedAt', () => {
    expect(describesThisRun(status({}, { targetVersion: RUN.target }).executor, RUN)).toBe(true);
  });

  it('rejects an unreachable executor outright', () => {
    expect(describesThisRun({ configured: true, reachable: false, targetVersion: RUN.target }, RUN)).toBe(false);
  });
});

describe('deriveOutcome', () => {
  const fresh = new Date(RUN.startedAt + 1_000).toISOString();

  it('is running while nothing has answered', () => {
    expect(deriveOutcome(null, RUN)).toBe('running');
  });

  it('is succeeded as soon as the middleware reports the target, whatever the sidecar says', () => {
    expect(deriveOutcome(status({ current: { version: 'v0.120.0', source: 'release' } }, { reachable: false }), RUN)).toBe('succeeded');
  });

  it('is rolled_back only for THIS run', () => {
    const ex = { targetVersion: RUN.target, state: 'rolled_back' as const, startedAt: fresh };
    expect(deriveOutcome(status({}, ex), RUN)).toBe('rolled_back');
    const stale = new Date(RUN.startedAt - 3_600_000).toISOString();
    expect(deriveOutcome(status({}, { ...ex, startedAt: stale }), RUN)).toBe('running');
  });

  it('is failed when the sidecar could not even roll back', () => {
    expect(deriveOutcome(status({}, { targetVersion: RUN.target, state: 'failed', startedAt: fresh }), RUN)).toBe('failed');
  });

  it('stays running while the sidecar is still updating', () => {
    expect(deriveOutcome(status({}, { targetVersion: RUN.target, state: 'updating', startedAt: fresh, phase: 'health_gate' }), RUN)).toBe('running');
  });
});
