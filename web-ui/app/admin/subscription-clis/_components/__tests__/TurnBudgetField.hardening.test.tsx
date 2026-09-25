import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import { TurnBudgetField } from '../TurnBudgetField';

/**
 * #1077 — the defects the OM-104 turn-budget field shipped with.
 *
 * - A failed load left Save enabled on an empty field, so one click PATCHed
 *   `cli_turn_seconds: null` and wiped the stored budget while showing "Saved".
 * - `parseInt` validation accepted `240.5` (saved verbatim) and read `1e3` as 1.
 * - Both failure paths rendered the raw exception text as the headline.
 */

const { mockGetInstalledPlugin, mockUpdateConfig } = vi.hoisted(() => ({
  mockGetInstalledPlugin: vi.fn(),
  mockUpdateConfig: vi.fn(),
}));

vi.mock('../../../../_lib/api', () => ({
  getInstalledPlugin: mockGetInstalledPlugin,
  updateInstalledPluginConfig: mockUpdateConfig,
  // The component classifies failures with `instanceof ApiError`; without a
  // class here that check would throw inside the catch.
  ApiError: class MockApiError extends Error {
    code: string | null = null;
  },
}));

function installed(config: Record<string, unknown>): unknown {
  return { id: '@omadia/orchestrator', config };
}

function input(): HTMLInputElement {
  return screen.getByRole('spinbutton') as HTMLInputElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^(Save|Speichern)$/ }) as HTMLButtonElement;
}

async function loaded(value: string): Promise<void> {
  await waitFor(() => expect(input().value).toBe(value));
  await waitFor(() => expect(input()).not.toBeDisabled());
}

describe('<TurnBudgetField /> hardening (#1077)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateConfig.mockResolvedValue(undefined);
  });

  describe('after a failed load', () => {
    beforeEach(() => {
      mockGetInstalledPlugin.mockRejectedValue(new Error('plugin not installed'));
    });

    it('keeps the input and Save disabled and never PATCHes', async () => {
      renderWithIntl(<TurnBudgetField />);

      await screen.findByText(/Couldn't load the current time limit/);
      expect(input()).toBeDisabled();
      expect(saveButton()).toBeDisabled();

      fireEvent.click(saveButton());
      expect(mockUpdateConfig).not.toHaveBeenCalled();
    });

    it('shows localized copy with the raw detail only behind the support disclosure', async () => {
      renderWithIntl(<TurnBudgetField />);

      const headline = await screen.findByText(
        "Couldn't load the current time limit. Saving is disabled until it loads.",
      );
      expect(headline.textContent).not.toContain('plugin not installed');
      expect(screen.getByRole('button', { name: 'Load again' })).toBeInTheDocument();

      const disclosure = screen.getByText('Details for support').closest('details');
      expect(disclosure).not.toBeNull();
      expect(within(disclosure as HTMLElement).getByText(/plugin not installed/)).toBeInTheDocument();
    });

    it('renders the German headline under the de locale', async () => {
      renderWithIntl(<TurnBudgetField />, { locale: 'de' });

      await screen.findByText(
        'Das aktuelle Zeitlimit konnte nicht geladen werden. Speichern ist gesperrt, bis es geladen ist.',
      );
      expect(screen.getByRole('button', { name: 'Erneut laden' })).toBeInTheDocument();
    });
  });

  it('re-enables Save once "Load again" succeeds', async () => {
    mockGetInstalledPlugin
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(installed({ cli_turn_seconds: '240' }));

    renderWithIntl(<TurnBudgetField />);

    fireEvent.click(await screen.findByRole('button', { name: 'Load again' }));

    await loaded('240');
    expect(mockGetInstalledPlugin).toHaveBeenCalledTimes(2);
    expect(saveButton()).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Load again' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).not.toBeInTheDocument();
  });

  it.each(['240.5', '1e3', '-5'])('rejects %s as not a whole number', async (typed) => {
    mockGetInstalledPlugin.mockResolvedValue(installed({}));
    renderWithIntl(<TurnBudgetField />);
    await loaded('');

    fireEvent.change(input(), { target: { value: typed } });
    fireEvent.click(saveButton());

    await screen.findByText('Enter a whole number between 30 and 3600.');
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('treats text the number input cannot parse as invalid, not as a clear', async () => {
    mockGetInstalledPlugin.mockResolvedValue(installed({ cli_turn_seconds: '240' }));
    renderWithIntl(<TurnBudgetField />);
    await loaded('240');

    // What a browser does with `+240` in a number input: the value becomes ''
    // and `validity.badInput` is set. jsdom sanitizes the value but has no
    // badInput, so the flag is stubbed on the element.
    fireEvent.change(input(), { target: { value: '' } });
    Object.defineProperty(input(), 'validity', {
      configurable: true,
      value: { ...input().validity, badInput: true },
    });
    fireEvent.click(saveButton());

    await screen.findByText('Enter a whole number between 30 and 3600.');
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('shows a stored fractional value as the orchestrator reads it and refuses to save it unchanged', async () => {
    mockGetInstalledPlugin.mockResolvedValue(installed({ cli_turn_seconds: '240.5' }));
    renderWithIntl(<TurnBudgetField />);
    await loaded('240.5');

    fireEvent.click(saveButton());

    await screen.findByText('Enter a whole number between 30 and 3600.');
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('shows a localized headline for a failed save and no "Saved"', async () => {
    mockGetInstalledPlugin.mockResolvedValue(installed({ cli_turn_seconds: '240' }));
    mockUpdateConfig.mockRejectedValue(new Error('HTTP 500 upstream exploded'));
    renderWithIntl(<TurnBudgetField />);
    await loaded('240');

    fireEvent.click(saveButton());

    const headline = await screen.findByText("Couldn't save the time limit.");
    expect(headline.textContent).not.toContain('upstream exploded');
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    // A failed save is not a failed load: the operator can simply retry.
    expect(saveButton()).not.toBeDisabled();
  });

  describe('regressions', () => {
    it('loads a stored value, clears to null after a successful load, and saves a valid one', async () => {
      mockGetInstalledPlugin.mockResolvedValue(installed({ cli_turn_seconds: 240 }));
      renderWithIntl(<TurnBudgetField />);
      await loaded('240');

      fireEvent.click(saveButton());
      await screen.findByText('Saved');
      expect(mockUpdateConfig).toHaveBeenLastCalledWith('@omadia/orchestrator', {
        cli_turn_seconds: '240',
      });

      fireEvent.change(input(), { target: { value: '' } });
      fireEvent.click(saveButton());
      await screen.findByText('Saved');
      expect(mockUpdateConfig).toHaveBeenLastCalledWith('@omadia/orchestrator', {
        cli_turn_seconds: null,
      });
    });

    it.each(['29', '3601'])('rejects out-of-range %s', async (typed) => {
      mockGetInstalledPlugin.mockResolvedValue(installed({}));
      renderWithIntl(<TurnBudgetField />);
      await loaded('');

      fireEvent.change(input(), { target: { value: typed } });
      fireEvent.click(saveButton());

      await screen.findByText('Enter a whole number between 30 and 3600.');
      expect(mockUpdateConfig).not.toHaveBeenCalled();
    });
  });
});
