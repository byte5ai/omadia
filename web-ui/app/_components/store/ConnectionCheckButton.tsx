'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, Plug } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '../ui/Button';

/**
 * Issue #1453 — "check these credentials now".
 *
 * The probe behind it also runs at every activation, so most of the time this
 * button is not needed. It exists for the case nothing else covers: a key
 * revoked or repaired UPSTREAM, with nothing on the omadia side changed. Before
 * it, the only way to re-check was to save a setup field you did not want to
 * change.
 *
 * The verdict rendered here is deliberately three-valued. "Could not be
 * checked" is NOT "working" — presenting an inconclusive probe as a healthy
 * connection is the exact conflation this issue was filed about. The
 * `ActionStatusBanner` next to it picks up the new status on its own poll, so
 * this component only has to report what the check just answered.
 */
type Verdict = 'connected' | 'rejected' | 'inconclusive' | 'no_probe';

interface VerifyResponse {
  readonly status?: string;
  readonly reason?: string;
  readonly detail?: string;
}

export function ConnectionCheckButton({
  pluginId,
}: {
  pluginId: string;
}): React.ReactElement {
  const t = useTranslations('store.connectionCheck');
  const [running, setRunning] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setRunning(true);
    setVerdict(null);
    setDetail(null);
    try {
      const res = await fetch(
        `/bot-api/v1/admin/runtime/installed/${encodeURIComponent(pluginId)}/verify`,
        { method: 'POST', headers: { accept: 'application/json' } },
      );
      // A non-2xx is the route refusing to check (not installed, not running).
      // That is "unchecked", never "fine".
      if (!res.ok) {
        setVerdict('inconclusive');
        return;
      }
      const body = (await res.json()) as VerifyResponse;
      if (body.status === 'connected') setVerdict('connected');
      else if (body.status === 'rejected') setVerdict('rejected');
      else setVerdict(body.reason === 'no_probe' ? 'no_probe' : 'inconclusive');
      setDetail(typeof body.detail === 'string' ? body.detail : null);
    } catch {
      setVerdict('inconclusive');
    } finally {
      setRunning(false);
    }
  };

  const LABEL: Record<Verdict, string> = {
    connected: t('connected'),
    rejected: t('rejected'),
    inconclusive: t('inconclusive'),
    no_probe: t('noProbe'),
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        busy={running}
        busyLabel={t('checking')}
        onClick={() => {
          void run();
        }}
      >
        <Plug className="size-3.5" aria-hidden />
        {t('check')}
      </Button>

      {verdict ? (
        <p
          role="status"
          className={
            verdict === 'connected'
              ? 'flex items-center gap-1.5 text-[13px] text-[color:var(--success)]'
              : verdict === 'rejected'
                ? 'flex items-center gap-1.5 text-[13px] text-[color:var(--danger)]'
                : 'flex items-center gap-1.5 text-[13px] text-[color:var(--fg-subtle)]'
          }
        >
          {verdict === 'connected' ? (
            <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
          ) : verdict === 'rejected' ? (
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <HelpCircle className="size-3.5 shrink-0" aria-hidden />
          )}
          <span>
            {LABEL[verdict]}
            {detail ? ` — ${detail}` : ''}
          </span>
        </p>
      ) : null}
    </div>
  );
}
