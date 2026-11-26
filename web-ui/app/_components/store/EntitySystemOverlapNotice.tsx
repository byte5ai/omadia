import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { EntitySystemOverlap } from '../../_lib/entitySystemOverlap';

/**
 * #2245 / ADR-0167 — the highlighted line shown when a plugin declares an
 * entity system an installed plugin already writes (say, a second plugin with
 * `odoo`). Nothing in the kernel ties a system to one plugin, so this is the
 * operator's only chance to notice before both write the same nodes.
 *
 * Not async and no hooks beyond `useTranslations`, so it renders in the
 * server-rendered detail page and in the client install wizard alike.
 */
export function EntitySystemOverlapNotice({
  overlaps,
}: {
  overlaps: readonly EntitySystemOverlap[];
}): React.ReactElement | null {
  const t = useTranslations('store.detail.permissions');
  if (overlaps.length === 0) return null;
  return (
    <div
      className="rounded-md border border-[color:var(--oxblood)] p-3"
      data-testid="entity-system-overlap"
      role="note"
    >
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[color:var(--oxblood)]">
        <AlertTriangle className="size-3.5" aria-hidden />
        {t('entitySystemOverlapTitle')}
      </div>
      <ul className="mt-2 space-y-1 text-sm text-[color:var(--muted-ink)]">
        {overlaps.map((o) => (
          <li key={o.system}>
            {t('entitySystemOverlapLine', {
              system: o.system,
              plugins: o.pluginNames.join(', '),
            })}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs italic text-[color:var(--faint-ink)]">
        {t('entitySystemOverlapBody')}
      </p>
    </div>
  );
}
