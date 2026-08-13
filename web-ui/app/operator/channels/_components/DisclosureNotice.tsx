import { getTranslations } from 'next-intl/server';

import {
  deviatingChannels,
  shouldShowDisclosureNotice,
  type DisclosureHealthDto,
} from '../../../_lib/disclosure';

interface Props {
  posture: DisclosureHealthDto | null;
}

/**
 * AI-Act marking deviation hint (#648, epic #642).
 *
 * The operator may grade the marking down per channel or switch it off —
 * omadia is self-hosted, that is their call. This notice exists because the
 * decision was previously visible NOWHERE, so a copied config or a leftover
 * from a test setup was never noticed by anyone.
 *
 * Informing, not paternalistic: it describes the state and blocks nothing. It
 * renders `null` at the delivered state, when the posture could not be read,
 * and on an older middleware whose `/health` has no `disclosure` block — #648
 * requires the surface to stay completely quiet in the delivered state, and a
 * hint that fires on a default install is a hint operators learn to ignore.
 *
 * Server component: the posture is fetched server-side (`/health` sits outside
 * the `/api` mount the browser proxy reaches), so there is nothing to hydrate.
 */
export async function DisclosureNotice({
  posture,
}: Props): Promise<React.ReactElement | null> {
  if (!shouldShowDisclosureNotice(posture) || !posture) return null;
  const t = await getTranslations('operatorChannels.disclosure');

  const deviating = deviatingChannels(posture)
    .map(([channel, level]) => `${channel} · ${t(`level.${level}`)}`)
    .join(', ');

  return (
    <div className="mb-6 rounded border border-[color:var(--warning)] bg-[color:var(--warning)]/8 p-4 text-sm">
      <p className="font-medium text-[color:var(--fg)]">{t('heading')}</p>
      {posture.deviates && deviating.length > 0 && (
        <p className="mt-1 text-[color:var(--fg-muted)]">
          {t('body', { channels: deviating })}
        </p>
      )}
      {posture.inertOverrides.length > 0 && (
        <p className="mt-2 text-xs text-[color:var(--fg-muted)]">
          {t('inert', { channels: posture.inertOverrides.join(', ') })}
        </p>
      )}
      <p className="mt-2 text-xs text-[color:var(--fg-muted)]">{t('note')}</p>
    </div>
  );
}
