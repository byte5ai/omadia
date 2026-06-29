import { LlmAccessTabs, type LlmTab } from './_components/LlmAccessTabs';

/**
 * `/admin/providers` — the combined "LLM access" admin page. Reads the initial
 * tab from `?tab=` server-side and hands it to the client tab switcher, which
 * renders the providers panel or the subscription-CLI panel. The legacy
 * `/admin/subscription-clis` route redirects here with `?tab=subscriptions`.
 */
export const dynamic = 'force-dynamic';

export default async function AdminLlmAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}): Promise<React.ReactElement> {
  const { tab } = await searchParams;
  const initialTab: LlmTab =
    tab === 'subscriptions' ? 'subscriptions' : 'providers';
  return <LlmAccessTabs initialTab={initialTab} />;
}
