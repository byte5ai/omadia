'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  deleteSkill,
  getSkill,
  listSkills,
  listSkillResources,
  type SkillDetail,
  type SkillNode,
  type SkillResource,
  type SkillVerdictSeverity,
} from '../../_lib/agentBuilder';
import { SkillEditor } from './SkillEditor';
import { SkillImportModal } from './SkillImportModal';
import { SKILL_VERDICT_LABEL_KEY, SkillVerdictBadge } from './SkillVerdictBadge';

const VERDICT_FILTER_VALUES: readonly SkillVerdictSeverity[] = [
  'high_risk',
  'flagged',
  'no_signals',
  'not_yet_scanned',
  'scan_failed',
  'too_large_to_scan',
  'pending',
];

/**
 * The central skills registry, reused wherever skills are managed (the Operator
 * screen and the conversational Builder's Skills tab): list + search, the shared
 * <SkillEditor>, import, export (via the editor), delete with a used-by-aware
 * confirm, and a "used by N agents" readout. Self-loading — pass `initial` for
 * an SSR first paint, or omit it and the component fetches on mount.
 */
export function SkillsRegistry({
  initial = [],
  showScopeHint = false,
}: {
  initial?: SkillNode[];
  /** Show a caption clarifying this manages the shared registry (builder tab). */
  showScopeHint?: boolean;
}): React.ReactElement {
  const t = useTranslations('skills');
  const [skills, setSkills] = useState<SkillNode[]>(initial);
  const [query, setQuery] = useState('');
  const [verdictFilter, setVerdictFilter] = useState<SkillVerdictSeverity | ''>('');
  const [selected, setSelected] = useState<SkillNode | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [resources, setResources] = useState<SkillResource[]>([]);
  const [importing, setImporting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const refresh = useCallback(async () => {
    setSkills((await listSkills()).skills);
  }, []);

  // Load on mount when no SSR list was provided (the builder tab). When
  // `initial` is present (the operator page SSRs a fresh list under
  // force-dynamic) we skip the redundant round-trip. The state update lives in
  // the async callback, guarded against a late resolve after unmount.
  useEffect(() => {
    if (initial.length > 0) return undefined;
    let active = true;
    void listSkills()
      .then((r) => {
        if (active) setSkills(r.skills);
      })
      .catch(() => {
        /* keep the initial list on failure */
      });
    return () => {
      active = false;
    };
  }, [initial.length]);

  const select = useCallback(async (skill: SkillNode) => {
    setSelected(skill);
    setDetail(null);
    setResources([]);
    setConfirmingDelete(false);
    try {
      setDetail(await getSkill(skill.id));
    } catch {
      /* used-by readout is best-effort */
    }
    try {
      setResources(await listSkillResources(skill.id));
    } catch {
      /* resources readout is best-effort */
    }
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills
      .filter((s) => !q || `${s.name} ${s.slug} ${s.description ?? ''}`.toLowerCase().includes(q))
      .filter((s) => !verdictFilter || (s.verdict?.severity ?? 'not_yet_scanned') === verdictFilter);
  }, [skills, query, verdictFilter]);

  const onDelete = useCallback(
    async (id: string) => {
      await deleteSkill(id);
      setConfirmingDelete(false);
      setSelected((cur) => (cur?.id === id ? null : cur));
      await refresh();
    },
    [refresh],
  );

  return (
    <div className="flex flex-col gap-3">
      {showScopeHint && (
        <p className="rounded-md bg-[color:var(--bg-soft)] px-3 py-2 text-xs text-[color:var(--fg-muted)]">
          {t('scopeHint')}
        </p>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <section className="flex flex-col gap-3">
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search')}
            className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg-soft)] px-3 py-2 text-sm"
          />
          <select
            value={verdictFilter}
            onChange={(e) => setVerdictFilter(e.target.value as SkillVerdictSeverity | '')}
            aria-label={t('verdict.filterLabel')}
            className="shrink-0 rounded-md border border-[color:var(--border)] bg-[color:var(--bg-soft)] px-2 py-2 text-sm"
          >
            <option value="">{t('verdict.filterAll')}</option>
            {VERDICT_FILTER_VALUES.map((v) => (
              <option key={v} value={v}>
                {t(`verdict.${SKILL_VERDICT_LABEL_KEY[v]}`)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setImporting(true)}
            className="shrink-0 rounded-md bg-[color:var(--accent)] px-3 py-2 text-sm text-white"
          >
            {t('import')}
          </button>
        </div>
        {filtered.length === 0 ? (
          <p className="text-sm text-[color:var(--fg-muted)]">{t('empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {filtered.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => void select(s)}
                  className={`flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm ${
                    selected?.id === s.id
                      ? 'border-[color:var(--accent)] bg-[color:var(--accent)]/5'
                      : 'border-[color:var(--border)] hover:border-[color:var(--accent)]'
                  }`}
                >
                  <span className="truncate text-[color:var(--fg-strong)]">{s.name}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <SkillVerdictBadge severity={s.verdict?.severity ?? 'not_yet_scanned'} />
                    <span className="rounded-full border border-[color:var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[color:var(--fg-muted)]">
                      {t(`source.${s.source}`)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
        {selected ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-mono text-xs text-[color:var(--fg-muted)]">{selected.slug}</div>
                {detail && (
                  <div className="text-xs text-[color:var(--fg-muted)]">
                    {t('usedBy', { count: detail.usedByCount })}
                  </div>
                )}
                {detail && detail.usedByAgentsCount > 0 && (
                  <div className="text-xs text-[color:var(--fg-muted)]">
                    {t('usedByPersona', { count: detail.usedByAgentsCount })}
                  </div>
                )}
                {resources.length > 0 && (
                  <div className="text-xs text-[color:var(--fg-muted)]">
                    {t('resources', { count: resources.length })}: {resources.map((r) => r.name).join(', ')}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  const totalUsedBy =
                    (detail?.usedByCount ?? 0) + (detail?.usedByAgentsCount ?? 0);
                  if (totalUsedBy > 0) setConfirmingDelete(true);
                  else void onDelete(selected.id);
                }}
                className="shrink-0 rounded-md border border-[color:var(--danger-edge)] px-3 py-1.5 text-sm text-[color:var(--danger)]"
              >
                {t('delete')}
              </button>
            </div>
            {confirmingDelete && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 px-3 py-2 text-xs text-[color:var(--danger)]">
                <span>
                  {t('confirmDelete', {
                    count: (detail?.usedByCount ?? 0) + (detail?.usedByAgentsCount ?? 0),
                  })}
                </span>
                <span className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => void onDelete(selected.id)}
                    className="rounded-md border border-[color:var(--danger-edge)] px-2 py-1"
                  >
                    {t('confirmDeleteAction')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(false)}
                    className="rounded-md border border-[color:var(--border)] px-2 py-1 text-[color:var(--fg-muted)]"
                  >
                    {t('cancel')}
                  </button>
                </span>
              </div>
            )}
            <SkillEditor
              key={selected.id}
              skill={selected}
              onSaved={(updated) => {
                void refresh();
                if (updated) void select(updated);
              }}
            />
          </div>
        ) : (
          <p className="text-sm text-[color:var(--fg-muted)]">{t('selectHint')}</p>
        )}
        </section>
      </div>

      {importing && (
        <SkillImportModal
          onClose={() => setImporting(false)}
          onImported={() => {
            setImporting(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
