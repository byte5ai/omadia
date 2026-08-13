import { describe, expect, it } from 'vitest';

import type { DevGateView } from '@/app/admin/dev-platform/_lib/api';

import { findGateForJob, parseDevJobStartResult } from '../devJobChatCardState';

describe('parseDevJobStartResult', () => {
  it('parses a successful job_started result into a seed', () => {
    const out = JSON.stringify({
      status: 'job_started',
      jobId: 'job-1',
      repoId: 'repo-1',
      phase: 'queued',
    });
    expect(parseDevJobStartResult(out)).toEqual({
      jobId: 'job-1',
      repoId: 'repo-1',
      phase: 'queued',
    });
  });

  it('defaults phase to queued when absent', () => {
    const out = JSON.stringify({ status: 'job_started', jobId: 'j', repoId: 'r' });
    expect(parseDevJobStartResult(out)?.phase).toBe('queued');
  });

  it('returns null for an Error refusal string', () => {
    expect(
      parseDevJobStartResult('Error: repository "x" is not available to this agent'),
    ).toBeNull();
  });

  it('returns null for a non-launch JSON payload', () => {
    expect(parseDevJobStartResult(JSON.stringify({ jobs: [] }))).toBeNull();
    expect(parseDevJobStartResult(JSON.stringify({ status: 'other', jobId: 'j' }))).toBeNull();
  });

  it('returns null for undefined, empty, or malformed input', () => {
    expect(parseDevJobStartResult(undefined)).toBeNull();
    expect(parseDevJobStartResult('')).toBeNull();
    expect(parseDevJobStartResult('{ not json')).toBeNull();
    expect(parseDevJobStartResult(JSON.stringify({ status: 'job_started', jobId: 42 }))).toBeNull();
  });
});

function gate(over: Partial<DevGateView> = {}): DevGateView {
  return {
    id: 'gate-1',
    jobId: 'job-1',
    questions: [],
    planArtifactId: null,
    planSha256: null,
    deadlineAt: null,
    createdAt: '2026-07-11T00:00:00.000Z',
    resolvedHolders: [],
    ...over,
  };
}

describe('findGateForJob', () => {
  it('finds the waiting gate for a job', () => {
    const gates = [gate({ id: 'g-a', jobId: 'other' }), gate({ id: 'g-b', jobId: 'job-1' })];
    expect(findGateForJob(gates, 'job-1')?.id).toBe('g-b');
  });

  it('returns null when the job has no waiting gate', () => {
    expect(findGateForJob([gate({ jobId: 'other' })], 'job-1')).toBeNull();
    expect(findGateForJob([], 'job-1')).toBeNull();
  });
});
