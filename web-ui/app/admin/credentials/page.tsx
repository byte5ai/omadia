'use client';

import { useEffect, useState } from 'react';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { type CredentialDto, listCredentials, listPendingAsks } from '../../_lib/adminCredentials';
import { ErrorLine, MutedLine, SurfaceFrame, SurfaceSection, useErrorText } from '../_components/AdminSurface';
import { CredentialTable } from './_components/CredentialTable';

/**
 * Admin → Credentials (#2320, ADR-0102): the keychain's credential metadata
 * with grants and revocation, and a link to the ask inbox
 * (`/admin/credentials/asks`). No secret, no fingerprint ever reaches it.
 */

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; credentials: CredentialDto[]; pendingCount: number | null }
  | { kind: 'error'; error: unknown };

export default function AdminCredentialsPage(): React.ReactElement {
  const t = useTranslations('adminCredentials');
  const errorText = useErrorText();
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [generation, setGeneration] = useState(0);
  const reload = async (): Promise<void> => setGeneration((g) => g + 1);

  useEffect(() => {
    let cancelled = false;
    // Fetch-on-change: state is touched only after the awaited round-trip.
    void (async () => {
      try {
        const [credentials, pending] = await Promise.all([
          listCredentials(),
          // The count is a hint; the inbox page reports its own errors.
          listPendingAsks().catch(() => null),
        ]);
        if (!cancelled) {
          setState({ kind: 'ready', credentials, pendingCount: pending === null ? null : pending.length });
        }
      } catch (err) {
        if (!cancelled) setState({ kind: 'error', error: err });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [generation]);

  if (state.kind !== 'ready') {
    return (
      <SurfaceFrame title={t('title')} intro={t('intro')}>
        {state.kind === 'loading' ? <MutedLine text={t('loading')} /> : <ErrorLine text={errorText(state.error)} />}
      </SurfaceFrame>
    );
  }

  return (
    <SurfaceFrame title={t('title')} intro={t('intro')}>
      <SurfaceSection heading={t('inbox.heading')} hint={t('inbox.hint')}>
        <Link href="/admin/credentials/asks" className="text-sm text-[color:var(--accent)] hover:underline">
          {state.pendingCount === null
            ? t('asksLink.unknown')
            : t('asksLink.count', { count: state.pendingCount })}
        </Link>
      </SurfaceSection>
      <SurfaceSection heading={t('list.heading')} hint={t('list.hint')}>
        {state.credentials.length === 0 ? (
          <MutedLine text={t('list.empty')} />
        ) : (
          <CredentialTable credentials={state.credentials} onChanged={reload} />
        )}
      </SurfaceSection>
    </SurfaceFrame>
  );
}
