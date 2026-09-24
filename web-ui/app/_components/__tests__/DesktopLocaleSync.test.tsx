import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesktopLocaleSync } from '../DesktopLocaleSync';

type BridgeWindow = Window & { omadia?: { setUiLocale?: (locale: string) => void } };

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
