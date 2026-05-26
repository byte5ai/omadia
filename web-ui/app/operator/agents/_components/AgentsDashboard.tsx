'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import {
  createOperatorAgent,
  deleteOperatorAgent,
  drainAgentSessions,
  killAgentSessions,
  patchOperatorAgent,
  replaceAgentBindings,
  replaceAgentPlugins,
  setFallbackAgent,
  triggerAgentReload,
  type OperatorAgentDto,
  type OperatorAgentsListDto,
  type PrivacyProfile,
} from '../../../_lib/agents';

interface AgentsDashboardProps {
  initial: OperatorAgentsListDto;
}

/**
 * Single-page dashboard for US9 (T038–T041):
 *  - List every Agent with its memory scope, plugins, bindings, runtime state.
 *  - Inline create + edit + disable + delete forms.
 *  - Drain & Kill controls per Agent (T041 — force-invalidate sessions).
 *  - Per-Agent plugin list editor (T040 — multi_instance comes from the
 *    plugin manifest registry; this MVP shows the raw plugin ids and
 *    leaves the metadata badge for a follow-up that exposes
 *    /api/v1/admin/plugins from the kernel).
 *  - Fallback selector + manual reload trigger.
 *
 * Every write calls a typed wrapper in `_lib/agents.ts`; after a
 * successful write we call `router.refresh()` so the RSC re-fetches the
 * list state without a full page reload.
 */
export function AgentsDashboard({
  initial,
}: AgentsDashboardProps): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const fallbackSlug =
    initial.agents.find((a) => a.id === initial.fallback_agent_id)?.slug ?? null;

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

      <section className="rounded border border-neutral-200 bg-white p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">{t('platformHeading')}</h2>
          <button
            type="button"
            className="rounded border border-neutral-300 bg-neutral-50 px-3 py-1 text-xs hover:bg-neutral-100"
            disabled={pending || !!busy}
            onClick={() => run('reload', () => triggerAgentReload())}
          >
            {t('forceReload')}
          </button>
        </div>
        <FallbackPicker
          agents={initial.agents}
          currentSlug={fallbackSlug}
          disabled={pending || !!busy}
          onChange={(slug) =>
            run('fallback', () => setFallbackAgent(slug))
          }
        />
      </section>

      <CreateAgentForm
        disabled={pending || !!busy}
        onCreate={(input) =>
          run('create', () => createOperatorAgent(input))
        }
      />

      <section className="space-y-4">
        <h2 className="text-lg font-medium">
          {t('agentsHeading')}{' '}
          <span className="text-sm font-normal text-neutral-500">
            ({initial.agents.length})
          </span>
        </h2>
        {initial.agents.length === 0 ? (
          <p className="text-sm text-neutral-500">
            {t('agentsEmpty')}
          </p>
        ) : (
          initial.agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
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
                run(`kill:${agent.slug}`, () =>
                  killAgentSessions(agent.slug),
                )
              }
            />
          ))
        )}
      </section>
    </div>
  );
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
  disabled: boolean;
  onPatch: (patch: {
    name?: string;
    description?: string | null;
    privacy_profile?: PrivacyProfile;
    status?: 'enabled' | 'disabled';
  }) => void;
  onDelete: () => void;
  onReplacePlugins: (
    plugins: Array<{ id: string; enabled?: boolean }>,
  ) => void;
  onReplaceBindings: (
    bindings: Array<{ channel_type: string; channel_key: string }>,
  ) => void;
  onDrain: () => void;
  onKill: () => void;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const { agent } = props;
  const [pluginsText, setPluginsText] = useState(
    agent.plugins.map((p) => p.id).join('\n'),
  );
  const [bindingsText, setBindingsText] = useState(
    agent.bindings
      .map((b) => `${b.channel_type}\t${b.channel_key}`)
      .join('\n'),
  );

  function submitPlugins(): void {
    const ids = pluginsText
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    props.onReplacePlugins(ids.map((id) => ({ id, enabled: true })));
  }

  function submitBindings(): void {
    const rows = bindingsText
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((line) => {
        const [type, ...rest] = line.split(/\s+/);
        return { channel_type: type ?? '', channel_key: rest.join(' ') };
      })
      .filter((b) => b.channel_type && b.channel_key);
    props.onReplaceBindings(rows);
  }

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

      <div className="grid gap-4 lg:grid-cols-3">
        <div>
          <h4 className="mb-2 text-sm font-medium">{t('memoryScopeHeading')}</h4>
          {agent.memory_scope.length === 0 ? (
            <p className="text-xs text-neutral-500">{t('memoryScopeEmpty')}</p>
          ) : (
            <ul className="space-y-1 font-mono text-xs">
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
        <div>
          <h4 className="mb-2 flex items-center justify-between text-sm font-medium">
            {t('pluginsHeading')}
            <button
              type="button"
              className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs hover:bg-neutral-50"
              disabled={props.disabled}
              onClick={submitPlugins}
            >
              {t('save')}
            </button>
          </h4>
          <textarea
            value={pluginsText}
            onChange={(e) => setPluginsText(e.target.value)}
            rows={4}
            placeholder={'@omadia/agent-...\n@omadia/integration-...'}
            className="w-full rounded border border-neutral-300 p-2 font-mono text-xs"
          />
        </div>
        <div>
          <h4 className="mb-2 flex items-center justify-between text-sm font-medium">
            {t('bindingsHeading')}
            <button
              type="button"
              className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs hover:bg-neutral-50"
              disabled={props.disabled}
              onClick={submitBindings}
            >
              {t('save')}
            </button>
          </h4>
          <textarea
            value={bindingsText}
            onChange={(e) => setBindingsText(e.target.value)}
            rows={4}
            placeholder={'teams\t28:bot-id\ntelegram\t@bot_username'}
            className="w-full rounded border border-neutral-300 p-2 font-mono text-xs"
          />
        </div>
      </div>
    </article>
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
