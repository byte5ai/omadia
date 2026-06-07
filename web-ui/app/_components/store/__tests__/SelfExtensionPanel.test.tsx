import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { SelfExtensionPanel } from '../SelfExtensionPanel';
import type { SelfExtensionProposalView } from '../../../_lib/api';

const {
  mockList,
  mockApprove,
  mockDeny,
  mockInstall,
  mockPropose,
} = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockApprove: vi.fn(),
  mockDeny: vi.fn(),
  mockInstall: vi.fn(),
  mockPropose: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('../../../_lib/api', () => ({
  listSelfExtensionProposals: mockList,
  approveSelfExtensionProposal: mockApprove,
  denySelfExtensionProposal: mockDeny,
  installSelfExtensionProposal: mockInstall,
  proposeSelfExtension: mockPropose,
  ApiError: class ApiError extends Error {},
}));

function proposal(over: Partial<SelfExtensionProposalView> = {}): SelfExtensionProposalView {
  return {
    id: 'p1',
    pluginId: 'de.byte5.agent.dynamics',
    status: 'pending',
    decision: 'needs_approval',
    rationale: 'add aggregation tool',
    patchCount: 1,
    escalations: [],
    submittedBy: 'op@byte5.de',
    createdAt: 1,
    ...over,
  };
}

describe('<SelfExtensionPanel />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the escalations of an auto-denied proposal', async () => {
    mockList.mockResolvedValue([
      proposal({
        status: 'denied',
        decision: 'denied_escalation',
        rationale: 'grab odoo write access',
        escalations: [{ dimension: 'graph.writes', item: 'odoo:invoices:*', reason: 'not covered' }],
      }),
    ]);
    renderWithIntl(<SelfExtensionPanel agentId="de.byte5.agent.dynamics" />);
    expect(await screen.findByText('Privilege escalation — auto-denied')).toBeTruthy();
    expect(screen.getByText(/graph\.writes: odoo:invoices:\*/)).toBeTruthy();
  });

  it('shows Approve + Deny for a pending proposal and approves on click', async () => {
    mockList.mockResolvedValue([proposal()]);
    mockApprove.mockResolvedValue(proposal({ status: 'approved', decision: 'needs_approval' }));
    renderWithIntl(<SelfExtensionPanel agentId="de.byte5.agent.dynamics" />);

    const approveBtn = await screen.findByText('Approve');
    expect(screen.getByText('Deny')).toBeTruthy();
    fireEvent.click(approveBtn);
    await waitFor(() => expect(mockApprove).toHaveBeenCalledWith('p1'));
  });

  it('renders the Install action for an approved proposal', async () => {
    mockList.mockResolvedValue([proposal({ status: 'approved', approvedToolCount: 2 })]);
    renderWithIntl(<SelfExtensionPanel agentId="de.byte5.agent.dynamics" />);
    expect(await screen.findByText('Install + reactivate')).toBeTruthy();
  });

  it('shows the empty state when there are no proposals', async () => {
    mockList.mockResolvedValue([]);
    renderWithIntl(<SelfExtensionPanel agentId="de.byte5.agent.dynamics" />);
    expect(await screen.findByText('No proposals yet.')).toBeTruthy();
  });
});
