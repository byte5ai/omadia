'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowRight } from 'lucide-react';

import {
  listAgentPluginCatalog,
  parseOperatorAgentErrorCode,
  replaceAgentPlugins,
  toggleAgentPlugin,
  type OperatorAgentDto,
  type PluginCatalogEntryDto,
} from '../../../../_lib/agents';
import { listBuilderDrafts } from '../../../../_lib/api';
import type { DraftSummary } from '../../../../_lib/builderTypes';
import { humanizeApiError } from '../../_components/AgentsDashboard';
import { PluginsDnd } from '../../_components/PluginsDnd';
import { AgentTeamsIdentity } from './AgentTeamsIdentity';
import { AgentTeamsInstalls } from './AgentTeamsInstalls';

/** Route of the native Agent Builder overview — the never-404 fallback. */
const BUILDER_INDEX_HREF = '/store/builder';

/**
 * Wave W2a — deep link from an orchestrator to the native Agent Builder.
 *
 * The builder route is keyed by a draft `[id]`, the operator page by an
 * orchestrator `slug`; there is no direct column joining the two. What DOES
 * join them is the published agent plugin: a builder draft pins the plugin
 * it published (`publishedAgentId`), and an orchestrator carries that same
 * plugin id in its assigned set. So: take the assigned plugins whose catalog
 * entry is `kind === 'agent'`, and look for a draft that published one of
 * them.
 *
 * Deliberately conservative — a deep link is only returned when exactly ONE
 * draft matches. Zero matches (an orchestrator with no builder-authored
 * agent) and ambiguous matches (several agent plugins, several drafts) both
 * fall back to the builder overview, which always exists. A guessed `[id]`
 * would 404, and picking one of several drafts would silently send the
 * operator to the wrong persona.
 */
