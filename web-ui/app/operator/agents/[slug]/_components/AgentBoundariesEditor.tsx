'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  BOUNDARY_PRESETS,
  findUnknownBoundaryPresets,
  type BoundaryCategory,
} from '../../../../_lib/boundaryPresets';
import { FACILITATOR_DEFAULT_SYCOPHANCY } from '../../../../_lib/facilitators';
import type {
  QualityConfig,
  SycophancyLevel,
} from '../../../../_lib/builderTypes';

/**
 * The limits half of an agent's identity (#914 follow-up): what it must not
 * do, and how hard it resists flattering the user.
 *
 * Both blocks are the SAME `quality` document the Agent Builder writes, and
 * both compile through the same functions on the server
 * (`compileBoundariesSection`, `compileSycophancyGuard`). This component only
 * edits the document — the preset library, its categories and its labels all
 * come from `_lib/boundaryPresets`.
 *
 * Unknown preset ids round-trip untouched and are surfaced as a warning: a
 * value written by a newer build, or a preset retired from the library, is a
 * rule the agent may have stopped following. Silently dropping it would hide
 * exactly that.
 */
export interface AgentBoundariesEditorProps {
  readonly value: QualityConfig;
  readonly onChange: (next: QualityConfig) => void;
  readonly disabled?: boolean;
  /**
   * #2066 — a FACILITATOR's limits: the sycophancy guard cannot be switched
   * off (spec 2043 §2.4), so `off` is not offered and an unset level shows
   * what the kernel compiles it to.
   */
  readonly facilitator?: boolean;
  /** Server finding for the sycophancy guard, already localized. */
  readonly sycophancyError?: string;
}

const CATEGORY_ORDER: readonly BoundaryCategory[] = [
  'data',
  'scope',
  'authority',
  'communication',
];

const SYCOPHANCY_LEVELS: readonly SycophancyLevel[] = [
  'off',
  'low',
  'medium',
  'high',
];

/**
 * #1894 — the select value for "no level of its own". An agent that leaves
 * the level open gets the Quality Guard's default (when the plugin is
 * installed); that is not the same as an explicit `off`, which tells the
 * guard to add nothing.
 */
const SYCOPHANCY_UNSET = '';

/**
 * #1895 — one rule per non-empty line, trimmed. Applied to what reaches the
 * parent, never to what the textarea shows while the operator types: a
 * controlled value rebuilt from the normalized lines swallowed every Enter
 * and every trailing space.
 */
function normalizeRuleLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isSycophancyLevel(raw: string): raw is SycophancyLevel {
  return (SYCOPHANCY_LEVELS as readonly string[]).includes(raw);
}

