import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { redirectIfUnauthorized } from '../../_lib/authRedirect';
import {
  getReceipt,
  listReceipts,
  type ReceiptsPageDto,
} from '../../_lib/receipts';
import { getProvenancePublicKey, type ProvenancePublicKeyDto } from '../../_lib/provenance';
import { ChainStatusCard } from './_components/ChainStatusCard';
import { ReceiptsList } from './_components/ReceiptsList';

/**
 * #757 — operator-facing list of persisted per-turn privacy receipts.
 *
 * A turn writes its PII-free receipt to the middleware's `turn_receipts`
 * store only when the privacy shield acted in it: it interned a dataset,
 * recorded a bypass or a connected tool's structured output, masked the
 * prompt, withheld or redacted a tool error's text, or sent an answer-verifier
 * request under the turn's privacy view (`finalizeTurn()` in
 * harness-plugin-privacy-guard `src/service.ts` returns no receipt otherwise,
 * and the orchestrator persists only when one exists). Turns without shield activity leave no row (#1081), and neither
 * do turns on the Claude subscription CLI: that runtime (`CliChatAgent`)
 * installs no privacy handle, so the shield never runs there. This page is
 * the read surface: what did the shield intern, mask, and (where the
 * operator opted into bypass) pass through, per turn, after the fact, not
 * only while the answer was on screen.
 *
 * #1552 — `?turn=<turnId>` shows that one turn's receipt, expanded, with a
 * link back to the full list. Miss reports and the chat's receipt card link
 * here.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('operatorReceipts');
  return { title: t('metaTitle') };
}

export const dynamic = 'force-dynamic';

/** Reads the optional `?turn=` deep link; repeated or empty values are ignored. */
function turnParam(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 && trimmed.length <= 512 ? trimmed : null;
}

export default async function OperatorReceiptsPage({
  searchParams,
}: {
  searchParams?: Promise<{ turn?: string | string[] }>;
} = {}): Promise<React.ReactElement> {
  const t = await getTranslations('operatorReceipts');
  const turnId = turnParam((await searchParams)?.turn);
  let initial: ReceiptsPageDto | null = null;
  let loadError: string | null = null;
  try {
    if (turnId) {
      const one = await getReceipt(turnId);
      initial = { items: one ? [one] : [] };
    } else {
      initial = await listReceipts({ limit: 25 });
    }
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
      {turnId ? (
        <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
          <Link
            href="/operator/receipts"
            className="font-medium text-[color:var(--accent)] hover:underline"
          >
            {t('backToAll')}
          </Link>
          <span className="break-all text-[color:var(--fg-muted)]">
            {t('singleTurnHeading', { turnId })}
          </span>
        </div>
      ) : null}
      {loadError ? (
        <div className="rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-4 text-sm text-[color:var(--danger)]">
          {loadError}
        </div>
      ) : turnId && initial!.items.length === 0 ? (
        <p
          data-testid="receipt-not-found"
          className="rounded border border-[color:var(--edge)] p-6 text-sm text-[color:var(--fg-muted)]"
        >
          {t('turnNotFound')}
        </p>
      ) : (
        <ReceiptsList
          initial={initial!}
          {...(turnId ? { openTurnId: turnId } : {})}
        />
      )}
    </main>
  );
}
