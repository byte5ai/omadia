import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../../../../_lib/api';
import { BoundariesSection } from '../BoundariesSection';
import { renderWithIntl } from './personaIntlHelper';

const render = (ui: ReactElement) => renderWithIntl(ui, { locale: 'de' });

/**
 * Issue #54 — BoundariesSection component tests.
 *
 * Coverage:
 *   - 12 preset checkboxes render, grouped by category
 *   - Toggling a checkbox + Speichern persists via setQualityConfig
 *   - Custom textarea lines are trimmed and split on newlines
 *   - Unknown preset IDs in initialQuality surface a warning badge
 */

describe('<BoundariesSection />', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let setQualityConfigSpy: any;

  beforeEach(() => {
    setQualityConfigSpy = vi
      .spyOn(api, 'setQualityConfig')
      .mockResolvedValue({} as Awaited<ReturnType<typeof api.setQualityConfig>>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all 12 preset checkboxes grouped by 4 categories', () => {
    render(<BoundariesSection draftId="draft-1" />);
    // 12 preset checkboxes
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(12);
    // category headers (regex anchored to exact match — the labels are
    // single-word, no overlap with preset labels)
    expect(screen.getByText('Daten')).toBeInTheDocument();
    expect(screen.getByText('Geltungsbereich')).toBeInTheDocument();
    expect(screen.getByText('Befugnisse')).toBeInTheDocument();
    expect(screen.getByText('Kommunikation')).toBeInTheDocument();
  });

  it('honours initialQuality for prefilled checkboxes', () => {
    render(
      <BoundariesSection
        draftId="draft-1"
        initialQuality={{
          boundaries: { presets: ['no-pii', 'no-commitments'], custom: [] },
        }}
      />,
    );
    const piiBox = screen
      .getByTestId('boundary-preset-no-pii')
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    const commBox = screen
      .getByTestId('boundary-preset-no-commitments')
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    const medBox = screen
      .getByTestId('boundary-preset-no-medical-data')
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(piiBox.checked).toBe(true);
    expect(commBox.checked).toBe(true);
    expect(medBox.checked).toBe(false);
  });

  it('Speichern persists checked presets + parsed custom lines via setQualityConfig', async () => {
    render(<BoundariesSection draftId="draft-7" />);
    const piiBox = screen
      .getByTestId('boundary-preset-no-pii')
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(piiBox);
    fireEvent.change(screen.getByTestId('boundaries-custom'), {
      target: { value: 'no off-topic chitchat\n  promise refunds  \n' },
    });
    fireEvent.click(screen.getByTestId('boundaries-save'));

    await waitFor(() => expect(setQualityConfigSpy).toHaveBeenCalledTimes(1));
    const [draftId, payload] = setQualityConfigSpy.mock.calls[0]!;
    expect(draftId).toBe('draft-7');
    expect(payload).toEqual({
      boundaries: {
        presets: ['no-pii'],
        custom: ['no off-topic chitchat', 'promise refunds'],
      },
    });
  });

  it('renders a warning badge when initialQuality contains unknown preset IDs', () => {
    render(
      <BoundariesSection
        draftId="draft-1"
        initialQuality={{
          boundaries: { presets: ['no-pii', 'mystery-preset'], custom: [] },
        }}
      />,
    );
    const badge = screen.getByTestId('boundaries-unknown-warning');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain('mystery-preset');
  });

  it('does not render a warning badge when all IDs are known', () => {
    render(
      <BoundariesSection
        draftId="draft-1"
        initialQuality={{
          boundaries: { presets: ['no-pii'], custom: [] },
        }}
      />,
    );
    expect(
      screen.queryByTestId('boundaries-unknown-warning'),
    ).not.toBeInTheDocument();
  });

  it('passes through pre-existing sycophancy when saving boundaries', async () => {
    render(
      <BoundariesSection
        draftId="draft-1"
        initialQuality={{ sycophancy: 'high', boundaries: { presets: [], custom: [] } }}
      />,
    );
    fireEvent.click(
      screen
        .getByTestId('boundary-preset-no-pii')
        .querySelector('input[type="checkbox"]') as HTMLInputElement,
    );
    fireEvent.click(screen.getByTestId('boundaries-save'));

    await waitFor(() => expect(setQualityConfigSpy).toHaveBeenCalledTimes(1));
    const [, payload] = setQualityConfigSpy.mock.calls[0]!;
    expect(payload.sycophancy).toBe('high');
    expect(payload.boundaries.presets).toEqual(['no-pii']);
  });
});