export function resolveBuilderDraftId(
  agentPluginIds: ReadonlySet<string>,
  drafts: readonly DraftSummary[],
): string | null {
  if (agentPluginIds.size === 0) return null;
  const matches = drafts.filter(
    (d) => d.publishedAgentId !== null && agentPluginIds.has(d.publishedAgentId),
  );
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

interface AgentDetailProps {
  readonly agent: OperatorAgentDto;
  /** Fallback agents always run plugins with the global store config —
   *  surfaced as a notice and forwarded to PluginsDnd, which hides the
   *  per-agent config drawer and wipes overrides on save. */
  readonly isFallback: boolean;
}

/**
 * Issue #861 (epic #860) — per-agent plugin assignment, detail-page slice.
 *
 * Two write paths on purpose:
 *
 *  - The assigned-plugins list flips ONE plugin via
 *    `PATCH /v1/operator/agents/:slug/plugins` (`toggleAgentPlugin`) — the
 *    endpoint added so the UI does not have to PUT the whole set to flip
 *    one flag.
 *  - Attaching/detaching plugins and editing per-agent config reuses the
 *    dashboard's PluginsDnd editor unchanged (`replaceAgentPlugins`
 *    replace-set PUT) — spec says extend, not duplicate.
 *
 * After every successful write `router.refresh()` re-runs the parent RSC
 * fetch. PluginsDnd is remounted (reseeding its local state from fresh props)
 * only after ITS OWN save — see `editorRevision` — so an instant toggle above
 * never discards unsaved edits in the editor below.
 *
 * Error copy: the routes emit machine codes as `{ error: '<code>' }`.
 * `parseOperatorAgentErrorCode` narrows them and each code maps to a
 * `detailErrors.*` catalogue key; unknown failures render the localized
 * fallback sentence with the technical detail as an ICU argument — raw
 * bodies never reach the UI (web-ui i18n hard rule).
 *
 * Wave W2a adds ONE more thing and deliberately nothing else: a link to the
 * native Agent Builder. Persona, tone and behaviour are designed THERE
 * (PersonaPillar et al.); this page stays a capability-assignment surface —
 * no persona editor is duplicated here.
 */
export function AgentDetail(props: AgentDetailProps): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<PluginCatalogEntryDto[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  /**
   * Builder drafts, fetched best-effort ONLY to deep-link the builder CTA.
   * A rejection is swallowed into an empty list on purpose: the link must
   * still render (pointing at the builder overview), and this page's error
   * banner is reserved for failures of the writes it actually owns.
   */
  const [builderDrafts, setBuilderDrafts] = useState<readonly DraftSummary[]>(
    [],
  );
  /**
   * Remount key for PluginsDnd, bumped ONLY by the editor's own save path.
   *
   * The dashboard keys PluginsDnd on `pluginsRevisionKey(agent)` (a hash over
   * each plugin's id/enabled/config) because there the editor is the only
   * writer. Here the assigned-list checkbox is a SECOND writer that mutates
   * exactly the `enabled` bit such a hash includes — with a shared key, a
   * successful toggle would remount the editor and silently discard every
   * unsaved drag and config edit below it (W0c review). A counter the toggle
   * cannot touch keeps the two write paths decoupled: toggles leave the
   * editor's local state alone; the editor's own save still remounts it so it
   * reseeds from the fresh props (same contract as the dashboard).
   */
  const [editorRevision, setEditorRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listAgentPluginCatalog()
      .then((res) => {
        if (!cancelled) setCatalog(res.items);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setCatalogError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    listBuilderDrafts()
      .then((res) => {
        if (!cancelled) setBuilderDrafts(res.items);
      })
      .catch(() => {
        if (!cancelled) setBuilderDrafts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const catalogById = useMemo(() => {
    const m = new Map<string, PluginCatalogEntryDto>();
    for (const entry of catalog ?? []) m.set(entry.id, entry);
    return m;
  }, [catalog]);

  const assigned = useMemo(
    () =>
      [...props.agent.plugins].sort((a, b) => a.id.localeCompare(b.id)),
    [props.agent.plugins],
  );

  const builderDraftId = useMemo(() => {
    const agentPluginIds = new Set(
      props.agent.plugins
        .filter((p) => catalogById.get(p.id)?.kind === 'agent')
        .map((p) => p.id),
    );
    return resolveBuilderDraftId(agentPluginIds, builderDrafts);
  }, [builderDrafts, catalogById, props.agent.plugins]);

  const builderHref =
    builderDraftId !== null
      ? `${BUILDER_INDEX_HREF}/${encodeURIComponent(builderDraftId)}`
      : BUILDER_INDEX_HREF;

  const disabled = pending || busy !== null;

  function localizeError(err: unknown): string {
    const code = parseOperatorAgentErrorCode(err);
    return code !== null
      ? t(`detailErrors.${code}`)
      : t('detailErrors.unknown', { detail: humanizeApiError(err) });
  }

  function run(
    label: string,
    op: () => Promise<unknown>,
    opts?: { readonly remountEditor?: boolean },
  ): void {
    setError(null);
    setBusy(label);
    op()
      .then(() => {
        if (opts?.remountEditor) setEditorRevision((r) => r + 1);
        startTransition(() => router.refresh());
      })
      .catch((err: unknown) => {
        setError(localizeError(err));
      })
      .finally(() => setBusy(null));
  }

  return (
    <div className="space-y-8">
      {error && (
        <div
          role="alert"
          className="rounded border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 p-3 text-sm text-[color:var(--danger)]"
        >
          {error}
        </div>
      )}
      {catalogError && (
        <div className="rounded border border-[color:var(--warning)] bg-[color:var(--warning)]/10 p-3 text-sm text-[color:var(--warning)]">
          {t('catalogError', { message: catalogError })}
        </div>
      )}

      {/* Teams sections (epic #860, wave W2a). This component is the single
          composition point for them, so the sibling Teams units (config
          block, installs panel, builder link) extend one file instead of
          racing over the page shell. The assignment panel fetches its own
          read model by slug and disables what the platform cannot do, so it
          is safe to mount before an identity exists. */}
      <AgentTeamsIdentity slug={props.agent.slug} />
      <AgentTeamsInstalls slug={props.agent.slug} />

      <section className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4">
        <h2 className="mb-1 text-lg font-medium">{t('personaHeading')}</h2>
        <p className="mb-3 text-xs text-[color:var(--fg-muted)]">
          {t('personaHint')}
        </p>
        <Link
          href={builderHref}
          className="inline-flex items-center gap-2 rounded-md bg-[color:var(--accent)]/10 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[color:var(--accent)] transition-colors hover:bg-[color:var(--accent)] hover:text-[color:var(--fg-on-dark)]"
        >
          {t('personaOpenBuilder')}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
        {builderDraftId === null && (
          <p className="mt-2 text-xs text-[color:var(--fg-muted)]">
            {t('personaNoDraftHint')}
          </p>
        )}
      </section>

      <section className="rounded border border-[color:var(--border)] bg-[color:var(--bg-elevated)] p-4">
        <h2 className="mb-1 text-lg font-medium">
          {t('detailAssignedHeading')}
        </h2>
        <p className="mb-3 text-xs text-[color:var(--fg-muted)]">
          {t('detailAssignedHint')}
        </p>
        {assigned.length === 0 ? (
          <p className="text-sm text-[color:var(--fg-muted)]">
            {t('detailAssignedEmpty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {assigned.map((p) => {
              const entry = catalogById.get(p.id);
              const displayName = entry?.name ?? p.id;
              return (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center gap-2 rounded border border-[color:var(--border)] bg-[color:var(--bg-soft)]/40 px-3 py-2 text-sm"
                >
                  <span className="font-medium">{displayName}</span>
                  <code className="font-mono text-[10px] text-[color:var(--fg-muted)]">
                    {p.id}
                  </code>
                  <label className="ml-auto flex items-center gap-2 text-xs text-[color:var(--fg-muted)]">
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      disabled={disabled}
                      aria-label={t('detailToggleAria', {
                        plugin: displayName,
                      })}
                      onChange={() =>
                        run(`toggle:${p.id}`, () =>
                          toggleAgentPlugin(
                            props.agent.slug,
                            p.id,
                            !p.enabled,
                          ),
                        )
                      }
                    />
                    {t('enabledShort')}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        {props.isFallback && (
          <div className="mb-3 rounded border border-[color:var(--accent)] bg-[color:var(--accent)]/10 px-3 py-2 text-xs text-[color:var(--accent)]">
            {t('fallbackStoreOnlyNotice')}
          </div>
        )}
        {catalog ? (
          <PluginsDnd
            key={`${props.agent.id}:${editorRevision}`}
            agent={props.agent}
            catalog={catalog}
            isFallback={props.isFallback}
            disabled={disabled}
            onReplace={(plugins) =>
              run(
                'plugins',
                () => replaceAgentPlugins(props.agent.slug, plugins),
                { remountEditor: true },
              )
            }
          />
        ) : (
          !catalogError && (
            <p className="text-xs text-[color:var(--fg-muted)]">
              {t('catalogLoading')}
            </p>
          )
        )}
      </section>
    </div>
  );
}
