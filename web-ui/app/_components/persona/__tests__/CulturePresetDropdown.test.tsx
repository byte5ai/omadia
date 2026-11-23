import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps, ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { CulturePresetDropdown } from '../CulturePresetDropdown';

const render = (ui: ReactElement) => renderWithIntl(ui, { locale: 'de' });

/**
 * #59, moved for #2049 — the culture / industry preset dropdown is a
 * controlled component shared by every place that edits an agent's persona:
 *   - the presets render in the dropdown;
 *   - selecting one opens the confirm panel with the axis diff;
 *   - confirm hands the FULL merged persona to `onApply` (template,
 *     custom_notes and untouched axes kept); cancel applies nothing;
 *   - a rejected `onApply` is shown inline.
 */

describe('<CulturePresetDropdown />', () => {
  type DropdownProps = ComponentProps<typeof CulturePresetDropdown>;
  let onApply: Mock<DropdownProps['onApply']>;

  beforeEach(() => {
    onApply = vi.fn<DropdownProps['onApply']>();
  });

  it('renders the industry options + the "no selection" placeholder', () => {
    render(<CulturePresetDropdown persona={undefined} onApply={onApply} />);
    const select = screen.getByTestId('culture-preset-select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      '',
      'saas-startup',
      'enterprise-corporate',
      'healthcare',
      'legal',
      'ecommerce',
      'creative-agency',
    ]);
  });

  it('selecting a preset opens the confirm panel with the diff list', () => {
    render(<CulturePresetDropdown persona={{ axes: { directness: 50, warmth: 50 } }} onApply={onApply} />);
    fireEvent.change(screen.getByTestId('culture-preset-select'), { target: { value: 'saas-startup' } });
    const modal = screen.getByTestId('culture-confirm-modal');
    expect(within(modal).getByTestId('culture-diff-directness')).toHaveTextContent(/50.*→.*75/);
    expect(within(modal).getByTestId('culture-diff-warmth')).toHaveTextContent(/50.*→.*55/);
  });

  it('cancel closes the panel without applying', () => {
    render(<CulturePresetDropdown persona={{ axes: { directness: 50 } }} onApply={onApply} />);
    fireEvent.change(screen.getByTestId('culture-preset-select'), { target: { value: 'legal' } });
    fireEvent.click(screen.getByTestId('culture-confirm-cancel'));
    expect(screen.queryByTestId('culture-confirm-modal')).not.toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('confirm hands the full merged persona to onApply', async () => {
    render(
      <CulturePresetDropdown
        persona={{
          template: 'software-engineer',
          axes: { directness: 50, warmth: 50, drama: 90 },
          custom_notes: 'Antworte auf Deutsch',
        }}
        onApply={onApply}
      />,
    );
    fireEvent.change(screen.getByTestId('culture-preset-select'), { target: { value: 'saas-startup' } });
    fireEvent.click(screen.getByTestId('culture-confirm-apply'));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const payload = onApply.mock.calls[0]![0];
    expect(payload.template).toBe('software-engineer');
    expect(payload.custom_notes).toBe('Antworte auf Deutsch');
    expect(payload.axes?.directness).toBe(75);
    expect(payload.axes?.warmth).toBe(55);
    expect(payload.axes?.drama).toBe(90);
    await waitFor(() => expect(screen.queryByTestId('culture-confirm-modal')).not.toBeInTheDocument());
  });

  it('handles an undefined persona on first apply', async () => {
    render(<CulturePresetDropdown persona={undefined} onApply={onApply} />);
    fireEvent.change(screen.getByTestId('culture-preset-select'), { target: { value: 'creative-agency' } });
    fireEvent.click(screen.getByTestId('culture-confirm-apply'));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const payload = onApply.mock.calls[0]![0];
    expect(payload.axes?.creativity).toBe(85);
    expect(payload.axes?.drama).toBe(50);
  });

  it('shows a rejected onApply inline and keeps the panel open', async () => {
    onApply.mockRejectedValueOnce(new Error('nope'));
    render(<CulturePresetDropdown persona={undefined} onApply={onApply} />);
    fireEvent.change(screen.getByTestId('culture-preset-select'), { target: { value: 'legal' } });
    fireEvent.click(screen.getByTestId('culture-confirm-apply'));
    await waitFor(() => expect(screen.getByTestId('culture-error')).toHaveTextContent('nope'));
    expect(screen.getByTestId('culture-confirm-modal')).toBeInTheDocument();
  });
});
