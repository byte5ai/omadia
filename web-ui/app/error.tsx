'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';

/**
 * Route-level error boundary. Without it, a thrown error during render of the
 * chat page (e.g. a chat session persisted by an older schema, whose drifted
 * shape crashed on `message.content.length`) bubbled up to the browser's
 * cryptic "This page couldn't load" page with no recovery path and nothing
 * logged server-side. This renders an in-app fallback with two recoveries:
 *   - Reload — retry the render (fixes transient errors).
 *   - Reset local chat data — clears this browser's locally-stored chats, the
 *     usual culprit after a schema bump, then reloads. Server-side data is
 *     untouched.
 */

// Mirrors the keys in app/_lib/chatSessions.ts. Kept inline so the boundary has
// no dependency on the module that may have thrown.
const LOCAL_CHAT_KEYS = [
  'odoo-bot-chat-sessions',
  'odoo-bot-chat-active-id',
  'odoo-bot-scope',
];

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  const t = useTranslations('error');

  useEffect(() => {
    console.error('[web-ui] route error boundary caught:', error);
  }, [error]);

  const resetLocalData = (): void => {
    try {
      for (const key of LOCAL_CHAT_KEYS) window.localStorage.removeItem(key);
    } catch {
      // localStorage may be unavailable (private mode) — reload anyway.
    }
    window.location.reload();
  };

  return (
    <main className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mx-auto flex max-w-md flex-col items-center gap-4">
        <h1 className="font-display text-2xl text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="text-sm text-[color:var(--fg-muted)]">{t('description')}</p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => {
              reset();
            }}
            className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            {t('reload')}
          </button>
          <button
            type="button"
            onClick={resetLocalData}
            className="rounded border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition hover:border-neutral-400 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            {t('resetData')}
          </button>
        </div>
        <p className="mt-1 text-xs text-[color:var(--fg-muted)]">
          {t('resetDataHint')}
        </p>
      </div>
    </main>
  );
}
