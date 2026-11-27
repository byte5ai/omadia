'use client';

import { useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Button } from '@/app/_components/ui/Button';
import { DimensionSlider } from '@/app/_components/persona/DimensionSlider';
import { PersonaRadar } from '@/app/_components/persona/PersonaRadar';
import { usePersonaAxisCopy } from '@/app/_components/persona/usePersonaAxisCopy';
import { CulturePresetDropdown } from '@/app/_components/persona/CulturePresetDropdown';
import { PersonaTemplateGallery } from '@/app/_components/persona/PersonaTemplateGallery';
import {
  CORE_PERSONA_AXES,
  EXTENDED_PERSONA_AXES,
  PERSONA_AXIS_NEUTRAL,
  PERSONA_CUSTOM_NOTES_MAX_LENGTH,
  personaMessageId,
  type PersonaAxisKey,
  type PersonaConfig,
} from '../../../../_lib/personaTypes';
import { getPersonaTemplate } from '../../../../_lib/personaTemplates';
import type { PersonaConflictWarning } from '../../../../_lib/personaConflicts';
import type { PersonaBaselineDto } from '../../../../_lib/agentIdentity';
import {
  clampFacilitatorAxes,
  clampFacilitatorAxis,
  facilitatorAxisBound,
  facilitatorAxisDisplayValue,
} from '../../../../_lib/facilitators';

/**
 * The character half of an agent's identity (#914 follow-up): the same
 * 12-axis persona model the Agent Builder edits, attached to the DEPLOYED
 * agent.
 *
 * Every piece of logic here is imported, not re-implemented: the axis
 * vocabulary and labels from `personaTypes`, the archetype gallery, the
 * industry preset dropdown, the radar and the sliders from
 * `_components/persona` (#2049: the gallery and the dropdown moved there
 * from the Plugin Builder, spec 2042 §5.2). What this file adds is
 * the composition and the wiring to ONE controlled value — the parent owns
 * the state, saves everything in one request, and therefore knows whether
 * anything is unsaved.
 *
 * Templates and culture presets merge CLIENT-SIDE here, unlike the Builder,
 * which sends the id to a server tool that merges into a draft spec. There is
 * no draft to patch: the merged persona is just the next value of a
 * controlled input, and the operator can still see and undo it before saving.
 */
export interface AgentPersonaEditorProps {
  readonly value: PersonaConfig;
  readonly onChange: (next: PersonaConfig) => void;
  /** Conflicts between persona axes and the quality block, from the shared
   *  detector — rendered per axis, next to the slider that caused them. */
  readonly warnings: readonly PersonaConflictWarning[];
  readonly disabled?: boolean;
  /**
   * #2066 — edit a FACILITATOR's character: every axis stays inside the
   * bounds of the neutrality contract (spec 2043 §2.4). Sliders, archetypes
   * and culture presets are clamped here, so what the operator sees is what
   * the kernel will accept; the kernel still validates on save.
   */
  readonly facilitatorBounds?: boolean;
  /** Server findings of the last refused save, already localized, per axis. */
  readonly axisErrors?: Readonly<Partial<Record<PersonaAxisKey, string>>>;
  /** Server finding for the free-text notes, already localized. */
  readonly notesError?: string;
  /**
   * #1893 / ADR-0217 — the natural level per axis of the model the agent runs
   * on. Drawn as the "model default" tick and the radar's reference; an unset
   * axis sits on it, because that is what the compiler measures against.
   * Absent (older server): the scale's middle.
   */
  readonly baseline?: PersonaBaselineDto;
}

/** Where an UNSET axis sits: the model's own level, else the scale middle. */
function unsetValue(axis: PersonaAxisKey, baseline: PersonaBaselineDto | undefined): number {
  return baseline?.axes[axis] ?? PERSONA_AXIS_NEUTRAL;
}

function axisValue(
  persona: PersonaConfig,
  axis: PersonaAxisKey,
  bounded: boolean,
  baseline: PersonaBaselineDto | undefined,
): number {
  const value = persona.axes?.[axis] ?? unsetValue(axis, baseline);
  return bounded ? facilitatorAxisDisplayValue(axis, value) : value;
}

