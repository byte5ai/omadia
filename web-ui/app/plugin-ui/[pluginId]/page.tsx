import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

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

/** Mirrors the plugin-id charset gate in `manifestLoader`. */
const PLUGIN_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

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
  if (!PLUGIN_ID.test(pluginId)) notFound();

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
