'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

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
  type PluginSetupFieldDto,
  type PrivacyProfile,
  type ResolveChannelResponse,
} from '../../../_lib/agents';

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
        setError(err instanceof Error ? err.message : String(err));
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

  return (
    <article className="rounded border border-neutral-200 bg-white p-5">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold">
            {agent.name}{' '}
            <span className="font-mono text-sm text-neutral-500">
              ({agent.slug})
            </span>
          </h3>
          <p className="text-xs text-neutral-500">
            {t('agentMeta', {
              id: agent.id,
              privacy: agent.privacy_profile,
              status:
                agent.status === 'enabled'
                  ? t('statusEnabled')
                  : t('statusDisabled'),
              runtime: agent.active
                ? t('runtimeActive')
                : t('runtimeInactive'),
            })}
          </p>
          {agent.description && (
            <p className="mt-1 text-sm text-neutral-700">{agent.description}</p>
          )}
        </div>
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
          <div className="flex gap-2">
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
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h4 className="mb-2 text-sm font-medium">{t('memoryScopeHeading')}</h4>
          {agent.memory_scope.length === 0 ? (
            <p className="text-xs text-neutral-500">{t('memoryScopeEmpty')}</p>
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
        <PluginsEditor
          key={`plugins:${agent.updated_at}`}
          agent={agent}
          catalog={props.catalog}
          disabled={props.disabled}
          onReplace={props.onReplacePlugins}
        />
      </div>

      <BindingsEditor
        key={`bindings:${agent.updated_at}`}
        agent={agent}
        channelTypes={props.channelTypes}
        disabled={props.disabled}
        onReplace={props.onReplaceBindings}
      />
    </article>
  );
}

function PluginsEditor(props: {
  agent: OperatorAgentDto;
  catalog: PluginCatalogEntryDto[] | null;
  disabled: boolean;
  onReplace: (
    plugins: Array<{
      id: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    }>,
  ) => void;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const initialMap = useMemo(() => {
    const m = new Map<string, { enabled: boolean; config: Record<string, unknown> }>();
    for (const p of props.agent.plugins) {
      m.set(p.id, { enabled: p.enabled, config: p.config });
    }
    return m;
  }, [props.agent.plugins]);

  const [selected, setSelected] = useState<Map<string, { enabled: boolean; config: Record<string, unknown> }>>(
    initialMap,
  );
  const [expanded, setExpanded] = useState<string | null>(null);

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, { enabled: true, config: {} });
      return next;
    });
  }

  function setConfigKey(
    pluginId: string,
    fieldKey: string,
    value: string | boolean | number | string[],
  ): void {
    setSelected((prev) => {
      const next = new Map(prev);
      const cur = next.get(pluginId);
      if (!cur) return prev;
      next.set(pluginId, {
        ...cur,
        config: { ...cur.config, [fieldKey]: value },
      });
      return next;
    });
  }

  function submit(): void {
    const out: Array<{
      id: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
    }> = [];
    for (const [id, entry] of selected) {
      out.push({ id, enabled: entry.enabled, config: entry.config });
    }
    props.onReplace(out);
  }

  const catalog = props.catalog;
  if (!catalog) {
    return (
      <div>
        <h4 className="mb-2 text-sm font-medium">{t('pluginsHeading')}</h4>
        <p className="text-xs text-neutral-500">{t('catalogLoading')}</p>
      </div>
    );
  }

  // Always include orphan plugin ids (rows in agent_plugins that no longer
  // map to a catalog entry — typically because the plugin was uninstalled).
  // Surfacing them lets the operator un-attach them; hiding them would
  // silently lose state on save.
  const orphans = Array.from(selected.keys()).filter(
    (id) => !catalog.some((c) => c.id === id),
  );

  return (
    <div>
      <h4 className="mb-2 flex items-center justify-between text-sm font-medium">
        {t('pluginsHeading')}
        <button
          type="button"
          className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs hover:bg-neutral-50"
          disabled={props.disabled}
          onClick={submit}
        >
          {t('save')}
        </button>
      </h4>
      <ul className="space-y-1.5">
        {catalog.map((entry) => {
          const attached = selected.has(entry.id);
          const isExpanded = expanded === entry.id;
          const hasFields = entry.setup_fields.length > 0;
          return (
            <li
              key={entry.id}
              className="rounded border border-neutral-200 bg-neutral-50/40"
            >
              <label className="flex cursor-pointer items-start gap-2 px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={attached}
                  disabled={props.disabled}
                  onChange={() => toggle(entry.id)}
                  className="mt-0.5"
                />
                <div className="flex-1 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-neutral-800">
                      {entry.name}
                    </span>
                    <code className="font-mono text-[10px] text-neutral-500">
                      {entry.id}
                    </code>
                    <KindBadge kind={entry.kind} />
                    {!entry.multi_instance && (
                      <span
                        title={
                          entry.multi_instance_justification ??
                          t('multiInstanceFalseBadge')
                        }
                        className="rounded bg-amber-100 px-1.5 py-0 text-[10px] uppercase tracking-wide text-amber-800"
                      >
                        {t('multiInstanceFalseShort')}
                      </span>
                    )}
                    {entry.privacy_class === 'strict' && (
                      <span className="rounded bg-violet-100 px-1.5 py-0 text-[10px] uppercase tracking-wide text-violet-800">
                        {t('privacyStrictBadge')}
                      </span>
                    )}
                    {hasFields && attached && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          setExpanded(isExpanded ? null : entry.id);
                        }}
                        className="ml-auto rounded border border-neutral-300 bg-white px-1.5 py-0 text-[10px] uppercase hover:bg-neutral-100"
                      >
                        {isExpanded ? t('configHide') : t('configShow')}
                      </button>
                    )}
                  </div>
                  {(entry.memory_reads.length > 0 ||
                    entry.memory_writes.length > 0) && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {entry.memory_reads.map((s) => (
                        <span
                          key={`r-${s}`}
                          title={t('memoryReadTooltip')}
                          className="rounded bg-blue-50 px-1.5 py-0 text-[10px] text-blue-800"
                        >
                          r:{s}
                        </span>
                      ))}
                      {entry.memory_writes.map((s) => (
                        <span
                          key={`w-${s}`}
                          title={t('memoryWriteTooltip')}
                          className="rounded bg-emerald-50 px-1.5 py-0 text-[10px] text-emerald-800"
                        >
                          w:{s}
                        </span>
                      ))}
                    </div>
                  )}
                  {entry.network_outbound.length > 0 && (
                    <p className="mt-1 truncate text-[10px] text-neutral-500">
                      {t('networkLabel')} {entry.network_outbound.join(', ')}
                    </p>
                  )}
                </div>
              </label>
              {attached && isExpanded && hasFields && (
                <PluginConfigForm
                  fields={entry.setup_fields}
                  values={selected.get(entry.id)?.config ?? {}}
                  disabled={props.disabled}
                  onChange={(key, value) =>
                    setConfigKey(entry.id, key, value)
                  }
                />
              )}
            </li>
          );
        })}
        {orphans.map((id) => (
          <li
            key={id}
            className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs"
          >
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={true}
                disabled={props.disabled}
                onChange={() => toggle(id)}
              />
              <span className="font-mono text-amber-900">{id}</span>
              <span className="text-[10px] uppercase text-amber-800">
                {t('orphanPluginBadge')}
              </span>
            </label>
          </li>
        ))}
        {catalog.length === 0 && orphans.length === 0 && (
          <li className="text-xs text-neutral-500">{t('catalogEmpty')}</li>
        )}
      </ul>
    </div>
  );
}

