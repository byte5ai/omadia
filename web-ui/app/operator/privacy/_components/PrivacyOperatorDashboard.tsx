'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  runOperatorPrivacyLiveTest,
  setOperatorPrivacyOverrides,
  type OperatorPrivacyState,
  type PrivacyLiveTestResponse,
} from '../../../_lib/api';

interface DashboardProps {
  readonly initialState: OperatorPrivacyState;
}

/**
 * v0.2.0 dashboard. Four sections; the fifth (Recent-Hits-Audit) is
 * deferred to v0.2.x. The component is fully client-side for
 * interactivity; the initial state is fetched server-side and passed
 * in to keep the first paint hydrated.
 */
export function PrivacyOperatorDashboard({
  initialState,
}: DashboardProps): React.ReactElement {
  const [state, setState] = useState(initialState);
  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
      <ConfigOverviewCard state={state} />
      <TenantSelfCard terms={state.allowlist.tenantSelf} />
      <RepoDefaultCard terms={state.allowlist.repoDefault} />
      <OperatorOverrideCard
        terms={state.allowlist.operatorOverride}
        persistsAcrossRestart={state.overridePersistsAcrossRestart}
        onSaved={(allowlist) => {
          setState((prev) => ({ ...prev, allowlist }));
        }}
      />
      <div className="lg:col-span-2">
        <LiveTestCard />
      </div>
      <div className="lg:col-span-2">
        <RecentHitsAuditPlaceholder />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section helpers
// ---------------------------------------------------------------------------

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <article className="rounded-[18px] border border-[color:var(--divider)] bg-[color:var(--bg-elevated)] p-6">
      <header>
        <h2 className="text-[18px] font-semibold text-[color:var(--fg-strong)]">
          {title}
        </h2>
        {subtitle ? (
          <p className="mt-1 text-[13px] text-[color:var(--fg-muted)]">{subtitle}</p>
        ) : null}
      </header>
      <div className="mt-4">{children}</div>
    </article>
  );
}

function ConfigOverviewCard({
  state,
}: {
  state: OperatorPrivacyState;
}): React.ReactElement {
  const t = useTranslations('privacyOperator');
  return (
    <Card title={t('configTitle')} subtitle={t('configSubtitle')}>
      <dl className="grid grid-cols-2 gap-y-3 text-[14px]">
        <dt className="text-[color:var(--fg-muted)]">{t('configEgress')}</dt>
        <dd className="font-mono text-[color:var(--fg)]">
          {state.egress.enabled ? `${state.egress.mode}` : t('configOff')}
        </dd>
        <dt className="text-[color:var(--fg-muted)]">{t('configDetectors')}</dt>
        <dd className="font-mono text-[color:var(--fg)]">
          {state.detectors.length > 0 ? state.detectors.join(', ') : '—'}
        </dd>
        <dt className="text-[color:var(--fg-muted)]">{t('configAllowlistSize')}</dt>
        <dd className="font-mono text-[color:var(--fg)]">
          {state.allowlist.tenantSelf.length} ·{' '}
          {state.allowlist.repoDefault.length} ·{' '}
          {state.allowlist.operatorOverride.length}
        </dd>
      </dl>
      {state.egress.enabled && state.egress.mode === 'block' ? (
        <p className="mt-4 rounded-md border border-[color:var(--divider)] bg-[color:var(--bg)] p-3 text-[12px] text-[color:var(--fg-muted)]">
          {t('configBlockPlaceholder')}{' '}
          <span className="italic">&ldquo;{state.egress.blockPlaceholderText}&rdquo;</span>
        </p>
      ) : null}
    </Card>
  );
}

function TermList({
  terms,
  empty,
}: {
  terms: readonly string[];
  empty: string;
}): React.ReactElement {
  if (terms.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-[color:var(--divider)] p-3 text-[13px] text-[color:var(--fg-muted)]">
        {empty}
      </p>
    );
  }
  return (
    <ul className="flex flex-wrap gap-2">
      {terms.map((term, i) => (
        <li
          key={`${term}-${String(i)}`}
          className="rounded-full border border-[color:var(--divider)] bg-[color:var(--bg)] px-3 py-1 text-[12px] font-mono text-[color:var(--fg)]"
        >
          {term}
        </li>
      ))}
    </ul>
  );
}

