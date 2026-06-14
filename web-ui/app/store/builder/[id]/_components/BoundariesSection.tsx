'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useState, useTransition } from 'react';

import { Button } from '@/app/_components/ui/Button';

import { setQualityConfig } from '../../../../_lib/api';
import {
  BOUNDARY_CATEGORY_LABELS_DE,
  BOUNDARY_PRESETS,
  type BoundaryCategory,
  findUnknownBoundaryPresets,
} from '../../../../_lib/boundaryPresets';
import type { QualityConfig } from '../../../../_lib/builderTypes';

/**
 * Boundaries pillar — checkbox grid over the 12 kemia preset library
 * grouped by category, plus a textarea for custom "You must NOT: …"
 * lines. Persists the full `spec.quality` block via the same JSON-Patch
 * route as `setPersonaConfig` (issue #54).
 *
 * Unknown preset IDs (legacy values, future presets not yet ported)
 * are surfaced via a warning badge — the spec round-trips with the
 * unknown IDs so a future kemia preset can land without a migration.
 */

export interface BoundariesSectionProps {
  draftId: string;
  /** Initial quality block; passes through unchanged when not modified. */
  initialQuality?: QualityConfig;
  /** Disable interaction (read-only / archived draft). */
  disabled?: boolean;
  /** Invoked after a successful save with the persisted block. */
  onPersisted?: (next: QualityConfig) => void;
}

const CATEGORY_ORDER: readonly BoundaryCategory[] = [
  'data',
  'scope',
  'authority',
  'communication',
];

export function BoundariesSection({
  draftId,
  initialQuality,
  disabled,
  onPersisted,
}: BoundariesSectionProps): React.ReactElement {
  const t = useTranslations('builder.persona.boundaries');
  const [selectedIds, setSelectedIds] = useState<readonly string[]>(
    () => initialQuality?.boundaries?.presets ?? [],
  );
  const [customLines, setCustomLines] = useState<string>(
    () => (initialQuality?.boundaries?.custom ?? []).join('\n'),
  );
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const presetsByCategory = useMemo(() => {
    const out: Partial<Record<BoundaryCategory, typeof BOUNDARY_PRESETS>> = {};
    for (const cat of CATEGORY_ORDER) {
      out[cat] = BOUNDARY_PRESETS.filter((p) => p.category === cat);
    }
    return out as Record<BoundaryCategory, typeof BOUNDARY_PRESETS>;
  }, []);

  const unknownIds = useMemo(
    () => findUnknownBoundaryPresets(selectedIds),
    [selectedIds],
  );

  const handleToggle = useCallback((id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      if (checked) {
        if (prev.includes(id)) return prev;
        return [...prev, id];
      }
      return prev.filter((p) => p !== id);
    });
  }, []);

  const handleSave = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const custom = customLines
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const config: QualityConfig = {
        ...initialQuality,
        boundaries: { presets: [...selectedIds], custom },
      };
      try {
        await setQualityConfig(draftId, config);
        setSavedAt(Date.now());
        onPersisted?.(config);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }, [customLines, draftId, initialQuality, onPersisted, selectedIds]);

  return (
    <section
      data-testid="boundaries-section"
      className="space-y-3 rounded border border-[color:var(--border)] p-4"
    >
      <header className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-[color:var(--fg-strong)]">
          {t('heading')}
        </h3>
        <span className="text-xs text-[color:var(--fg-muted)]">
          {t('selectedCount', { count: selectedIds.length })}
        </span>
      </header>

      {unknownIds.length > 0 && (
        <div
          data-testid="boundaries-unknown-warning"
          role="alert"
          className="rounded border border-[color:var(--warning)] bg-[color:var(--warning)]/10 px-2 py-1 text-xs text-[color:var(--warning)]"
        >
          {t('unknownPresets', { ids: unknownIds.join(', ') })}
        </div>
      )}

      {CATEGORY_ORDER.map((cat) => (
        <div key={cat} className="space-y-1">
          <div className="text-xs font-medium uppercase tracking-wider text-[color:var(--fg-muted)]">
            {BOUNDARY_CATEGORY_LABELS_DE[cat]}
          </div>
          <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
            {presetsByCategory[cat]?.map((p) => {
              const checked = selectedIds.includes(p.id);
              return (
                <label
                  key={p.id}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                  data-testid={`boundary-preset-${p.id}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => handleToggle(p.id, e.target.checked)}
                    disabled={disabled || pending}
                  />
                  <span>{p.labelDe}</span>
                </label>
              );
            })}
          </div>
        </div>
      ))}

      <div className="space-y-1">
        <label
          htmlFor={`boundaries-custom-${draftId}`}
          className="text-xs font-medium uppercase tracking-wider text-[color:var(--fg-muted)]"
        >
          {t('customLabel')}
        </label>
        <textarea
          id={`boundaries-custom-${draftId}`}
          data-testid="boundaries-custom"
          value={customLines}
          onChange={(e) => setCustomLines(e.target.value)}
          rows={3}
          disabled={disabled || pending}
          className="w-full rounded border border-[color:var(--border)] bg-transparent p-2 text-sm"
        />
      </div>

      {error && (
        <div role="alert" className="text-xs text-[color:var(--danger)]">
          {error}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={disabled || pending}
          className="text-sm"
          data-testid="boundaries-save"
        >
          {pending ? t('saving') : t('save')}
        </Button>
        {savedAt && (
          <span className="text-xs text-[color:var(--fg-muted)]">
            {t('saved')}
          </span>
        )}
      </div>
    </section>
  );
}
