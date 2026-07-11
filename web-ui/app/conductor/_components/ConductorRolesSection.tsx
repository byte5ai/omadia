'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/app/_components/ui/Button';
import { ApiError, assignRoleHolder, createConductorRole, type ConductorRole } from '@/app/_lib/api';

/**
 * Roles & the baton (US6) — split out of conductor/page.tsx to keep the page
 * within the repo's 500-line rule. Owns the create/assign input state; list
 * data and error surfacing stay with the page (errors render in the page's
 * existing load-error slot, unchanged).
 */
export function ConductorRolesSection({
  roles,
  onChanged,
  onError,
}: {
  roles: ConductorRole[];
  /** refetch the page's lists after a successful mutation. */
  onChanged: () => void;
  /** route failures into the page's load-error display (behavior-preserving). */
  onError: (message: string) => void;
}): React.JSX.Element {
  const t = useTranslations('conductor');
  const [newRoleKey, setNewRoleKey] = useState('');
  const [newRoleLabel, setNewRoleLabel] = useState('');
  const [holderInputs, setHolderInputs] = useState<Record<string, string>>({});

  const handleCreateRole = useCallback(async () => {
    if (!newRoleKey || !newRoleLabel) return;
    try {
      await createConductorRole(newRoleKey, newRoleLabel);
      setNewRoleKey('');
      setNewRoleLabel('');
      onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : String(err));
    }
  }, [newRoleKey, newRoleLabel, onChanged, onError]);

  const handleAssign = useCallback(
    async (key: string, action: 'add' | 'remove', holderId: string) => {
      if (!holderId) return;
      try {
        await assignRoleHolder(key, holderId, action);
        setHolderInputs((m) => ({ ...m, [key]: '' }));
        onChanged();
      } catch (err) {
        onError(err instanceof ApiError ? err.message : String(err));
      }
    },
    [onChanged, onError],
  );

  const card = 'rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-4';

  return (
    <section className="mb-10">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
        {t('rolesHeading')}
      </h2>
      <p className="mb-4 max-w-2xl text-[13px] text-[color:var(--fg-muted)]">{t('rolesHint')}</p>
      <div className="grid gap-3">
        {roles.map((role) => (
          <div key={role.key} className={card}>
            <div className="text-[15px] text-[color:var(--fg-strong)]">
              {role.label} <span className="font-mono text-[12px] text-[color:var(--fg-muted)]">{role.key}</span>
            </div>
            <div className="font-mono text-[12px] text-[color:var(--fg-muted)]">
              {t('holdersLabel')}: {role.holders.length ? role.holders.join(', ') : '—'}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1 text-[13px] text-[color:var(--fg-strong)]"
                placeholder="holder@email"
                value={holderInputs[role.key] ?? ''}
                onChange={(e) => setHolderInputs((m) => ({ ...m, [role.key]: e.target.value }))}
              />
              <Button variant="primary" onClick={() => void handleAssign(role.key, 'add', holderInputs[role.key] ?? '')}>
                {t('assignButton')}
              </Button>
              {role.holders.map((h) => (
                <button
                  key={h}
                  className="rounded-md border border-[color:var(--border)] px-2 py-1 font-mono text-[11px] text-[color:var(--fg-muted)]"
                  onClick={() => void handleAssign(role.key, 'remove', h)}
                >
                  ✕ {h}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className={`${card} flex flex-wrap items-end gap-2`}>
          <input
            className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1 font-mono text-[13px] text-[color:var(--fg-strong)]"
            placeholder="approver.release"
            value={newRoleKey}
            onChange={(e) => setNewRoleKey(e.target.value)}
          />
          <input
            className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1 text-[13px] text-[color:var(--fg-strong)]"
            placeholder="Release approver"
            value={newRoleLabel}
            onChange={(e) => setNewRoleLabel(e.target.value)}
          />
          <Button variant="ghost" onClick={() => void handleCreateRole()}>
            {t('createRoleButton')}
          </Button>
        </div>
      </div>
    </section>
  );
}
