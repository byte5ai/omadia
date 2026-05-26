'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { ChevronDown, ChevronRight } from 'lucide-react';

import { ApiError } from '../../../_lib/api';
import {
  createOperatorAgent,
  deleteOperatorAgent,
  drainAgentSessions,
  killAgentSessions,
  listAgentPluginCatalog,
  patchOperatorAgent,
  rehydrateFallback,
  replaceAgentBindings,
  replaceAgentPlugins,
  resolveAgentForChannel,
  setFallbackAgent,
  triggerAgentReload,
  type OperatorAgentDto,
  type OperatorAgentsListDto,
  type PluginCatalogEntryDto,
  type PrivacyProfile,
  type ResolveChannelResponse,
} from '../../../_lib/agents';

import { PluginsDnd } from './PluginsDnd';

interface AgentsDashboardProps {
  initial: OperatorAgentsListDto;
}

/**
 * Phase B operator dashboard.
 *
 * B3a — plugin multi-select with manifest metadata (multi_instance badge,
 *       memory-scope chips, kind badge) replaces the raw plugin-id textarea.
 * B3b — channel-binding form with type dropdown + routing tester.
 * B3c — per-(Agent × plugin) config editor rendered from `setup_fields`.
 * B3d — operator-facing "Reset fallback to all installed plugins" button.
 *
 * The catalog is fetched once on mount via `listAgentPluginCatalog()` and
 * shared across every AgentCard; we treat it as read-only for the lifetime
 * of the page render. A `router.refresh()` after writes re-fetches the
 * Agent list via the parent RSC; the catalog only refreshes when the
 * dashboard is unmounted/remounted.
 */
export function AgentsDashboard({
  initial,
}: AgentsDashboardProps): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<PluginCatalogEntryDto[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

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

  const fallbackSlug =
    initial.agents.find((a) => a.id === initial.fallback_agent_id)?.slug ??
    null;

  const channelTypes = useMemo(
    () =>
      Array.from(
        new Set(
          (catalog ?? [])
            .filter((p) => p.kind === 'channel')
            .map((p) => deriveChannelType(p.id)),
        ),
      ).sort(),
    [catalog],
  );

  function run(label: string, op: () => Promise<unknown>): void {
    setError(null);
    setBusy(label);
    op()
      .then(() => {
        startTransition(() => router.refresh());
      })
      .catch((err: unknown) => {
        setError(humanizeApiError(err));
      })
      .finally(() => setBusy(null));
  }

  return (
    <div className="space-y-10">
      {error && (
        <div className="rounded border border-red-400 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}
      {catalogError && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          {t('catalogError', { message: catalogError })}
        </div>
      )}

      <section className="rounded border border-neutral-200 bg-white p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">{t('platformHeading')}</h2>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-neutral-300 bg-neutral-50 px-3 py-1 text-xs hover:bg-neutral-100"
              disabled={pending || !!busy || !fallbackSlug}
              onClick={() => {
                if (!confirm(t('rehydrateConfirm'))) return;
                run('rehydrate', async () => {
                  const res = await rehydrateFallback();
                  setError(
                    t('rehydrateDone', {
                      attached: res.attached,
                      requested: res.requested,
                    }),
                  );
                });
              }}
              title={t('rehydrateTooltip')}
            >
              {t('actionRehydrateFallback')}
            </button>
            <button
              type="button"
              className="rounded border border-neutral-300 bg-neutral-50 px-3 py-1 text-xs hover:bg-neutral-100"
              disabled={pending || !!busy}
              onClick={() => run('reload', () => triggerAgentReload())}
            >
              {t('forceReload')}
            </button>
          </div>
        </div>
        <FallbackPicker
          agents={initial.agents}
          currentSlug={fallbackSlug}
          disabled={pending || !!busy}
          onChange={(slug) => run('fallback', () => setFallbackAgent(slug))}
        />
      </section>

      <RoutingTester
        channelTypes={channelTypes}
        disabled={pending || !!busy}
      />

      <CreateAgentForm
        disabled={pending || !!busy}
        onCreate={(input) => run('create', () => createOperatorAgent(input))}
      />

      <section className="space-y-4">
        <h2 className="text-lg font-medium">
          {t('agentsHeading')}{' '}
          <span className="text-sm font-normal text-neutral-500">
            ({initial.agents.length})
          </span>
        </h2>
        {initial.agents.length === 0 ? (
          <p className="text-sm text-neutral-500">{t('agentsEmpty')}</p>
        ) : (
          initial.agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              catalog={catalog}
              channelTypes={channelTypes}
              isFallback={agent.id === initial.fallback_agent_id}
              disabled={pending || !!busy}
              onPatch={(patch) =>
                run(`patch:${agent.slug}`, () =>
                  patchOperatorAgent(agent.slug, patch),
                )
              }
              onDelete={() =>
                run(`delete:${agent.slug}`, () =>
                  deleteOperatorAgent(agent.slug),
                )
              }
              onReplacePlugins={(plugins) =>
                run(`plugins:${agent.slug}`, () =>
                  replaceAgentPlugins(agent.slug, plugins),
                )
              }
              onReplaceBindings={(bindings) =>
                run(`bindings:${agent.slug}`, () =>
                  replaceAgentBindings(agent.slug, bindings),
                )
              }
              onDrain={() =>
                run(`drain:${agent.slug}`, () =>
                  drainAgentSessions(agent.slug),
                )
              }
              onKill={() =>
                run(`kill:${agent.slug}`, () => killAgentSessions(agent.slug))
              }
            />
          ))
        )}
      </section>
    </div>
  );
}

