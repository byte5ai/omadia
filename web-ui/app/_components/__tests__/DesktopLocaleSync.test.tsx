import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesktopLocaleSync } from '../DesktopLocaleSync';
import { DesktopUiReady } from '../DesktopUiReady';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

type BridgeWindow = Window & {
  omadia?: { setUiLocale?: (locale: string) => void; uiReady?: () => void };
};

const LAYOUT_FILE = path.resolve(__dirname, '../../layout.tsx');

function withLocale(locale: string) {
  return (
    <NextIntlClientProvider locale={locale} messages={{}}>
      <DesktopLocaleSync />
    </NextIntlClientProvider>
  );
}

afterEach(() => {
  delete (window as BridgeWindow).omadia;
});

/**
 * #1074: the desktop shell's own dialogs followed the OS locale because
 * nothing told it which language the UI was showing.
 */
describe('<DesktopLocaleSync />', () => {
  it('tells the desktop shell the language on first render', () => {
    const setUiLocale = vi.fn();
    (window as BridgeWindow).omadia = { setUiLocale };
    render(withLocale('de'));
    expect(setUiLocale).toHaveBeenCalledTimes(1);
    expect(setUiLocale).toHaveBeenCalledWith('de');
  });

  it('tells it again after a switch re-renders the provider', () => {
    const setUiLocale = vi.fn();
    (window as BridgeWindow).omadia = { setUiLocale };
    const { rerender } = render(withLocale('de'));
    rerender(withLocale('en'));
    expect(setUiLocale).toHaveBeenCalledTimes(2);
    expect(setUiLocale).toHaveBeenLastCalledWith('en');
  });

  it('renders fine in a plain browser without the bridge', () => {
    expect(() => render(withLocale('de'))).not.toThrow();
  });
});

/**
 * #1074 review: the ready ping releases the recovery-key reminder, which
 * translates its text synchronously. If `omadia:uiReady` reaches the shell
 * before `omadia:uiLocale`, that reminder speaks the OS language on the first
 * launch after an upgrade. Electron keeps IPC send order, so the web UI must
 * send the locale first.
 */
describe('locale before ready (#1074)', () => {
  it('mounts <DesktopLocaleSync /> before <DesktopUiReady /> in the root layout', () => {
    const source = readFileSync(LAYOUT_FILE, 'utf8');
    // Whole-line JSX elements only, so the explanatory comment that names both
    // components does not count as a mount.
    const syncAt = source.search(/^\s*<DesktopLocaleSync \/>\s*$/m);
    const readyAt = source.search(/^\s*<DesktopUiReady \/>\s*$/m);
    expect(syncAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(-1);
    expect(syncAt).toBeLessThan(readyAt);
  });

  it('sends the locale before the ready ping when mounted in that order', () => {
    const sent: string[] = [];
    (window as BridgeWindow).omadia = {
      setUiLocale: (locale) => sent.push(`uiLocale:${locale}`),
      uiReady: () => sent.push('uiReady'),
    };
    render(
      <NextIntlClientProvider locale="de" messages={{}}>
        <DesktopLocaleSync />
        <DesktopUiReady />
      </NextIntlClientProvider>,
    );
    expect(sent).toEqual(['uiLocale:de', 'uiReady']);
  });
});
