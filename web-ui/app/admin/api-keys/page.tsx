'use client';

import { useTranslations } from 'next-intl';

import { ApiKeysPanel } from './_components/ApiKeysPanel';

/**
 * Issues #438/#439 admin surface — server-to-server bearer credentials for
 * the public chat API (`POST /api/public/v1/chat`). Create/list/revoke only;
 * there is no update or rotate — a key that needs different scopes or a
 * different rate limit is revoked and replaced by a new one, keeping the
 * "plaintext shown exactly once, at creation" invariant simple to reason
 * about (no second code path that could leak a token after the fact).
 */
export default function AdminApiKeysPage(): React.ReactElement {
  const t = useTranslations('adminApiKeys');

  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t('intro')}
        </p>
      </header>

      <ApiKeysPanel />
    </main>
  );
}