function KindBadge({ kind }: { kind: string }): React.ReactElement {
  const cls = {
    agent: 'bg-sky-100 text-sky-800',
    integration: 'bg-emerald-100 text-emerald-800',
    channel: 'bg-fuchsia-100 text-fuchsia-800',
    tool: 'bg-neutral-200 text-neutral-700',
    extension: 'bg-orange-100 text-orange-800',
  }[kind] ?? 'bg-neutral-200 text-neutral-700';
  return (
    <span
      className={`rounded px-1.5 py-0 text-[10px] uppercase tracking-wide ${cls}`}
    >
      {kind}
    </span>
  );
}

function PluginConfigForm(props: {
  fields: readonly PluginSetupFieldDto[];
  values: Record<string, unknown>;
  disabled: boolean;
  onChange: (
    key: string,
    value: string | boolean | number | string[],
  ) => void;
}): React.ReactElement {
  return (
    <div className="border-t border-neutral-200 bg-white px-3 py-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {props.fields.map((f) => (
          <PluginConfigField
            key={f.key}
            field={f}
            value={props.values[f.key]}
            disabled={props.disabled}
            onChange={(v) => props.onChange(f.key, v)}
          />
        ))}
      </div>
    </div>
  );
}

function PluginConfigField(props: {
  field: PluginSetupFieldDto;
  value: unknown;
  disabled: boolean;
  onChange: (value: string | boolean | number | string[]) => void;
}): React.ReactElement {
  const { field, value, disabled, onChange } = props;
  const isSecret = field.type === 'secret' || field.type === 'password';
  const isHostList = field.type === 'host_list';
  const isEnum = field.type === 'enum' && (field.enum?.length ?? 0) > 0;
  const isBool = field.type === 'boolean';
  const isNumber = field.type === 'number';

  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-neutral-500">
        {field.label}
        {field.help && (
          <span className="ml-1 text-neutral-400">— {field.help}</span>
        )}
      </span>
      {isSecret ? (
        <input
          type="password"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          className="rounded border border-neutral-300 px-2 py-1 text-xs"
          placeholder={typeof field.default === 'string' ? field.default : ''}
        />
      ) : isEnum ? (
        <select
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1 text-xs"
        >
          <option value="">—</option>
          {field.enum?.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : isBool ? (
        <input
          type="checkbox"
          checked={value === true || value === 'true'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1"
        />
      ) : isNumber ? (
        <input
          type="number"
          value={typeof value === 'number' ? value : value === undefined ? '' : Number(value)}
          disabled={disabled}
          onChange={(e) =>
            onChange(e.target.value === '' ? 0 : Number(e.target.value))
          }
          className="rounded border border-neutral-300 px-2 py-1 text-xs"
        />
      ) : isHostList ? (
        <textarea
          value={
            Array.isArray(value)
              ? value.join('\n')
              : typeof value === 'string'
                ? value
                : ''
          }
          disabled={disabled}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(/\n/)
                .map((s) => s.trim())
                .filter((s) => s.length > 0),
            )
          }
          rows={3}
          placeholder="hostname.example.com"
          className="rounded border border-neutral-300 px-2 py-1 font-mono text-xs"
        />
      ) : (
        <input
          type={field.type === 'url' ? 'url' : 'text'}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={typeof field.default === 'string' ? field.default : ''}
          className="rounded border border-neutral-300 px-2 py-1 text-xs"
        />
      )}
    </label>
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
