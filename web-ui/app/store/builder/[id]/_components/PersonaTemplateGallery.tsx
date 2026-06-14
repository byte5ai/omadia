'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useState, useTransition } from 'react';

import { patchBuilderSpec, setPersonaConfig } from '../../../../_lib/api';
import {
  PERSONA_TEMPLATES,
  type PersonaTemplate,
} from '../../../../_lib/personaTemplates';
import type { PersonaConfig } from '../../../../_lib/personaTypes';

/**
 * Issue #53 — modal overlay gallery of 6 persona archetypes.
 *
 * Open via the "Vorlage anwenden" button in `PersonaPillar`. Each card
 * shows the German label, subtitle, identity creature/vibe, and the
 * suggested skill role. Clicking a card pre-selects it; the "Anwenden"
 * button then calls `setPersonaConfig` with the template id — the tool
 * loads the full 12-axis profile server-side and merges with any
 * pre-existing operator overrides. If the operator opts into prefilling
 * skill fields, a second `patchBuilderSpec` call writes `/skill/role` +
 * `/skill/tonality`. The skill patch only fires after the persona
 * patch resolves successfully.
 */

export interface PersonaTemplateGalleryProps {
  draftId: string;
  /** Current persona block — merged on apply so `custom_notes` survives. */
  persona: PersonaConfig | undefined;
  disabled?: boolean;
  onClose: () => void;
  /** Notify parent after a successful apply so it can re-sync state. */
  onApplied?: (next: PersonaConfig) => void;
}

export function PersonaTemplateGallery({
  draftId,
  persona,
  disabled,
  onClose,
  onApplied,
}: PersonaTemplateGalleryProps): React.ReactElement {
  const t = useTranslations('builder.persona.gallery');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prefillSkill, setPrefillSkill] = useState<boolean>(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const selected: PersonaTemplate | undefined = selectedId
    ? PERSONA_TEMPLATES.find((t) => t.id === selectedId)
    : undefined;

  const handleApply = useCallback(() => {
    if (!selected) return;
    setError(null);
    startTransition(async () => {
      try {
        // Step 1 — persona-only via the tool surface so template axes
        // merge server-side. We send template + axes from the existing
        // operator overrides so the merge keeps explicit per-axis values.
        const next: PersonaConfig = {
          ...(persona ?? {}),
          template: selected.id,
          axes: { ...selected.axes, ...(persona?.axes ?? {}) },
        };
        await setPersonaConfig(draftId, next);

        // Step 2 — optional skill prefill (only fires after step 1 lands)
        if (prefillSkill && selected.suggested_skill) {
          await patchBuilderSpec(draftId, [
            { op: 'add', path: '/skill/role', value: selected.suggested_skill.role },
            {
              op: 'add',
              path: '/skill/tonality',
              value: selected.suggested_skill.tonality,
            },
          ]);
        }

        onApplied?.(next);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }, [draftId, onApplied, onClose, persona, prefillSkill, selected]);

  return (
    <div
      data-testid="persona-template-gallery"
      role="dialog"
      aria-modal="true"
      aria-label={t('title')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--bg-modal-overlay)] p-4"
    >
      <div className="max-h-full w-full max-w-3xl overflow-y-auto rounded-lg border border-[color:var(--border)] bg-[color:var(--bg-elevated,var(--bg))] p-4 text-[color:var(--fg)] shadow-xl">
        <header className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-[color:var(--fg-strong)]">
            {t('title')}
          </h2>
          <button
            type="button"
            data-testid="gallery-close"
            onClick={onClose}
            disabled={pending}
            className="rounded border border-[color:var(--border)] px-2 py-1 text-sm text-[color:var(--fg-muted)] hover:bg-[color:var(--accent-bg)]"
          >
            {t('close')}
          </button>
        </header>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3" data-testid="gallery-grid">
          {PERSONA_TEMPLATES.map((tpl) => {
            const active = selectedId === tpl.id;
            return (
              <button
                key={tpl.id}
                type="button"
                data-testid={`gallery-card-${tpl.id}`}
                aria-pressed={active}
                onClick={() => setSelectedId(tpl.id)}
                disabled={disabled || pending}
                className={`flex flex-col gap-1 rounded border p-3 text-left text-sm ${
                  active
                    ? 'border-[color:var(--accent)] bg-[color:var(--accent-bg)]'
                    : 'border-[color:var(--border)]'
                }`}
              >
                <div className="font-medium text-[color:var(--fg-strong)]">{tpl.labelDe}</div>
                <div className="text-xs text-[color:var(--fg-muted)]">{tpl.description}</div>
                {tpl.identity && (
                  <div className="text-xs italic text-[color:var(--fg-subtle)]">
                    {tpl.identity.creature} — {tpl.identity.vibe}
                  </div>
                )}
                {tpl.suggested_skill && (
                  <div className="text-xs text-[color:var(--fg-subtle)]">
                    {t('role', { role: tpl.suggested_skill.role })}
                  </div>
                )}
              </button>
            );
          })}
          <button
            type="button"
            data-testid="gallery-card-custom"
            aria-pressed={selectedId === null}
            onClick={() => setSelectedId(null)}
            disabled={disabled || pending}
            className={`flex flex-col gap-1 rounded border p-3 text-left text-sm ${
              selectedId === null
                ? 'border-[color:var(--accent)] bg-[color:var(--accent-bg)]'
                : 'border-[color:var(--border)]'
            }`}
          >
            <div className="font-medium text-[color:var(--fg-strong)]">{t('customLabel')}</div>
            <div className="text-xs text-[color:var(--fg-muted)]">
              {t('customDescription')}
            </div>
          </button>
        </div>

        {selected?.suggested_skill && (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="gallery-prefill-skill"
              checked={prefillSkill}
              onChange={(e) => setPrefillSkill(e.target.checked)}
              disabled={pending}
            />
            <span>
              {t('prefillSkill', { role: selected.suggested_skill.role })}
            </span>
          </label>
        )}

        {error && (
          <div role="alert" className="mt-3 text-sm text-[color:var(--danger)]" data-testid="gallery-error">
            {error}
          </div>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            data-testid="gallery-cancel"
            onClick={onClose}
            disabled={pending}
            className="rounded border border-[color:var(--border)] px-3 py-1 text-sm"
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            data-testid="gallery-apply"
            onClick={handleApply}
            disabled={disabled || pending || !selected}
            className="rounded bg-[color:var(--accent)] px-3 py-1 text-sm font-medium text-[color:var(--fg-on-dark)] disabled:opacity-50"
          >
            {pending ? t('applying') : t('apply')}
          </button>
        </div>
      </div>
    </div>
  );
}
