'use client';

import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { reapSandboxes, type SandboxReaperBounds, type SandboxReapResponse } from '../../../_lib/adminSandboxes';
import { ConfirmButton, ErrorLine, Mono, MutedLine, useErrorText } from '../../_components/AdminSurface';

/**
 * Manual idle sweep: preview first (dry run), then sweep. The threshold is in
 * hours here and sent in minutes; the server checks the bounds again.
 */
export function ReaperPanel({
  bounds,
  onSwept,
}: {
  bounds: SandboxReaperBounds;
  onSwept: () => Promise<void>;
}): React.ReactElement {
  const t = useTranslations('adminSandboxes.reaper');
  const errorText = useErrorText({ 'sandbox_admin.invalid_idle': t('errors.invalidIdle') });
  const [hours, setHours] = useState(String(bounds.default_idle_minutes / 60));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SandboxReapResponse | null>(null);
  const [error, setError] = useState<unknown>(null);

  const minutes = Math.round(Number(hours) * 60);
  const valid =
    Number.isFinite(minutes) && minutes >= bounds.min_idle_minutes && minutes <= bounds.max_idle_minutes;

  async function run(dryRun: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const next = await reapSandboxes(minutes, dryRun);
      setResult(next);
      if (!dryRun) await onSwept();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t('idleLabel')}</span>
          <input
            type="number"
            min={bounds.min_idle_minutes / 60}
            max={bounds.max_idle_minutes / 60}
            step="any"
            value={hours}
            onChange={(e) => {
              setHours(e.target.value);
              setResult(null);
            }}
            className="w-28 rounded-md border border-[color:var(--border)] bg-transparent px-3 py-2 text-sm"
          />
        </label>
        <Button variant="secondary" size="sm" disabled={!valid || busy} onClick={() => void run(true)}>
          {t('preview')}
        </Button>
        <ConfirmButton
          label={t('sweep')}
          confirmLabel={t('confirmSweep')}
          busy={busy}
          disabled={!valid}
          onConfirm={() => void run(false)}
        />
      </div>
      {!valid ? (
        <MutedLine
          text={t('bounds', { min: bounds.min_idle_minutes / 60, max: bounds.max_idle_minutes / 60 })}
        />
      ) : null}
      {error !== null ? <ErrorLine text={errorText(error)} /> : null}
      {result ? <ReapResult result={result} /> : null}
    </div>
  );
}

function ReapResult({ result }: { result: SandboxReapResponse }): React.ReactElement {
  const t = useTranslations('adminSandboxes.reaper');
  if (result.dry_run) {
    return (
      <div className="text-sm">
        <p>{t('previewResult', { count: result.candidates.length })}</p>
        <ScopeList keys={result.candidates} />
      </div>
    );
  }
  return (
    <div className="text-sm">
      <p>{t('sweepResult', { reaped: result.reaped.length, failed: result.failed.length })}</p>
      <ScopeList keys={result.failed} />
    </div>
  );
}

function ScopeList({ keys }: { keys: readonly string[] }): React.ReactElement | null {
  if (keys.length === 0) return null;
  return (
    <ul className="mt-1 list-disc pl-5">
      {keys.map((k) => (
        <li key={k}>
          <Mono>{k}</Mono>
        </li>
      ))}
    </ul>
  );
}
