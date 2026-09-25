import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import deMessages from '../../messages/de.json';
import enMessages from '../../messages/en.json';

/**
 * OM-96 / #1077 — the root navigation boundary.
 *
 * Without a `loading.tsx`, Next kept the current page mounted while a dynamic
 * route's payload was in flight, so a working DASHBOARD click looked like a
 * dead link. This boundary makes the navigation observable, and its
 * `role="status"` is the only thing a screen reader hears meanwhile. The
 * translation is resolved from the REAL catalog, so a renamed or missing key
 * goes red here instead of rendering a raw key to the announcement.
 */

const requested: string[] = [];
let locale: 'en' | 'de' = 'en';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => {
    requested.push(namespace);
    const catalog = (locale === 'en' ? enMessages : deMessages) as unknown as Record<
      string,
      Record<string, string>
    >;
    return (key: string): string => {
      const value = catalog[namespace]?.[key];
      if (typeof value !== 'string') throw new Error(`missing message ${namespace}.${key}`);
      return value;
    };
  },
}));

import Loading from '../loading';

describe('root loading boundary (OM-96)', () => {
  it('announces the pending navigation as a polite, busy status region', async () => {
    locale = 'en';
    render(await Loading());

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Loading page…');
    expect(requested).toContain('layout');
    // The skeleton is decoration: hidden from assistive tech, so the one
    // sentence above is all that is read out.
    expect(status.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('has the announcement in German too', async () => {
    locale = 'de';
    render(await Loading());
    expect(screen.getAllByRole('status').at(-1)).toHaveTextContent('Seite wird geladen…');
  });
});
