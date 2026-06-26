import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import { ThemeControls } from '../ThemeControls';

/**
 * Regression guard for issue #360 — the previous `<option>` markup carried
 * `className="bg-[color:var(...)] text-[color:var(...)]"` props, which the
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
