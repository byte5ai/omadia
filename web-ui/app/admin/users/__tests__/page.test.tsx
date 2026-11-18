import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../_lib/api';
import { renderWithIntl } from '../../../_lib/test-utils';
import AdminUsersPage from '../page';

/**
 * Creating a local user: a password over the sign-in maximum is refused by
 * the server with `admin_users.password_too_long`, and the form explains it
 * with the catalogue's copy instead of the generic "Error 400" line.
 */

const { mockListAdminUsers, mockCreateAdminUser } = vi.hoisted(() => ({
  mockListAdminUsers: vi.fn(),
  mockCreateAdminUser: vi.fn(),
}));

// Keep the real ApiError (its `code` comes from the JSON body); stub the calls.
vi.mock('../../../_lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../_lib/api')>();
  return {
    ...actual,
    listAdminUsers: mockListAdminUsers,
    createAdminUser: mockCreateAdminUser,
  };
});

beforeEach(() => {
  mockListAdminUsers.mockResolvedValue({ users: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function submitCreate(password: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Create new user' }));
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } });
  fireEvent.change(screen.getByLabelText('Password (min. 8 characters)'), {
    target: { value: password },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
}

describe('<AdminUsersPage /> create form', () => {
  it('explains a password over the sign-in maximum', async () => {
    mockCreateAdminUser.mockRejectedValue(
      new ApiError(
        400,
        'HTTP 400',
        JSON.stringify({ code: 'admin_users.password_too_long', message: 'raw server text' }),
      ),
    );
    renderWithIntl(<AdminUsersPage />);
    await submitCreate('p'.repeat(1025));

    expect(
      await screen.findByText(
        'The password is longer than 1024 characters, the most sign-in accepts. Choose a shorter password. Nothing was changed.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/raw server text|Error 400/)).toBeNull();
  });
});
