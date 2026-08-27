'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  promoteMemory,
  type MemoryPromoteMode,
  type MemoryPromoteTier,
  type MemoryPromotionReceipt,
} from '@/app/_lib/api';

import {
  agentTierRoot,
  contextTierRoot,
  type MemoryContextLocation,
} from '../_lib/memoryPaths';

/**
 * "Promote…" — the explicit operator act that lifts one memory file out of a
 * chat context into a wider tier of the SAME agent (design #870 §6).
 *
 * Direction is constrained by the source axis, because those are the only
 * directions the design allows: channel→team, channel→agent, team→agent,
 * user→agent. Nothing here can cross agents; that is a non-goal, not a
 * missing feature.
 *
 * The reason is mandatory in the UI even though the service takes it as
 * optional: an unexplained cross-context copy is exactly the event the audit
 * log exists to explain.
 */

const MODES: readonly MemoryPromoteMode[] = ['copy', 'move'];

function tiersForAxis(axis: MemoryContextLocation['axis']): MemoryPromoteTier[] {
  return axis === 'channel' ? ['team', 'agent'] : ['agent'];
}

export interface PromoteDialogProps {
  source: MemoryContextLocation;
  /** Known team context keys of the same agent, offered as suggestions. */
  teamKeys: readonly string[];
  onClose: () => void;
  onPromoted: (receipt: MemoryPromotionReceipt) => void;
}

export function PromoteDialog({
  source,
  teamKeys,
  onClose,
  onPromoted,
}: PromoteDialogProps): React.ReactElement {
  const t = useTranslations('memory.promote');
  const tiers = useMemo(() => tiersForAxis(source.axis), [source.axis]);
  const [tier, setTier] = useState<MemoryPromoteTier>(tiers[0] ?? 'agent');
  const [targetCtxKey, setTargetCtxKey] = useState<string>(teamKeys[0] ?? '');
  const [targetPath, setTargetPath] = useState<string>(source.relPath);
  const [mode, setMode] = useState<MemoryPromoteMode>('copy');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedReason = reason.trim();
  const trimmedCtxKey = targetCtxKey.trim();
  const trimmedPath = targetPath.trim();
  const needsCtxKey = tier === 'team';
  const canSubmit =
    trimmedReason.length > 0 &&
    trimmedPath.length > 0 &&
    (!needsCtxKey || trimmedCtxKey.length > 0) &&
    !submitting;

  const sourcePath = `${contextTierRoot(source)}/${source.relPath}`;
  const targetPreview =
    tier === 'agent'
      ? `${agentTierRoot(source.agentSlug)}/${trimmedPath}`
      : `${contextTierRoot({
          agentSlug: source.agentSlug,
          axis: 'team',
          ctxKey: trimmedCtxKey || '…',
        })}/${trimmedPath}`;

  const submit = useCallback(async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const receipt = await promoteMemory(source.agentSlug, {
        source: {
          axis: source.axis,
          ctxKey: source.ctxKey,
          path: source.relPath,
        },
        target: {
          tier,
          ...(needsCtxKey ? { ctxKey: trimmedCtxKey } : {}),
          ...(trimmedPath === source.relPath ? {} : { path: trimmedPath }),
        },
        mode,
        reason: trimmedReason,
      });
      onPromoted(receipt);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError(t('forbidden'));
      } else if (err instanceof ApiError && err.status === 404) {
        setError(t('unavailable'));
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit,
    mode,
    needsCtxKey,
    onPromoted,
    source,
    t,
    tier,
    trimmedCtxKey,
    trimmedPath,
    trimmedReason,
  ]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('title')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
    >
      <div className="w-full max-w-[560px] rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-5 shadow-xl">
        <h2 className="text-sm font-semibold text-[color:var(--fg-strong)]">
          {t('title')}
        </h2>
        <p className="mt-1 text-[11px] text-[color:var(--fg-muted)]">
          {t('intro')}
        </p>

        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[11px]">
          <dt className="text-[color:var(--fg-muted)]">{t('sourceLabel')}</dt>
          <dd className="truncate font-mono text-[color:var(--fg)]">{sourcePath}</dd>
          <dt className="text-[color:var(--fg-muted)]">{t('targetPreviewLabel')}</dt>
          <dd className="truncate font-mono text-[color:var(--fg)]">{targetPreview}</dd>
        </dl>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
              {t('tierLabel')}
            </span>
            <select
              value={tier}
              onChange={(e) => { setTier(e.target.value as MemoryPromoteTier); }}
              disabled={submitting}
              className="rounded border border-[color:var(--border)] px-2 py-1 text-sm"
            >
              {tiers.map((option) => (
                <option key={option} value={option}>
                  {t(`tier.${option}`)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
              {t('modeLabel')}
            </span>
            <select
              value={mode}
              onChange={(e) => { setMode(e.target.value as MemoryPromoteMode); }}
              disabled={submitting}
              className="rounded border border-[color:var(--border)] px-2 py-1 text-sm"
            >
              {MODES.map((option) => (
                <option key={option} value={option}>
                  {t(`mode.${option}`)}
                </option>
              ))}
            </select>
          </label>

          {needsCtxKey && (
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
                {t('targetCtxKeyLabel')}
              </span>
              <input
                type="text"
                list="promote-team-keys"
                value={targetCtxKey}
                onChange={(e) => { setTargetCtxKey(e.target.value); }}
                placeholder={t('targetCtxKeyPlaceholder')}
                disabled={submitting}
                className="rounded border border-[color:var(--border)] px-2 py-1 font-mono text-xs"
              />
              <datalist id="promote-team-keys">
                {teamKeys.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
            </label>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
              {t('targetPathLabel')}
            </span>
            <input
              type="text"
              value={targetPath}
              onChange={(e) => { setTargetPath(e.target.value); }}
              disabled={submitting}
              className="rounded border border-[color:var(--border)] px-2 py-1 font-mono text-xs"
            />
          </label>
        </div>

        <label className="mt-3 flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-[color:var(--fg-muted)]">
            {t('reasonLabel')}
          </span>
          <textarea
            value={reason}
            onChange={(e) => { setReason(e.target.value); }}
            rows={3}
            placeholder={t('reasonPlaceholder')}
            disabled={submitting}
            className="rounded border border-[color:var(--border)] px-2 py-1 text-sm"
          />
          <span className="text-[10px] text-[color:var(--fg-muted)]">
            {t('reasonHint')}
          </span>
        </label>

        {error !== null && (
          <p className="mt-3 border-l-2 border-[color:var(--danger-edge)] px-3 py-2 text-xs text-[color:var(--danger)]">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            {submitting ? t('submitting') : t('submit')}
          </Button>
        </div>
      </div>
    </div>
  );
}
