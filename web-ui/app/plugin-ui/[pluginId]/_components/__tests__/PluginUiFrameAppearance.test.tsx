import { act, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import deMessages from '../../../../../messages/de.json';
import enMessages from '../../../../../messages/en.json';
import {
  PLUGIN_UI_APPEARANCE_MESSAGE,
  PLUGIN_UI_READY_MESSAGE,
  PluginUiFrame,
} from '../PluginUiFrame';

/**
 * #1480 — every theme, palette or language switch reloaded the plugin UI.
 *
 * The iframe carried ``key={`${theme}-${palette}-${locale}`}`` and the same
 * values in its `src`, so React built a new element and the bundle started
 * over on its start view, losing hash route, form input and scroll position.
 * What these tests own: a bundle that announces `ready` keeps ITS element and
 * ITS src and gets the change by postMessage; a bundle that does not keeps
 * the reload it always had, so it still follows the shell; and the channel
 * only listens to this frame on this origin.
 */

const MESSAGES = { en: enMessages, de: deMessages } as const;

function ui(locale: 'en' | 'de'): ReactElement {
  return (
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="UTC">
      <PluginUiFrame pluginId="@omadia/example-ui" name="Example UI" />
    </NextIntlClientProvider>
  );
}

function frameOf(container: HTMLElement): HTMLIFrameElement {
  const el = container.querySelector('iframe');
  if (!el) throw new Error('no iframe rendered');
  return el;
}

function announce(frame: HTMLIFrameElement, init: Partial<MessageEventInit> = {}): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: PLUGIN_UI_READY_MESSAGE },
        origin: window.location.origin,
        source: frame.contentWindow,
        ...init,
      }),
    );
  });
}

async function setShellTheme(theme: 'light' | 'dark'): Promise<void> {
  await act(async () => {
    document.documentElement.setAttribute('data-theme', theme);
    // MutationObserver callbacks are microtasks.
    await Promise.resolve();
  });
}

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-palette');
  vi.restoreAllMocks();
});

describe('<PluginUiFrame /> — appearance changes (#1480)', () => {
  it('carries no key that remounts the element on an appearance change', async () => {
    const { container } = render(ui('en'));
    const before = frameOf(container);
    await setShellTheme('dark');
    expect(frameOf(container)).toBe(before);
  });

  it('updates a live bundle in place: same element, same src, a postMessage', async () => {
    document.documentElement.setAttribute('data-theme', 'light');
    const { container, rerender } = render(ui('en'));
    const frame = frameOf(container);
    const post = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    const srcAtLoad = frame.getAttribute('src');

    announce(frame);
    // The reply to `ready` is the current value.
    expect(post).toHaveBeenLastCalledWith(
      { type: PLUGIN_UI_APPEARANCE_MESSAGE, theme: 'light', palette: 'lagoon', locale: 'en' },
      window.location.origin,
    );

    await setShellTheme('dark');
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: PLUGIN_UI_APPEARANCE_MESSAGE, theme: 'dark' }),
      window.location.origin,
    );

    await act(async () => {
      document.documentElement.setAttribute('data-palette', 'ember');
      await Promise.resolve();
    });
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ palette: 'ember' }),
      window.location.origin,
    );

    rerender(ui('de'));
    expect(post).toHaveBeenLastCalledWith(
      { type: PLUGIN_UI_APPEARANCE_MESSAGE, theme: 'dark', palette: 'ember', locale: 'de' },
      window.location.origin,
    );

    expect(frameOf(container)).toBe(frame);
    expect(frame.getAttribute('src')).toBe(srcAtLoad);
  });

  it('answers every ready, so a bundle that reloaded itself catches up', async () => {
    const { container } = render(ui('en'));
    const frame = frameOf(container);
    announce(frame);
    await setShellTheme('dark');
    const post = vi.spyOn(frame.contentWindow as Window, 'postMessage');
    announce(frame);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'dark' }),
      window.location.origin,
    );
  });

  it('keeps reloading a bundle that never announced itself, so it still follows the shell', async () => {
    document.documentElement.setAttribute('data-theme', 'light');
    const { container } = render(ui('en'));
    const frame = frameOf(container);
    expect(frame.getAttribute('src')).toContain('theme=light');
    await setShellTheme('dark');
    expect(frame.getAttribute('src')).toContain('theme=dark');
  });

  it('ignores a ready from another origin or another window', async () => {
    document.documentElement.setAttribute('data-theme', 'light');
    const { container } = render(ui('en'));
    const frame = frameOf(container);
    const post = vi.spyOn(frame.contentWindow as Window, 'postMessage');

    announce(frame, { origin: 'https://evil.example' });
    announce(frame, { source: window });
    announce(frame, { data: { type: 'something-else' } });
    expect(post).not.toHaveBeenCalled();

    // Still on the reload contract: none of those switched the channel on.
    await setShellTheme('dark');
    expect(frame.getAttribute('src')).toContain('theme=dark');
    expect(post).not.toHaveBeenCalled();
  });
});

describe('<PluginUiFrame /> — frame title (#1479)', () => {
  it('names the plugin by its localized name, not its id', () => {
    const { container } = render(ui('en'));
    expect(frameOf(container).getAttribute('title')).toBe('User interface of the plugin Example UI');
  });
});
