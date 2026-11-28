'use client';

import { useEffect, useState } from 'react';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import {
  type CredentialAskDto,
  listCredentials,
  listMyAsks,
  listPendingAsks,
} from '../../../_lib/adminCredentials';
import { ErrorLine, MutedLine, SurfaceFrame, SurfaceSection, useErrorText } from '../../_components/AdminSurface';
import { AskTable } from './AskTable';

type Load =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      pending: CredentialAskDto[];
      mine: CredentialAskDto[];
      names: ReadonlyMap<string, string>;
    }
  | { kind: 'error'; error: unknown };

/**
 * Both ask lists. Each read is scoped by the server to the session: the
 * inbox holds asks addressed to the signed-in owner, "your asks" the ones
 * they made. `focusAskId` (from `?ask=`) highlights one row.
 */
export function AskInboxView({ focusAskId }: { focusAskId: string | null }): React.ReactElement {
  const t = useTranslations('adminCredentials');
  const errorText = useErrorText();
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [generation, setGeneration] = useState(0);
  const reload = async (): Promise<void> => setGeneration((g) => g + 1);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [pending, mine, credentials] = await Promise.all([
          listPendingAsks(),
          listMyAsks(),
          // Names only make the table readable; the inbox works without them.
          listCredentials().catch(() => []),
        ]);
        if (!cancelled) {
          setState({ kind: 'ready', pending, mine, names: new Map(credentials.map((c) => [c.id, c.name])) });
        }
      } catch (err) {
        if (!cancelled) setState({ kind: 'error', error: err });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [generation]);

  const back = (
    <Link href="/admin/credentials" className="text-sm text-[color:var(--accent)] hover:underline">
      {t('asksPage.back')}
    </Link>
  );

  if (state.kind !== 'ready') {
    return (
      <SurfaceFrame title={t('asksPage.title')} intro={t('asksPage.intro')}>
        {back}
        {state.kind === 'loading' ? <MutedLine text={t('loading')} /> : <ErrorLine text={errorText(state.error)} />}
      </SurfaceFrame>
    );
  }

  const focusMissing =
    focusAskId !== null && !state.pending.some((a) => a.id === focusAskId) && !state.mine.some((a) => a.id === focusAskId);

  return (
    <SurfaceFrame title={t('asksPage.title')} intro={t('asksPage.intro')}>
      {back}
      {focusMissing ? <MutedLine text={t('asksPage.focusMissing')} /> : null}
      <SurfaceSection heading={t('inbox.heading')} hint={t('inbox.hint')}>
        {state.pending.length === 0 ? (
          <MutedLine text={t('inbox.empty')} />
        ) : (
          <AskTable asks={state.pending} names={state.names} role="owner" focusId={focusAskId} onChanged={reload} />
        )}
      </SurfaceSection>
      <SurfaceSection heading={t('mine.heading')}>
        {state.mine.length === 0 ? (
          <MutedLine text={t('mine.empty')} />
        ) : (
          <AskTable asks={state.mine} names={state.names} role="requester" focusId={focusAskId} onChanged={reload} />
        )}
      </SurfaceSection>
    </SurfaceFrame>
  );
}
