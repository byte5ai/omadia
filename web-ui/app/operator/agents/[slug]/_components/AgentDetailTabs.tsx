'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * The agent detail page as tabs.
 *
 * The page grew one stacked section per wave (#860 Teams, #914 identity,
 * #1018 peers, #1033 model, #861/#862 grants + MCP, #899 memory) until the
 * one-pager stopped being navigable. Each tab groups the sections an
 * operator works on together; only the active panel is mounted, so a tab
 * fetches its read model when opened, not seven at once on page load.
 *
 * The active tab lives in `?tab=` so a link can land on a section (the
 * dashboard, a runbook, a test script). It is written with
 * `history.replaceState`, not the router: switching a tab is not a
 * navigation and must not re-run the RSC fetch behind the page.
 */
export const AGENT_DETAIL_TABS = [
  'identity',
  'model',
  'peers',
  'teams',
  'plugins',
  'tools',
  'memory',
] as const;

export type AgentDetailTab = (typeof AGENT_DETAIL_TABS)[number];

const DEFAULT_TAB: AgentDetailTab = 'identity';
const TAB_PARAM = 'tab';

export function parseAgentDetailTab(raw: string | null | undefined): AgentDetailTab {
  return (AGENT_DETAIL_TABS as readonly string[]).includes(raw ?? '')
    ? (raw as AgentDetailTab)
    : DEFAULT_TAB;
}

function readTabFromLocation(): AgentDetailTab {
  if (typeof window === 'undefined') return DEFAULT_TAB;
  try {
    return parseAgentDetailTab(new URLSearchParams(window.location.search).get(TAB_PARAM));
  } catch {
    return DEFAULT_TAB;
  }
}

function writeTabToLocation(tab: AgentDetailTab): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (tab === DEFAULT_TAB) url.searchParams.delete(TAB_PARAM);
    else url.searchParams.set(TAB_PARAM, tab);
    window.history.replaceState(window.history.state, '', url);
  } catch {
    // A sandboxed frame without history access still gets a working page;
    // only the deep link is lost.
  }
}

interface AgentDetailTabsProps {
  /** One render function per tab; only the active one is called. */
  readonly panels: Readonly<Record<AgentDetailTab, () => React.ReactNode>>;
  /** Tab to open when the URL names none. */
  readonly initialTab?: AgentDetailTab;
}

export function AgentDetailTabs(props: AgentDetailTabsProps): React.ReactElement {
  const t = useTranslations('operatorAgents.detailTabs');
  // Lazy initial read: the server renders the default tab, the client picks
  // the URL's tab on hydration. The effect below re-syncs if the URL is
  // edited by hand (back/forward keeps the same document, so `popstate`).
  const [tab, setTab] = useState<AgentDetailTab>(() => {
    const fromUrl = readTabFromLocation();
    return fromUrl !== DEFAULT_TAB ? fromUrl : (props.initialTab ?? DEFAULT_TAB);
  });

  useEffect(() => {
    const onPop = (): void => setTab(readTabFromLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const select = useCallback((next: AgentDetailTab): void => {
    setTab(next);
    writeTabToLocation(next);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const idx = AGENT_DETAIL_TABS.indexOf(tab);
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const next = AGENT_DETAIL_TABS[(idx + delta + AGENT_DETAIL_TABS.length) % AGENT_DETAIL_TABS.length]!;
    select(next);
    document.getElementById(`agent-detail-tab-${next}`)?.focus();
  };

  return (
    <div>
      <div
        role="tablist"
        aria-label={t('aria')}
        onKeyDown={onKeyDown}
        className="sticky top-0 z-10 -mx-1 mb-6 flex flex-wrap gap-1 border-b border-[color:var(--border)] bg-[color:var(--bg)] px-1 pt-2"
      >
        {AGENT_DETAIL_TABS.map((id) => (
          // eslint-disable-next-line no-restricted-syntax -- tab, not a §4.2 CTA
          <button
            key={id}
            type="button"
            role="tab"
            id={`agent-detail-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`agent-detail-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            data-testid={`agent-detail-tab-${id}`}
            onClick={() => select(id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === id
                ? 'border-[color:var(--accent)] text-[color:var(--accent)]'
                : 'border-transparent text-[color:var(--fg-muted)] hover:text-[color:var(--fg)]'
            }`}
          >
            {t(id)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`agent-detail-panel-${tab}`}
        aria-labelledby={`agent-detail-tab-${tab}`}
        className="space-y-8"
      >
        {props.panels[tab]()}
      </div>
    </div>
  );
}
