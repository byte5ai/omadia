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
import { SkillImportModal } from '../admin/SkillImportModal';
import { SkillVerdictBadge } from '../admin/SkillVerdictBadge';
import type { SkillImportResult } from '../../_lib/agentBuilder';

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

/**
 * OM-01/12 — the selected business case, persisted.
 *
 * It used to live in plain `useState`, so it reset on EVERY navigation. That is
 * why the card looked byte-for-byte identical after the tester had installed
 * plugins and worked in admin for half an hour: the wizard had no memory of
 * anything they had done. Sits next to `HIDDEN_KEY` deliberately — same
 * lifetime, same storage, same failure modes.
 */
const CASE_KEY = 'omadia.dashboard.onboarding.case';

// Read through `useSyncExternalStore` for the same reason `hidden` is: the
// server snapshot has no localStorage, so seeding `useState` from it would be a
// hydration mismatch, and a setState-in-effect is forbidden by the
// cascading-render lint rule.
let caseCache: string | null | undefined;
const caseListeners = new Set<() => void>();

function subscribeCase(cb: () => void): () => void {
  caseListeners.add(cb);
  return () => caseListeners.delete(cb);
}

function getCaseSnapshot(): string | null {
  if (caseCache === undefined) {
    try {
      caseCache = window.localStorage.getItem(CASE_KEY);
    } catch {
      caseCache = null;
    }
  }
  return caseCache;
}

function getCaseServerSnapshot(): string | null {
  return null;
}

function setCasePersisted(value: string | null): void {
  caseCache = value;
  try {
    if (value) window.localStorage.setItem(CASE_KEY, value);
    else window.localStorage.removeItem(CASE_KEY);
  } catch {
    /* private mode / no storage */
  }
  for (const l of caseListeners) l();
}

/** Test seam: drop the module-level caches between renders. */
export function __resetOnboardingStores(): void {
  hiddenCache = null;
  caseCache = undefined;
}

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

export interface DashboardOnboardingProps {
  /** Live Hub catalog, or null when the catalog fetch failed — so the
   *  recommender can tell "plugin missing" apart from "catalog unavailable". */
  plugins: Plugin[] | null;
  /**
   * A provider key that was actually PROBED and worked (`status === 'verified'`).
   *
   * OM-01/12 + Wave 1: step 1 must not tick on the old `connected` signal.
   * `connected` only means "a non-empty string sits in the vault" — exactly the
   * state that rendered a green badge while every request failed with
   * `invalid x-api-key`. Marking the step done on that signal would take the
   * existing lie and give it a MORE prominent widget to be told in.
   */
  llmVerified: boolean;
  /**
   * The operator is logged into a subscription CLI (`loggedIn === 'yes'`).
   *
   * The only other genuinely verified LLM signal in the codebase, and the
   * dashboard ignored it: a user logged into the Claude CLI was still told
   * "Schritt 1: LLM verbinden". Counts as satisfying step 1.
   */
  cliLoggedIn: boolean;
  /** At least one plugin is installed — satisfies step 3. */
  hasInstalledPlugin: boolean;
}

/** One onboarding step. `done` is computed, never stored — there is no way for
 *  a persisted "completed" flag to drift from reality. */
interface OnboardingStep {
  readonly id: 'llmAccess' | 'businessCase' | 'install';
  readonly done: boolean;
}