function TenantSelfCard({
  terms,
}: {
  terms: readonly string[];
}): React.ReactElement {
  const t = useTranslations('privacyOperator');
  return (
    <Card title={t('tenantSelfTitle')} subtitle={t('tenantSelfSubtitle')}>
      <TermList terms={terms} empty={t('tenantSelfEmpty')} />
      <p className="mt-4 text-[12px] text-[color:var(--fg-subtle)]">
        {t('tenantSelfFooter')}
      </p>
    </Card>
  );
}

function RepoDefaultCard({
  terms,
}: {
  terms: readonly string[];
}): React.ReactElement {
  const t = useTranslations('privacyOperator');
  const [filter, setFilter] = useState('');
  const filtered = useMemo(() => {
    if (filter.trim().length === 0) return terms;
    const needle = filter.trim().toLowerCase();
    return terms.filter((term) => term.toLowerCase().includes(needle));
  }, [terms, filter]);
  return (
    <Card title={t('repoDefaultTitle')} subtitle={t('repoDefaultSubtitle')}>
      <input
        type="search"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
        }}
        placeholder={t('repoDefaultFilterPlaceholder')}
        className="mb-3 w-full rounded-md border border-[color:var(--divider)] bg-[color:var(--bg)] px-3 py-2 text-[14px] text-[color:var(--fg)]"
      />
      <div className="max-h-72 overflow-y-auto">
        <TermList terms={filtered} empty={t('repoDefaultEmptyFiltered')} />
      </div>
      <p className="mt-3 text-[12px] text-[color:var(--fg-subtle)]">
        {t('repoDefaultCount', { count: terms.length })}
      </p>
    </Card>
  );
}

