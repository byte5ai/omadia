import { redirect } from 'next/navigation';

/**
 * Legacy route. The subscription-CLI surface folded into the combined LLM
 * access page; keep the path alive for bookmarks and deep links by redirecting
 * to that page's Subscriptions tab.
 */
export default function AdminSubscriptionClisRedirect(): never {
  redirect('/admin/providers?tab=subscriptions');
}
