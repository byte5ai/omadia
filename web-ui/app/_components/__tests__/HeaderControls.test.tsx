import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import { HeaderControls } from '../HeaderControls';

const { mockPathname } = vi.hoisted(() => ({ mockPathname: vi.fn(() => '/') }));
vi.mock('next/navigation', () => ({
  usePathname: mockPathname,
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock('../../_lib/api', () => ({
  getUiPrefs: vi.fn().mockRejectedValue(new Error('unauthenticated')),
  putUiPrefs: vi.fn().mockResolvedValue(undefined),
}));

// The issue button and user chip have their own suites and fetch on mount;
// stubbed so this suite only pins which controls the header shows, in order.
vi.mock('../CreateIssueButton', () => ({
  CreateIssueButton: () => <span data-testid="issue-button" />,
}));
vi.mock('../AuthBadge', () => ({
  AuthBadge: ({ preferences }: { preferences?: React.ReactNode }) => (
    <div data-testid="auth-badge">{preferences}</div>
  ),
}));

beforeEach(() => {
  mockPathname.mockReturnValue('/');
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

function lastChildTestId(container: HTMLElement): string | null {
  const row = container.firstElementChild;
  return row?.lastElementChild?.getAttribute('data-testid') ?? null;
}

describe('<HeaderControls /> signed out', () => {
  it('shows only the flag menu, the sun/moon toggle and the issue button — no nav, no login', () => {
    const { container } = renderWithIntl(<HeaderControls signedIn={false} navEntries={[]} />);

    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByTestId('auth-badge')).toBeNull();
    expect(screen.queryByRole('link', { name: /login/i })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Switch language' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeTruthy();
    expect(lastChildTestId(container)).toBe('issue-button');
  });

  it('uses the signed-out bar on /login even with a fresh session cookie', () => {
    mockPathname.mockReturnValue('/login');
    renderWithIntl(<HeaderControls signedIn navEntries={[]} />);
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.getByRole('button', { name: 'Switch language' })).toBeTruthy();
  });

  it('opens the flag menu with one radio item per locale', () => {
    renderWithIntl(<HeaderControls signedIn={false} navEntries={[]} />);
    const trigger = screen.getByRole('button', { name: 'Switch language' });

    fireEvent.click(trigger);
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.textContent)).toEqual(['Deutsch', 'English']);
    expect(items[1]?.getAttribute('aria-checked')).toBe('true');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('<HeaderControls /> signed in', () => {
  it('shows the nav and the user chip, with preferences inside it and the issue button last', () => {
    const { container } = renderWithIntl(<HeaderControls signedIn navEntries={[]} />);

    expect(screen.getByRole('navigation')).toBeTruthy();
    const badge = screen.getByTestId('auth-badge');
    // Palette, appearance and language selects live in the user menu.
    expect(badge.querySelectorAll('select')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Switch language' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Switch to (dark|light) mode/ })).toBeNull();
    expect(lastChildTestId(container)).toBe('issue-button');
  });
});