/**
 * Heuristic: derive the channel binding "type" string from a channel
 * plugin id. `de.byte5.channel.teams` → `teams`, `@omadia/channel-foo` →
 * `foo`. Operators bind by type-string in `channel_bindings`, not by
 * plugin id, so the dashboard does the mapping client-side. Unknown
 * formats fall back to the last segment.
 */
function deriveChannelType(pluginId: string): string {
  const match = pluginId.match(/(?:^|[./])channel[./]([a-z0-9_-]+)/i);
  if (match?.[1]) return match[1].toLowerCase();
  const last = pluginId.split(/[./]/).pop();
  return (last ?? pluginId).toLowerCase();
}

function FallbackPicker(props: {
  agents: OperatorAgentDto[];
  currentSlug: string | null;
  disabled: boolean;
  onChange: (slug: string | null) => void;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  return (
    <label className="flex items-center gap-3 text-sm">
      <span className="text-neutral-600">{t('fallbackLabel')}</span>
      <select
        className="rounded border border-neutral-300 bg-white px-2 py-1"
        value={props.currentSlug ?? ''}
        disabled={props.disabled}
        onChange={(e) =>
          props.onChange(e.target.value === '' ? null : e.target.value)
        }
      >
        <option value="">{t('fallbackNone')}</option>
        {props.agents
          .filter((a) => a.status === 'enabled')
          .map((a) => (
            <option key={a.slug} value={a.slug}>
              {a.slug}
            </option>
          ))}
      </select>
    </label>
  );
}

function RoutingTester(props: {
  channelTypes: readonly string[];
  disabled: boolean;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const [type, setType] = useState('');
  const [key, setKey] = useState('');
  const [result, setResult] = useState<ResolveChannelResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  function submit(): void {
    if (!type || !key) return;
    setRunning(true);
    setError(null);
    resolveAgentForChannel(type, key)
      .then((res) => setResult(res))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setRunning(false));
  }

  return (
    <section className="rounded border border-neutral-200 bg-white p-5">
      <h2 className="mb-1 text-lg font-medium">{t('routingTesterHeading')}</h2>
      <p className="mb-3 text-xs text-neutral-500">
        {t('routingTesterHelp')}
      </p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-neutral-500">
            {t('fieldChannelType')}
          </span>
          {props.channelTypes.length > 0 ? (
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="rounded border border-neutral-300 px-2 py-1 text-sm"
            >
              <option value="">—</option>
              {props.channelTypes.map((ct) => (
                <option key={ct} value={ct}>
                  {ct}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder="teams"
              className="rounded border border-neutral-300 px-2 py-1 text-sm"
            />
          )}
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-neutral-500">
            {t('fieldChannelKey')}
          </span>
          <input
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="28:bot-id-or-@username"
            className="rounded border border-neutral-300 px-2 py-1 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={props.disabled || running || !type || !key}
          className="rounded bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-800 disabled:opacity-40"
        >
          {running ? t('routingTesterRunning') : t('routingTesterSubmit')}
        </button>
      </form>
      {error && (
        <p className="mt-3 text-sm text-red-700">{error}</p>
      )}
      {result && (
        <div className="mt-3 rounded border border-neutral-200 bg-neutral-50 p-3 text-sm">
          {result.matched ? (
            <p>
              {t('routingTesterMatched', {
                slug: result.matched.slug,
                via: result.via,
              })}
            </p>
          ) : (
            <p className="text-neutral-600">
              {result.message ?? t('routingTesterNoMatch')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function CreateAgentForm(props: {
  disabled: boolean;
  onCreate: (input: {
    slug: string;
    name: string;
    description?: string;
    privacy_profile?: PrivacyProfile;
  }) => void;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [privacy, setPrivacy] = useState<PrivacyProfile>('default');

  return (
    <section className="rounded border border-neutral-200 bg-white p-5">
      <h2 className="mb-4 text-lg font-medium">{t('createHeading')}</h2>
      <form
        className="grid gap-4 lg:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!slug || !name) return;
          props.onCreate({
            slug,
            name,
            description: description || undefined,
            privacy_profile: privacy,
          });
          setSlug('');
          setName('');
          setDescription('');
          setPrivacy('default');
        }}
      >
        <Field label={t('fieldSlug')}>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            pattern="^[a-z0-9][a-z0-9-]*$"
            required
            className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
            placeholder="public"
          />
        </Field>
        <Field label={t('fieldName')}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
          />
        </Field>
        <Field label={t('fieldDescription')}>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
          />
        </Field>
        <Field label={t('fieldPrivacy')}>
          <select
            value={privacy}
            onChange={(e) => setPrivacy(e.target.value as PrivacyProfile)}
            className="w-full rounded border border-neutral-300 px-2 py-1 text-sm"
          >
            <option value="default">default</option>
            <option value="strict">strict</option>
          </select>
        </Field>
        <div className="lg:col-span-4">
          <button
            type="submit"
            disabled={props.disabled || !slug || !name}
            className="rounded bg-neutral-900 px-4 py-1.5 text-sm text-white hover:bg-neutral-800 disabled:opacity-40"
          >
            {t('createSubmit')}
          </button>
        </div>
      </form>
    </section>
  );
}

function AgentCard(props: {
  agent: OperatorAgentDto;
  catalog: PluginCatalogEntryDto[] | null;
  channelTypes: readonly string[];
  isFallback: boolean;
  disabled: boolean;
  onPatch: (patch: {
    name?: string;
    description?: string | null;
    privacy_profile?: PrivacyProfile;
    status?: 'enabled' | 'disabled';
  }) => void;
  onDelete: () => void;
  onReplacePlugins: (
    plugins: Array<{
      id: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    }>,
  ) => void;
  onReplaceBindings: (
    bindings: Array<{ channel_type: string; channel_key: string }>,
  ) => void;
  onDrain: () => void;
  onKill: () => void;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const { agent } = props;
  // Default-collapsed (per operator request): the page starts compact and
  // expands per-Agent only when the operator clicks the chevron. Local
  // state on each card; no global open-all (use the page's collapse-state
  // muscle memory + key=updated_at to re-render after server writes).
  const [expanded, setExpanded] = useState(false);

  const enabledPluginCount = agent.plugins.filter((p) => p.enabled).length;

  return (
    <article className="rounded border border-neutral-200 bg-white">
      <header className="flex items-start justify-between gap-4 px-5 py-3">
        <button
          type="button"
          className="flex flex-1 items-start gap-2 text-left"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span className="mt-0.5 text-neutral-500">
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
          <span className="flex-1">
            <span className="block text-base font-semibold">
              {agent.name}{' '}
              <span className="font-mono text-sm text-neutral-500">
                ({agent.slug})
              </span>
            </span>
            <span className="block text-xs text-neutral-500">
              {t('agentCardSummary', {
                privacy: agent.privacy_profile,
                status:
                  agent.status === 'enabled'
                    ? t('statusEnabled')
                    : t('statusDisabled'),
                runtime: agent.active
                  ? t('runtimeActive')
                  : t('runtimeInactive'),
                plugins: enabledPluginCount,
                bindings: agent.bindings.length,
              })}
            </span>
          </span>
        </button>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-neutral-300 bg-neutral-50 px-2 py-1 text-xs hover:bg-neutral-100"
              disabled={props.disabled}
              onClick={() =>
                props.onPatch({
                  status: agent.status === 'enabled' ? 'disabled' : 'enabled',
                })
              }
            >
              {agent.status === 'enabled'
                ? t('actionDisable')
                : t('actionEnable')}
            </button>
            <button
              type="button"
              className="rounded border border-neutral-300 bg-neutral-50 px-2 py-1 text-xs hover:bg-neutral-100"
              disabled={props.disabled}
              onClick={() =>
                props.onPatch({
                  privacy_profile:
                    agent.privacy_profile === 'strict' ? 'default' : 'strict',
                })
              }
            >
              {t('actionTogglePrivacy')}
            </button>
            <button
              type="button"
              className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800 hover:bg-red-100"
              disabled={props.disabled}
              onClick={() => {
                if (confirm(t('deleteConfirm', { slug: agent.slug })))
                  props.onDelete();
              }}
            >
              {t('actionDelete')}
            </button>
          </div>
        </div>
      </header>

      {expanded && (
        <div className="border-t border-neutral-200 px-5 py-4">
          {agent.description && (
            <p className="mb-4 text-sm text-neutral-700">{agent.description}</p>
          )}

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-xs text-neutral-500">{t('sessionsLabel')}</span>
            <button
              type="button"
              className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 hover:bg-amber-100"
              disabled={props.disabled}
              onClick={() => props.onDrain()}
              title={t('drainTooltip')}
            >
              {t('actionDrain')}
            </button>
            <button
              type="button"
              className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800 hover:bg-red-100"
              disabled={props.disabled}
              onClick={() => {
                if (confirm(t('killConfirm', { slug: agent.slug })))
                  props.onKill();
              }}
            >
              {t('actionKill')}
            </button>
          </div>

          <div className="mb-6">
            <h4 className="mb-2 text-sm font-medium">
              {t('memoryScopeHeading')}
            </h4>
            {agent.memory_scope.length === 0 ? (
              <p className="text-xs text-neutral-500">
                {t('memoryScopeEmpty')}
              </p>
            ) : (
              <ul className="flex flex-wrap gap-1 font-mono text-xs">
                {agent.memory_scope.map((s) => (
                  <li
                    key={s}
                    className="rounded bg-neutral-100 px-2 py-0.5 text-neutral-700"
                  >
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {props.isFallback && (
            <div className="mb-3 rounded border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
              {t('fallbackStoreOnlyNotice')}
            </div>
          )}
          {props.catalog ? (
            <PluginsDnd
              key={pluginsRevisionKey(agent)}
              agent={agent}
              catalog={props.catalog}
              isFallback={props.isFallback}
              disabled={props.disabled}
              onReplace={props.onReplacePlugins}
            />
          ) : (
            <p className="text-xs text-neutral-500">{t('catalogLoading')}</p>
          )}

          <BindingsEditor
            key={bindingsRevisionKey(agent)}
            agent={agent}
            channelTypes={props.channelTypes}
            disabled={props.disabled}
            onReplace={props.onReplaceBindings}
          />
        </div>
      )}
    </article>
  );
}


function BindingsEditor(props: {
  agent: OperatorAgentDto;
  channelTypes: readonly string[];
  disabled: boolean;
  onReplace: (
    bindings: Array<{ channel_type: string; channel_key: string }>,
  ) => void;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const [rows, setRows] = useState<Array<{ channel_type: string; channel_key: string }>>(
    () => props.agent.bindings.map((b) => ({ ...b })),
  );

  function update(
    idx: number,
    patch: Partial<{ channel_type: string; channel_key: string }>,
  ): void {
    setRows((prev) =>
      prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)),
    );
  }

  function add(): void {
    setRows((prev) => [
      ...prev,
      {
        channel_type: props.channelTypes[0] ?? '',
        channel_key: '',
      },
    ]);
  }

  function remove(idx: number): void {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  }

  function submit(): void {
    const cleaned = rows
      .map((r) => ({
        channel_type: r.channel_type.trim(),
        channel_key: r.channel_key.trim(),
      }))
      .filter((r) => r.channel_type && r.channel_key);
    props.onReplace(cleaned);
  }

  return (
    <div className="mt-6">
      <h4 className="mb-2 flex items-center justify-between text-sm font-medium">
        {t('bindingsHeading')}
        <span className="flex gap-2">
          <button
            type="button"
            className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs hover:bg-neutral-50"
            disabled={props.disabled}
            onClick={add}
          >
            {t('bindingsAdd')}
          </button>
          <button
            type="button"
            className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs hover:bg-neutral-50"
            disabled={props.disabled}
            onClick={submit}
          >
            {t('save')}
          </button>
        </span>
      </h4>
      {rows.length === 0 ? (
        <p className="text-xs text-neutral-500">{t('bindingsEmpty')}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row, idx) => (
            <li key={idx} className="flex items-center gap-2">
              {props.channelTypes.length > 0 ? (
                <select
                  value={row.channel_type}
                  disabled={props.disabled}
                  onChange={(e) =>
                    update(idx, { channel_type: e.target.value })
                  }
                  className="rounded border border-neutral-300 px-2 py-1 text-xs"
                >
                  {!props.channelTypes.includes(row.channel_type) && (
                    <option value={row.channel_type}>{row.channel_type}</option>
                  )}
                  {props.channelTypes.map((ct) => (
                    <option key={ct} value={ct}>
                      {ct}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={row.channel_type}
                  disabled={props.disabled}
                  onChange={(e) =>
                    update(idx, { channel_type: e.target.value })
                  }
                  className="w-28 rounded border border-neutral-300 px-2 py-1 text-xs"
                  placeholder="teams"
                />
              )}
              <input
                type="text"
                value={row.channel_key}
                disabled={props.disabled}
                onChange={(e) =>
                  update(idx, { channel_key: e.target.value })
                }
                className="flex-1 rounded border border-neutral-300 px-2 py-1 font-mono text-xs"
                placeholder="28:bot-id-or-@username"
              />
              <button
                type="button"
                className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800 hover:bg-red-100"
                disabled={props.disabled}
                onClick={() => remove(idx)}
              >
                {t('bindingsRemove')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field(props: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-neutral-500">
        {props.label}
      </span>
      {props.children}
    </label>
  );
}

/**
 * `agents.updated_at` only bumps on the agents row, not on plugin / binding
 * writes — so the prior `key={updated_at}` did not remount the editor after
 * a save, leaving local state stale. Hash the actual payload instead so a
 * `replaceAgentPlugins` write that produces new server state remounts the
 * editor and reseeds local state from props.
 */
function pluginsRevisionKey(agent: OperatorAgentDto): string {
  const sig = agent.plugins
    .map(
      (p) =>
        `${p.id}|${p.enabled ? 1 : 0}|${JSON.stringify(p.config ?? {})}`,
    )
    .sort()
    .join('::');
  return `plugins:${agent.id}:${sig}`;
}

function bindingsRevisionKey(agent: OperatorAgentDto): string {
  const sig = agent.bindings
    .map((b) => `${b.channel_type}|${b.channel_key}`)
    .sort()
    .join('::');
  return `bindings:${agent.id}:${sig}`;
}

/**
 * Pull the operator-readable message out of a thrown error. `ApiError`
 * carries the JSON body the route returned (e.g. the 409 from
 * `validateSnapshot`); the bare `error.message` is just
 * `"PUT /v1/... failed: 409"` which tells the operator nothing.
 */
export function humanizeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const parsed = err.body ? JSON.parse(err.body) : null;
      const m =
        (parsed && typeof parsed === 'object' && 'message' in parsed
          ? String((parsed as { message?: unknown }).message ?? '')
          : '') || '';
      const e =
        (parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error?: unknown }).error ?? '')
          : '') || '';
      if (m && e) return `${e}: ${m} (HTTP ${err.status})`;
      if (m) return `${m} (HTTP ${err.status})`;
      if (e) return `${e} (HTTP ${err.status})`;
    } catch {
      // body wasn't JSON — fall through to status-only
    }
    return `${err.message}${err.body ? ` — ${err.body.slice(0, 200)}` : ''}`;
  }
  return err instanceof Error ? err.message : String(err);
}
