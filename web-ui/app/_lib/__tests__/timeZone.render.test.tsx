import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider, useFormatter } from 'next-intl';
import { describe, expect, it } from 'vitest';

import enMessages from '../../../messages/en.json';
import { parseTimeZoneCookie } from '../timeZone';

/**
 * Issue #1091, end to end through the piece that actually renders. The guards
 * in `timeZone.test.ts` grep source; this one asserts the property the operator
 * complained about — that the string on screen is in THEIR zone — by feeding
 * the cookie value through the same provider `layout.tsx` uses.
 *
 * The instant is 2026-09-23T14:17:47Z: the UTC time from the issue, which the
 * operator triggered at 16:17 CEST.
 */
const INSTANT = new Date('2026-09-23T14:17:47Z');

function Clock(): React.ReactElement {
  const format = useFormatter();
  return (
    <span data-testid="clock">
      {format.dateTime(INSTANT, {
        // `hour12: false` pins the assertion to a 24-hour string; the 'en'
        // default would render "04:17:47 PM" and make the shift harder to read.
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })}
    </span>
  );
}

function renderInZone(cookie: string | undefined): string {
  render(
    <NextIntlClientProvider
      locale="en"
      messages={enMessages}
      timeZone={parseTimeZoneCookie(cookie)}
    >
      <Clock />
    </NextIntlClientProvider>,
  );
  return screen.getByTestId('clock').textContent ?? '';
}

describe('#1091 — the rendered timestamp follows the cookie zone', () => {
  it('renders the operator wall-clock time for a CEST browser', () => {
    expect(renderInZone('Europe%2FBerlin')).toContain('16:17:47');
  });

  it('renders UTC when no cookie has been written yet', () => {
    expect(renderInZone(undefined)).toContain('14:17:47');
  });

  it('renders UTC rather than throwing on a junk cookie', () => {
    expect(renderInZone('Mars%2FOlympus_Mons')).toContain('14:17:47');
  });

  it('shifts the calendar day, not just the clock', () => {
    // A 23:30 UTC instant is already the next day in Berlin — the half of this
    // bug that a date-only column shows.
    const lateNight = new Date('2026-09-23T23:30:00Z');
    render(
      <NextIntlClientProvider
        locale="en"
        messages={enMessages}
        timeZone={parseTimeZoneCookie('Europe%2FBerlin')}
      >
        <span data-testid="day">
          <DayOf instant={lateNight} />
        </span>
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('day').textContent).toContain('24');
  });
});

function DayOf({ instant }: { instant: Date }): React.ReactElement {
  const format = useFormatter();
  return <>{format.dateTime(instant, { day: '2-digit', month: '2-digit' })}</>;
}
