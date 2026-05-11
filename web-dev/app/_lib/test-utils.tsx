import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';

import deMessages from '../../messages/de.json';
import enMessages from '../../messages/en.json';

const MESSAGES = {
  de: deMessages,
  en: enMessages,
} as const;

type Locale = keyof typeof MESSAGES;

interface IntlOptions extends Omit<RenderOptions, 'wrapper'> {
  locale?: Locale;
}

/**
 * Render a React tree under a NextIntlClientProvider so components that
 * call useTranslations() work without a real Next.js request context.
 *
 * Default locale is 'en' to mirror production. Tests that assert German
 * UI strings (e.g. PrivacyReceiptCard) must pass `locale: 'de'`
 * explicitly so the assertion intent is self-documenting.
 */
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
