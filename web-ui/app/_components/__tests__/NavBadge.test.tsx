import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import { Nav } from '../Nav';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}));

/**
 * #1556 follow-up — the admin nav entry for /admin/privacy-fields carries the
 * count of fields waiting for a decision; the cluster header repeats it so it
 * is visible while the menu is closed.
 */
describe('<Nav /> count badge', () => {
  it('shows no badge without a count', () => {
    renderWithIntl(<Nav badges={{ '/admin/privacy-fields': 0 }} />);
    expect(screen.queryByTestId('nav-count-badge')).toBeNull();
  });

  it('shows the count on the admin cluster and on the field-classification entry', () => {
    renderWithIntl(<Nav badges={{ '/admin/privacy-fields': 5 }} />);
    const headerBadge = screen.getByTestId('nav-count-badge');
    expect(headerBadge).toHaveTextContent('5');
    expect(headerBadge.getAttribute('aria-label')).toBe('5 fields need a decision');

    const opener = screen.getByRole('button', { name: /admin/i });
    fireEvent.click(opener);
    const entry = screen.getByRole('menuitem', { name: /field classification/i });
    expect(entry.getAttribute('href')).toBe('/admin/privacy-fields');
    expect(entry).toHaveTextContent('5');
  });
});
