'use client';

/**
 * Epic #470 C16 (#817) — the install wizard's "Permissions" step.
 *
 * Shown after a successful configure, and ONLY when the manifest declares
 * `permissions.sql` and/or `permissions.public_paths`. A plugin that asks for
 * neither never sees this step, because a consent dialog with nothing to
 * consent to teaches operators to click through consent dialogs.
 *
 * WHY THE BOXES DEFAULT ON
 * ------------------------
 * The operator is answering the manifest's question, and the manifest asked for
 * all of it. Defaulting off would make the common, correct outcome — grant what
 * the plugin needs so it works — the one that takes the most clicks, and the
 * pre-C16 workaround (hand-INSERT the row later) the path of least resistance.
 * Every box is individually untickable and every grant is revocable afterwards
 * from the same panel; that is where the safety lives, not in a default that
 * makes the plugin arrive broken.
 *
 * WHY "SKIP" ASKS THE SERVER WHAT HAPPENED
 * ----------------------------------------
 * Skipping is a legitimate answer, and its consequence depends on the plugin.
 * One that reaches for the database in `activate()` comes back `errored`; one
 * that only declared a public path stays `active` with that prefix behind
 * `requireAuth`. Guessing either way would put a sentence on screen that is
 * false half the time, so Skip reads the state instead of asserting one.
 */

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { ApiError, getPluginGrants, setPluginGrants } from '../../_lib/api';
import type { PluginGrantsView } from '../../_lib/api';
import { Button } from '../ui/Button';
import { ErrorHelp } from '../ErrorHelp';
import { GrantChecklist, GrantState, initialSelection } from './GrantChecklist';
import type { GrantSelection } from './GrantChecklist';

/** True when this plugin asks for anything the operator has to answer. */
export function hasGrantsToAsk(view: PluginGrantsView): boolean {
  return view.declared.sql !== null || view.declared.public_paths.length > 0;
}

type Status =
  | { kind: 'asking' }
  | { kind: 'saving' }
  | { kind: 'done'; view: PluginGrantsView; skipped: boolean }
  | { kind: 'error'; code: string | null; detail: unknown };

export function PermissionsStep({
  grants: view,
  onFinish,
}: {
  grants: PluginGrantsView;
  /** Called when the operator closes the step. The caller refreshes. */
  onFinish: () => void;
}): React.ReactElement {
  const t = useTranslations('store.grants');
  const [selection, setSelection] = useState<GrantSelection>(() =>
    initialSelection(view, 'declared'),
  );
  const [status, setStatus] = useState<Status>({ kind: 'asking' });

  const grant = useCallback(async (): Promise<void> => {
    setStatus({ kind: 'saving' });
    try {
      const next = await setPluginGrants(view.id, {
        ...(selection.sql === undefined ? {} : { sql: selection.sql }),
        ...(view.declared.public_paths.length > 0
          ? { public_paths: selection.publicPaths }
          : {}),
      });
      setStatus({ kind: 'done', view: next, skipped: false });
    } catch (err) {
      setStatus({
        kind: 'error',
        code: err instanceof ApiError ? err.code : null,
        detail: err,
      });
    }
  }, [selection, view.declared.public_paths.length, view.id]);

  const skip = useCallback(async (): Promise<void> => {
    setStatus({ kind: 'saving' });
    try {
      const next = await getPluginGrants(view.id);
      setStatus({ kind: 'done', view: next, skipped: true });
    } catch (err) {
      setStatus({
        kind: 'error',
        code: err instanceof ApiError ? err.code : null,
        detail: err,
      });
    }
  }, [view.id]);

  if (status.kind === 'done') {
    return (
      <div className="flex flex-col gap-4" data-testid="permissions-result">
        <GrantState view={status.view} />
        {status.skipped ? (
          <p className="text-[12px] text-[color:var(--fg-muted)]">
            {t('skippedBody')}
          </p>
        ) : null}
        <div className="flex items-center gap-4">
          <Button type="button" variant="primary" size="sm" onClick={onFinish}>
            {t('close')}
          </Button>
          <Link
            href={`/store/${encodeURIComponent(view.id)}#grants`}
            className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[color:var(--fg-muted)] underline underline-offset-2 transition hover:opacity-80"
          >
            {t('openPanel')}
          </Link>
        </div>
      </div>
    );
  }

  const busy = status.kind === 'saving';

  return (
    <div className="flex flex-col gap-4" data-testid="permissions-step">
      <div className="flex flex-col gap-1">
        <h3 className="text-[14px] font-semibold text-[color:var(--fg-strong)]">
          {t('stepTitle')}
        </h3>
        <p className="text-[12px] text-[color:var(--fg-muted)]">
          {t('stepIntro')}
        </p>
      </div>

      <GrantChecklist
        view={view}
        selection={selection}
        onChange={setSelection}
        disabled={busy}
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
          onClick={() => void grant()}
        >
          {t('grantAndActivate')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void skip()}
        >
          {t('skip')}
        </Button>
      </div>
    </div>
  );
}
