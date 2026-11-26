'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  DEFAULT_AGENT_DETAIL_TAB as DEFAULT_TAB,
  AGENT_DETAIL_TABS,
  parseAgentDetailTab,
  type AgentDetailTab,
} from './agentDetailTab';
import { UnsavedChangesContext, type ReportUnsaved } from './unsavedChangesGuard';

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
// The tab list and its parser live in `agentDetailTab.ts` (no 'use client'):
// the page calls the parser on the server to read `?tab=`.
export { AGENT_DETAIL_TABS, parseAgentDetailTab, type AgentDetailTab } from './agentDetailTab';

const TAB_PARAM = 'tab';


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
  /**
   * One render function per tab; only the active one is called. A tab
   * WITHOUT a panel is not offered at all (#2066): a facilitator has no
   * plugins, tools, conversations or memory to configure, and a tab that
   * opens onto nothing would promise something the kernel refuses.
   */
  readonly panels: Readonly<Partial<Record<AgentDetailTab, () => React.ReactNode>>>;
  /** The tab to render first: what `?tab=` names, read by the page on the
   *  server (the default tab when it names none). */
  readonly initialTab?: AgentDetailTab;
}

export function AgentDetailTabs(props: AgentDetailTabsProps): React.ReactElement {
  const t = useTranslations('operatorAgents.detailTabs');
  // The page reads `?tab=` on the server and passes it as `initialTab`, so
  // the server and the client render the same tab. Reading `window` here
  // made the hydration render differ from the server's for every deep link.
  // The effect below re-syncs if the URL changes in the same document
  // (back/forward, so `popstate`).
  const [requested, setTab] = useState<AgentDetailTab>(props.initialTab ?? DEFAULT_TAB);
  const tabs = AGENT_DETAIL_TABS.filter((id) => props.panels[id] !== undefined);
  // A deep link to a tab this agent does not have lands on the first one.
  const tab = tabs.includes(requested) ? requested : (tabs[0] ?? DEFAULT_TAB);

  useEffect(() => {
    const onPop = (): void => setTab(readTabFromLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // #1889 — the active panel reports unsaved input here; leaving it asks
  // first, because the panel unmounts and its local state goes with it.
  const unsaved = useRef(false);
  const reportUnsaved = useCallback<ReportUnsaved>((dirty) => {
    unsaved.current = dirty;
  }, []);
  const leaveMessage = t('unsavedLeaveConfirm');

  const select = (next: AgentDetailTab): boolean => {
    if (next === tab) return true;
    if (unsaved.current && !window.confirm(leaveMessage)) return false;
    setTab(next);
    writeTabToLocation(next);
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const idx = tabs.indexOf(tab);
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const next = tabs[(idx + delta + tabs.length) % tabs.length];
    if (next === undefined) return;
    if (!select(next)) return;
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
        {tabs.map((id) => (
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
        <UnsavedChangesContext.Provider value={reportUnsaved}>
          {props.panels[tab]?.()}
        </UnsavedChangesContext.Provider>
      </div>
    </div>
  );
}