export function AgentBoundariesEditor(
  props: AgentBoundariesEditorProps,
): React.ReactElement {
  const t = useTranslations('operatorAgents.identity.boundaries');
  // The preset labels live in the builder catalogue, where the library was
  // written; one library, one set of names.
  // #1882 — the labels sit one level below the section, under `presets.*`.
  const tPresets = useTranslations('builder.persona.boundaries.presets');

  const presets = props.value.boundaries?.presets ?? [];
  const custom = props.value.boundaries?.custom ?? [];
  const unknown = findUnknownBoundaryPresets(presets);
  const isFacilitator = props.facilitator === true;
  const sycophancyLevels = isFacilitator
    ? SYCOPHANCY_LEVELS.filter((level) => level !== 'off')
    : SYCOPHANCY_LEVELS;
  const storedSycophancy = props.value.sycophancy;
  const sycophancyValue = isFacilitator
    ? storedSycophancy === undefined || storedSycophancy === 'off'
      ? FACILITATOR_DEFAULT_SYCOPHANCY
      : storedSycophancy
    : (storedSycophancy ?? SYCOPHANCY_UNSET);

  // #1895 — the textarea's own text. The parent only ever receives the
  // normalized rules; the raw text is re-seeded from the parent only when the
  // parent's rules change for a reason other than this field (a save that
  // returns the stored value, a reload).
  const customJoined = custom.join('\n');
  const [customText, setCustomText] = useState(customJoined);
  const [customSeed, setCustomSeed] = useState(customJoined);
  if (customSeed !== customJoined) {
    setCustomSeed(customJoined);
    if (normalizeRuleLines(customText).join('\n') !== customJoined) {
      setCustomText(customJoined);
    }
  }

  const setBoundaries = (
    nextPresets: readonly string[],
    nextCustom: readonly string[],
  ): void => {
    props.onChange({
      ...props.value,
      boundaries: { presets: [...nextPresets], custom: [...nextCustom] },
    });
  };

  const togglePreset = (id: string): void => {
    setBoundaries(
      presets.includes(id) ? presets.filter((p) => p !== id) : [...presets, id],
      custom,
    );
  };

  return (
    <div className="space-y-5" data-testid="agent-boundaries-editor">
      <p
        data-testid="agent-boundaries-plugin-stack-note"
        className="text-[11px] text-[color:var(--fg-muted)]"
      >
        {t('pluginStackNote')}
      </p>
      <div>
        <p className="text-xs font-medium">{t('presetsHeading')}</p>
        <p className="mt-1 text-[11px] text-[color:var(--fg-muted)]">
          {t('presetsHint')}
        </p>
        {unknown.length > 0 && (
          <p
            role="status"
            data-testid="agent-boundaries-unknown"
            className="mt-2 rounded border border-[color:var(--warning)] bg-[color:var(--warning)]/10 p-2 text-[11px] text-[color:var(--warning)]"
          >
            {t('unknownPresets', { ids: unknown.join(', ') })}
          </p>
        )}
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          {CATEGORY_ORDER.map((category) => (
            <fieldset key={category} className="space-y-2">
              <legend className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--fg-muted)]">
                {t(`categories.${category}`)}
              </legend>
              {BOUNDARY_PRESETS.filter((p) => p.category === category).map(
                (preset) => (
                  <label
                    key={preset.id}
                    className="flex items-start gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={presets.includes(preset.id)}
                      disabled={props.disabled}
                      data-testid={`agent-boundary-${preset.id}`}
                      onChange={() => togglePreset(preset.id)}
                    />
                    <span>{tPresets(preset.labelKey)}</span>
                  </label>
                ),
              )}
            </fieldset>
          ))}
        </div>
      </div>

      <div>
        <label
          className="mb-1 block text-xs font-medium"
          htmlFor="agent-boundaries-custom"
        >
          {t('customLabel')}
        </label>
        <textarea
          id="agent-boundaries-custom"
          className="min-h-[5rem] w-full rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 px-3 py-2 font-mono text-xs"
          // One rule per line, spliced verbatim into the prompt — what the
          // operator types is what the agent reads (issue #1101).
          value={customText}
          placeholder={t('customPlaceholder')}
          disabled={props.disabled}
          onChange={(e) => {
            setCustomText(e.target.value);
            setBoundaries(presets, normalizeRuleLines(e.target.value));
          }}
          onBlur={() => setCustomText(normalizeRuleLines(customText).join('\n'))}
        />
        <p className="mt-1 text-[11px] text-[color:var(--fg-muted)]">
          {t('customHint')}
        </p>
      </div>

      <div>
        <label
          className="mb-1 block text-xs font-medium"
          htmlFor="agent-sycophancy"
        >
          {t('sycophancyLabel')}
        </label>
        <select
          id="agent-sycophancy"
          className="rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 px-3 py-2 text-sm"
          value={sycophancyValue}
          {...(props.sycophancyError ? { 'aria-invalid': true } : {})}
          disabled={props.disabled}
          onChange={(e) => props.onChange(withSycophancy(props.value, e.target.value))}
        >
          {!isFacilitator && (
            <option value={SYCOPHANCY_UNSET}>{t('sycophancyUnset')}</option>
          )}
          {sycophancyLevels.map((level) => (
            <option key={level} value={level}>
              {t(`sycophancyLevels.${level}`)}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] text-[color:var(--fg-muted)]">
          {isFacilitator ? t('sycophancyFacilitatorHint') : t('sycophancyHint')}
        </p>
        {props.sycophancyError && (
          <p
            role="alert"
            data-testid="agent-sycophancy-error"
            className="mt-1 text-[11px] text-[color:var(--danger)]"
          >
            {props.sycophancyError}
          </p>
        )}
      </div>
    </div>
  );
}

/** The quality document with the select's choice; unset drops the field. */
function withSycophancy(value: QualityConfig, raw: string): QualityConfig {
  if (isSycophancyLevel(raw)) return { ...value, sycophancy: raw };
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'sycophancy'),
  ) as QualityConfig;
}
