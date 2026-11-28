'use client';

import { useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { listSandboxes, type SandboxListResponse } from '../../_lib/adminSandboxes';
import { ErrorLine, MutedLine, SurfaceFrame, SurfaceSection, useErrorText } from '../_components/AdminSurface';
import { ReaperPanel } from './_components/ReaperPanel';
import { SandboxTable } from './_components/SandboxTable';

/**
 * Admin → Sandboxes (#2320, #576, ADR-0055). The per-scope containers the
 * `execute` and `publish` tools run in, and the idle sweep. No reaper runs on
 * a schedule; a sweep is started here.
 */

type Load = { kind: 'loading' } | { kind: 'ready'; data: SandboxListResponse } | { kind: 'error'; error: unknown };

export default function AdminSandboxesPage(): React.ReactElement {
  const t = useTranslations('adminSandboxes');
  const errorText = useErrorText();
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [generation, setGeneration] = useState(0);
  const reload = async (): Promise<void> => setGeneration((g) => g + 1);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await listSandboxes();
        if (!cancelled) setState({ kind: 'ready', data });
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
      <SurfaceSection heading={t('reaper.heading')} hint={t('reaper.hint')}>
        <ReaperPanel bounds={state.data.reaper} onSwept={reload} />
      </SurfaceSection>
      <SurfaceSection heading={t('list.heading')}>
        {state.data.sandboxes.length === 0 ? (
          <MutedLine text={t('list.empty')} />
        ) : (
          <SandboxTable sandboxes={state.data.sandboxes} onChanged={reload} />
        )}
      </SurfaceSection>
    </SurfaceFrame>
  );
}
