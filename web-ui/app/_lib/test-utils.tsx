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
  timeZone?: string;
}

/**
 * Pinned, not inherited (issue #1091). Without an explicit zone next-intl logs
 * an ENVIRONMENT_FALLBACK IntlError per `format.dateTime` call and formats in
 * whatever zone the machine running the suite happens to be in — so a test
 * asserting a rendered timestamp would pass in Berlin and fail in CI.
 */
const TEST_TIME_ZONE = 'UTC';

/**
 * Render a React tree under a NextIntlClientProvider so components that
 * call useTranslations() work without a real Next.js request context.
 *
 * Default locale is 'en' to mirror production. Tests that assert German
 * UI strings (e.g. PrivacyReceiptCard) must pass `locale: 'de'`
 * explicitly so the assertion intent is self-documenting. The time zone is
 * pinned to UTC for the same reason — pass `timeZone` to assert a shift.
 */
export function renderWithIntl(
  ui: ReactElement,
  options: IntlOptions = {},
): RenderResult {
  const { locale = 'en', timeZone = TEST_TIME_ZONE, ...rest } = options;
  function Wrapper({ children }: { children: ReactNode }): ReactElement {
    return (
      <NextIntlClientProvider
        locale={locale}
        messages={MESSAGES[locale]}
        timeZone={timeZone}
      >
        {children}
      </NextIntlClientProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...rest });
}
