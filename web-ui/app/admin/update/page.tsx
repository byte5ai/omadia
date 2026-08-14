import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { UpdateClient } from './_components/UpdateClient';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('adminUpdate');
  return { title: t('title') };
}

/**
 * Admin → Update (#432).
 *
 * A thin server shell around the client component, for exactly one reason:
 * when the stack runs on Fly.io the admin page has to print a `fly deploy`
 * command for the **web-ui app**, and only this process knows that app's name
 * — Fly sets `FLY_APP_NAME` inside each Machine, and the web-ui's Machine
 * knows its own, not the middleware's. The middleware reports its own through
 * `/status`; this supplies the other half. Unset (compose, local, anything
 * else) leaves the UI on its generic instructions.
 */
export default function UpdatePage(): React.ReactElement {
  const webUiApp = process.env.FLY_APP_NAME?.trim();
  return (
    <UpdateClient
      {...(webUiApp !== undefined && webUiApp.length > 0 ? { webUiApp } : {})}
    />
  );
}
