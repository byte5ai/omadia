import { afterEach, describe, expect, it, vi } from 'vitest';

import { LOCALE_COOKIE } from '../../../i18n/locales';
import { TIME_ZONE_COOKIE } from '../timeZone';

/**
 * Issue #1091, through the real request config. `timeZone.test.ts` greps
 * `i18n/request.ts` for the cookie contract, but the import line alone
 * satisfies that grep — `const timeZone = CONTAINER_TIME_ZONE;` (ignore the
 * cookie, keep the import) stayed green in vitest, tsc and eslint while it
 * silently reinstated #1091 in the shipped container. This runs the default
 * export against a stubbed request and asserts the zone it hands next-intl.
 */

const jar = vi.hoisted(() => ({ cookies: {} as Record<string, string> }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name in jar.cookies ? { value: jar.cookies[name] } : undefined,
  }),
  headers: async () => new Headers(),
}));

// Unwrap next-intl's factory so the test calls the config function directly.
vi.mock('next-intl/server', () => ({
  getRequestConfig: (fn: unknown) => fn,
}));

/** `CONTAINER_TIME_ZONE` is resolved when `request.ts` loads, so TZ has to be
 *  in place before every fresh import. */
async function resolveZone(
  cookies: Record<string, string>,
  tz: string | undefined,
): Promise<string | undefined> {
  jar.cookies = cookies;
  vi.stubEnv('TZ', tz);
  vi.resetModules();
  const { default: getConfig } = await import('../../../i18n/request');
  const config = await getConfig({ requestLocale: Promise.resolve(undefined) });
  return config.timeZone;
}

afterEach(() => {
  vi.unstubAllEnvs();
  jar.cookies = {};
});

describe('#1091 — i18n/request.ts renders in the cookie zone', () => {
  it('uses the operator zone from the cookie, even over a configured TZ', async () => {
    await expect(
      resolveZone({ [TIME_ZONE_COOKIE]: 'Europe%2FBerlin' }, 'America/New_York'),
    ).resolves.toBe('Europe/Berlin');
  });

  it('uses the cookie zone on the explicit-locale branch too', async () => {
    await expect(
      resolveZone(
        { [TIME_ZONE_COOKIE]: 'Europe%2FBerlin', [LOCALE_COOKIE]: 'de' },
        undefined,
      ),
    ).resolves.toBe('Europe/Berlin');
  });

  it('falls back to UTC with no cookie and no TZ', async () => {
    await expect(resolveZone({}, undefined)).resolves.toBe('UTC');
  });

  it('falls back to a valid container TZ when the cookie is junk', async () => {
    await expect(
      resolveZone({ [TIME_ZONE_COOKIE]: 'Not%2FA_Zone' }, 'America/New_York'),
    ).resolves.toBe('America/New_York');
  });
});
