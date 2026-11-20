import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import type { TriggerDto, TriggerOverviewDto } from '../../../_lib/triggers';

/**
 * #2082 — the operator sees what agents do unasked, with purpose, deadline
 * and cost, and can pause, resume and end each trigger.
 */

const { mockGet, mockPause, mockResume, mockEnd } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPause: vi.fn(),
  mockResume: vi.fn(),
  mockEnd: vi.fn(),
}));

vi.mock('../../../_lib/triggers', () => ({
  getTriggerOverview: mockGet,
  pauseTrigger: mockPause,
  resumeTrigger: mockResume,
  endTrigger: mockEnd,
}));

const { TriggerOverview } = await import('../_components/TriggerOverview');

const t = en.operatorTriggers;

const TRIGGER: TriggerDto = {
  id: '11111111-1111-1111-1111-111111111111',
  agent: 'erika',
  agentId: 'a-erika',
  kind: 'wake_every',
  origin: 'agent',
  purpose: 'Überfällige Rechnungen melden',
  state: 'active',
  context: 'conversation',
  contextId: 'teams:19:abc',
  until: '2026-12-20T08:00:00.000Z',
  everySeconds: 3600,
  runs: 2,
  maxRuns: 10,
  actions: ['check:new_activity', 'deliver'],
  spentUsd: 0,
  budgetUsd: 2,
  lastFiredAt: null,
  lastError: null,
  createdBy: 'agent:erika',
  createdAt: '2026-11-20T08:00:00.000Z',
};

const overview = (triggers: TriggerDto[]): TriggerOverviewDto => ({
  month: '2026-11-01',
  instance: { spentUsd: 1.5, reservedUsd: 0.1 },
  caps: { monthlyInstanceUsd: 200, monthlyAgentUsd: 25, perTriggerUsd: 20, perFiringUsd: 1, maxActivePerAgent: 50 },
  agents: { 'a-erika': { spentUsd: 0.75, reservedUsd: 0 } },
  triggers,
  jobs: [],
  batchJobs: [{ id: 'orchestrator-extras.scratch-promotion', purpose: 'Consolidate notes', intervalMinutes: 60 }],
});

describe('TriggerOverview', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPause.mockReset();
    mockResume.mockReset();
    mockEnd.mockReset();
  });

  it('lists purpose, agent and controls; pausing re-reads the list', async () => {
    mockPause.mockResolvedValue(undefined);
    mockGet.mockResolvedValue(overview([{ ...TRIGGER, state: 'paused', pausedBecause: 'operator' }]));
    renderWithIntl(<TriggerOverview initial={overview([TRIGGER])} />);
    expect(screen.getByText(TRIGGER.purpose)).toBeTruthy();
    expect(screen.getByText(/check for news → send data/)).toBeTruthy();
    expect(screen.getByText(/erika: \$0\.75 of \$25\.00/)).toBeTruthy();
    expect(screen.getByText('erika')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t.actions.pause }));
    await waitFor(() => expect(mockPause).toHaveBeenCalledWith(TRIGGER.id));
    await waitFor(() => expect(screen.getByRole('button', { name: t.actions.resume })).toBeTruthy());
    expect(screen.getByText(/paused: by an operator/)).toBeTruthy();
  });

  it('says so when nothing is watched, and shows the batch jobs', () => {
    renderWithIntl(<TriggerOverview initial={overview([])} />);
    expect(screen.getByText(t.list.empty)).toBeTruthy();
    expect(screen.getByText(/Consolidate notes/)).toBeTruthy();
  });
});
