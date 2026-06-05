'use client';

import { useEffect } from 'react';

/**
 * Last-resort boundary for errors thrown in the ROOT LAYOUT itself (e.g.
 * next-intl `getMessages()` failing) — at that point the NextIntlClientProvider
 * isn't mounted, so this file cannot use `useTranslations`. Strings are
 * therefore hardcoded: this is the one documented exception to the web-ui i18n
 * rule (see web-ui/CLAUDE.md), because the provider that would translate them
 * is the very thing that failed. Bilingual to stay useful for both locales.
 *
 * global-error replaces the whole document, so it must render <html>/<body>.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  useEffect(() => {
    console.error('[web-ui] global error boundary caught:', error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          margin: 0,
          padding: '2rem',
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: '28rem' }}>
          <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>
            Something went wrong · Etwas ist schiefgelaufen
          </h1>
          <p style={{ color: '#666', fontSize: '0.875rem', marginBottom: '1rem' }}>
            The app failed to load. Try reloading. · Die App konnte nicht geladen
            werden. Bitte neu laden.
          </p>
          <button
            type="button"
            onClick={() => {
              reset();
            }}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '0.375rem',
              border: 'none',
              background: '#171717',
              color: '#fff',
              fontSize: '0.875rem',
              cursor: 'pointer',
            }}
          >
            Reload · Neu laden
          </button>
        </div>
      </body>
    </html>
  );
}
