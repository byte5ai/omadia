import { describe, expect, it } from 'vitest';

import { signalDesktopUiReady } from '../desktopShell';

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