export function DashboardOnboarding({
  plugins,
  llmVerified,
  cliLoggedIn,
  hasInstalledPlugin,
}: DashboardOnboardingProps): React.ReactElement | null {
  const t = useTranslations('dashboard.onboarding');
  const hidden = useSyncExternalStore(
    subscribeHidden,
    getHiddenSnapshot,
    getHiddenServerSnapshot,
  );
  const persistedCaseId = useSyncExternalStore(
    subscribeCase,
    getCaseSnapshot,
    getCaseServerSnapshot,
  );
  const selectedCaseId = persistedCaseId;
  const setSelectedCaseId = setCasePersisted;

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

  // OM-01/12 — the card was titled "Erste Schritte" and its first visible
  // content was "SCHRITT 2 · BUSINESS-CASE WÄHLEN". There was no step 1,
  // because the three `t('step', {n})` calls lived inside a mutually-exclusive
  // ternary: step 1 VANISHED once satisfied instead of being checked off, so
  // the numbering started at 2 and no progress was ever visible. All three
  // steps now render always; `done` decides the checkmark, not the visibility.
  //
  // Step 1 is LLM access — the actual blocker the card never mentioned.
  // A fixed-length tuple, not a bare array: the three steps are a closed set,
  // and `noUncheckedIndexedAccess` would otherwise make every read optional.
  const steps: readonly [OnboardingStep, OnboardingStep, OnboardingStep] = [
    { id: 'llmAccess', done: llmVerified || cliLoggedIn },
    { id: 'businessCase', done: selectedCase !== null },
    { id: 'install', done: hasInstalledPlugin },
  ];
  const llmDone = steps[0].done;

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
          {/* OM-01/12 — `subtitle` and `chooseCaseSubtitle` said the same thing
              in two places. The one that stayed is the one attached to the step
              it actually describes; this slot now carries progress instead. */}
          <p className="mt-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)]">
            {t('progress', {
              done: steps.filter((s) => s.done).length,
              total: steps.length,
            })}
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

      {/* Step 1 — LLM access. Gates everything below: without a working model
          no orchestrator can run, so a business case would install plugins that
          cannot act. It stays VISIBLE once done — a checked-off step is what
          makes the numbering honest and the progress legible. */}
      <StepShell
        n={1}
        total={steps.length}
        done={llmDone}
        icon={Cpu}
        title={t('llmStep.title')}
      >
        {llmDone ? (
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-[color:var(--fg-muted)]">
            {cliLoggedIn && !llmVerified
              ? t('llmStep.doneViaCli')
              : t('llmStep.doneViaProvider')}
          </p>
        ) : (
          <>
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
          </>
        )}
      </StepShell>

      {/* Step 2 — business case. */}
      <StepShell
        n={2}
        total={steps.length}
        done={steps[1].done}
        icon={Briefcase}
        title={t('chooseCaseHeading')}
      >
        {selectedCase === null ? (
          <ChooseCase onSelect={setSelectedCaseId} />
        ) : (
          <p className="mt-2 flex flex-wrap items-center gap-3 text-[13px] text-[color:var(--fg-muted)]">
            <span>
              {t('caseChosen', { name: t(`cases.${selectedCase.id}.name`) })}
            </span>
            <button
              type="button"
              onClick={() => setSelectedCaseId(null)}
              className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[color:var(--fg-subtle)] transition-colors hover:text-[color:var(--fg-strong)]"
            >
              <ArrowLeft className="size-3.5" aria-hidden />
              {t('recommend.back')}
            </button>
          </p>
        )}
      </StepShell>

      {/* Step 3 — install the recommended set. */}
      <StepShell
        n={3}
        total={steps.length}
        done={steps[2].done}
        icon={Boxes}
        title={t('installStep.title')}
      >
        {selectedCase === null ? (
          <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--fg-muted)]">
            {t('installStep.pickCaseFirst')}
          </p>
        ) : (
          <Recommendations
            businessCase={selectedCase}
            plugins={plugins ?? []}
            catalogAvailable={plugins !== null}
          />
        )}
      </StepShell>
    </section>
  );
}

/**
 * OM-01/12 — the shared frame for a step: number, "n of total", a checkmark
 * when done, and the step's own content.
 *
 * The old card had three bare `t('step', {n})` labels inside a ternary, so the
 * user saw a number with nothing to compare it to and no indication that
 * anything had been achieved. `n of total` and the checked state are the whole
 * point of this component.
 */
function StepShell({
  n,
  total,
  done,
  icon: Icon,
  title,
  children,
}: {
  n: number;
  total: number;
  done: boolean;
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  const t = useTranslations('dashboard.onboarding');
  return (
    <div
      data-testid={`onboarding-step-${n}`}
      data-done={done ? 'true' : 'false'}
      className={`mt-6 rounded-lg border p-5 ${
        done
          ? 'border-[color:var(--border)] bg-[color:var(--card)]/40'
          : 'border-[color:var(--accent)]/50 bg-[color:var(--accent-subtle)]'
      }`}
    >
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em]">
        {done ? (
          <Check
            className="size-3.5 text-[color:var(--success)]"
            aria-hidden
            data-testid={`onboarding-step-${n}-check`}
          />
        ) : (
          <Icon className="size-3.5 text-[color:var(--accent)]" aria-hidden />
        )}
        <span
          className={
            done
              ? 'text-[color:var(--fg-subtle)]'
              : 'text-[color:var(--accent)]'
          }
        >
          {t('stepOfTotal', { n, total })}
        </span>
        {done ? (
          <span className="text-[color:var(--success)]">{t('applied')}</span>
        ) : null}
      </div>
      <h3 className="font-display mt-1 text-lg font-medium text-[color:var(--fg-strong)]">
        {title}
      </h3>
      {children}
    </div>
  );
}

