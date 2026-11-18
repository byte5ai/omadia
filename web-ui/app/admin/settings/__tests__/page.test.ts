import { describe, expect, it, vi } from 'vitest';

const { mockRedirect } = vi.hoisted(() => ({
  mockRedirect: vi.fn((): never => {
    throw new Error('NEXT_REDIRECT');
  }),
}));
vi.mock('next/navigation', () => ({ redirect: mockRedirect }));

import AdminSettingsRedirect from '../page';

describe('/admin/settings (#1397)', () => {
  it('redirects to the one place provider keys are managed', () => {
    expect(() => AdminSettingsRedirect()).toThrow('NEXT_REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/admin/providers');
  });
});
