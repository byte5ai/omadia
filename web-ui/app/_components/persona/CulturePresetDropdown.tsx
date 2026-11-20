'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useState, useTransition } from 'react';

import { Button } from '@/app/_components/ui/Button';

import {
  CULTURE_PRESETS,
  applyCulturePreset,
  diffCulturePreset,
  getCulturePreset,
} from '../../_lib/culturePresets';
import { personaMessageId, type PersonaConfig } from '../../_lib/personaTypes';

/**
 * Culture / industry dropdown above the persona sliders (#59; #2049: moved
 * out of the Plugin Builder into the agent's own persona editing, spec 2042
 * §5.2).
 *
 * Selecting a preset opens a confirm panel listing every axis the overlay
 * would change (before → after). Confirming hands the FULL merged persona to
 * `onApply` — existing `template`, `custom_notes` and untouched axes
 * survive. The preset id itself is not persisted (one-shot overlay).
 */

export interface CulturePresetDropdownProps {
  /** Full current persona block. */
  persona: PersonaConfig | undefined;
  /** Receives the merged persona; a rejection is shown inline. */
  onApply: (next: PersonaConfig) => void | Promise<void>;
  disabled?: boolean;
}

export function CulturePresetDropdown({
  persona,
  onApply,
  disabled,
}: CulturePresetDropdownProps): React.ReactElement {
  const t = useTranslations('builder.persona.culture');
  const [selectedId, setSelectedId] = useState<string>('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const diff = useMemo(
    () => (selectedId ? diffCulturePreset(persona?.axes, selectedId) : []),
    [persona, selectedId],
  );

  const handleConfirm = useCallback(() => {
    if (!selectedId || !getCulturePreset(selectedId)) return;
    setError(null);
    startTransition(async () => {
      try {
        await onApply({
          ...(persona ?? {}),
          axes: applyCulturePreset(persona?.axes, selectedId),
        });
        setSelectedId('');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }, [onApply, persona, selectedId]);

  const handleCancel = useCallback(() => {
    setSelectedId('');
    setError(null);
  }, []);

  return (
    <div
      data-testid="culture-preset-dropdown"
      className="space-y-2 rounded border border-[color:var(--border)] p-3"
    >
      <label
        htmlFor="culture-preset-select"
        className="text-xs font-medium uppercase tracking-wider text-[color:var(--fg-muted)]"
      >
        {t('label')}
      </label>
      <select
        id="culture-preset-select"
        data-testid="culture-preset-select"
        value={selectedId}
        onChange={(e) => setSelectedId(e.target.value)}
        disabled={disabled || pending}
        className="w-full rounded border border-[color:var(--border)] bg-transparent p-2 text-sm"
      >
        <option value="">{t('noSelection')}</option>
        {CULTURE_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {t('presetOption', {
              label: t(`presets.${personaMessageId(p.id)}.label`),
              description: t(`presets.${personaMessageId(p.id)}.description`),
            })}
          </option>
        ))}
      </select>

      {selectedId && (
        <div
          data-testid="culture-confirm-modal"
          role="dialog"
          aria-label={t('modalLabel')}
          className="space-y-2 rounded border border-[color:var(--warning)] bg-[color:var(--warning)]/10 p-3"
        >
          <div className="text-sm font-medium text-[color:var(--warning)]">
            {t('overwriteNotice')}
          </div>
          <ul className="space-y-0.5 text-xs text-[color:var(--warning)]" data-testid="culture-diff-list">
            {diff.map((d) => (
              <li key={d.axis} data-testid={`culture-diff-${d.axis}`}>
                <code>{d.axis}</code>: {d.before ?? t('unset')} → {d.after}
              </li>
            ))}
            {diff.length === 0 && <li>{t('noChange')}</li>}
          </ul>
          {error && (
            <div role="alert" data-testid="culture-error" className="text-xs text-[color:var(--danger)]">
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              data-testid="culture-confirm-apply"
              onClick={handleConfirm}
              disabled={disabled || pending || diff.length === 0}
              className="text-sm"
            >
              {pending ? t('applying') : t('apply')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              data-testid="culture-confirm-cancel"
              onClick={handleCancel}
              disabled={pending}
              className="text-sm"
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
