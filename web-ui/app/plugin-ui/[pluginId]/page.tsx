import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { isValidPluginId } from '@/app/_lib/pluginId';

import { PluginUiFrame } from './_components/PluginUiFrame';

/**
 * Host page for a plugin-supplied SPA (epic #470 C8 / G7).
 *
 * A plugin distributed as a package cannot compile pages into web-ui — that
 * would be a hardcoded core reference, which the epic's constraint 2 forbids.
 * It ships a compiled bundle inside its ZIP instead, core serves it at
 * `/p/<pluginId>/ui/`, and this route embeds it.
 *
 * A plugin puts its entry in the shell's navigation with the existing nav
 * contribution API (PR #536):
 *
 *   ctx.uiRoutes.registerNav({
 *     navId: 'main',
 *     href: `/plugin-ui/${pluginId}`,
 *     cluster: 'adminCluster',
 *     label: { en: 'My Plugin', de: 'Mein Plugin' },
 *   });
 *
 * `href` is validated as an in-app single-slash path, so this route is
 * reachable from a nav contribution while `//evil.example` is not.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ pluginId: string }>;
}): Promise<Metadata> {
  const { pluginId } = await params;
  const t = await getTranslations('pluginUi');
  return { title: t('metaTitle', { pluginId }) };
}

export default async function PluginUiPage({
  params,
}: {
  params: Promise<{ pluginId: string }>;
}): Promise<React.ReactElement> {
  const { pluginId } = await params;
  // Rejected here rather than passed on: an id outside the charset can never
  // resolve to a package, and refusing it keeps a malformed value out of the
  // iframe URL entirely.
  //
  // The gate lives in `_lib/pluginId.ts` and is pinned by test to the
  // middleware definition it claims to mirror. The version that shipped with
  // C8 declared the same intention in a comment and then omitted the optional
  // `@scope/`, so `@omadia/example-ui` — the id of the very plugin this
  // route was built for, and the shape of every omadia plugin id — was
  // rejected here. Next hands us the DECODED segment, so the value compared is
  // `@omadia/example-ui`, not its percent-encoded form.
  if (!isValidPluginId(pluginId)) notFound();

  const t = await getTranslations('pluginUi');

  return (
    <main className="flex h-full flex-col gap-4 p-6">
      <header>
        <h1 className="text-xl font-semibold text-fg-strong">
          {t('title', { pluginId })}
        </h1>
        <p className="text-sm text-fg-muted">{t('subtitle')}</p>
      </header>
      <div className="min-h-0 flex-1">
        <PluginUiFrame pluginId={pluginId} />
      </div>
    </main>
  );
}
