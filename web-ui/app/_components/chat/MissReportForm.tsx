'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '../ui/Button';
import { createMissReport } from '../../_lib/privacyReports';

interface MissReportFormProps {
  /** The turn the report refers to, when the caller knows it. */
  turnId?: string;
}

/**
 * #760 — "report a missed value": the catch basin's intake. Lives inside the
 * PrivacyReceiptCard so the report happens where the miss is noticed. The
 * operator types the missed term deliberately (auth-gated surface); the
 * report lands in the admin review queue at /operator/privacy-reports, where
 * a reviewer turns it into a custom_terms deny-list entry.
 */
export function MissReportForm({ turnId }: MissReportFormProps): React.ReactElement {
  const t = useTranslations('privacyReceipt');
  const [term, setTerm] = useState('');
  const [description, setDescription] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function submit(): Promise<void> {
    if (term.trim().length === 0 || state === 'sending') return;
    setState('sending');
    try {
      await createMissReport({
        term: term.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(turnId ? { turnId } : {}),
      });
      setState('sent');
      setTerm('');
      setDescription('');
    } catch {
      setState('error');
    }
  }

  if (state === 'sent') {
    return <p className="mt-1 text-[11px] italic">{t('missReportSent')}</p>;
  }

  return (
    <details className="mt-1">
      <summary className="cursor-pointer select-none text-[11px] underline decoration-dotted">
        {t('missReportSummary')}
      </summary>
      <div className="mt-1 grid gap-1">
        <input
          className="rounded border border-[color:var(--edge)] bg-transparent px-2 py-1 text-[12px]"
          value={term}
          maxLength={200}
          placeholder={t('missReportTermPlaceholder')}
          onChange={(e) => setTerm(e.target.value)}
        />
        <input
          className="rounded border border-[color:var(--edge)] bg-transparent px-2 py-1 text-[12px]"
          value={description}
          maxLength={2000}
          placeholder={t('missReportDescriptionPlaceholder')}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={term.trim().length === 0}
            busy={state === 'sending'}
            busyLabel={t('missReportSending')}
            onClick={() => void submit()}
          >
            {t('missReportSubmit')}
          </Button>
          {state === 'error' ? (
            <span className="text-[11px] text-[color:var(--danger)]">{t('missReportFailed')}</span>
          ) : null}
        </div>
        <p className="text-[10px] italic opacity-80">{t('missReportHint')}</p>
      </div>
    </details>
  );
}
