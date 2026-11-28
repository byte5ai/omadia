'use client';

import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  type CredentialAskDto,
  type CredentialDto,
  listCredentials,
  listMyAsks,
  listPendingAsks,
} from '../../_lib/adminCredentials';
import { ErrorLine, MutedLine, SurfaceFrame, SurfaceSection, useErrorText } from '../_components/AdminSurface';
import { AskTable } from './_components/AskTable';
import { CredentialTable } from './_components/CredentialTable';

/**
 * Admin → Credentials (#2320, ADR-0102). Three reads, each scoped by the
 * server: asks addressed to the signed-in owner, asks the signed-in user
 * made, and the keychain's credential metadata with grants and revocation.
 * No secret, no fingerprint ever reaches this page.
 */

type Load<T> = { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'error'; error: unknown };

interface PageData {
  readonly credentials: CredentialDto[];
  readonly pending: CredentialAskDto[];
  readonly mine: CredentialAskDto[];
}

export default function AdminCredentialsPage(): React.ReactElement {
  const t = useTranslations('adminCredentials');
  const errorText = useErrorText();
  const [state, setState] = useState<Load<PageData>>({ kind: 'loading' });

  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Fetch-on-change: state is touched only after the awaited round-trip.
    void (async () => {
      try {
        const [credentials, pending, mine] = await Promise.all([
          listCredentials(),
          listPendingAsks(),
          listMyAsks(),
        ]);
        if (!cancelled) setState({ kind: 'ready', value: { credentials, pending, mine } });
      } catch (err) {
        if (!cancelled) setState({ kind: 'error', error: err });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [generation]);

  async function reload(): Promise<void> {
    setGeneration((g) => g + 1);
  }

  if (state.kind === 'loading') {
    return (
      <SurfaceFrame title={t('title')} intro={t('intro')}>
        <MutedLine text={t('loading')} />
      </SurfaceFrame>
    );
  }
  if (state.kind === 'error') {
    return (
      <SurfaceFrame title={t('title')} intro={t('intro')}>
        <ErrorLine text={errorText(state.error)} />
      </SurfaceFrame>
    );
  }

  const { credentials, pending, mine } = state.value;
  const names = new Map(credentials.map((c) => [c.id, c.name]));
  return (
    <SurfaceFrame title={t('title')} intro={t('intro')}>
      <SurfaceSection heading={t('inbox.heading')} hint={t('inbox.hint')}>
        {pending.length === 0 ? (
          <MutedLine text={t('inbox.empty')} />
        ) : (
          <AskTable asks={pending} names={names} role="owner" onChanged={reload} />
        )}
      </SurfaceSection>
      <SurfaceSection heading={t('mine.heading')}>
        {mine.length === 0 ? (
          <MutedLine text={t('mine.empty')} />
        ) : (
          <AskTable asks={mine} names={names} role="requester" onChanged={reload} />
        )}
      </SurfaceSection>
      <SurfaceSection heading={t('list.heading')} hint={t('list.hint')}>
        {credentials.length === 0 ? (
          <MutedLine text={t('list.empty')} />
        ) : (
          <CredentialTable credentials={credentials} onChanged={reload} />
        )}
      </SurfaceSection>
    </SurfaceFrame>
  );
}
