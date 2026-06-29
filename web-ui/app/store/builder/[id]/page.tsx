import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ApiError, getBuilderDraft } from '../../../_lib/api';
import { redirectIfUnauthorized } from '../../../_lib/authRedirect';

import { Workspace } from './_components/Workspace';

export const metadata: Metadata = {
  title: 'Workspace · Agent-Builder · omadia',
};

export const dynamic = 'force-dynamic';

export default async function BuilderWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await params;

  // Only the data fetch is wrapped — constructing the <Workspace> JSX inside
  // the try would (correctly) trip the React-Compiler `error-boundaries` rule:
  // render errors from <Workspace> are not caught by a try/catch around it.
  let envelope: Awaited<ReturnType<typeof getBuilderDraft>>;
  try {
    envelope = await getBuilderDraft(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      notFound();
    }
    await redirectIfUnauthorized(err);
    return <LoadErrorState id={id} error={err} />;
  }
  return <Workspace initialDraft={envelope.draft} />;
}

async function LoadErrorState({
  id,
  error,
}: {
  id: string;
  error: unknown;
}): Promise<React.ReactElement> {
  const t = await getTranslations('builder.drafts.detail');
  const message = error instanceof Error ? error.message : t('error.unknown');
  return (
    <main className="mx-auto max-w-[1280px] px-6 py-12 lg:px-8 lg:py-16">
      <div className="rounded-lg border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/6 p-8">
        <div className="flex items-baseline gap-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[color:var(--danger)]">
          <span>{t('error.label')}</span>
          <span className="h-px flex-1 bg-[color:var(--danger)]/30" />
        </div>
        <p className="font-display mt-4 text-[26px] text-[color:var(--danger)]">
          {t('error.loadFailed')}
        </p>
        <p className="font-mono-num mt-3 text-sm text-[color:var(--fg-muted)]">
          {t('error.draftPrefix')} <span className="font-mono-num">{id}</span> — {message}
        </p>
        <Link
          href="/store/builder"
          className="mt-6 inline-flex items-center gap-2 rounded-full bg-[color:var(--accent)] px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-on-dark)] shadow-[var(--shadow-cta)]"
        >
          ← {t('error.backToList')}
        </Link>
      </div>
    </main>
  );
}
