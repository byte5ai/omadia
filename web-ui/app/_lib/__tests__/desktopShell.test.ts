import { describe, expect, it } from 'vitest';

import { pushDesktopUiLocale, signalDesktopUiReady } from '../desktopShell';

describe('signalDesktopUiReady (OM-71)', () => {
  it('pings the desktop bridge when it is present', () => {
    let pinged = 0;
    const ok = signalDesktopUiReady({ omadia: { uiReady: () => void (pinged += 1) } });
    expect(ok).toBe(true);
    expect(pinged).toBe(1);
  });

  it('is a no-op in a plain browser', () => {
    expect(signalDesktopUiReady({})).toBe(false);
    expect(signalDesktopUiReady(undefined)).toBe(false);
  });

  it('survives a bridge that throws', () => {
    expect(
      signalDesktopUiReady({
        omadia: {
          uiReady: () => {
            throw new Error('bridge gone');
          },
        },
      }),
    ).toBe(false);
  });
});

describe('pushDesktopUiLocale (#1074)', () => {
  it('hands the locale to the desktop bridge when it is present', () => {
    const seen: string[] = [];
    const ok = pushDesktopUiLocale('de', { omadia: { setUiLocale: (l) => void seen.push(l) } });
    expect(ok).toBe(true);
    expect(seen).toEqual(['de']);
  });

  it('is a no-op in a plain browser', () => {
    expect(pushDesktopUiLocale('de', {})).toBe(false);
    expect(pushDesktopUiLocale('de', undefined)).toBe(false);
  });

  it('is a no-op against an older shell that only knows uiReady', () => {
    expect(pushDesktopUiLocale('de', { omadia: { uiReady: () => undefined } })).toBe(false);
  });

  it('survives a bridge that throws', () => {
    expect(
      pushDesktopUiLocale('de', {
        omadia: {
          setUiLocale: () => {
            throw new Error('bridge gone');
          },
        },
      }),
    ).toBe(false);
  });
});
