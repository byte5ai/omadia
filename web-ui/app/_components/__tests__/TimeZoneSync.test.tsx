import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TIME_ZONE_COOKIE } from '../../_lib/timeZone';
import { TimeZoneSync } from '../TimeZoneSync';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));

const browserZone = vi.hoisted(() => ({ value: 'Europe/Berlin' }));
vi.mock('../../_lib/timeZone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../_lib/timeZone')>();
  return { ...actual, resolveBrowserTimeZone: () => browserZone.value };
});

function clearCookie(): void {
  document.cookie = `${TIME_ZONE_COOKIE}=; path=/; max-age=0`;
}

/** What the server rendered this page in — `layout.tsx` stamps it onto <html>
 *  the same way it stamps `data-palette`. */
function setServerZone(zone: string | null): void {
  if (zone === null) delete document.documentElement.dataset.timezone;
  else document.documentElement.dataset.timezone = zone;
}

beforeEach(() => {
  refresh.mockClear();
  browserZone.value = 'Europe/Berlin';
  clearCookie();
  setServerZone(null);
});

afterEach(() => {
  clearCookie();
  setServerZone(null);
});

/**
 * Issue #1091. The server cannot know the operator's zone — `i18n/request.ts`
 * runs in the container, where `Intl` resolves to UTC. This component is the
 * only thing that knows it, and its whole job is to hand it to the server once
 * and then stay quiet.
 */
describe('<TimeZoneSync />', () => {
  it('renders nothing', () => {
    const { container } = render(<TimeZoneSync />);
    expect(container).toBeEmptyDOMElement();
  });

  it('writes the browser zone into the cookie on mount', async () => {
    render(<TimeZoneSync />);
    await waitFor(() => {
      expect(document.cookie).toContain(`${TIME_ZONE_COOKIE}=Europe%2FBerlin`);
    });
  });

  it('refreshes once so the server re-renders in the operator zone', async () => {
    render(<TimeZoneSync />);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('does not refresh when the cookie already matches', async () => {
    document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent('Europe/Berlin')}; path=/`;
    render(<TimeZoneSync />);
    // A refresh on every mount would re-render the whole RSC tree on every
    // navigation — the cookie is written once and then left alone.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('ignores a browser zone Intl would reject', async () => {
    browserZone.value = 'Mars/Olympus_Mons';
    render(<TimeZoneSync />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.cookie).not.toContain(TIME_ZONE_COOKIE);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not refresh when the cookie write does not stick', async () => {
    // Blocked site cookies, a strict-privacy profile, or a shell serving from a
    // scheme where writes are dropped: `readTimeZoneCookie()` would come back
    // empty on every fresh mount, so an unconditional refresh would re-render
    // the whole RSC tree (nav fetch included) on every single page load, for a
    // zone the server is never going to receive.
    const descriptor = Object.getOwnPropertyDescriptor(
      Document.prototype,
      'cookie',
    );
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => '',
      set: () => {},
    });
    try {
      render(<TimeZoneSync />);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      delete (document as unknown as { cookie?: unknown }).cookie;
      if (descriptor) Object.defineProperty(Document.prototype, 'cookie', descriptor);
    }
  });

  it('does not refresh when the server already rendered the operator zone', async () => {
    // A container run with `TZ=Europe/Berlin` and a Berlin browser: the page in
    // front of the operator is already correct, so the cookie is worth storing
    // for later but a refresh would only re-render the tree (nav fetch
    // included) to produce the identical output.
    setServerZone('Europe/Berlin');
    render(<TimeZoneSync />);
    await waitFor(() => {
      expect(document.cookie).toContain(`${TIME_ZONE_COOKIE}=Europe%2FBerlin`);
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes when the server rendered a different zone', async () => {
    setServerZone('UTC');
    render(<TimeZoneSync />);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('renews the cookie even when nothing changed', async () => {
    // The cookie carries a 1-year max-age. Returning early on a match would
    // never renew it, so an operator on the same browser past 365 days gets a
    // UTC-rendered page and a needless refresh to recover from it.
    document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent('Europe/Berlin')}; path=/`;
    setServerZone('Europe/Berlin');
    const written: string[] = [];
    const descriptor = Object.getOwnPropertyDescriptor(
      Document.prototype,
      'cookie',
    );
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => `${TIME_ZONE_COOKIE}=${encodeURIComponent('Europe/Berlin')}`,
      set: (value: string) => void written.push(value),
    });
    try {
      render(<TimeZoneSync />);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(written.some((v) => v.includes('max-age='))).toBe(true);
    } finally {
      delete (document as unknown as { cookie?: unknown }).cookie;
      if (descriptor) Object.defineProperty(Document.prototype, 'cookie', descriptor);
    }
    expect(refresh).not.toHaveBeenCalled();
  });

  it('rewrites the cookie when the operator moves zone', async () => {
    document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent('America/New_York')}; path=/`;
    render(<TimeZoneSync />);
    await waitFor(() => {
      expect(document.cookie).toContain(`${TIME_ZONE_COOKIE}=Europe%2FBerlin`);
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });
});
