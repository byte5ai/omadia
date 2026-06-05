import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../../../../_lib/api';
import { CulturePresetDropdown } from '../CulturePresetDropdown';
import { renderWithIntl } from './personaIntlHelper';

const render = (ui: ReactElement) => renderWithIntl(ui, { locale: 'de' });

/**
 * Issue #59 — CulturePresetDropdown component tests.
 *
 * Coverage:
 *   - 6 industry presets render in the dropdown
 *   - Selecting a preset opens the confirm modal with diff entries
 *   - Confirm sends a single `setPersonaConfig` call with the full
 *     merged persona (existing template / custom_notes / untouched axes
 *     preserved)
 *   - Cancel closes the modal without persisting
 */

describe('<CulturePresetDropdown />', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setPersonaConfigSpy: any;

  beforeEach(() => {
    setPersonaConfigSpy = vi
      .spyOn(api, 'setPersonaConfig')
      .mockResolvedValue({} as Awaited<ReturnType<typeof api.setPersonaConfig>>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders 6 industry options + the "no selection" placeholder', () => {
    render(<CulturePresetDropdown draftId="draft-1" persona={undefined} />);
    const select = screen.getByTestId('culture-preset-select') as HTMLSelectElement;
    // 6 presets + 1 placeholder
    expect(select.options).toHaveLength(7);
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toEqual([
      '',
      'saas-startup',
      'enterprise-corporate',
      'healthcare',
      'legal',
      'ecommerce',
      'creative-agency',
    ]);
  });

  it('selecting a preset opens the confirm modal with the diff list', () => {
    render(
      <CulturePresetDropdown
        draftId="draft-1"
        persona={{ axes: { directness: 50, warmth: 50 } }}
      />,
    );
    fireEvent.change(screen.getByTestId('culture-preset-select'), {
      target: { value: 'saas-startup' },
    });
    const modal = screen.getByTestId('culture-confirm-modal');
    expect(modal).toBeInTheDocument();
    // saas-startup overrides directness 50→75 and warmth 50→55
    expect(within(modal).getByTestId('culture-diff-directness')).toHaveTextContent(
      /50.*→.*75/,
    );
    expect(within(modal).getByTestId('culture-diff-warmth')).toHaveTextContent(
      /50.*→.*55/,
    );
  });

  it('cancel closes the modal without persisting', () => {
    render(
      <CulturePresetDropdown
        draftId="draft-1"
        persona={{ axes: { directness: 50 } }}
      />,
    );
    fireEvent.change(screen.getByTestId('culture-preset-select'), {
      target: { value: 'legal' },
    });
    expect(screen.getByTestId('culture-confirm-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('culture-confirm-cancel'));
    expect(screen.queryByTestId('culture-confirm-modal')).not.toBeInTheDocument();
    expect(setPersonaConfigSpy).not.toHaveBeenCalled();
  });

  it('confirm sends a single setPersonaConfig call with full merged persona', async () => {
    render(
      <CulturePresetDropdown
        draftId="draft-7"
        persona={{
          template: 'software-engineer',
          axes: { directness: 50, warmth: 50, drama: 90 },
          custom_notes: 'Antworte auf Deutsch',
        }}
      />,
    );
    fireEvent.change(screen.getByTestId('culture-preset-select'), {
      target: { value: 'saas-startup' },
    });
    fireEvent.click(screen.getByTestId('culture-confirm-apply'));

    await waitFor(() => expect(setPersonaConfigSpy).toHaveBeenCalledTimes(1));
    const [draftId, payload] = setPersonaConfigSpy.mock.calls[0]!;
    expect(draftId).toBe('draft-7');
    // template + custom_notes preserved
    expect(payload.template).toBe('software-engineer');
    expect(payload.custom_notes).toBe('Antworte auf Deutsch');
    // saas-startup overlay applied; drama (not in preset) survives at 90
    expect(payload.axes.directness).toBe(75);
    expect(payload.axes.warmth).toBe(55);
    expect(payload.axes.drama).toBe(90);
  });

  it('handles undefined persona on first apply', async () => {
    render(<CulturePresetDropdown draftId="draft-1" persona={undefined} />);
    fireEvent.change(screen.getByTestId('culture-preset-select'), {
      target: { value: 'creative-agency' },
    });
    fireEvent.click(screen.getByTestId('culture-confirm-apply'));
    await waitFor(() => expect(setPersonaConfigSpy).toHaveBeenCalledTimes(1));
    const [, payload] = setPersonaConfigSpy.mock.calls[0]!;
    expect(payload.axes.creativity).toBe(85);
    expect(payload.axes.drama).toBe(50);
  });
});
