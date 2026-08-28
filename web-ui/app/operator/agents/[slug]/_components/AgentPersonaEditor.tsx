'use client';

import { useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Button } from '@/app/_components/ui/Button';
import { DimensionSlider } from '@/app/_components/persona/DimensionSlider';
import { PersonaRadar } from '@/app/_components/persona/PersonaRadar';
import {
  applyCulturePreset,
  CULTURE_PRESETS,
  diffCulturePreset,
} from '../../../../_lib/culturePresets';
import {
  CORE_PERSONA_AXES,
  EXTENDED_PERSONA_AXES,
  PERSONA_AXIS_LABELS,
  PERSONA_AXIS_NEUTRAL,
  PERSONA_CUSTOM_NOTES_MAX_LENGTH,
  personaMessageId,
  type PersonaAxisKey,
  type PersonaConfig,
} from '../../../../_lib/personaTypes';
import {
  getPersonaTemplate,
  PERSONA_TEMPLATES,
} from '../../../../_lib/personaTemplates';
import type { PersonaConflictWarning } from '../../../../_lib/personaConflicts';

/**
 * The character half of an agent's identity (#914 follow-up): the same
 * 12-axis persona model the Agent Builder edits, attached to the DEPLOYED
 * agent.
 *
 * Every piece of logic here is imported, not re-implemented: the axis
 * vocabulary and labels from `personaTypes`, the archetypes from
 * `personaTemplates`, the industry calibration from `culturePresets`, the
 * radar and the sliders from `_components/persona`. What this file adds is
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
}

function axisValue(persona: PersonaConfig, axis: PersonaAxisKey): number {
  return persona.axes?.[axis] ?? PERSONA_AXIS_NEUTRAL;
}

export function AgentPersonaEditor(
  props: AgentPersonaEditorProps,
): React.ReactElement {
  const t = useTranslations('operatorAgents.identity.persona');
  const tAxes = useTranslations('builder.persona.axes');
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

  const setAxis = (axis: PersonaAxisKey, next: number): void => {
    props.onChange({
      ...props.value,
      axes: { ...(props.value.axes ?? {}), [axis]: next },
    });
  };

  const applyTemplate = (templateId: string): void => {
    const template = getPersonaTemplate(templateId);
    if (!template) return;
    props.onChange({
      ...props.value,
      template: templateId,
      // The archetype supplies the axes; anything the operator already tuned
      // stays on top of it, which is the same precedence the Builder's
      // server-side merge applies.
      axes: { ...template.axes, ...(props.value.axes ?? {}) },
    });
    setGalleryOpen(false);
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
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {PERSONA_TEMPLATES.map((template) => (
              <li key={template.id}>
                {/* eslint-disable-next-line no-restricted-syntax -- selectable card, no §4.2 variant fits */}
                <button
                  type="button"
                  disabled={props.disabled}
                  onClick={() => applyTemplate(template.id)}
                  data-testid={`agent-persona-template-${template.id}`}
                  className="h-full w-full rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-3 text-left transition-colors hover:border-[color:var(--accent)]"
                >
                  <span className="block text-sm font-medium">
                    {tBuilder(
                      `gallery.templates.${personaMessageId(template.id)}.label`,
                    )}
                  </span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-[color:var(--fg-muted)]">
                    {tBuilder(
                      `gallery.templates.${personaMessageId(template.id)}.description`,
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── industry calibration ──────────────────────────────────── */}
      <div className="rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 p-3">
        <p className="text-xs font-medium">{t('culture.heading')}</p>
        <p className="mt-1 text-[11px] text-[color:var(--fg-muted)]">
          {t('culture.hint')}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {CULTURE_PRESETS.map((preset) => {
            // How many axes this preset would actually move — an operator
            // deserves to know a click changes six sliders, not one.
            const changes = diffCulturePreset(props.value.axes, preset.id);
            return (
              // eslint-disable-next-line no-restricted-syntax -- filter chip, not a §4.2 CTA
              <button
                key={preset.id}
                type="button"
                disabled={props.disabled}
                onClick={() =>
                  props.onChange({
                    ...props.value,
                    axes: applyCulturePreset(props.value.axes, preset.id),
                  })
                }
                data-testid={`agent-persona-culture-${preset.id}`}
                title={t('culture.changes', { count: changes.length })}
                className="rounded-full border border-[color:var(--border)] px-3 py-1 text-[11px] transition-colors hover:border-[color:var(--accent)] hover:text-[color:var(--accent)]"
              >
                {tBuilder(`culture.presets.${personaMessageId(preset.id)}.label`)}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── radar + sliders ───────────────────────────────────────── */}
      <div className="flex flex-col gap-5 xl:flex-row">
        <div className="shrink-0 xl:w-[280px]">
          <PersonaRadar axes={props.value.axes} size={260} />
        </div>
        <div className="flex-1 space-y-3">
          {CORE_PERSONA_AXES.map((axis) => (
            <DimensionSlider
              key={axis}
              axis={axis}
              labelLeft={PERSONA_AXIS_LABELS[axis].left}
              labelRight={PERSONA_AXIS_LABELS[axis].right}
              description={tAxes(`${axis}.description`)}
              value={axisValue(props.value, axis)}
              onChange={(next) => setAxis(axis, next)}
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
                labelLeft={PERSONA_AXIS_LABELS[axis].left}
                labelRight={PERSONA_AXIS_LABELS[axis].right}
                description={tAxes(`${axis}.description`)}
                value={axisValue(props.value, axis)}
                onChange={(next) => setAxis(axis, next)}
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
      </div>
    </div>
  );
}
