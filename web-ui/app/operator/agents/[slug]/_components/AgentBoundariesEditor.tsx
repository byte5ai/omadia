'use client';

import { useTranslations } from 'next-intl';

import {
  BOUNDARY_PRESETS,
  findUnknownBoundaryPresets,
  type BoundaryCategory,
} from '../../../../_lib/boundaryPresets';
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

export function AgentBoundariesEditor(
  props: AgentBoundariesEditorProps,
): React.ReactElement {
  const t = useTranslations('operatorAgents.identity.boundaries');
  // The preset labels live in the builder catalogue, where the library was
  // written; one library, one set of names.
  const tPresets = useTranslations('builder.persona.boundaries');

  const presets = props.value.boundaries?.presets ?? [];
  const custom = props.value.boundaries?.custom ?? [];
  const unknown = findUnknownBoundaryPresets(presets);

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
          // One rule per line — the shape the compiler emits, so what the
          // operator types is what the agent reads.
          value={custom.join('\n')}
          disabled={props.disabled}
          onChange={(e) =>
            setBoundaries(
              presets,
              e.target.value
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0),
            )
          }
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
          value={props.value.sycophancy ?? 'off'}
          disabled={props.disabled}
          onChange={(e) =>
            props.onChange({
              ...props.value,
              sycophancy: e.target.value as SycophancyLevel,
            })
          }
        >
          {SYCOPHANCY_LEVELS.map((level) => (
            <option key={level} value={level}>
              {t(`sycophancyLevels.${level}`)}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] text-[color:var(--fg-muted)]">
          {t('sycophancyHint')}
        </p>
      </div>
    </div>
  );
}
