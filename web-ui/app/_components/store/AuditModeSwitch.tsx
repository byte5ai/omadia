'use client';

/**
 * #91 — operator mode switch for an installed audit/scanner plugin.
 *
 * Three egress modes, widening top-to-bottom:
 *   single-host — only the host(s) declared in the manifest.
 *   allowlist   — manifest hosts + the operator-curated host_list.
 *   public-web  — any public host (private ranges + cloud-metadata stay
 *                 hard-blocked by the runtime SSRF guard).
 *
 * Switching to a wider mode requires an explicit confirm. The current
 * mode is read from the plugin's registry config (`audit_mode`); the
 * middleware rejects the call unless the manifest declares
 * `permissions.network.web_scanner`.
 */

import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { ApiError, listInstalledSecretKeys, setAuditMode } from '../../_lib/api';
import type { AuditMode } from '../../_lib/storeTypes';

/** Mode labels are technical identifiers (same in every locale); the help
 *  copy lives in the catalog under `store.auditMode.<helpKey>`. */
const MODES: ReadonlyArray<{
  value: AuditMode;
  label: string;
  helpKey: string;
}> = [
  {
    value: 'single-host',
    label: 'Single-Host',
    helpKey: 'singleHostHelp',
  },
  {
    value: 'allowlist',
    label: 'Allowlist',
    helpKey: 'allowlistHelp',
  },
  {
    value: 'public-web',
    label: 'Public-Web',
    helpKey: 'publicWebHelp',
  },
];

type Status =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

export function AuditModeSwitch({
  pluginId,
}: {
  pluginId: string;
}): React.ReactElement {
  const t = useTranslations('store.auditMode');
  const [mode, setMode] = useState<AuditMode>('single-host');
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  const load = useCallback(async (): Promise<void> => {
    try {
      const state = await listInstalledSecretKeys(pluginId);
      const raw = state.config_values['audit_mode'];
      if (raw === 'allowlist' || raw === 'public-web' || raw === 'single-host') {
        setMode(raw);
      }
      setStatus({ kind: 'ready' });
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [pluginId]);

  useEffect(() => {
    // Fetch-on-mount: load() touches state only after the awaited fetch —
    // no synchronous cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const onSelect = useCallback(
    async (next: AuditMode): Promise<void> => {
      if (next === mode) return;
      const widening =
        next === 'public-web' ||
        (next === 'allowlist' && mode === 'single-host');
      if (widening) {
        const ok = window.confirm(
          next === 'public-web'
            ? t('confirmPublicWeb')
            : t('confirmAllowlist'),
        );
        if (!ok) return;
      }
      setStatus({ kind: 'saving' });
      try {
        const res = await setAuditMode(pluginId, next);
        setMode(res.audit_mode);
        setStatus({ kind: 'saved' });
      } catch (err) {
        setStatus({
          kind: 'error',
          message:
            err instanceof ApiError
              ? `${String(err.status)}: ${err.message}`
              : err instanceof Error
                ? err.message
                : String(err),
        });
      }
    },
    [mode, pluginId, t],
  );

  const busy = status.kind === 'loading' || status.kind === 'saving';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 text-[13px] text-[color:var(--fg-muted)]">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>
          {t.rich('intro', {
            code: (chunks) => <code>{chunks}</code>,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {MODES.map((m) => (
          <label
            key={m.value}
            className={[
              'flex cursor-pointer items-start gap-3 rounded-md border p-3',
              mode === m.value
                ? 'border-[color:var(--accent)]'
                : 'border-[color:var(--rule)]',
            ].join(' ')}
          >
            <input
              type="radio"
              name="audit-mode"
              value={m.value}
              checked={mode === m.value}
              disabled={busy}
              onChange={() => void onSelect(m.value)}
              className="mt-0.5"
            />
            <span className="flex flex-col">
              <span className="text-[14px] font-semibold text-[color:var(--fg-strong)]">
                {m.label}
              </span>
              <span className="text-[12px] text-[color:var(--fg-muted)]">
                {t(m.helpKey)}
              </span>
            </span>
          </label>
        ))}
      </div>
      <div className="min-h-[20px] text-[12px]">
        {status.kind === 'loading' && (
          <span className="inline-flex items-center gap-2 text-[color:var(--fg-muted)]">
            <span className="lume-busy-dots" aria-hidden /> {t('loading')}
          </span>
        )}
        {status.kind === 'saving' && (
          <span className="inline-flex items-center gap-2 text-[color:var(--fg-muted)]">
            <span className="lume-busy-dots" aria-hidden /> {t('saving')}
          </span>
        )}
        {status.kind === 'saved' && (
          <span className="text-[color:var(--accent)]">{t('saved')}</span>
        )}
        {status.kind === 'error' && (
          <span className="text-[color:var(--danger)]">
            {t('error', { message: status.message })}
          </span>
        )}
      </div>
    </div>
  );
}
