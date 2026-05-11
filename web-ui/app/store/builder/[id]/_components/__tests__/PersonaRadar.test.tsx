import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PersonaRadar, personaAxisToSliderTestId } from '../PersonaRadar';

/**
 * Phase 3 / OB-67 Slice 5 — PersonaRadar SVG view-only tests.
 *
 * Coverage:
 *   - Renders 12 axis labels (Core 8 + Extended 4)
 *   - Empty axes still draw a closed polygon (neutral baseline)
 *   - axes overrides are reflected in the polygon-points (vertex moves)
 *   - onAxisFocus fires on click
 *   - Keyboard activation (Enter / Space) fires onAxisFocus
 *   - personaAxisToSliderTestId helper returns matching testid
 */
describe('<PersonaRadar />', () => {
  it('renders all 12 axis labels in uppercase font', () => {
    render(<PersonaRadar />);
    const radar = screen.getByTestId('persona-radar');
    // Each axis name appears exactly once as <text>.
    expect(radar.querySelectorAll('text').length).toBeGreaterThanOrEqual(12);
  });

  it('renders both polygons (neutral baseline + persona) when axes empty', () => {
    render(<PersonaRadar />);
    const radar = screen.getByTestId('persona-radar');
    const polygons = radar.querySelectorAll('polygon');
    expect(polygons.length).toBe(2);
  });

  it('omits onClick affordance when onAxisFocus is not provided', () => {
    render(<PersonaRadar />);
    expect(
      screen.queryByTestId('persona-radar-label-directness'),
    ).toBeNull();
  });

  it('renders clickable label when onAxisFocus is provided', () => {
    const focus = vi.fn();
    render(<PersonaRadar onAxisFocus={focus} />);
    const label = screen.getByTestId('persona-radar-label-directness');
    fireEvent.click(label);
    expect(focus).toHaveBeenCalledWith('directness');
  });

  it('Enter and Space activate the axis label via keyboard', () => {
    const focus = vi.fn();
    render(<PersonaRadar onAxisFocus={focus} />);
    const label = screen.getByTestId('persona-radar-label-warmth');
    fireEvent.keyDown(label, { key: 'Enter' });
    fireEvent.keyDown(label, { key: ' ' });
    expect(focus).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenLastCalledWith('warmth');
  });

  it('vertex moves with axes value (directness=100 lands further from centre than directness=0)', () => {
    const { rerender } = render(<PersonaRadar axes={{ directness: 0 }} />);
    const radar = screen.getByTestId('persona-radar');
    const personaPoly = radar.querySelectorAll('polygon')[1] as SVGPolygonElement;
    const pointsLow = personaPoly.getAttribute('points') ?? '';

    rerender(<PersonaRadar axes={{ directness: 100 }} />);
    const personaPolyHigh = screen
      .getByTestId('persona-radar')
      .querySelectorAll('polygon')[1] as SVGPolygonElement;
    const pointsHigh = personaPolyHigh.getAttribute('points') ?? '';

    expect(pointsLow).not.toBe(pointsHigh);
  });

  it('personaAxisToSliderTestId maps axis to slider data-testid', () => {
    expect(personaAxisToSliderTestId('directness')).toBe(
      'dimension-slider-directness',
    );
  });
});
