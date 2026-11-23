'use client';

/**
 * Spec 2042 §5.10 — the explicit confirmation before a system module is
 * installed. A system module is infrastructure of omadia itself (agent
 * runtime, memory system, Conductor …): it serves every agent and operator,
 * so the operator confirms it before the install starts.
 */

import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';

export function SystemModuleInstallConfirm({
  pluginName,
  busy,
  onConfirm,
  onCancel,
}: {
  pluginName: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const t = useTranslations('store.install.systemModuleConfirm');
  return (
    <div className="space-y-5" data-testid="system-module-install-confirm">
      <div className="space-y-2">
        <h3 className="text-base font-semibold text-[color:var(--ink)]">{t('title', { plugin: pluginName })}</h3>
        <p className="text-sm text-[color:var(--muted-ink)]">{t('lead', { plugin: pluginName })}</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button variant="primary" pill onClick={onConfirm} disabled={busy}>
          {busy ? t('confirming') : t('confirm')}
        </Button>
        <Button variant="secondary" pill onClick={onCancel} disabled={busy}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}
