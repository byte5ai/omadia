'use client';

import { useTranslations } from 'next-intl';

import { WebhookEndpointsSection } from './_components/WebhookEndpointsSection';
import { WebhookSubscriptionsSection } from './_components/WebhookSubscriptionsSection';

/**
 * Issue #437 admin surface — inbound endpoints (start subscribed workflow
 * runs) and outbound subscriptions (receive run-lifecycle events), each with
 * secret rotation and delivery history. The backend CRUD + delivery-log
 * routes already exist under `/api/v1/operator/conductors/webhooks/*`; this
 * page is the acceptance-criterion admin view onto them.
 */
export default function AdminWebhooksPage(): React.ReactElement {
  const t = useTranslations('adminWebhooks');

  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">{t('title')}</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">{t('intro')}</p>
      </header>

      <WebhookEndpointsSection />
      <WebhookSubscriptionsSection />
    </main>
  );
}
