import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import { TurnBudgetField } from '../TurnBudgetField';

/**
 * OM-104 / #1077 — "Time limit per turn" on the LLM-access page.
 *
 * Load, validate, save and clear were only ever exercised by hand. The field
 * persists the orchestrator plugin's `cli_turn_seconds`; the contract that
 * matters downstream is the PATCH body: a whole number as a string, or `null`
 * to hand control back to the environment variable and then the default. An
 * empty string there would be persisted as a value, not as "unset".
 */

const { mockGetInstalledPlugin, mockUpdateInstalledPluginConfig } = vi.hoisted(() => ({
  mockGetInstalledPlugin: vi.fn(),
  mockUpdateInstalledPluginConfig: vi.fn(),
}));

vi.mock('../../../../_lib/api', () => ({
  getInstalledPlugin: mockGetInstalledPlugin,
  updateInstalledPluginConfig: mockUpdateInstalledPluginConfig,
}));

const LABEL = 'Time limit per turn (seconds)';

function installed(config: Record<string, unknown>): void {
  mockGetInstalledPlugin.mockResolvedValue({ config });
}

async function renderLoaded(): Promise<HTMLInputElement> {
  renderWithIntl(<TurnBudgetField />);
  const input = screen.getByLabelText(LABEL) as HTMLInputElement;
  await waitFor(() => expect(input).not.toBeDisabled());
  return input;
}

function typeAndSave(input: HTMLInputElement, value: string): void {
  fireEvent.change(input, { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
}

describe('<TurnBudgetField />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateInstalledPluginConfig.mockResolvedValue(undefined);
  });

  it('loads the configured budget of the orchestrator plugin', async () => {
    installed({ cli_turn_seconds: '240' });
    const input = await renderLoaded();
    expect(mockGetInstalledPlugin).toHaveBeenCalledWith('@omadia/orchestrator');
    expect(input.value).toBe('240');
  });

  it('shows an empty field for a stored zero or junk value', async () => {
    for (const stored of ['0', 'abc', -5]) {
      installed({ cli_turn_seconds: stored });
      const { unmount } = renderWithIntl(<TurnBudgetField />);
      const input = screen.getByLabelText(LABEL) as HTMLInputElement;
      await waitFor(() => expect(input).not.toBeDisabled());
      expect(input.value, `stored=${String(stored)}`).toBe('');
      unmount();
    }
  });

  it('surfaces a failed load instead of an empty field that swallows saves', async () => {
    mockGetInstalledPlugin.mockRejectedValue(new Error('plugin not installed'));
    renderWithIntl(<TurnBudgetField />);
    expect(await screen.findByText('plugin not installed')).toBeInTheDocument();
  });

  it('rejects values outside 30–3600 seconds without saving', async () => {
    installed({});
    const input = await renderLoaded();
    for (const bad of ['29', '3601']) {
      typeAndSave(input, bad);
      expect(
        await screen.findByText('Enter a whole number between 30 and 3600.'),
      ).toBeInTheDocument();
    }
    expect(mockUpdateInstalledPluginConfig).not.toHaveBeenCalled();
  });

  it('saves a valid budget as the string the orchestrator parses', async () => {
    installed({});
    const input = await renderLoaded();
    typeAndSave(input, '240');
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(mockUpdateInstalledPluginConfig).toHaveBeenCalledWith('@omadia/orchestrator', {
      cli_turn_seconds: '240',
    });
  });

  it('clears the budget with null, not an empty string', async () => {
    installed({ cli_turn_seconds: '240' });
    const input = await renderLoaded();
    typeAndSave(input, '');
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(mockUpdateInstalledPluginConfig).toHaveBeenCalledWith('@omadia/orchestrator', {
      cli_turn_seconds: null,
    });
  });

  it('shows a failed save', async () => {
    installed({});
    mockUpdateInstalledPluginConfig.mockRejectedValue(new Error('PATCH failed: 500'));
    const input = await renderLoaded();
    typeAndSave(input, '300');
    expect(await screen.findByText('PATCH failed: 500')).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});
