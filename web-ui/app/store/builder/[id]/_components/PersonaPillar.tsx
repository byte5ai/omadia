'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useState, useTransition } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';

import { ApiError, setPersonaConfig } from '../../../../_lib/api';
import type { QualityConfig } from '../../../../_lib/builderTypes';
import { cn } from '../../../../_lib/cn';
import {
  detectPersonaConflicts,
  type PersonaConflictWarning,
} from '../../../../_lib/personaConflicts';
import {
  CORE_PERSONA_AXES,
  EXTENDED_PERSONA_AXES,
  PERSONA_AXIS_LABELS,
  PERSONA_AXIS_NEUTRAL,
  PERSONA_CUSTOM_NOTES_MAX_LENGTH,
  type PersonaAxisKey,
  type PersonaConfig,
} from '../../../../_lib/personaTypes';
import { BoundariesSection } from './BoundariesSection';
import { ConflictBanner } from './ConflictBanner';
import { CulturePresetDropdown } from './CulturePresetDropdown';
import { DimensionSlider } from './DimensionSlider';
import { PersonaRadar, personaAxisToSliderTestId } from './PersonaRadar';
import { PersonaTemplateGallery } from './PersonaTemplateGallery';
import { QualityPanel } from './QualityPanel';

/**
 * Phase 3 / OB-67 Slice 4 — top-level persona pillar.
 *
 * Layout (top to bottom):
 *   1. Section header (b5-Brand: accent label, font-display title)
 *   2. ConflictBanner (hard warnings + soft warning list)
 *   3. Optional template input (Phase-4-aware — templates ship in
 *      `harness-persona`; Phase 3 only carries the slot)
 *   4. Core 8 sliders (always visible)
 *   5. Extended 4 sliders (collapsed by default)
 *   6. Custom notes textarea (2000-char cap)
 *   7. Save / Reset row
 *
 * Persistence: every change is local-state only until "Speichern" — that
 * triggers `setPersonaConfig(draftId, …)` which is a thin wrapper over
 * `patchBuilderSpec` (`{ op: 'add', path: '/persona', value }`). Optimistic-
 * update pattern: the parent passes the resulting Draft back via
 * `onPersisted` so the `quality` block can reflect on the next render
 * without a re-fetch.
 */

export interface PersonaPillarProps {
  draftId: string;
  /** Initial persona block (may be undefined for fresh drafts). */
  initialPersona?: PersonaConfig;
  /** Quality block from the same spec — drives the conflict detector
   *  alongside the local persona state. */
  quality?: QualityConfig;
  /** Callback invoked after a successful save. The parent re-syncs the
   *  Workspace draft state from the returned envelope. */
  onPersisted?: (next: PersonaConfig) => void;
  /** Disable interaction (e.g. when the draft is read-only / archived). */
  disabled?: boolean;
}

