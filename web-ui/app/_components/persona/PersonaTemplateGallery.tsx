'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useState, useTransition } from 'react';

import { Button } from '@/app/_components/ui/Button';

import {
  axesForTemplate,
  PERSONA_TEMPLATES,
  type PersonaTemplate,
} from '../../_lib/personaTemplates';
import { personaMessageId, type PersonaConfig } from '../../_lib/personaTypes';

/**
 * Modal gallery of the persona archetypes (#53; #2049: moved out of the
 * Plugin Builder into the agent's own persona editing, spec 2042 §5.2).
 *
 * Each card shows the archetype's label, subtitle, identity creature/vibe
 * and the role it suits. Clicking a card selects it; "Apply" hands the
 * MERGED persona to `onApply`: the archetype supplies the axes, only the
 * sliders the operator moved away from the previous archetype stay on top,
 * and `custom_notes` survives. Where the result goes — a controlled form
 * value, a save request — is the caller's; a rejection is shown inline and
 * the gallery stays open.
 */

export interface PersonaTemplateGalleryProps {
  /** Current persona block — merged on apply so `custom_notes` survives. */
  persona: PersonaConfig | undefined;
  /** Receives the merged persona; the gallery closes once it resolves. */
  onApply: (next: PersonaConfig) => void | Promise<void>;
  onClose: () => void;
  disabled?: boolean;
}

export function PersonaTemplateGallery({
  persona,
  onApply,
  onClose,
  disabled,
}: PersonaTemplateGalleryProps): React.ReactElement {
  const t = useTranslations('builder.persona.gallery');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const selected: PersonaTemplate | undefined = selectedId
    ? PERSONA_TEMPLATES.find((tpl) => tpl.id === selectedId)
    : undefined;

  const handleApply = useCallback(() => {
    if (!selected) return;
    setError(null);
    startTransition(async () => {
      try {
        await onApply({
          ...(persona ?? {}),
          template: selected.id,
          axes: axesForTemplate(persona, selected),
        });
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }, [onApply, onClose, persona, selected]);

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
          <Button
            variant="secondary"
            size="sm"
            data-testid="gallery-close"
            onClick={onClose}
            disabled={pending}
            className="text-sm"
          >
            {t('close')}
          </Button>
        </header>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3" data-testid="gallery-grid">
          {PERSONA_TEMPLATES.map((tpl) => {
            const active = selectedId === tpl.id;
            return (
              // eslint-disable-next-line no-restricted-syntax -- selection tile (aria-pressed multi-line template card), not a §4.2 CTA
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
                <div className="font-medium text-[color:var(--fg-strong)]">
                  {t(`templates.${personaMessageId(tpl.id)}.label`)}
                </div>
                <div className="text-xs text-[color:var(--fg-muted)]">
                  {t(`templates.${personaMessageId(tpl.id)}.description`)}
                </div>
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
          {/* eslint-disable-next-line no-restricted-syntax -- selection tile (aria-pressed "custom" template card), not a §4.2 CTA */}
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

        {error && (
          <div role="alert" className="mt-3 text-sm text-[color:var(--danger)]" data-testid="gallery-error">
            {error}
          </div>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            data-testid="gallery-cancel"
            onClick={onClose}
            disabled={pending}
            className="text-sm"
          >
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            data-testid="gallery-apply"
            onClick={handleApply}
            disabled={disabled || pending || !selected}
            className="text-sm"
          >
            {pending ? t('applying') : t('apply')}
          </Button>
        </div>
      </div>
    </div>
  );
}
