import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../../../../_lib/api';
import { PersonaPillar } from '../PersonaPillar';

/**
 * Phase 3 / OB-67 Slice 4 — PersonaPillar integration tests.
 *
 * Coverage:
 *   - Initial render shows Core 8 sliders by default; Extended 4 collapsed.
 *   - Slider onChange writes to local state (rendered value updates).
 *   - "Speichern" calls setPersonaConfig with compact persona payload.
 *   - "Zurücksetzen" reverts to initial.
 *   - Conflict banner appears for hard sycophancy=high + directness <= 30.
 *   - Empty initial persona renders without crashing.
 */
describe('<PersonaPillar />', () => {
  // The MockInstance type from vitest's spyOn is parameterised on the
  // function signature in a way that doesn't cleanly accept an exported
  // ESM binding under `--strict`. Using a wider type avoids the
  // assignability friction without losing test ergonomics — we only
  // read `.mock.calls` later.
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

  it('renders Core 8 sliders + Extended-toggle (Extended hidden by default)', () => {
    render(<PersonaPillar draftId="draft-1" />);
    // Core block heading
    expect(screen.getByText(/Core \(8\)/)).toBeInTheDocument();
    // 8 core sliders
    expect(screen.getAllByTestId(/^dimension-slider-/)).toHaveLength(8);
    // Extended toggle present, but list hidden
    const extToggle = screen.getByRole('button', { name: /Extended \(4\)/ });
    expect(extToggle).toHaveAttribute('aria-expanded', 'false');
    // Extended sliders not in DOM yet
    expect(screen.queryByTestId('dimension-slider-creativity')).toBeNull();
  });

  it('expands Extended block on toggle click', () => {
    render(<PersonaPillar draftId="draft-1" />);
    fireEvent.click(screen.getByRole('button', { name: /Extended \(4\)/ }));
    expect(screen.getByTestId('dimension-slider-creativity')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^dimension-slider-/)).toHaveLength(12);
  });

  it('initial value defaults to neutral 50 when axis is unset', () => {
    render(<PersonaPillar draftId="draft-1" />);
    const directnessSlider = screen
      .getByTestId('dimension-slider-directness')
      .querySelector('input[type="range"]') as HTMLInputElement;
    expect(directnessSlider.value).toBe('50');
  });

  it('honours initialPersona for prefilled axes', () => {
    render(
      <PersonaPillar
        draftId="draft-1"
        initialPersona={{ axes: { directness: 80, warmth: 30 } }}
      />,
    );
    const directness = screen
      .getByTestId('dimension-slider-directness')
      .querySelector('input[type="range"]') as HTMLInputElement;
    const warmth = screen
      .getByTestId('dimension-slider-warmth')
      .querySelector('input[type="range"]') as HTMLInputElement;
    expect(directness.value).toBe('80');
    expect(warmth.value).toBe('30');
  });

  it('Speichern fires setPersonaConfig with compact payload', async () => {
    render(<PersonaPillar draftId="draft-7" />);
    const directness = screen
      .getByTestId('dimension-slider-directness')
      .querySelector('input[type="range"]') as HTMLInputElement;
    fireEvent.change(directness, { target: { value: '75' } });

    const saveBtn = screen.getByRole('button', { name: /Speichern/ });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    // The async transition awaits the promise — flush via microtask
    await Promise.resolve();
    await Promise.resolve();
    expect(setPersonaConfigSpy).toHaveBeenCalledTimes(1);
    const [draftId, payload] = setPersonaConfigSpy.mock.calls[0]!;
    expect(draftId).toBe('draft-7');
    expect(payload).toEqual({ axes: { directness: 75 } });
  });

  it('Zurücksetzen reverts to initialPersona', () => {
    render(
      <PersonaPillar
        draftId="draft-1"
        initialPersona={{ axes: { warmth: 40 } }}
      />,
    );
    const warmth = screen
      .getByTestId('dimension-slider-warmth')
      .querySelector('input[type="range"]') as HTMLInputElement;
    fireEvent.change(warmth, { target: { value: '90' } });
    expect(warmth.value).toBe('90');

    fireEvent.click(screen.getByRole('button', { name: /Zurücksetzen/ }));
    expect(warmth.value).toBe('40');
  });

  it('renders ConflictBanner when persona × quality conflict triggers', () => {
    render(
      <PersonaPillar
        draftId="draft-1"
        quality={{ sycophancy: 'high' }}
        initialPersona={{ axes: { directness: 20 } }}
      />,
    );
    expect(screen.getByTestId('persona-conflict-banner')).toBeInTheDocument();
    // Hard conflict alert
    expect(
      screen.getByTestId('conflict-hard-sycophancy-high__directness-low'),
    ).toBeInTheDocument();
  });

  it('Speichern disabled when nothing changed', () => {
    render(<PersonaPillar draftId="draft-1" />);
    expect(screen.getByRole('button', { name: /Speichern/ })).toBeDisabled();
  });

  it('renders without crash for empty initialPersona', () => {
    render(<PersonaPillar draftId="draft-1" />);
    expect(screen.getByTestId('persona-pillar')).toBeInTheDocument();
  });
});
