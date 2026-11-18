import { getTranslations } from 'next-intl/server';

/**
 * The navigation skeleton every `loading.tsx` renders (OM-96).
 *
 * A beta tester reported the DASHBOARD nav item "does not navigate": the page
 * stayed, the active marker stayed, only the window title sometimes changed.
 * The nav was innocent. Without a `loading.tsx` boundary, Next keeps the
 * CURRENT page mounted while a dynamic route's RSC payload is in flight and
 * commits the navigation only once it arrives, so one slow middleware endpoint
 * made a working navigation look like a dead link. A boundary makes the
 * navigation *observable*: the click commits immediately and the nav marker
 * moves. The other half of that fix, bounding the fetches, lives in
 * `_lib/api.ts` (`RSC_FETCH_TIMEOUT_MS`).
 *
 * WHY THERE IS NO ROOT `app/loading.tsx` (#1398)
 * ----------------------------------------------
 * A loading boundary is a Suspense boundary: Next flushes the shell, and with
 * it the `200` status line, before the page below it runs. A page that then
 * calls `notFound()` can no longer answer 404; it serves the not-found UI with
 * status 200, and monitoring, link checkers and crawlers see a healthy page.
 * So the boundary sits per segment instead, never above a page that calls
 * `notFound()`. Index pages that share a segment with such a detail route live
 * in a route group (`(index)`, `(dashboard)`) to get their own boundary.
 * `app/__tests__/loadingBoundaries.test.ts` enforces both halves.
 *
 * Deliberately a plain skeleton and not a spinner: it stands in for content
 * that is arriving, and a shape that matches the page underneath is less
 * jarring on a fast local connection, where it may only be visible for a
 * frame. `role="status"` carries the announcement for screen readers, which
 * would otherwise be told nothing at all.
 */
export async function PageLoading(): Promise<React.ReactElement> {
  const t = await getTranslations('layout');
  return (
    <main
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="mx-auto w-full max-w-[1280px] px-6 py-12 lg:px-8 lg:py-16"
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
