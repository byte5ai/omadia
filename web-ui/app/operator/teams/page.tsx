import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { TeamsTenantSignIn } from './_components/TeamsTenantSignIn';

/**
 * The tenant-wide Teams sign-in (byte5ai/omadia#924).
 *
 * A page rather than a panel inside an agent, because the thing it manages is
 * shared: `POST /appCatalogs/teamsApps` is delegated-only at Microsoft, so one
 * admin signs in once for the whole directory and every agent provisioned
 * afterwards — including agents that do not exist yet — rides on that sign-in.
 * Under `/operator/agents/:slug` this would have claimed the opposite, and
 * "sign in before creating your first agent" would have had nowhere to live.
 *
 * Everything is client-side: the panel drives a live device-code flow with a
 * countdown and a poll, which is not something a server render can hold.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('operatorTeamsSignIn');
  return { title: t('metaTitle') };
}

export const dynamic = 'force-dynamic';

export default function OperatorTeamsPage(): React.ReactElement {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-4 p-4">
      <TeamsTenantSignIn />
    </main>
  );
}
