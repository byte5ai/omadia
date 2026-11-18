'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  type LegacyConversionResult,
  type LegacyFieldEntry,
  convertLegacyFieldEntry,
  listLegacyFieldEntries,
} from '../../../_lib/api';
import { serverErrorMessage } from '../../../_lib/apiErrorMessage';
import { ErrorLine } from './FieldCard';
import { scopeText } from './fieldText';
import { PRIVACY_FIELDS_PATH } from './PrivacyFieldsView';

/**
 * `/admin/privacy-fields?view=legacy` — legacy `non_personal_fields` entries
 * (`tool:field`, `*:field`, `field`). They apply to EVERY model of a source,
 * so the same field name in a person model is cleared too. Each can be
 * converted into model-scoped entries for the fields the page has seen;
 * fields it covers that were never seen are masked afterwards.
 */

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; entries: LegacyFieldEntry[] }
  | { kind: 'error'; detail: string | null };

type ConvertNotice =
  | { kind: 'done'; result: LegacyConversionResult }
  | { kind: 'gone'; entry: string }
  | { kind: 'error'; entry: string; detail: string | null };

async function fetchEntries(): Promise<LoadState> {
  try {
    const { entries } = await listLegacyFieldEntries();
    return { kind: 'ready', entries };
  } catch (err) {
    return { kind: 'error', detail: serverErrorMessage(err) };
  }
}

export function LegacyEntriesView(): React.ReactElement {
  const t = useTranslations('adminPrivacyFields');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [busyEntry, setBusyEntry] = useState<string | null>(null);
  const [notice, setNotice] = useState<ConvertNotice | null>(null);

  const load = useCallback(async (): Promise<void> => setState(await fetchEntries()), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await fetchEntries();
      if (!cancelled) setState(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const convert = async (entry: string): Promise<void> => {
    setBusyEntry(entry);
    setNotice(null);
    try {
      const result = await convertLegacyFieldEntry(entry);
      setNotice({ kind: 'done', result });
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'legacy_entry_not_found') {
        setNotice({ kind: 'gone', entry });
        await load();
      } else {
        setNotice({ kind: 'error', entry, detail: serverErrorMessage(err) });
      }
    } finally {
      setBusyEntry(null);
    }
  };

  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-6">
        <p className="mb-2 text-[13px]">
          <Link href={PRIVACY_FIELDS_PATH} className="text-[color:var(--accent)] hover:underline">
            {t('legacy.back')}
          </Link>
        </p>
        <h1 className="font-display text-[clamp(2rem,4vw,3rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('legacy.title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t('legacy.intro')}
        </p>
      </header>

      {notice !== null ? <ConvertNoticeLine notice={notice} /> : null}

      {state.kind === 'loading' ? (
        <p className="text-sm opacity-70">{t('loading')}</p>
      ) : state.kind === 'error' ? (
        <ErrorLine message={t('legacy.errors.load')} detail={state.detail} />
      ) : state.entries.length === 0 ? (
        <p className="text-sm text-[color:var(--fg-muted)]" data-testid="legacy-empty">
          {t('legacy.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {state.entries.map((legacy) => (
            <li
              key={legacy.entry}
              data-testid={`legacy-${legacy.entry}`}
              className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <code className="font-mono text-[14px] font-semibold text-[color:var(--fg-strong)]">
                  {legacy.entry}
                </code>
                <span className="text-xs text-[color:var(--fg-muted)]">{t('legacy.appliesToAll')}</span>
              </div>
              {legacy.covers.length > 0 ? (
                <div className="mt-3">
                  <div className="text-xs font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
                    {t('legacy.coversHeading', { count: legacy.covers.length })}
                  </div>
                  <ul className="mt-1 flex flex-col gap-1 text-[13px]">
                    {legacy.covers.map((field) => (
                      <li key={field.id} className="font-mono" data-testid={`legacy-cover-${field.id}`}>
                        {field.toolName} · {scopeText(field, t)} · {field.fieldPath}
                        {field.personal ? (
                          <span className="font-sans text-[color:var(--danger)]"> — {t('legacy.personalCover')}</span>
                        ) : (
                          <span className="text-[color:var(--fg-muted)]"> → {field.configEntry}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="mt-3 text-[13px] text-[color:var(--fg-muted)]">{t('legacy.coversNone')}</p>
              )}
              <div className="mt-3">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busyEntry !== null}
                  busy={busyEntry === legacy.entry}
                  busyLabel={t('actions.working')}
                  onClick={() => void convert(legacy.entry)}
                >
                  {t('legacy.convert')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function ConvertNoticeLine({ notice }: { notice: ConvertNotice }): React.ReactElement {
  const t = useTranslations('adminPrivacyFields');
  switch (notice.kind) {
    case 'done':
      return (
        <div role="status" className="mb-4 text-[13px] text-[color:var(--accent)]">
          <p>
            {t('legacy.converted', { entry: notice.result.entry, count: notice.result.added.length })}
          </p>
          {notice.result.skipped.length > 0 ? (
            <p>{t('legacy.skipped', { count: notice.result.skipped.length })}</p>
          ) : null}
          {notice.result.skippedPersonal.length > 0 ? (
            <div className="mt-1 text-[color:var(--fg)]" data-testid="legacy-skipped-personal">
              <p>{t('legacy.skippedPersonal', { count: notice.result.skippedPersonal.length })}</p>
              <ul className="mt-1 list-disc pl-5 font-mono">
                {notice.result.skippedPersonal.map((field) => (
                  <li key={field.id}>
                    {field.toolName} · {scopeText(field, t)} · {field.fieldPath}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {notice.result.conflicts.length > 0 ? (
            <p>{t('legacy.conflicts', { count: notice.result.conflicts.length })}</p>
          ) : null}
        </div>
      );
    case 'gone':
      return <ErrorLine message={t('legacy.errors.notFound', { entry: notice.entry })} detail={null} />;
    case 'error':
      return <ErrorLine message={t('legacy.errors.convert', { entry: notice.entry })} detail={notice.detail} />;
  }
}
