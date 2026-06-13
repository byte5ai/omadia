'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useState, useTransition } from 'react';

import { setPersonaConfig } from '../../../../_lib/api';
import {
  CULTURE_PRESETS,
  applyCulturePreset,
  diffCulturePreset,
  getCulturePreset,
} from '../../../../_lib/culturePresets';
import type { PersonaConfig } from '../../../../_lib/personaTypes';

/**
 * Issue #59 — Culture / industry dropdown above the persona sliders.
 *
 * Selecting a preset opens a confirm modal listing every axis the
 * overlay would change (with before/after values). Confirming sends a
 * single `setPersonaConfig` call with the **full merged** persona —
 * existing `template`, `custom_notes`, and untouched axes survive.
 * Preset id itself is NOT persisted (one-shot overlay).
 */

export interface CulturePresetDropdownProps {
  draftId: string;
  /** Full current persona block — needed for the full-replace tool call. */
  persona: PersonaConfig | undefined;
  disabled?: boolean;
  /** Called after a successful apply with the new persona block. */
  onApplied?: (next: PersonaConfig) => void;
}

export function CulturePresetDropdown({
  draftId,
  persona,
  disabled,
  onApplied,
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
    if (!selectedId) return;
    const preset = getCulturePreset(selectedId);
    if (!preset) return;
    setError(null);
    startTransition(async () => {
      const mergedAxes = applyCulturePreset(persona?.axes, selectedId);
      const next: PersonaConfig = {
        ...(persona ?? {}),
        axes: mergedAxes,
      };
      try {
        await setPersonaConfig(draftId, next);
        onApplied?.(next);
        setSelectedId('');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }, [draftId, onApplied, persona, selectedId]);

  const handleCancel = useCallback(() => {
    setSelectedId('');
  }, []);

  return (
    <div
      data-testid="culture-preset-dropdown"
      className="space-y-2 rounded border border-[color:var(--border)] p-3"
    >
      <label className="text-xs font-medium uppercase tracking-wider text-[color:var(--fg-muted)]">
        {t('label')}
      </label>
      <select
        data-testid="culture-preset-select"
        value={selectedId}
        onChange={(e) => setSelectedId(e.target.value)}
        disabled={disabled || pending}
        className="w-full rounded border border-[color:var(--border)] bg-transparent p-2 text-sm"
      >
        <option value="">{t('noSelection')}</option>
        {CULTURE_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.labelDe} — {p.descriptionDe}
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
            {diff.length === 0 && (
              <li>{t('noChange')}</li>
            )}
          </ul>
          {error && (
            <div role="alert" className="text-xs text-[color:var(--danger)]">
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="culture-confirm-apply"
              onClick={handleConfirm}
              disabled={disabled || pending || diff.length === 0}
              className="rounded bg-[color:var(--accent)] px-3 py-1 text-sm font-medium text-[color:var(--fg-on-dark)] disabled:opacity-50"
            >
              {pending ? t('applying') : t('apply')}
            </button>
            <button
              type="button"
              data-testid="culture-confirm-cancel"
              onClick={handleCancel}
              disabled={pending}
              className="rounded border border-[color:var(--border)] px-3 py-1 text-sm"
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
