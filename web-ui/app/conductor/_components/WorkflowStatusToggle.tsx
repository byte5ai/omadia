'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { setConductorWorkflowStatus, type ConductorWorkflow } from '@/app/_lib/api';

/**
 * #1711 — enable/disable, on the workflow's own list row.
 *
 * `POST /conductors/templates/:id/instantiate` without `enable: true` creates
 * the workflow `disabled`, and the backend route that flips it
 * (`POST /conductors/:slug/status`, 204) had no caller in the web UI: the list
 * printed the status as text and "Starten" answered with a raw 409. So the only
 * exit from the default state of a template instantiation was a hand-written
 * API call. The switch belongs where the operator already is — next to Run.
 *
 * Lume: a plain ghost button like the row's other secondary actions, labelled
 * with the TARGET state (the verb, not the current status — the status itself is
 * rendered as text beside the slug). Failures are reported to the page's error
 * slot rather than painted into the row, so one error line serves the list.
 */
export function WorkflowStatusToggle({
  slug,
  status,
  disabled = false,
  onChanged,
  onError,
}: {
  slug: string;
  status: ConductorWorkflow['status'];
  /** Set while another row-level mutation (delete) is in flight. */
  disabled?: boolean;
  onChanged: () => void;
  onError: (message: string | null) => void;
}): React.JSX.Element {
  const t = useTranslations('conductor');
  const [busy, setBusy] = useState(false);
  const next: ConductorWorkflow['status'] = status === 'enabled' ? 'disabled' : 'enabled';

  const toggle = async (): Promise<void> => {
    // Own in-flight guard: a double-fired click must not send the status twice
    // (the second would flip it straight back).
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await setConductorWorkflowStatus(slug, next);
      onChanged();
    } catch {
      // Catalog copy, never the raw ApiError text (i18n hard rule).
      onError(t('statusChangeFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant="ghost"
      busy={busy}
      busyLabel={t('statusSaving')}
      disabled={disabled || busy}
      onClick={() => void toggle()}
    >
      {next === 'enabled' ? t('enableButton') : t('disableButton')}
    </Button>
  );
}
