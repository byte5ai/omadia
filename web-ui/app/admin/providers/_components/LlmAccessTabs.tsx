'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { cn } from '../../../_lib/cn';
import { ProvidersPanel } from './ProvidersPanel';
import { SubscriptionClisPanel } from '../../subscription-clis/_components/SubscriptionClisPanel';

/**
 * Combined "LLM access" admin surface. Folds the former `/admin/providers` and
 * `/admin/subscription-clis` pages into one page with two tabs:
 *   • API keys      — providers + per-plugin model assignments
 *   • Subscriptions — vendor CLIs connected via in-app login
 *
 * Both are ways to give the orchestrator an LLM, so they belong together. The
 * initial tab comes from `?tab=` (resolved server-side) so deep links and the
 * dashboard onboarding CTAs can target either side directly.
 */

export type LlmTab = 'providers' | 'subscriptions';

export function LlmAccessTabs({
  initialTab,
}: {
  initialTab: LlmTab;
}): React.ReactElement {
  const t = useTranslations('adminLlm');
  const [tab, setTab] = useState<LlmTab>(initialTab);

  const tabs: Array<{ key: LlmTab; label: string }> = [
    { key: 'providers', label: t('tabProviders') },
    { key: 'subscriptions', label: t('tabSubscriptions') },
  ];

  return (
    <main className="mx-auto max-w-[960px] px-6 py-12 lg:px-8 lg:py-16">
      <header className="mb-8">
        <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-[1.1] text-[color:var(--fg-strong)]">
          {t('title')}
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-[1.55] text-[color:var(--fg-muted)]">
          {t('subtitle')}
        </p>
      </header>

      <div
        className="mb-8 inline-flex rounded-full border border-[color:var(--border)] bg-[color:var(--bg-soft)] p-1"
        role="tablist"
        aria-label={t('title')}
      >
        {tabs.map((tabDef) => {
          const active = tabDef.key === tab;
          return (
            <button
              key={tabDef.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(tabDef.key)}
              className={cn(
                'rounded-full px-4 py-2 text-[13px] font-semibold transition-colors',
                active
                  ? 'bg-[color:var(--accent)] text-[color:var(--fg-on-dark)] shadow-[var(--shadow-cta)]'
                  : 'text-[color:var(--fg-muted)] hover:text-[color:var(--fg-strong)]',
              )}
            >
              {tabDef.label}
            </button>
          );
        })}
      </div>

      {tab === 'providers' ? (
        <ProvidersPanel onSwitchToSubscriptions={() => setTab('subscriptions')} />
      ) : (
        <SubscriptionClisPanel />
      )}
    </main>
  );
}
