import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../_lib/api';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { FirstAgentCard } from '../FirstAgentCard';

/**
 * A refused first-run create says WHY in the reader's language and what to
 * do — never the transport text ("POST … failed: 409"). The slug comes from
 * the name, so the name stays in the field for another try.
 */

const { mockOnboarding, mockCreate, mockRefresh } = vi.hoisted(() => ({
  mockOnboarding: vi.fn(),
  mockCreate: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  getFirstRunOnboarding: mockOnboarding,
  createFirstAgent: mockCreate,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function refusal(error: string): ApiError {
  return new ApiError(
    409,
    'POST /v1/operator/agents/onboarding/first-agent failed: 409',
    JSON.stringify({ error, message: `slug "vertrieb": ${error}`, slug: 'vertrieb' }),
  );
}

describe('<FirstAgentCard /> refusals', () => {
  it('explains leftover state of an earlier agent and keeps the name', async () => {
    mockOnboarding.mockResolvedValue({ required: true, capabilities: [] });
    mockCreate.mockRejectedValue(refusal('slug_state_remains'));
    renderWithIntl(<FirstAgentCard />, { locale: 'de' });

    const name = await screen.findByRole('textbox', { name: 'Name' });
    await userEvent.type(name, 'Vertrieb');
    await userEvent.click(screen.getByRole('button', { name: 'Agent anlegen' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Von einem früheren Agenten „vertrieb“');
    expect(alert.textContent).toContain('ein anderer Name ergibt also einen anderen Slug');
    expect(alert.textContent).not.toContain('failed: 409');
    expect(name).toHaveValue('Vertrieb');
  });

  it('says when the leftover check could not run', async () => {
    mockOnboarding.mockResolvedValue({ required: true, capabilities: [] });
    mockCreate.mockRejectedValue(refusal('slug_state_unverifiable'));
    renderWithIntl(<FirstAgentCard />);

    await userEvent.type(await screen.findByRole('textbox', { name: 'Name' }), 'Vertrieb');
    await userEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Could not check whether data'),
    );
  });
});
