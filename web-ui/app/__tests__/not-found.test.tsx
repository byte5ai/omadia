import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import deMessages from '../../messages/de.json';
import enMessages from '../../messages/en.json';

/**
 * #1398 — omadia's own 404. Next's built-in page was always English, had no
 * way back into the app and overrode the theme. Messages come from the REAL
 * catalogs, so a renamed or missing key fails here.
 */

let locale: 'en' | 'de' = 'en';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => {
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

import NotFound, { generateMetadata } from '../not-found';

afterEach(() => {
  cleanup();
});

describe('root not-found page (#1398)', () => {
  it('renders in English with a link back to the dashboard', async () => {
    locale = 'en';
    render(await NotFound());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Page not found');
    expect(screen.getByRole('link', { name: 'Back to the dashboard' })).toHaveAttribute(
      'href',
      '/',
    );
    expect((await generateMetadata()).title).toBe('Page not found · omadia');
  });

  it('renders in German', async () => {
    locale = 'de';
    render(await NotFound());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Seite nicht gefunden');
    expect(screen.getByRole('link', { name: 'Zurück zum Dashboard' })).toHaveAttribute(
      'href',
      '/',
    );
  });
});
