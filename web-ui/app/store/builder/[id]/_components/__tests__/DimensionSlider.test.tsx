import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DimensionSlider } from '../DimensionSlider';

/**
 * Phase 3 / OB-67 Slice 3 — DimensionSlider behaviour tests.
 *
 * Coverage focus:
 *   - Renders left/right labels + numeric value
 *   - onChange fires with parsed integer
 *   - Base-tick dot only appears when baseValue is set
 *   - Warning marker only appears when warning prop is set
 *   - Disabled state propagates to the underlying input
 *   - aria-label is composed from axis + labels (a11y)
 */
describe('<DimensionSlider />', () => {
  it('renders left/right labels and current value', () => {
    render(
      <DimensionSlider
        axis="directness"
        labelLeft="DIPLOMATIC"
        labelRight="DIRECT"
        value={65}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('DIPLOMATIC')).toBeInTheDocument();
    expect(screen.getByText('DIRECT')).toBeInTheDocument();
    expect(screen.getByText('65')).toBeInTheDocument();
  });

  it('emits parsed integer on change', () => {
    const onChange = vi.fn();
    render(
      <DimensionSlider
        axis="directness"
        labelLeft="DIPLOMATIC"
        labelRight="DIRECT"
        value={50}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText(
      /directness: DIPLOMATIC to DIRECT/,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '80' } });
    expect(onChange).toHaveBeenCalledWith(80);
  });

  it('omits base-tick dot when baseValue is unset', () => {
    render(
      <DimensionSlider
        axis="directness"
        labelLeft="L"
        labelRight="R"
        value={50}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.queryByTestId('dimension-slider-directness-base-tick'),
    ).toBeNull();
  });

  it('renders base-tick dot positioned at baseValue%', () => {
    render(
      <DimensionSlider
        axis="directness"
        labelLeft="L"
        labelRight="R"
        value={50}
        baseValue={42}
        onChange={vi.fn()}
      />,
    );
    const tick = screen.getByTestId('dimension-slider-directness-base-tick');
    expect(tick).toBeInTheDocument();
    expect((tick as HTMLElement).style.left).toBe('42%');
  });

  it('omits inline warning when no warning prop', () => {
    render(
      <DimensionSlider
        axis="directness"
        labelLeft="L"
        labelRight="R"
        value={50}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.queryByTestId('dimension-slider-directness-warning'),
    ).toBeNull();
  });

  it('renders soft / hard warning differently (data-testid present, class differs)', () => {
    const { rerender } = render(
      <DimensionSlider
        axis="directness"
        labelLeft="L"
        labelRight="R"
        value={50}
        warning="soft"
        onChange={vi.fn()}
      />,
    );
    const softMarker = screen.getByTestId(
      'dimension-slider-directness-warning',
    );
    expect(softMarker.className).toMatch(/--warning/);
    expect(softMarker.className).not.toMatch(/--danger/);

    rerender(
      <DimensionSlider
        axis="directness"
        labelLeft="L"
        labelRight="R"
        value={50}
        warning="hard"
        onChange={vi.fn()}
      />,
    );
    const hardMarker = screen.getByTestId(
      'dimension-slider-directness-warning',
    );
    expect(hardMarker.className).toMatch(/--danger/);
  });

  it('disabled state propagates to the input element', () => {
    render(
      <DimensionSlider
        axis="directness"
        labelLeft="L"
        labelRight="R"
        value={50}
        disabled
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByLabelText(
      /directness: L to R/,
    ) as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('a11y: aria-label composes axis + labels', () => {
    render(
      <DimensionSlider
        axis="warmth"
        labelLeft="COOL"
        labelRight="WARM"
        value={50}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('warmth: COOL to WARM')).toBeInTheDocument();
  });
});