export function AgentPersonaEditor(
  props: AgentPersonaEditorProps,
): React.ReactElement {
  const t = useTranslations('operatorAgents.identity.persona');
  const tAxes = useTranslations('builder.persona.axes');
  const axisCopy = usePersonaAxisCopy();
  // Archetype names live in the builder catalogue (`template.<id>`), which is
  // where they were written; naming them a second time under this section
  // would be two catalogues for one list of archetypes.
  const tBuilder = useTranslations('builder.persona');
  const [extendedOpen, setExtendedOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);

  /** Axis → the strongest warning touching it (hard beats soft). */
  const warningByAxis = useMemo(() => {
    const out = new Map<PersonaAxisKey, PersonaConflictWarning>();
    for (const w of props.warnings) {
      for (const a of w.axes) {
        if (!a.startsWith('persona.')) continue;
        const axis = a.slice('persona.'.length) as PersonaAxisKey;
        const existing = out.get(axis);
        if (!existing || w.severity === 'hard') out.set(axis, w);
      }
    }
    return out;
  }, [props.warnings]);

  const bounded = props.facilitatorBounds === true;
  /** Presets and archetypes move many axes at once; a facilitator gets the
   *  same result pulled into its bounds rather than a save that is refused. */
  const withinBounds = (axes: PersonaConfig['axes']): PersonaConfig['axes'] =>
    bounded ? clampFacilitatorAxes(axes) : axes;

  const setAxis = (axis: PersonaAxisKey, next: number): void => {
    props.onChange({
      ...props.value,
      axes: {
        ...(props.value.axes ?? {}),
        [axis]: bounded ? clampFacilitatorAxis(axis, next) : next,
      },
    });
  };

  /** The "model default" tick of a slider, when the baseline is known. */
  const baseValueOf = (axis: PersonaAxisKey): { baseValue?: number } => {
    const base = props.baseline?.axes[axis];
    return base === undefined ? {} : { baseValue: base };
  };

  const sliderExtras = (
    axis: PersonaAxisKey,
  ): { hint?: string; error?: string } => {
    const bound = bounded ? facilitatorAxisBound(axis) : null;
    const error = props.axisErrors?.[axis];
    return {
      ...(bound
        ? { hint: t('bounds.axisRange', { min: bound.min, max: bound.max }) }
        : {}),
      ...(error ? { error } : {}),
    };
  };

  /** The gallery and the culture dropdown merge the persona; a facilitator
   *  gets the result pulled into its bounds. Nothing is saved here: the
   *  merged persona is the next value of the controlled input. */
  const applyPersona = (next: PersonaConfig): void => {
    props.onChange({ ...next, axes: withinBounds(next.axes) });
  };

  const clearTemplate = (): void => {
    // Detaching the archetype LEAVES the axes where they are: the operator
    // tuned them, and silently resetting twelve sliders because a label was
    // removed would be the surprise this button exists to avoid.
    const next = { ...props.value };
    delete next.template;
    props.onChange(next);
  };

  const activeTemplate = props.value.template
    ? getPersonaTemplate(props.value.template)
    : undefined;

  return (
    <div className="space-y-5" data-testid="agent-persona-editor">
      {bounded && (
        <p
          data-testid="agent-persona-bounds-note"
          className="rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 p-3 text-[11px] text-[color:var(--fg-muted)]"
        >
          {t('bounds.note')}
        </p>
      )}
      {/* ── archetype ─────────────────────────────────────────────── */}
      <div className="rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-medium">{t('template.heading')}</p>
            <p
              className="mt-1 text-[11px] text-[color:var(--fg-muted)]"
              data-testid="agent-persona-template-badge"
            >
              {activeTemplate
                ? t('template.active', {
                    name: tBuilder(
                      `gallery.templates.${personaMessageId(activeTemplate.id)}.label`,
                    ),
                  })
                : t('template.none')}
            </p>
          </div>
          <div className="flex gap-2">
            {props.value.template && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={props.disabled}
                onClick={clearTemplate}
              >
                {t('template.clear')}
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={props.disabled}
              onClick={() => setGalleryOpen((open) => !open)}
              data-testid="agent-persona-template-toggle"
            >
              {t('template.choose')}
            </Button>
          </div>
        </div>
        {galleryOpen && (
          <PersonaTemplateGallery
            persona={props.value}
            onApply={applyPersona}
            onClose={() => setGalleryOpen(false)}
            {...(props.disabled ? { disabled: true } : {})}
          />
        )}
      </div>

      {/* ── industry calibration ──────────────────────────────────── */}
      <div className="rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 p-3">
        <p className="text-xs font-medium">{t('culture.heading')}</p>
        <p className="mt-1 text-[11px] text-[color:var(--fg-muted)]">
          {t('culture.hint')}
        </p>
        <div className="mt-2">
          <CulturePresetDropdown
            persona={props.value}
            onApply={applyPersona}
            {...(props.disabled ? { disabled: true } : {})}
          />
        </div>
      </div>

      {props.baseline && (
        <p
          data-testid="agent-persona-baseline-hint"
          className="text-[11px] text-[color:var(--fg-muted)]"
        >
          {t('baseline.hint', { family: props.baseline.family })}
        </p>
      )}

      {/* ── radar + sliders ───────────────────────────────────────── */}
      <div className="flex flex-col gap-5 xl:flex-row">
        <div className="shrink-0 xl:w-[280px]">
          <PersonaRadar
            axes={props.value.axes}
            size={260}
            {...(props.baseline ? { baseline: props.baseline.axes } : {})}
          />
        </div>
        <div className="flex-1 space-y-3">
          {CORE_PERSONA_AXES.map((axis) => (
            <DimensionSlider
              key={axis}
              axis={axis}
              labelLeft={axisCopy(axis).left}
              labelRight={axisCopy(axis).right}
              axisLabel={axisCopy(axis).name}
              description={tAxes(`${axis}.description`)}
              value={axisValue(props.value, axis, bounded, props.baseline)}
              onChange={(next) => setAxis(axis, next)}
              {...baseValueOf(axis)}
              {...sliderExtras(axis)}
              {...(warningByAxis.get(axis)
                ? { warning: warningByAxis.get(axis)?.severity }
                : {})}
              {...(props.disabled ? { disabled: true } : {})}
            />
          ))}

          {/* eslint-disable-next-line no-restricted-syntax -- disclosure toggle, not a §4.2 CTA */}
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-[color:var(--fg-muted)] hover:text-[color:var(--fg)]"
            onClick={() => setExtendedOpen((open) => !open)}
            data-testid="agent-persona-extended-toggle"
            aria-expanded={extendedOpen}
          >
            {extendedOpen ? (
              <ChevronDown className="size-3.5" aria-hidden />
            ) : (
              <ChevronRight className="size-3.5" aria-hidden />
            )}
            {t('extended.toggle')}
          </button>
          {extendedOpen &&
            EXTENDED_PERSONA_AXES.map((axis) => (
              <DimensionSlider
                key={axis}
                axis={axis}
                labelLeft={axisCopy(axis).left}
                labelRight={axisCopy(axis).right}
              axisLabel={axisCopy(axis).name}
                description={tAxes(`${axis}.description`)}
                value={axisValue(props.value, axis, bounded, props.baseline)}
                onChange={(next) => setAxis(axis, next)}
                {...baseValueOf(axis)}
                {...sliderExtras(axis)}
                {...(warningByAxis.get(axis)
                  ? { warning: warningByAxis.get(axis)?.severity }
                  : {})}
                {...(props.disabled ? { disabled: true } : {})}
              />
            ))}
        </div>
      </div>

      {/* ── free-text notes ───────────────────────────────────────── */}
      <div>
        <label
          className="mb-1 block text-xs font-medium"
          htmlFor="agent-persona-notes"
        >
          {t('notes.label')}
        </label>
        <textarea
          id="agent-persona-notes"
          className="min-h-[5rem] w-full rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 px-3 py-2 text-sm"
          value={props.value.custom_notes ?? ''}
          maxLength={PERSONA_CUSTOM_NOTES_MAX_LENGTH}
          disabled={props.disabled}
          onChange={(e) =>
            props.onChange({ ...props.value, custom_notes: e.target.value })
          }
        />
        <p className="mt-1 text-[11px] text-[color:var(--fg-muted)]">
          {t('notes.hint')}
        </p>
        {props.notesError && (
          <p
            role="alert"
            data-testid="agent-persona-notes-error"
            className="mt-1 text-[11px] text-[color:var(--danger)]"
          >
            {props.notesError}
          </p>
        )}
      </div>
    </div>
  );
}
