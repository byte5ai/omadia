import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '@/app/_lib/test-utils';

// The SSE hook is a no-op in tests — we drive state through the mocked getJob.
vi.mock('@/app/_lib/useDevJobEvents', () => ({
  useDevJobEvents: vi.fn(),
}));

const getJob = vi.fn();
const listWaitingGates = vi.fn();
const resolveGate = vi.fn();

vi.mock('@/app/admin/dev-platform/_lib/api', () => ({
  getJob: (...a: unknown[]) => getJob(...a),
  listWaitingGates: (...a: unknown[]) => listWaitingGates(...a),
  resolveGate: (...a: unknown[]) => resolveGate(...a),
  isTerminalStatus: () => false,
}));

import { DevJobChatCard } from '../DevJobChatCard';

const SEED = { jobId: 'job-1', repoId: 'byte5ai/omadia', phase: 'queued' };

function jobView(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'job-1', repoId: 'byte5ai/omadia', kind: 'fix_issue', phase: 'implement', status: 'running', prUrl: null, ...over };
}

describe('<DevJobChatCard />', () => {
  beforeEach(() => {
    getJob.mockReset();
    listWaitingGates.mockReset();
    resolveGate.mockReset();
    listWaitingGates.mockResolvedValue({ gates: [] });
    resolveGate.mockResolvedValue({ ok: true, jobId: 'job-1', status: 'resolved' });
  });

  it('renders the live card and reflects the authoritative status', async () => {
    getJob.mockResolvedValue(jobView({ status: 'running' }));
    renderWithIntl(<DevJobChatCard seed={SEED} />, { locale: 'en' });

    const card = await screen.findByTestId('dev-job-chat-card');
    expect(card).toBeInTheDocument();
    await waitFor(() => expect(card).toHaveAttribute('data-status', 'running'));
    // Seed repo id is shown; the job link points at the admin detail page.
    expect(screen.getByText('Open job')).toHaveAttribute(
      'href',
      '/admin/dev-platform/jobs/job-1',
    );
  });

  it('offers approve/reject when the job parks at a gate and posts approved=true', async () => {
    getJob.mockResolvedValue(jobView({ status: 'waiting', phase: 'await_human' }));
    listWaitingGates.mockResolvedValue({
      gates: [
        {
          id: 'gate-9',
          jobId: 'job-1',
          questions: [{ id: 'q1', text: 'Proceed with the plan?' }],
          planArtifactId: null,
          planSha256: null,
          deadlineAt: null,
          createdAt: '2026-07-11T00:00:00.000Z',
          resolvedHolders: ['operator-1'],
        },
      ],
    });

    renderWithIntl(<DevJobChatCard seed={SEED} />, { locale: 'en' });

    const approve = await screen.findByText('Approve');
    expect(screen.getByText('Reject')).toBeInTheDocument();
    expect(screen.getByText('Proceed with the plan?')).toBeInTheDocument();

    fireEvent.click(approve);
    await waitFor(() => expect(resolveGate).toHaveBeenCalledWith('gate-9', { approved: true }));
  });

  it('posts approved=false on reject', async () => {
    getJob.mockResolvedValue(jobView({ status: 'waiting', phase: 'await_human' }));
    listWaitingGates.mockResolvedValue({
      gates: [
        {
          id: 'gate-9',
          jobId: 'job-1',
          questions: [],
          planArtifactId: null,
          planSha256: null,
          deadlineAt: null,
          createdAt: '2026-07-11T00:00:00.000Z',
          resolvedHolders: ['operator-1'],
        },
      ],
    });

    renderWithIntl(<DevJobChatCard seed={SEED} />, { locale: 'en' });
    const reject = await screen.findByText('Reject');
    fireEvent.click(reject);
    await waitFor(() => expect(resolveGate).toHaveBeenCalledWith('gate-9', { approved: false }));
  });

  it('does not show gate controls for a non-gated (running) job', async () => {
    getJob.mockResolvedValue(jobView({ status: 'running' }));
    renderWithIntl(<DevJobChatCard seed={SEED} />, { locale: 'en' });
    await screen.findByTestId('dev-job-chat-card');
    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
    expect(listWaitingGates).not.toHaveBeenCalled();
  });
});
