import { describe, expect, it, vi } from 'vitest';

import { LOCALES } from '../../../i18n/locales';
import { renderWithIntl } from '../../_lib/test-utils';
import { LocaleSwitcher } from '../LocaleSwitcher';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

/**
 * Regression guard for issue #360 — same rationale as ThemeControls.test.tsx:
 * the Windows native combobox widget silently ignores per-`<option>` styling
 * driven by CSS custom properties, so any bg-/text- arbitrary-value color
 * className on `<option>` is a no-op there. (Spelled out prosaically on
 * purpose: Tailwind v4 scans comments too, and a literal bracket-class with
 * `var(...)` inside compiles into invalid CSS that breaks `next dev`.) Option
 * colors are owned by `[data-theme]`-scoped rules in globals.css with
 * concrete hex values; the per-option className must not come back, or
 * contributors would assume it does something.
 */
describe('<LocaleSwitcher />', () => {
  it('renders one select with the expected locale options and no inline color classes', () => {
    const { container } = renderWithIntl(<LocaleSwitcher />);

    const selects = container.querySelectorAll('select');
    expect(selects).toHaveLength(1);

    const options = container.querySelectorAll('option');
    expect(options).toHaveLength(LOCALES.length);

    const values = Array.from(options).map((o) => o.getAttribute('value'));
    expect(values).toEqual([...LOCALES]);

    for (const option of options) {
      expect(option.getAttribute('class')).toBeNull();
    }
  });
});
