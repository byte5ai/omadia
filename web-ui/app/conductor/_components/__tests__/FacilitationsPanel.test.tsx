import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, getConductorRun, listFacilitations, terminateFacilitation, type FacilitationOverview } from '@/app/_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import { FacilitationsPanel } from '../FacilitationsPanel';

vi.mock('@/app/_lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/_lib/api')>();
  return {
    ...actual,
    listFacilitations: vi.fn(),
    terminateFacilitation: vi.fn(),
    getConductorRun: vi.fn(),
  };
});

function row(overrides: Partial<FacilitationOverview> = {}): FacilitationOverview {
  return {
    workflowId: 'wf-1',
    slug: 'eph-facilitation-ab12cd34',
    name: 'Facilitation',
    createdByAgent: '@omadia/agent-facilitator',
    expiresAt: '2026-08-25T07:00:00.000Z',
    conversation: { channelType: 'teams', conversationId: '19:abc@thread.v2' },
    roleKey: 'facilitation-abc',
    initiators: ['mwege@byte5.de'],
    incomplete: false,
    run: {
      id: 'run-1',
      status: 'waiting',
      startedAt: '2026-08-24T07:00:00.000Z',
      endedAt: null,
      cancelRequestedAt: null,
      currentStepId: 'wait',
      goal: 'omadia Event planen',
      definitionOfDone: '6 Punkte, alle bestätigt',
      rounds: 7,
      lastVerdict: {
        dodMet: false,
        summary: '3/6 offen',
        items: [
          { point: 1, label: 'Eventformat entschieden', status: 'done', note: 'Meetup, von allen bestätigt' },
          { point: 2, label: 'Termin fix', status: 'partial', note: 'Vorschlag 12.9. liegt vor' },
          { point: 3, label: 'Ort bzw. Plattform', status: 'open', note: '' },
        ],
      },
    },
    participants: [
      { displayName: 'Marcel Wege', isBot: false },
      { displayName: 'omadia-agent', isBot: true },
    ],
    participantsPartial: false,
    ...overrides,
  };
}

// #330 round 4 — running facilitations were invisible in the admin UI; this
// panel is the operator lens plus the ONE destructive action (terminate).
describe('FacilitationsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listFacilitations).mockResolvedValue({ facilitations: [row()] });
    vi.mocked(terminateFacilitation).mockResolvedValue({ cancelledRuns: 1, disposed: true });
  });

  it('shows goal, DoD, rounds, verdict, human participants and initiator', async () => {
    renderWithIntl(<FacilitationsPanel />);
    expect(await screen.findByText('omadia Event planen')).toBeInTheDocument();
    expect(screen.getByText(/6 Punkte, alle bestätigt/)).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText(/3\/6 offen/)).toBeInTheDocument();
    // Humans only — the bot is not a participant worth listing.
    expect(screen.getByText(/Marcel Wege/)).toBeInTheDocument();
    expect(screen.queryByText(/omadia-agent,/)).not.toBeInTheDocument();
    expect(screen.getByText('mwege@byte5.de')).toBeInTheDocument();
  });

  it('terminates only after the confirm dialog, then reloads', async () => {
    renderWithIntl(<FacilitationsPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Stop & remove' }));
    expect(terminateFacilitation).not.toHaveBeenCalled();

    await userEvent.click(screen.getAllByRole('button', { name: 'Stop & remove' }).at(-1)!);
    await waitFor(() => {
      expect(terminateFacilitation).toHaveBeenCalledWith('wf-1');
    });
    expect(listFacilitations).toHaveBeenCalledTimes(2);
  });

  it('renders NOTHING when no facilitation runs — installations without the facilitator see no box', async () => {
    vi.mocked(listFacilitations).mockResolvedValue({ facilitations: [] });
    renderWithIntl(<FacilitationsPanel />);
    await waitFor(() => {
      expect(listFacilitations).toHaveBeenCalled();
    });
    expect(screen.queryByText('Running facilitations')).not.toBeInTheDocument();
  });

  it('renders NOTHING on a pre-feature kernel (501)', async () => {
    vi.mocked(listFacilitations).mockRejectedValue(new ApiError(501, 'not wired'));
    renderWithIntl(<FacilitationsPanel />);
    await waitFor(() => {
      expect(listFacilitations).toHaveBeenCalled();
    });
    expect(screen.queryByText('Running facilitations')).not.toBeInTheDocument();
  });

  it('opens the details modal with the run trace', async () => {
    vi.mocked(getConductorRun).mockResolvedValue({
      run: {
        id: 'run-1', status: 'waiting', triggerKind: 'agent', startedAt: '2026-08-24T07:00:00.000Z',
        endedAt: null, currentStepId: 'wait', context: {}, cancelRequestedAt: null,
      },
      steps: [],
    } as never);
    renderWithIntl(<FacilitationsPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Details' }));
    expect(await screen.findByText('Facilitation details')).toBeInTheDocument();
    // Interim results table — one row per DoD point with its status.
    expect(screen.getByText('Interim results (per DoD point)')).toBeInTheDocument();
    expect(screen.getByText('Eventformat entschieden')).toBeInTheDocument();
    expect(screen.getByText('done')).toBeInTheDocument();
    expect(screen.getByText('partial')).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
    await waitFor(() => {
      expect(getConductorRun).toHaveBeenCalledWith('eph-facilitation-ab12cd34', 'run-1');
    });
  });

  it('falls back to the DoD list in the modal when the verdict has no items (pre-v3 runs)', async () => {
    vi.mocked(listFacilitations).mockResolvedValue({
      facilitations: [
        row({
          run: {
            ...row().run!,
            lastVerdict: { dodMet: false, summary: '3/6 offen', items: null },
          },
        }),
      ],
    });
    vi.mocked(getConductorRun).mockResolvedValue({
      run: {
        id: 'run-1', status: 'waiting', triggerKind: 'agent', startedAt: '2026-08-24T07:00:00.000Z',
        endedAt: null, currentStepId: 'wait', context: {}, cancelRequestedAt: null,
      },
      steps: [],
    } as never);
    renderWithIntl(<FacilitationsPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'Details' }));
    expect(await screen.findByText('Facilitation details')).toBeInTheDocument();
    expect(screen.queryByText('Interim results (per DoD point)')).not.toBeInTheDocument();
    expect(screen.getAllByText(/6 Punkte, alle bestätigt/).length).toBeGreaterThan(0);
  });

  it('renders a numbered DoD as an ordered list', async () => {
    vi.mocked(listFacilitations).mockResolvedValue({
      facilitations: [
        row({
          run: {
            ...row().run!,
            definitionOfDone: '1. Eventformat entschieden, von allen bestätigt. 2. Termin fix. 3. Ort festgelegt.',
          },
        }),
      ],
    });
    renderWithIntl(<FacilitationsPanel />);
    const items = await screen.findAllByRole('listitem');
    const texts = items.map((li) => li.textContent);
    expect(texts).toContain('Eventformat entschieden, von allen bestätigt.');
    expect(texts).toContain('Termin fix.');
    expect(texts).toContain('Ort festgelegt.');
  });
});
