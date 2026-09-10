import { getTranslations } from 'next-intl/server';

/**
 * Root loading boundary (OM-96).
 *
 * A beta tester reported the DASHBOARD nav item "does not navigate": the page
 * stayed, the active marker stayed, only the window title sometimes changed.
 * The nav was innocent. Without a `loading.tsx` anywhere in the tree, Next has
 * no boundary to show while a dynamic route's RSC payload is in flight, so it
 * keeps the CURRENT page mounted and commits the navigation only once the new
 * payload arrives. `app/page.tsx` is `force-dynamic` and awaits six upstream
 * calls, so one slow middleware endpoint made a working navigation look like a
 * dead link — there was no visual difference between "loading" and "ignored".
 *
 * This boundary is the half of the fix that makes the navigation *observable*:
 * the click now commits immediately and the nav marker moves. The other half —
 * bounding those fetches — lives in `_lib/api.ts` (`RSC_FETCH_TIMEOUT_MS`), so
 * a hung endpoint degrades one dashboard card instead of parking the page here
 * forever.
 *
 * Deliberately a plain skeleton and not a spinner: it stands in for content
 * that is arriving, and a shape that matches the page underneath is less
 * jarring on a fast local connection, where it may only be visible for a
 * frame. `role="status"` carries the announcement for screen readers, which
 * would otherwise be told nothing at all.
 */
export default async function Loading(): Promise<React.ReactElement> {
  const t = await getTranslations('layout');
  return (
    <main
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="mx-auto w-full max-w-[1600px] px-6 py-12 lg:px-8 lg:py-16"
    >
      <span className="sr-only">{t('loading')}</span>
      <div className="animate-pulse space-y-6" aria-hidden>
        <div className="h-3 w-24 rounded bg-[color:var(--border)]" />
        <div className="h-10 w-2/3 max-w-xl rounded bg-[color:var(--border)]" />
        <div className="h-4 w-1/2 max-w-md rounded bg-[color:var(--border)]" />
        <div className="grid gap-4 pt-6 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((slot) => (
            <div
              key={slot}
              className="h-28 rounded-lg border border-[color:var(--divider)] bg-[color:var(--border)]/40"
            />
          ))}
        </div>
      </div>
    </main>
  );
}
