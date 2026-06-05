import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';

import deMessages from '../../../../../../messages/de.json';
import enMessages from '../../../../../../messages/en.json';

/**
 * Intl helper for the persona-pillar component tests.
 *
 * Renders against the real global `messages/*.json` (single source of
 * truth — the `builder.persona.*` namespace lives there). Mirrors the
 * shared `renderWithIntl` API (defaults to 'en'); pass `{ locale: 'de' }`
 * to assert the German UI copy.
 */

const MESSAGES = {
  de: deMessages,
  en: enMessages,
} as const;

type Locale = keyof typeof MESSAGES;

interface IntlOptions extends Omit<RenderOptions, 'wrapper'> {
  locale?: Locale;
}

export function renderWithIntl(
  ui: ReactElement,
  options: IntlOptions = {},
): RenderResult {
  const { locale = 'en', ...rest } = options;
  function Wrapper({ children }: { children: ReactNode }): ReactElement {
    return (
      <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
        {children}
      </NextIntlClientProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...rest });
}