function ChooseCase({
  onSelect,
}: {
  onSelect: (id: string) => void;
}): React.ReactElement {
  const t = useTranslations('dashboard.onboarding');
  return (
    <div className="mt-2">
      {/* The step number and title now live in `StepShell`; this component owns
          only the choices themselves. */}
      <p className="text-sm text-[color:var(--fg-muted)]">
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
      <BringYourSkills />

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

/**
 * Optional, skippable onboarding offer (#396): bring skills you already trust
 * (e.g. from Claude) via the same import path as everywhere else. Never a gate —
 * just a card. On import it points at the registry and the builder so the user
 * can reach a working agent that uses their own skill.
 */
function BringYourSkills(): React.ReactElement {
  const t = useTranslations('dashboard.onboarding.bringSkills');
  const tVerdict = useTranslations('skills.verdict');
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<SkillImportResult | null>(null);
  const importVerdict = imported?.verdict;
  /** Falls back to a humanized raw code for an unmapped verifier pattern —
   *  same graceful degradation as the skill editor. */
  function riskCodeLabel(code: string): string {
    const key = `riskCode.${code}`;
    return tVerdict.has(key) ? tVerdict(key) : code.replace(/_/g, ' ');
  }

  return (
    <div className="mt-8 rounded-lg border border-dashed border-[color:var(--border-strong)] bg-[color:var(--bg-soft)] p-5">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[color:var(--fg-subtle)]">
        <Sparkles className="size-3.5" aria-hidden />
        {t('kicker')}
      </div>
      <h3 className="font-display mt-1 text-lg font-medium text-[color:var(--fg-strong)]">
        {t('title')}
      </h3>
      <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-[color:var(--fg-muted)]">
        {t('subtitle')}
      </p>
      {imported ? (
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1 text-[13px] text-[color:var(--success)]">
            <Check className="size-4" aria-hidden />
            {t('imported', { name: imported.skill.name })}
          </span>
          {/* OM-25 — the imported skill carried "⚠ MARKIERT — PRÜFUNG
              EMPFOHLEN" in the registry while this toast said only
              "…importiert — jetzt einen Agenten damit bauen". The flag was
              discovered by chance. It now travels on the import response and is
              shown right here, next to the success. */}
          {importVerdict && importVerdict.severity !== 'no_signals' ? (
            <span
              className="inline-flex flex-wrap items-center gap-2"
              data-testid="import-verdict"
            >
              <SkillVerdictBadge severity={importVerdict.severity} />
              {importVerdict.riskCodes.length > 0 ? (
                <span className="text-[12px] text-[color:var(--warning)]">
                  {tVerdict('why', {
                    codes: importVerdict.riskCodes
                      .map(riskCodeLabel)
                      .join(', '),
                  })}
                </span>
              ) : null}
            </span>
          ) : null}
          <Link href="/operator/skills" className="text-[12px] font-semibold text-[color:var(--accent)] hover:underline">
            {t('toRegistry')}
          </Link>
          <Link href="/store/builder" className="inline-flex items-center gap-1 text-[12px] font-semibold text-[color:var(--accent)] hover:underline">
            <Hammer className="size-3.5" aria-hidden />
            {t('toBuilder')}
          </Link>
          <button
            type="button"
            onClick={() => setImporting(true)}
            className="text-[12px] font-semibold text-[color:var(--fg-subtle)] transition-colors hover:text-[color:var(--fg-strong)]"
          >
            {t('importAnother')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setImporting(true)}
          className="mt-4 inline-flex items-center gap-2 rounded-full border border-[color:var(--accent)] px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.16em] text-[color:var(--accent)] transition-colors hover:bg-[color:var(--accent-subtle)]"
        >
          <ArrowUpRight className="size-3.5" aria-hidden />
          {t('cta')}
        </button>
      )}
      {importing && (
        <SkillImportModal
          onClose={() => setImporting(false)}
          onImported={(result) => {
            setImporting(false);
            setImported(result);
          }}
        />
      )}
    </div>
  );
}

function Recommendations({
  businessCase,
  plugins,
  catalogAvailable,
}: {
  businessCase: BusinessCase;
  plugins: Plugin[];
  catalogAvailable: boolean;
}): React.ReactElement {
  const t = useTranslations('dashboard.onboarding');
  const caseName = t(`cases.${businessCase.id}.name`);
  // Only render categories this case actually recommends — no dead "empty
  // category" placeholders.
  const categories = PLUGIN_CATEGORIES.filter((category) =>
    businessCase.plugins.some((p) => p.category === category),
  );

  return (
    <div className="mt-2">
      {/* Step framing (number, title, back-to-case) belongs to `StepShell` and
          step 2 now; this component is just the recommendation list. */}
      <p className="text-sm text-[color:var(--fg-muted)]">
        {t('recommend.subtitle')}
      </p>

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
