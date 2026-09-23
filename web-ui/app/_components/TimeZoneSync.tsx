'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

import {
  TIME_ZONE_COOKIE,
  isValidTimeZone,
  resolveBrowserTimeZone,
} from '../_lib/timeZone';

/**
 * Issue #1091 — headless. Mirrors the browser's IANA zone into the
 * `omadia-tz` cookie so `i18n/request.ts` can render timestamps in the
 * OPERATOR's zone instead of the container's (UTC in the shipped image).
 *
 * Same mechanism as the no-FOUC palette cookie in `ThemeControls`: the client
 * writes, the RSC reads on the next request. Deciding the zone before render
 * rather than re-formatting after mount is what keeps server and client output
 * identical — the alternative is a React hydration mismatch on every one of
 * the ~37 `format.dateTime` call sites in the app.
 *
 * Cost of the cookie approach, stated plainly: the very first page view on a
 * fresh browser renders the server's fallback zone, because the cookie does not
 * exist yet. The `router.refresh()` below closes that gap within the same
 * visit — and only then. The zone the page in front of the operator was
 * actually rendered in arrives as `data-timezone` on <html> (stamped by
 * `layout.tsx`, same mechanism as `data-palette`), so a page that is already
 * correct — operator in UTC, or a container run with a matching `TZ` — costs no
 * second render of the tree.
 */

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year — a stable client property.

function readTimeZoneCookie(): string | null {
  for (const entry of document.cookie.split(';')) {
    const [name, ...rest] = entry.trim().split('=');
    if (name === TIME_ZONE_COOKIE) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Lax + path=/ so it rides every same-site navigation; `Secure` over HTTPS so
 *  it is never sent on a downgraded plain-HTTP request, omitted on http
 *  (localhost dev) where browsers reject Secure cookies — as `ThemeControls`
 *  does for the UI-prefs cookie. */
function writeTimeZoneCookie(zone: string): void {
  const secure = window.location.protocol === 'https:' ? ';secure' : '';
  document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent(zone)};path=/;max-age=${COOKIE_MAX_AGE};samesite=lax${secure}`;
}

/** The zone this page was rendered in, per `layout.tsx`. Absent only if the
 *  markup predates that attribute (a stale cached document). */
function serverRenderedZone(): string | undefined {
  return document.documentElement.dataset.timezone;
}

export function TimeZoneSync(): null {
  const router = useRouter();

  useEffect(() => {
    const zone = resolveBrowserTimeZone();
    // A zone this runtime cannot format in would 500 the server on read. The
    // parser defends there too; not writing it at all is the cheaper half.
    if (!isValidTimeZone(zone)) return;

    const previous = readTimeZoneCookie();
    // Written unconditionally, including when the value is unchanged: the
    // cookie carries a 1-year max-age, and an early return on a match would
    // never renew it.
    writeTimeZoneCookie(zone);
    // Only go further if the write actually stuck. Where cookies are blocked
    // the read comes back empty on every fresh mount, and an unconditional
    // refresh would re-render the whole RSC tree (nav fetch included) on every
    // page load — forever, for a zone the server will never receive.
    if (readTimeZoneCookie() !== zone) return;

    // Refresh only when the page in front of the operator is actually in the
    // wrong zone. `data-timezone` answers that directly; without it (stale
    // markup) fall back to "did this mount change the cookie".
    const rendered = serverRenderedZone();
    const stale = rendered === undefined ? previous !== zone : rendered !== zone;
    if (!stale) return;
    router.refresh();
  }, [router]);

  return null;
}