function OperatorOverrideCard({
  terms,
  persistsAcrossRestart,
  onSaved,
}: {
  terms: readonly string[];
  persistsAcrossRestart: boolean;
  onSaved: (allowlist: OperatorPrivacyState['allowlist']) => void;
}): React.ReactElement {
  const t = useTranslations('privacyOperator');
  const [draft, setDraft] = useState(terms.join('\n'));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const parsed = draft
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const resp = await setOperatorPrivacyOverrides(parsed);
      onSaved(resp.allowlist);
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft, onSaved]);

  return (
    <Card title={t('overrideTitle')} subtitle={t('overrideSubtitle')}>
      {!persistsAcrossRestart ? (
        <p className="mb-3 rounded-md border border-[color:var(--divider)] bg-[color:var(--bg)] p-3 text-[12px] text-[color:var(--accent-warning,#cc6600)]">
          {t('overrideRuntimeOnly')}
        </p>
      ) : null}
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        rows={8}
        spellCheck={false}
        className="w-full rounded-md border border-[color:var(--divider)] bg-[color:var(--bg)] p-3 font-mono text-[13px] text-[color:var(--fg)]"
        placeholder={t('overridePlaceholder')}
      />
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            void handleSave();
          }}
          disabled={saving}
          className="rounded-md border border-[color:var(--accent)] bg-[color:var(--accent)] px-4 py-2 text-[13px] font-semibold uppercase tracking-[0.16em] text-[color:var(--bg)] transition disabled:opacity-50"
        >
          {saving ? t('overrideSaving') : t('overrideSave')}
        </button>
        {savedAt && !saving ? (
          <span className="text-[12px] text-[color:var(--fg-muted)]">
            {t('overrideSavedAt', {
              time: new Date(savedAt).toLocaleTimeString(),
            })}
          </span>
        ) : null}
        {saveError ? (
          <span className="text-[12px] text-[color:var(--accent-warning,#cc6600)]">
            {saveError}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

function LiveTestCard(): React.ReactElement {
  const t = useTranslations('privacyOperator');
  const [text, setText] = useState('');
  const [result, setResult] = useState<PrivacyLiveTestResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRun = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await runOperatorPrivacyLiveTest(text);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [text]);

  return (
    <Card title={t('liveTestTitle')} subtitle={t('liveTestSubtitle')}>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
        rows={4}
        spellCheck={false}
        className="w-full rounded-md border border-[color:var(--divider)] bg-[color:var(--bg)] p-3 font-mono text-[13px] text-[color:var(--fg)]"
        placeholder={t('liveTestPlaceholder')}
      />
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            void handleRun();
          }}
          disabled={running || text.trim().length === 0}
          className="rounded-md border border-[color:var(--accent)] bg-[color:var(--accent)] px-4 py-2 text-[13px] font-semibold uppercase tracking-[0.16em] text-[color:var(--bg)] transition disabled:opacity-50"
        >
          {running ? t('liveTestRunning') : t('liveTestRun')}
        </button>
        {error ? (
          <span className="text-[12px] text-[color:var(--accent-warning,#cc6600)]">
            {error}
          </span>
        ) : null}
      </div>

      {result ? (
        <div className="mt-6 space-y-4">
          <div>
            <h3 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-[color:var(--fg-muted)]">
              {t('liveTestTokenised')}
            </h3>
            <pre className="mt-2 whitespace-pre-wrap break-words rounded-md border border-[color:var(--divider)] bg-[color:var(--bg)] p-3 font-mono text-[12px] text-[color:var(--fg)]">
              {result.tokenized}
            </pre>
          </div>
          <div>
            <h3 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-[color:var(--fg-muted)]">
              {t('liveTestDetectorHits', { count: result.detectorHits.length })}
            </h3>
            {result.detectorHits.length === 0 ? (
              <p className="mt-2 text-[12px] text-[color:var(--fg-muted)]">
                {t('liveTestNoDetectorHits')}
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {result.detectorHits.map((hit, i) => (
                  <li
                    key={`${hit.value}-${String(i)}`}
                    className="rounded-md border border-[color:var(--divider)] bg-[color:var(--bg)] p-2 font-mono text-[12px]"
                  >
                    <span className="text-[color:var(--accent)]">{hit.type}</span>
                    {' · '}
                    <span className="text-[color:var(--fg)]">&ldquo;{hit.value}&rdquo;</span>
                    {' · '}
                    <span className="text-[color:var(--fg-muted)]">{hit.action}</span>
                    {' · '}
                    <span className="text-[color:var(--fg-subtle)]">
                      {hit.detector} · {hit.confidence.toFixed(2)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-[color:var(--fg-muted)]">
              {t('liveTestAllowlistMatches', {
                count: result.allowlistMatches.length,
              })}
            </h3>
            {result.allowlistMatches.length === 0 ? (
              <p className="mt-2 text-[12px] text-[color:var(--fg-muted)]">
                {t('liveTestNoAllowlistMatches')}
              </p>
            ) : (
              <ul className="mt-2 flex flex-wrap gap-2">
                {result.allowlistMatches.map((m, i) => (
                  <li
                    key={`${m.term}-${String(i)}`}
                    className="rounded-full border border-[color:var(--divider)] bg-[color:var(--bg)] px-3 py-1 font-mono text-[12px]"
                  >
                    <span className="text-[color:var(--accent)]">{m.source}</span>
                    {' · '}
                    <span className="text-[color:var(--fg)]">{m.term}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function RecentHitsAuditPlaceholder(): React.ReactElement {
  const t = useTranslations('privacyOperator');
  return (
    <Card title={t('auditTitle')} subtitle={t('auditSubtitle')}>
      <div className="rounded-md border border-dashed border-[color:var(--divider)] p-6 text-center text-[13px] text-[color:var(--fg-muted)]">
        {t('auditDeferred')}
      </div>
    </Card>
  );
}
