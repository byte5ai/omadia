import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import { ThemeControls } from '../ThemeControls';

const { mockGetUiPrefs, mockPutUiPrefs } = vi.hoisted(() => ({
  mockGetUiPrefs: vi.fn(),
  mockPutUiPrefs: vi.fn(),
}));
vi.mock('../../_lib/api', () => ({
  getUiPrefs: mockGetUiPrefs,
  putUiPrefs: mockPutUiPrefs,
}));

beforeEach(() => {
  mockGetUiPrefs.mockRejectedValue(new Error('unauthenticated'));
  mockPutUiPrefs.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  document.documentElement.removeAttribute('data-palette');
  document.documentElement.removeAttribute('data-theme');
});

/**
 * Regression guard for issue #360 — the previous `<option>` markup carried
 * bg-/text- arbitrary-value color classNames (spelled out prosaically on
 * purpose: Tailwind v4 scans comments too, and a literal bracket-class with
 * `var(...)` inside compiles into invalid CSS that breaks `next dev`), which the
 * Windows native combobox widget silently ignores (CSS custom properties do
 * not reach option painting). Option colors now live in `[data-theme]`-
 * scoped rules in globals.css with concrete hex values; the per-option
 * className must not come back, or contributors would assume it does
 * something.
 */
describe('<ThemeControls />', () => {
  it('renders both selects with the expected options and no inline color classes', () => {
    const { container } = renderWithIntl(<ThemeControls />);

    const selects = container.querySelectorAll('select');
    expect(selects).toHaveLength(2);

    const options = container.querySelectorAll('option');
    expect(options).toHaveLength(6);

    const values = Array.from(options).map((o) => o.getAttribute('value'));
    expect(values).toEqual(['lagoon', 'petrol', 'atelier', 'system', 'light', 'dark']);

    for (const option of options) {
      expect(option.getAttribute('class')).toBeNull();
    }
  });
});

/**
 * Issue #1073 — at the desktop shell's ~1100 px window the two inline selects
 * pushed the header row past its width and covered HELP. Below xl they now
 * collapse into one icon-triggered panel. jsdom does no layout, so the
 * breakpoint is pinned via the responsive classes; the real-width check is a
 * browser step.
 */
describe('<ThemeControls /> collapsed menu (#1073)', () => {
  it('below xl the controls collapse into one icon menu containing both selects', () => {
    const { container } = renderWithIntl(<ThemeControls />);

    const trigger = screen.getByRole('button', { name: 'Palette and appearance' });
    expect(trigger.parentElement?.className).toContain('xl:hidden');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group', { name: 'Palette and appearance' })).toBeNull();

    const inline = container.querySelector('select')?.closest('[data-theme-inline]');
    expect(inline).not.toBeNull();
    expect(inline?.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(inline?.className).toContain('xl:flex');

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    const panel = screen.getByRole('group', { name: 'Palette and appearance' });
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id);
    const selects = within(panel).getAllByRole('combobox');
    expect(selects).toHaveLength(2);
    const values = within(panel)
      .getAllByRole('option')
      .map((o) => o.getAttribute('value'));
    expect(values).toEqual(['lagoon', 'petrol', 'atelier', 'system', 'light', 'dark']);

    fireEvent.change(selects[0]!, { target: { value: 'petrol' } });
    expect(document.documentElement.getAttribute('data-palette')).toBe('petrol');
    expect(mockPutUiPrefs).toHaveBeenCalledWith({ palette: 'petrol', appearance: 'system' });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Palette and appearance' })).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('closes the panel on a mousedown outside it', () => {
    renderWithIntl(<ThemeControls />);
    const trigger = screen.getByRole('button', { name: 'Palette and appearance' });

    fireEvent.click(trigger);
    const panel = screen.getByRole('group', { name: 'Palette and appearance' });
    fireEvent.mouseDown(panel);
    expect(screen.queryByRole('group', { name: 'Palette and appearance' })).not.toBeNull();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('group', { name: 'Palette and appearance' })).toBeNull();
  });

  it('labels the trigger in German', () => {
    renderWithIntl(<ThemeControls />, { locale: 'de' });
    expect(screen.getByRole('button', { name: 'Palette und Darstellung' })).toBeTruthy();
  });
});
