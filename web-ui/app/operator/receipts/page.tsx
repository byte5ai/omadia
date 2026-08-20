import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { redirectIfUnauthorized } from '../../_lib/authRedirect';
import { listReceipts, type ReceiptsPageDto } from '../../_lib/receipts';
import { getProvenancePublicKey, type ProvenancePublicKeyDto } from '../../_lib/provenance';
import { ChainStatusCard } from './_components/ChainStatusCard';
import { ReceiptsList } from './_components/ReceiptsList';

/**
 * #757 — operator-facing list of persisted per-turn privacy receipts.
 *
 * Every completed turn writes its PII-free receipt to the middleware's
 * `turn_receipts` store; this page is the read surface: what did the shield
 * intern, mask, and (where the operator opted into bypass) pass through —
 * per turn, after the fact, not only while the answer was on screen.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('operatorReceipts');
  return { title: t('metaTitle') };
}

export const dynamic = 'force-dynamic';

export default async function OperatorReceiptsPage(): Promise<React.ReactElement> {
  const t = await getTranslations('operatorReceipts');
  let initial: ReceiptsPageDto | null = null;
  let loadError: string | null = null;
  try {
    initial = await listReceipts({ limit: 25 });
  } catch (err) {
    await redirectIfUnauthorized(err);
    // Catalog key first (checklist rule 3) — the raw error is a technical
    // detail that belongs in the server log, not as the page's primary text.
    console.error('[operator/receipts] initial load failed:', err);
    loadError = t('loadError');
  }
  // #761 — chain posture for the status card. Never fails the page: a
  // receipts list that 500s because a posture hint could not load would be
  // worse than a missing hint.
  let chainKey: ProvenancePublicKeyDto | null = null;
  try {
    chainKey = await getProvenancePublicKey();
  } catch (err) {
    console.error('[operator/receipts] provenance posture load failed:', err);
  }

  return (
    <main className="mx-auto w-full max-w-[1100px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-[color:var(--fg-muted)]">
          {t('subtitle')}
        </p>
      </header>
      <ChainStatusCard initialKey={chainKey} />
      {loadError ? (
        <div className="rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {loadError}
        </div>
      ) : (
        <ReceiptsList initial={initial!} />
      )}
    </main>
  );
}
