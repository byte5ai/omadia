'use client';

import { useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Boxes,
  Briefcase,
  Calculator,
  Check,
  Code2,
  Cpu,
  Hammer,
  MessageSquare,
  Send,
  Sparkles,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { Plugin } from '../../_lib/storeTypes';
import {
  BUSINESS_CASES,
  PLUGIN_CATEGORIES,
  normalizePluginId,
  pluginLabel,
  type BusinessCase,
  type PluginCategory,
} from '../../_lib/businessCases';

/**
 * Dashboard onboarding wizard. A guided, business-case-first flow:
 *   Step 1 — connect an LLM (gates everything below).
 *   Step 2 — pick a business case / role (Sales, HR, Finance, Dev team).
 *   Step 3 — recommended Hub plugins for that case, grouped into four
 *            categories (Channels / ERP / Knowledge / DevTools). Each plugin
 *            resolves against the live catalog: installed, installable (→ the
 *            store detail/install page), or missing → Builder + request.
 *
 * Inline + dismissible: the operator can hide it for good (persisted in
 * localStorage) and bring it back from the slim re-enable strip.
 */

const HIDDEN_KEY = 'omadia.dashboard.onboarding.hidden';

// Module-level store for the persisted "hidden" flag. Backed by localStorage
// and read through useSyncExternalStore so the server snapshot (always visible)
// and the client snapshot reconcile without a hydration mismatch — and without
// a setState-in-effect, which the cascading-render lint rule forbids.
let hiddenCache: boolean | null = null;
const hiddenListeners = new Set<() => void>();

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

function subscribeHidden(cb: () => void): () => void {
  hiddenListeners.add(cb);
  return () => hiddenListeners.delete(cb);
}

function getHiddenSnapshot(): boolean {
  if (hiddenCache === null) hiddenCache = readHidden();
  return hiddenCache;
}

function getHiddenServerSnapshot(): boolean {
  return false;
}

function setHiddenPersisted(value: boolean): void {
  hiddenCache = value;
  try {
    if (value) window.localStorage.setItem(HIDDEN_KEY, '1');
    else window.localStorage.removeItem(HIDDEN_KEY);
  } catch {
    /* private mode / no storage */
  }
  for (const l of hiddenListeners) l();
}

const CASE_ICON: Record<string, LucideIcon> = {
  sales: Briefcase,
  hr: Users,
  finance: Calculator,
  devteam: Code2,
};

const CATEGORY_ICON: Record<PluginCategory, LucideIcon> = {
  channels: MessageSquare,
  erp: Boxes,
  knowledge: BookOpen,
  devtools: Wrench,
};

type Availability = 'installed' | 'available' | 'incompatible' | 'missing';

function resolve(
  id: string,
  plugins: Plugin[],
): { availability: Availability; plugin: Plugin | undefined } {
  const target = normalizePluginId(id);
  const plugin = plugins.find((p) => normalizePluginId(p.id) === target);
  if (!plugin) return { availability: 'missing', plugin: undefined };
  // `update-available` is still installed (just upgradable); only a genuine
  // incompatibility gets its own, non-installable state.
  if (
    plugin.install_state === 'installed' ||
    plugin.install_state === 'update-available'
  ) {
    return { availability: 'installed', plugin };
  }
  if (plugin.install_state === 'incompatible') {
    return { availability: 'incompatible', plugin };
  }
  return { availability: 'available', plugin };
}

function requestPluginUrl(title: string, body: string): string {
  const params = new URLSearchParams({
    labels: 'enhancement',
    title,
    body,
  });
  return `https://github.com/byte5ai/omadia/issues/new?${params.toString()}`;
}

export function DashboardOnboarding({
  plugins,
  llmConnected,
}: {
  /** Live Hub catalog, or null when the catalog fetch failed — so the
   *  recommender can tell "plugin missing" apart from "catalog unavailable". */
  plugins: Plugin[] | null;
  llmConnected: boolean;
}): React.ReactElement | null {
  const t = useTranslations('dashboard.onboarding');
  const hidden = useSyncExternalStore(
    subscribeHidden,
    getHiddenSnapshot,
    getHiddenServerSnapshot,
  );
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);

  if (hidden) {
    return (
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setHiddenPersisted(false)}
          className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-[color:var(--fg-subtle)] transition-colors hover:text-[color:var(--fg-strong)]"
        >
          <Sparkles className="size-3.5" aria-hidden />
          {t('reenable')}
        </button>
      </div>
    );
  }

  const selectedCase =
    BUSINESS_CASES.find((c) => c.id === selectedCaseId) ?? null;

  return (
    <section
      aria-labelledby="dash-onboarding-heading"
      className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-6 lg:p-8"
    >
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-[color:var(--accent)]">
            <Sparkles className="size-3.5" aria-hidden />
            {t('kicker')}
          </div>
          <h2
            id="dash-onboarding-heading"
            className="font-display mt-2 text-[clamp(1.5rem,3vw,2rem)] leading-tight text-[color:var(--fg-strong)]"
          >
            {t('heading')}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[color:var(--fg-muted)]">
            {t('subtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setHiddenPersisted(true)}
          className="shrink-0 text-[color:var(--fg-subtle)] transition-colors hover:text-[color:var(--fg-strong)]"
          aria-label={t('dismiss')}
          title={t('dismiss')}
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      {/* Step 1 — connect an LLM. Gates everything below: without a model no
          orchestrator can run, so a business case would install plugins that
          can't act. */}
      {!llmConnected ? (
        <div className="mt-6 rounded-lg border border-[color:var(--accent)]/50 bg-[color:var(--accent-subtle)] p-5">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[color:var(--accent)]">
            <Cpu className="size-3.5" aria-hidden />
            {t('step', { n: 1 })}
          </div>
          <h3 className="font-display mt-1 text-lg font-medium text-[color:var(--fg-strong)]">
            {t('llmStep.title')}
          </h3>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-[color:var(--fg-muted)]">
            {t('llmStep.description')}
          </p>
          <div className="mt-4">
            <Link
              href="/admin/providers"
              className="inline-flex items-center gap-2 rounded-full bg-[color:var(--accent)] px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-on-dark)] shadow-[var(--shadow-cta)] transition-colors hover:bg-[color:var(--accent-hover)]"
            >
              {t('llmStep.connect')}
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </div>
        </div>
      ) : selectedCase === null ? (
        <ChooseCase onSelect={setSelectedCaseId} />
      ) : (
        <Recommendations
          businessCase={selectedCase}
          plugins={plugins ?? []}
          catalogAvailable={plugins !== null}
          onBack={() => setSelectedCaseId(null)}
        />
      )}
    </section>
  );
}

function ChooseCase({
  onSelect,
}: {
  onSelect: (id: string) => void;
}): React.ReactElement {
  const t = useTranslations('dashboard.onboarding');
  return (
    <div className="mt-6">
      <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
        {t('step', { n: 2 })} · {t('chooseCaseHeading')}
      </div>
      <p className="mt-1 text-sm text-[color:var(--fg-muted)]">
        {t('chooseCaseSubtitle')}
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {BUSINESS_CASES.map((c) => {
          const Icon = CASE_ICON[c.id] ?? Briefcase;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c.id)}
              className="group flex h-full flex-col rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/60 p-4 text-left transition-colors hover:border-[color:var(--accent)]"
            >
              <span className="text-[color:var(--accent)]">
                <Icon className="size-5" aria-hidden />
              </span>
              <span className="font-display mt-3 text-[15px] font-medium text-[color:var(--fg-strong)]">
                {t(`cases.${c.id}.name`)}
              </span>
              <span className="mt-1 flex-1 text-[12px] leading-relaxed text-[color:var(--fg-muted)]">
                {t(`cases.${c.id}.description`)}
              </span>
              <span className="mt-3 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)] transition-colors group-hover:text-[color:var(--accent)]">
                {t('recommend.open')}
                <ArrowRight className="size-3.5" aria-hidden />
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-6 flex items-center justify-end">
        <Link
          href="/store"
          className="text-[12px] font-semibold text-[color:var(--accent)] underline-offset-4 hover:underline"
        >
          {t('browseAll')}
        </Link>
      </div>
    </div>
  );
}

function Recommendations({
  businessCase,
  plugins,
  catalogAvailable,
  onBack,
}: {
  businessCase: BusinessCase;
  plugins: Plugin[];
  catalogAvailable: boolean;
  onBack: () => void;
}): React.ReactElement {
  const t = useTranslations('dashboard.onboarding');
  const caseName = t(`cases.${businessCase.id}.name`);
  // Only render categories this case actually recommends — no dead "empty
  // category" placeholders.
  const categories = PLUGIN_CATEGORIES.filter((category) =>
    businessCase.plugins.some((p) => p.category === category),
  );

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
            {t('step', { n: 3 })} · {caseName}
          </div>
          <p className="mt-1 text-sm text-[color:var(--fg-muted)]">
            {t('recommend.subtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)] transition-colors hover:text-[color:var(--fg-strong)]"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          {t('recommend.back')}
        </button>
      </div>

      {!catalogAvailable ? (
        <p className="mt-5 rounded-lg border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10 px-4 py-3 text-[13px] text-[color:var(--warning)]">
          {t('recommend.catalogUnavailable')}
        </p>
      ) : (
        <div className="mt-5 flex flex-col gap-8">
          {categories.map((category) => {
            const recs = businessCase.plugins.filter(
              (p) => p.category === category,
            );
            const Icon = CATEGORY_ICON[category];
            return (
              <section key={category}>
                <h3 className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-muted)]">
                  <Icon className="size-4" aria-hidden />
                  {t(`categories.${category}`)}
                </h3>
                <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {recs.map((rec) => (
                    <PluginRecommendation
                      key={rec.id}
                      id={rec.id}
                      category={category}
                      plugins={plugins}
                      caseName={caseName}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      <div className="mt-6 flex items-center justify-end">
        <Link
          href="/store"
          className="text-[12px] font-semibold text-[color:var(--accent)] underline-offset-4 hover:underline"
        >
          {t('browseAll')}
        </Link>
      </div>
    </div>
  );
}

function PluginRecommendation({
  id,
  category,
  plugins,
  caseName,
}: {
  id: string;
  category: PluginCategory;
  plugins: Plugin[];
  caseName: string;
}): React.ReactElement {
  const t = useTranslations('dashboard.onboarding');
  const { availability, plugin } = resolve(id, plugins);
  const name = plugin?.name ?? pluginLabel(id);

  return (
    <li className="flex flex-col rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/60 p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[14px] font-semibold text-[color:var(--fg-strong)]">
          {name}
        </span>
        {availability === 'installed' ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--success)]">
            <Check className="size-3.5" aria-hidden />
            {t('recommend.installedBadge')}
          </span>
        ) : availability === 'incompatible' ? (
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--warning)]">
            {t('recommend.incompatibleHint')}
          </span>
        ) : availability === 'missing' ? (
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--fg-subtle)]">
            {t('recommend.missingHint')}
          </span>
        ) : null}
      </div>

      {plugin?.description ? (
        <p className="mt-1 line-clamp-2 flex-1 text-[12px] leading-relaxed text-[color:var(--fg-muted)]">
          {plugin.description}
        </p>
      ) : (
        <div className="flex-1" />
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {availability === 'missing' ? (
          <>
            <Link
              href="/store/builder"
              aria-label={`${t('recommend.build')} — ${name}`}
              className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--accent)] hover:underline"
            >
              <Hammer className="size-3.5" aria-hidden />
              {t('recommend.build')}
            </Link>
            <a
              href={requestPluginUrl(
                `[Plugin request] ${name}`,
                `Business case: ${caseName}\nCategory: ${t(`categories.${category}`)}\nPlugin: ${name} (${id})\n\nRequested from the omadia onboarding.`,
              )}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${t('recommend.request')} — ${name}`}
              className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--fg-subtle)] transition-colors hover:text-[color:var(--fg-strong)]"
            >
              <Send className="size-3.5" aria-hidden />
              {t('recommend.request')}
            </a>
          </>
        ) : (
          <Link
            href={`/store/${encodeURIComponent(id)}`}
            aria-label={`${t('recommend.open')} — ${name}`}
            className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--accent)] hover:underline"
          >
            {t('recommend.open')}
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Link>
        )}
      </div>
    </li>
  );
}
