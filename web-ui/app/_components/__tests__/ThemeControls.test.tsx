import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import {
  AppearanceSelect,
  AppearanceToggle,
  PaletteSelect,
  useThemePrefs,
} from '../ThemeControls';

/** Harness mirroring how the header mounts the hook once and fans it out. */
function Harness({ variant }: { readonly variant: 'selects' | 'toggle' }): React.ReactElement {
  const prefs = useThemePrefs();
  return variant === 'selects' ? (
    <>
      <PaletteSelect palette={prefs.palette} onPalette={prefs.applyPalette} />
      <AppearanceSelect theme={prefs.theme} onTheme={prefs.applyTheme} />
    </>
  ) : (
    <AppearanceToggle theme={prefs.theme} onTheme={prefs.applyTheme} />
  );
}

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
describe('<PaletteSelect /> + <AppearanceSelect />', () => {
  it('renders both selects with the expected options and no inline color classes', () => {
    const { container } = renderWithIntl(<Harness variant="selects" />);

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

  it('applies and persists a palette change', () => {
    renderWithIntl(<Harness variant="selects" />);
    const [palette] = screen.getAllByRole('combobox');

    fireEvent.change(palette!, { target: { value: 'petrol' } });
    expect(document.documentElement.getAttribute('data-palette')).toBe('petrol');
    expect(mockPutUiPrefs).toHaveBeenCalledWith({ palette: 'petrol', appearance: 'system' });
  });
});

/** Signed-out header: one sun/moon button instead of the appearance select. */
describe('<AppearanceToggle />', () => {
  it('from system (OS light) pins dark, then flips back to light', async () => {
    renderWithIntl(<Harness variant="toggle" />);

    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(mockPutUiPrefs).toHaveBeenLastCalledWith({ palette: 'lagoon', appearance: 'dark' });

    // The <html> MutationObserver re-renders asynchronously.
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to light mode' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('labels the button in German', () => {
    renderWithIntl(<Harness variant="toggle" />, { locale: 'de' });
    expect(screen.getByRole('button', { name: 'Zum dunklen Modus wechseln' })).toBeTruthy();
  });
});
