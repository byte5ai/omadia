import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { decodePluginIdSegment } from '@/app/_lib/pluginId';

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
  const { pluginId: segment } = await params;
  const pluginId = decodePluginIdSegment(segment);
  // An invalid id renders the 404 page; it gets the default title rather
  // than echoing the raw segment into the tab.
  if (pluginId === null) return {};
  const t = await getTranslations('pluginUi');
  return { title: t('metaTitle', { pluginId }) };
}

export default async function PluginUiPage({
  params,
}: {
  params: Promise<{ pluginId: string }>;
}): Promise<React.ReactElement> {
  const { pluginId: segment } = await params;
  // Rejected here rather than passed on: an id outside the charset can never
  // resolve to a package, and refusing it keeps a malformed value out of the
  // iframe URL entirely.
  //
  // Next 16 passes the segment still percent-encoded (`%40omadia%2Fexample-ui`),
  // not decoded — see `decodePluginIdSegment` for the evidence. The helper
  // decodes first and runs the charset gate (pinned by test to the middleware
  // definition) on the decoded value; `PluginUiFrame` re-encodes it for the
  // iframe `src`. Validating the raw param 404'd every scoped id (#1399).
  const pluginId = decodePluginIdSegment(segment);
  if (pluginId === null) notFound();

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
