'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  deleteSkill,
  getSkill,
  listSkills,
  type SkillDetail,
  type SkillNode,
} from '../../../_lib/agentBuilder';
import { SkillEditor } from '../../../_components/admin/SkillEditor';
import { SkillImportModal } from '../../../_components/admin/SkillImportModal';

/**
 * The central skills registry: list + search on the left, the shared skill
 * editor on the right, plus import / export / delete and a "used by N agents"
 * readout. One editor everywhere — the same <SkillEditor> the node-graph
 * inspector uses.
 */
export function SkillsDashboard({ initial }: { initial: SkillNode[] }): React.ReactElement {
  const t = useTranslations('skills');
  const [skills, setSkills] = useState<SkillNode[]>(initial);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SkillNode | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const refresh = useCallback(async () => {
    setSkills((await listSkills()).skills);
  }, []);

  const select = useCallback(async (skill: SkillNode) => {
    setSelected(skill);
    setDetail(null);
    setConfirmingDelete(false);
    try {
      setDetail(await getSkill(skill.id));
    } catch {
      /* used-by readout is best-effort */
    }
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((s) =>
      `${s.name} ${s.slug} ${s.description ?? ''}`.toLowerCase().includes(q),
    );
  }, [skills, query]);

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
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <section className="flex flex-col gap-3">
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('search')}
            className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--bg-soft)] px-3 py-2 text-sm"
          />
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
                  <span className="shrink-0 rounded-full border border-[color:var(--border)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[color:var(--fg-muted)]">
                    {t(`source.${s.source}`)}
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
              </div>
              <button
                type="button"
                onClick={() => {
                  if ((detail?.usedByCount ?? 0) > 0) setConfirmingDelete(true);
                  else void onDelete(selected.id);
                }}
                className="shrink-0 rounded-md border border-[color:var(--danger-edge)] px-3 py-1.5 text-sm text-[color:var(--danger)]"
              >
                {t('delete')}
              </button>
            </div>
            {confirmingDelete && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 px-3 py-2 text-xs text-[color:var(--danger)]">
                <span>{t('confirmDelete', { count: detail?.usedByCount ?? 0 })}</span>
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
