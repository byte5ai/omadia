'use client';

/**
 * Epic #470 C16 (#817) — the presentational half of the consent surface.
 *
 * ONE component renders the grants in the install wizard and in the
 * plugin-detail panel, because they must not be able to disagree. Two
 * renderings of "what does this plugin want and what did I say?" would
 * eventually describe the same manifest differently, and the operator would
 * have to work out which one is lying.
 *
 * Everything here is display + local checkbox state. The write, the
 * re-activation and the resulting install state belong to the two callers.
 *
 * Lume: text and edge colours only, no filled state blocks, no spinners.
 */

import { Database, Globe, Puzzle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { PluginGrantsView } from '../../_lib/api';

export interface GrantSelection {
  /** Undefined when the manifest declares no `permissions.sql` — there is
   *  nothing to say yes to, so there is no checkbox and no key in the PUT. */
  sql?: boolean;
  /** The prefixes currently ticked. Sent as the COMPLETE consented set. */
  publicPaths: string[];
}

export function initialSelection(
  view: PluginGrantsView,
  mode: 'declared' | 'granted',
): GrantSelection {
  // The wizard defaults every box ON (`declared`): the operator is being asked
  // the manifest's question and the manifest asked for all of it. The panel
  // starts from what is actually granted, because there the boxes describe
  // reality rather than a proposal.
  const paths =
    mode === 'declared' ? view.declared.public_paths : view.granted.public_paths;
  return {
    ...(view.declared.sql
      ? { sql: mode === 'declared' ? true : view.granted.sql }
      : {}),
    publicPaths: [...paths],
  };
}

interface GrantChecklistProps {
  view: PluginGrantsView;
  selection: GrantSelection;
  onChange: (next: GrantSelection) => void;
  disabled?: boolean;
  /** Panel mode adds "granted / not granted" to each row. In the wizard
   *  nothing is granted yet, so the label would be noise on every line. */
  showCurrent?: boolean;
}

export function GrantChecklist({
  view,
  selection,
  onChange,
  disabled = false,
  showCurrent = false,
}: GrantChecklistProps): React.ReactElement {
  const t = useTranslations('store.grants');
  const declaredSql = view.declared.sql;

  return (
    <div className="flex flex-col gap-3">
      {declaredSql ? (
        <label
          className="flex cursor-pointer items-start gap-3 rounded-md border border-[color:var(--rule)] p-3"
          data-testid="grant-sql"
        >
          <input
            type="checkbox"
            className="mt-1"
            checked={selection.sql === true}
            disabled={disabled}
            aria-label={t('sqlTitle')}
            onChange={(e) => {
              onChange({ ...selection, sql: e.target.checked });
            }}
          />
          <span className="flex flex-col gap-1">
            <span className="flex items-center gap-2 text-[14px] font-semibold text-[color:var(--fg-strong)]">
              <Database className="size-4 shrink-0" aria-hidden />
              {t('sqlTitle')}
            </span>
            <span className="text-[12px] text-[color:var(--fg-muted)]">
              {t('sqlBody')}
            </span>
            <span className="font-mono-num text-[11px] text-[color:var(--fg-subtle)]">
              {t('sqlLedger', { ledger: declaredSql.ledger })}
            </span>
            {/* A grant on record for a table the manifest no longer declares.
                Not the same as "not granted", and it needs a different fix —
                so it gets its own line instead of an unticked box. */}
            {view.granted.sql_ledger !== null &&
            view.granted.sql_ledger !== declaredSql.ledger ? (
              <span className="text-[11px] text-[color:var(--danger)]">
                {t('sqlLedgerDrift', { ledger: view.granted.sql_ledger })}
              </span>
            ) : null}
            {showCurrent ? (
              <span className="text-[11px] text-[color:var(--fg-subtle)]">
                {view.granted.sql ? t('currentGranted') : t('currentNotGranted')}
              </span>
            ) : null}
          </span>
        </label>
      ) : null}

      {view.declared.public_paths.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-2 text-[12px] text-[color:var(--fg-muted)]">
            <Globe className="size-4 shrink-0" aria-hidden />
            {t('publicPathsIntro')}
          </p>
          {view.declared.public_paths.map((path) => {
            const checked = selection.publicPaths.includes(path);
            return (
              <label
                key={path}
                className="flex cursor-pointer items-start gap-3 rounded-md border border-[color:var(--rule)] p-3"
                data-testid={`grant-path-${path}`}
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={checked}
                  disabled={disabled}
                  aria-label={path}
                  onChange={(e) => {
                    onChange({
                      ...selection,
                      publicPaths: e.target.checked
                        ? [...selection.publicPaths, path]
                        : selection.publicPaths.filter((p) => p !== path),
                    });
                  }}
                />
                <span className="flex flex-col gap-1">
                  <span className="font-mono-num text-[13px] font-semibold text-[color:var(--fg-strong)]">
                    {path}
                  </span>
                  <span className="text-[12px] text-[color:var(--fg-muted)]">
                    {t('publicPathBody')}
                  </span>
                  {showCurrent ? (
                    <span className="text-[11px] text-[color:var(--fg-subtle)]">
                      {view.granted.public_paths.includes(path)
                        ? t('currentGranted')
                        : t('currentNotGranted')}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      ) : null}

      {/* Consent the operator gave to a prefix the manifest no longer asks for.
          It routes nothing today — only GRANTED ∩ DECLARED is served — but a
          row nobody can see is a row nobody will ever clear. */}
      {view.orphaned_public_paths.length > 0 ? (
        <p className="text-[11px] text-[color:var(--fg-subtle)]">
          {t('orphaned', { paths: view.orphaned_public_paths.join(', ') })}
        </p>
      ) : null}

      {/* Optional prerequisites. NOT grants and never checkboxes — nothing here
          is the operator's to consent to. They are listed because "the plugin
          works without them, but with less" is exactly what an operator wants
          to know while deciding how much to hand over. */}
      {view.declared.optional_requires.length > 0 ? (
        <div className="flex flex-col gap-1 border-t border-[color:var(--divider)] pt-3">
          <p className="flex items-center gap-2 text-[12px] text-[color:var(--fg-muted)]">
            <Puzzle className="size-4 shrink-0" aria-hidden />
            {t('optionalRequiresIntro')}
          </p>
          <ul className="ml-6 list-disc">
            {view.declared.optional_requires.map((cap) => (
              <li
                key={cap}
                className="font-mono-num text-[11px] text-[color:var(--fg-subtle)]"
              >
                {cap}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** The resulting install state, in the operator's language. Shared so the
 *  wizard and the panel cannot describe the same `state` differently. */
export function GrantState({
  view,
}: {
  view: PluginGrantsView;
}): React.ReactElement {
  const t = useTranslations('store.grants');
  const tone =
    view.state === 'active'
      ? 'text-[color:var(--accent)]'
      : 'text-[color:var(--danger)]';
  return (
    <div className="flex flex-col gap-1 text-[12px]">
      <span className={tone}>{t(`state.${view.state}`)}</span>
      {view.state !== 'active' && view.last_activation_error ? (
        // The middleware's own sentence, which since C16 names the missing
        // grant AND where to fix it. Secondary, never the headline — the
        // headline is the localized state line above.
        <span className="text-[color:var(--fg-muted)]">
          {view.last_activation_error}
        </span>
      ) : null}
    </div>
  );
}