export function PersonaPillar({
  draftId,
  initialPersona,
  quality,
  onPersisted,
  disabled,
}: PersonaPillarProps): React.ReactElement {
  const t = useTranslations('builder.persona.pillar');
  const [persona, setPersona] = useState<PersonaConfig>(
    () => initialPersona ?? {},
  );
  const [extendedOpen, setExtendedOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Issue #53 — modal-state for the persona-template gallery
  const [galleryOpen, setGalleryOpen] = useState(false);

  const warnings: PersonaConflictWarning[] = useMemo(
    () => detectPersonaConflicts(quality, persona),
    [quality, persona],
  );

  const warningByAxis = useMemo(() => {
    const out = new Map<PersonaAxisKey, PersonaConflictWarning>();
    for (const w of warnings) {
      for (const a of w.axes) {
        if (a.startsWith('persona.')) {
          const axis = a.slice('persona.'.length) as PersonaAxisKey;
          // Hard wins over soft — first iteration may set soft, override
          // when a hard arrives for the same axis.
          const existing = out.get(axis);
          if (!existing || w.severity === 'hard') out.set(axis, w);
        }
      }
    }
    return out;
  }, [warnings]);

  const handleAxisChange = useCallback(
    (axis: PersonaAxisKey, value: number) => {
      setPersona((prev) => ({
        ...prev,
        axes: { ...(prev.axes ?? {}), [axis]: value },
      }));
    },
    [],
  );

  const handleSave = useCallback(() => {
    setError(null);
    startTransition(async () => {
      try {
        // Compact: drop fields the server treats as empty so the
        // round-trip is stable.
        const payload: PersonaConfig = {};
        if (persona.template && persona.template.length > 0) {
          payload.template = persona.template;
        }
        if (persona.custom_notes && persona.custom_notes.length > 0) {
          payload.custom_notes = persona.custom_notes;
        }
        if (persona.axes && Object.keys(persona.axes).length > 0) {
          payload.axes = persona.axes;
        }
        await setPersonaConfig(draftId, payload);
        setSavedAt(Date.now());
        onPersisted?.(payload);
      } catch (err) {
        if (err instanceof ApiError) {
          try {
            const body = JSON.parse(err.body) as { message?: string };
            setError(body.message ?? err.message);
          } catch {
            setError(err.message);
          }
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    });
  }, [draftId, persona, onPersisted]);

  const handleReset = useCallback(() => {
    setPersona(initialPersona ?? {});
    setError(null);
    setSavedAt(null);
  }, [initialPersona]);

  const dirty = useMemo(
    () => JSON.stringify(persona) !== JSON.stringify(initialPersona ?? {}),
    [persona, initialPersona],
  );

  return (
    <section
      className="space-y-4 p-4"
      data-testid="persona-pillar"
      aria-labelledby="persona-pillar-heading"
    >
      <header className="flex items-baseline gap-3">
        <span className="text-[12px] font-semibold uppercase tracking-[0.2em] text-[color:var(--accent)]">
          {t('accentLabel')}
        </span>
        <span className="h-px flex-1 bg-[color:var(--border)]" />
        <Sparkles
          className="size-4 text-[color:var(--fg-subtle)]"
          aria-hidden
        />
      </header>

      <h2
        id="persona-pillar-heading"
        className="font-display text-[22px] leading-tight text-[color:var(--fg-strong)]"
      >
        {t('heading')}
      </h2>
      <p className="text-sm leading-relaxed text-[color:var(--fg-muted)]">
        {t('description')}
      </p>

      <ConflictBanner warnings={warnings} />

      {/* Issue #52 — quality score panel (collapsed by default). */}
      <QualityPanel draftId={draftId} />

      {/* Issue #53 — Apply persona-template button + gallery modal.
       *  Selecting an archetype calls setPersonaConfig server-side; the
       *  tool merges the template's 12-axis profile with operator
       *  overrides (override wins per axis). */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-[color:var(--fg-muted)]" data-testid="persona-template-badge">
          {persona.template
            ? persona.axes && Object.keys(persona.axes).length > 0
              ? t('templateBadgeAdjusted', { template: persona.template })
              : t('templateBadge', { template: persona.template })
            : t('templateBadgeNone')}
        </span>
        <button
          type="button"
          data-testid="persona-template-open"
          onClick={() => setGalleryOpen(true)}
          disabled={disabled || pending}
          className="rounded border border-[color:var(--border)] px-2 py-1 text-xs"
        >
          {t('applyTemplate')}
        </button>
      </div>
      {galleryOpen && (
        <PersonaTemplateGallery
          draftId={draftId}
          persona={persona}
          disabled={disabled}
          onClose={() => setGalleryOpen(false)}
          onApplied={(next) => {
            setPersona(next);
          }}
        />
      )}

      {/* Issue #59 — culture / industry preset dropdown. One-shot
       *  overlay; selecting a preset opens a confirm modal with the
       *  diff list, and on confirm sends a single setPersonaConfig call
       *  with the full merged persona. */}
      <CulturePresetDropdown
        draftId={draftId}
        persona={persona}
        disabled={disabled}
        onApplied={(next) => {
          setPersona(next);
        }}
      />

      {/* Radar (view-only, click axis label scrolls to slider) */}
      <PersonaRadar
        axes={persona.axes ?? {}}
        onAxisFocus={(axis) => {
          if (typeof document === 'undefined') return;
          // Auto-expand the Extended block if the targeted axis lives there
          // — otherwise the scrollIntoView lookup hits a hidden element.
          const ext = (
            ['risk_tolerance', 'creativity', 'drama', 'philosophy'] as const
          ).includes(axis as 'risk_tolerance' | 'creativity' | 'drama' | 'philosophy');
          if (ext) setExtendedOpen(true);
          // Defer the scroll one frame so the conditional Extended block
          // has time to mount.
          requestAnimationFrame(() => {
            const target = document.querySelector(
              `[data-testid="${personaAxisToSliderTestId(String(axis))}"]`,
            );
            if (target instanceof HTMLElement) {
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          });
        }}
      />

      {/* Template (Phase-4-aware placeholder) */}
      <div className="space-y-2">
        <label
          className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]"
          htmlFor="persona-template"
        >
          {t('templateLabel')}
        </label>
        <input
          id="persona-template"
          type="text"
          value={persona.template ?? ''}
          onChange={(e) =>
            setPersona((p) => ({
              ...p,
              template: e.target.value.length > 0 ? e.target.value : undefined,
            }))
          }
          placeholder={t('templatePlaceholder')}
          disabled={disabled}
          className={cn(
            'w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2',
            'text-sm text-[color:var(--fg-strong)] placeholder:text-[color:var(--fg-subtle)]',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]',
            'disabled:opacity-50',
          )}
        />
      </div>

      {/* Core axes */}
      <div className="space-y-4" data-testid="persona-core-axes">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg)]">
          {t('coreHeading')}
        </h3>
        {CORE_PERSONA_AXES.map((axis) => (
          <DimensionSlider
            key={axis}
            axis={axis}
            labelLeft={PERSONA_AXIS_LABELS[axis].left}
            labelRight={PERSONA_AXIS_LABELS[axis].right}
            description={PERSONA_AXIS_LABELS[axis].description}
            value={persona.axes?.[axis] ?? PERSONA_AXIS_NEUTRAL}
            onChange={(v) => handleAxisChange(axis, v)}
            {...(warningByAxis.has(axis)
              ? { warning: warningByAxis.get(axis)!.severity }
              : {})}
            disabled={disabled ?? false}
          />
        ))}
      </div>

      {/* Extended axes — collapsible */}
      <div className="space-y-3" data-testid="persona-extended-axes">
        <button
          type="button"
          onClick={() => setExtendedOpen((v) => !v)}
          className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]"
          aria-expanded={extendedOpen}
          aria-controls="persona-extended-axes-list"
        >
          {extendedOpen ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden />
          )}
          {t('extendedHeading')}
        </button>
        {extendedOpen ? (
          <div id="persona-extended-axes-list" className="space-y-4 pt-1">
            {EXTENDED_PERSONA_AXES.map((axis) => (
              <DimensionSlider
                key={axis}
                axis={axis}
                labelLeft={PERSONA_AXIS_LABELS[axis].left}
                labelRight={PERSONA_AXIS_LABELS[axis].right}
                description={PERSONA_AXIS_LABELS[axis].description}
                value={persona.axes?.[axis] ?? PERSONA_AXIS_NEUTRAL}
                onChange={(v) => handleAxisChange(axis, v)}
                {...(warningByAxis.has(axis)
                  ? { warning: warningByAxis.get(axis)!.severity }
                  : {})}
                disabled={disabled ?? false}
              />
            ))}
          </div>
        ) : null}
      </div>

      {/* Custom notes */}
      <div className="space-y-2">
        <label
          htmlFor="persona-custom-notes"
          className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]"
        >
          {t('customNotesLabel')}
        </label>
        <textarea
          id="persona-custom-notes"
          rows={3}
          maxLength={PERSONA_CUSTOM_NOTES_MAX_LENGTH}
          value={persona.custom_notes ?? ''}
          onChange={(e) =>
            setPersona((p) => ({
              ...p,
              custom_notes:
                e.target.value.length > 0 ? e.target.value : undefined,
            }))
          }
          placeholder={t('customNotesPlaceholder')}
          disabled={disabled}
          className={cn(
            'w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg)] px-3 py-2',
            'text-sm text-[color:var(--fg-strong)] placeholder:text-[color:var(--fg-subtle)]',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]',
            'disabled:opacity-50',
          )}
        />
        <p className="text-right font-mono-num text-[10px] text-[color:var(--fg-subtle)]">
          {(persona.custom_notes ?? '').length} / {PERSONA_CUSTOM_NOTES_MAX_LENGTH}
        </p>
      </div>

      {/* Issue #54 — boundary preset library + custom-line textarea. The
       *  section persists `spec.quality` independently of the persona
       *  Speichern button below; mounting here keeps the configuration
       *  surface alongside other persona / quality tuning controls. */}
      <BoundariesSection
        draftId={draftId}
        initialQuality={quality}
        disabled={disabled}
      />

      {/* Action row */}
      <div className="flex items-center justify-between gap-3 border-t border-[color:var(--divider)] pt-3">
        <div className="text-[11px] text-[color:var(--fg-subtle)]" aria-live="polite">
          {error ? (
            <span className="text-[color:var(--danger)]">{error}</span>
          ) : savedAt ? (
            <span className="text-[color:var(--success)]">{t('saved')}</span>
          ) : dirty ? (
            <span>{t('unsavedChanges')}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleReset}
            disabled={!dirty || pending || disabled}
            className={cn(
              'rounded-md border border-[color:var(--border)] px-3 py-2 text-sm',
              'text-[color:var(--fg)] disabled:opacity-50',
            )}
          >
            {t('reset')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || pending || disabled}
            className={cn(
              'rounded-md bg-[color:var(--accent)] px-3 py-2 text-sm font-medium text-[color:var(--fg-on-dark)]',
              'shadow-[var(--shadow-cta)] disabled:opacity-50',
            )}
          >
            {pending ? t('saving') : t('save')}
          </button>
        </div>
      </div>

    </section>
  );
}
