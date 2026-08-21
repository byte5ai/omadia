'use client';

/**
 * Epic #470 C16 (#817) — the plugin-detail Grants panel.
 *
 * Current versus declared, one toggle per grant, and the resulting install
 * state. This is where a grant skipped at install is granted later, where one
 * granted in haste is revoked, and — because the panel writes through the same
 * route as the wizard — where the two can never drift apart.
 *
 * The panel starts from what is ACTUALLY granted, not from what the manifest
 * asks for: here the boxes describe reality, and pre-ticking a box for a grant
 * the operator declined would misreport the system's state to the one person
 * who has to trust it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { ApiError, getPluginGrants, setPluginGrants } from '../../_lib/api';
import type { PluginGrantsView } from '../../_lib/api';
import { Button } from '../ui/Button';
import { ErrorHelp } from '../ErrorHelp';
import { GrantChecklist, GrantState, initialSelection } from './GrantChecklist';
import type { GrantSelection } from './GrantChecklist';

type Status =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; code: string | null; detail: unknown };

export function GrantsPanel({
  pluginId,
}: {
  pluginId: string;
}): React.ReactElement {
  const t = useTranslations('store.grants');
  const [view, setView] = useState<PluginGrantsView | null>(null);
  const [selection, setSelection] = useState<GrantSelection>({
    publicPaths: [],
  });
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await getPluginGrants(pluginId);
      setView(next);
      setSelection(initialSelection(next, 'granted'));
      setStatus({ kind: 'ready' });
    } catch (err) {
      setStatus({
        kind: 'error',
        code: err instanceof ApiError ? err.code : null,
        detail: err,
      });
    }
  }, [pluginId]);

  useEffect(() => {
    // Fetch-on-mount: load() touches state only after the awaited fetch —
    // no synchronous cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const save = useCallback(async (): Promise<void> => {
    if (!view) return;
    setStatus({ kind: 'saving' });
    try {
      const next = await setPluginGrants(pluginId, {
        ...(selection.sql === undefined ? {} : { sql: selection.sql }),
        // Omitted when the plugin has no public-path story at all: sending `[]`
        // would mean "revoke everything", which is a different statement from
        // "this plugin has none".
        //
        // NOT omitted when a grant is on record for a prefix the manifest no
        // longer declares. There `[]` is exactly the right statement, and it is
        // the only way the panel can honour what the `orphaned` line promises —
        // that applying this form clears them. A message that names a remedy the
        // UI cannot perform is the same class of lie C16 exists to remove.
        ...(view.declared.public_paths.length > 0 ||
        view.orphaned_public_paths.length > 0
          ? { public_paths: selection.publicPaths }
          : {}),
      });
      setView(next);
      setSelection(initialSelection(next, 'granted'));
      setStatus({ kind: 'saved' });
    } catch (err) {
      setStatus({
        kind: 'error',
        code: err instanceof ApiError ? err.code : null,
        detail: err,
      });
    }
  }, [pluginId, selection, view]);

  if (status.kind === 'loading') {
    return (
      <span className="inline-flex items-center gap-2 text-[12px] text-[color:var(--fg-muted)]">
        <span className="lume-busy-dots" aria-hidden /> {t('loading')}
      </span>
    );
  }

  if (!view) {
    return (
      <ErrorHelp
        code={status.kind === 'error' ? status.code : null}
        rawDetail={status.kind === 'error' ? status.detail : undefined}
        fallback={t('loadFailed')}
      />
    );
  }

  // Nothing to consent to. The line says so — and the checklist still renders
  // when the manifest declares optional prerequisites, because those are the
  // one thing left worth reading about a plugin that asks for no permissions.
  // Returning early on both would have hidden them exactly where they are the
  // whole content of the panel.
  // Orphaned consent is deliberately NOT part of this condition: a plugin that
  // declares nothing today but still has a grant on record has something for the
  // operator to DO, and the branch below has no Apply button to do it with.
  if (
    view.declared.sql === null &&
    view.declared.public_paths.length === 0 &&
    view.orphaned_public_paths.length === 0
  ) {
    return (
      <div className="flex flex-col gap-3" data-testid="grants-panel">
        <p className="text-[12px] text-[color:var(--fg-muted)]">
          {t('nothingDeclared')}
        </p>
        {view.declared.optional_requires.length > 0 ? (
          <GrantChecklist
            view={view}
            selection={selection}
            onChange={setSelection}
            disabled
            showCurrent
          />
        ) : null}
      </div>
    );
  }

  const busy = status.kind === 'saving';

  return (
    <div className="flex flex-col gap-4" data-testid="grants-panel">
      <GrantState view={view} />

      <GrantChecklist
        view={view}
        selection={selection}
        onChange={setSelection}
        disabled={busy}
        showCurrent
      />

      {status.kind === 'error' ? (
        <ErrorHelp
          code={status.code}
          rawDetail={status.detail}
          fallback={t('grantFailed')}
        />
      ) : null}

      <div className="flex items-center gap-4">
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={busy}
          busy={busy}
          busyLabel={t('saving')}
          onClick={() => void save()}
        >
          {t('apply')}
        </Button>
        {status.kind === 'saved' ? (
          <span className="text-[12px] text-[color:var(--accent)]">
            {t('saved')}
          </span>
        ) : null}
      </div>
    </div>
  );
}
