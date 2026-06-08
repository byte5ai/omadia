'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import {
  createGraphEdge,
  disablePlugin,
  discoverMcpTools,
  enablePlugin,
  listInstallablePlugins,
  patchModelRouting,
  patchSkill,
  patchSubAgent,
  type AgentNode,
  type McpServerNode,
  type ModelRoutingConfig,
  type ModelRoutingMode,
  type PluginNode,
  type ScheduleNode,
  type SkillNode,
  type SubAgentNode,
} from '../../../_lib/agentBuilder';
import type { BuilderNodeData, ChannelNodeData } from '../nodes/types';
import { Field, inputCls, SaveButton } from './InspectorControls';

export interface InspectorPanelProps {
  slug: string;
  data: BuilderNodeData;
  onClose: () => void;
  /** Re-fetch the authoritative graph after a successful save. */
  onSaved: () => void;
  /** Delete the selected node (agent + plugin nodes are not deletable). */
  onDelete: (data: BuilderNodeData) => void;
}

/**
 * Right-hand inspector for the selected node. Switches editor by node kind:
 * agent identity + model-routing, sub-agent model/skill/prompt, skill
 * markdown body, MCP connection + Discover, schedule cron/timezone.
 */
export function InspectorPanel(props: InspectorPanelProps): React.ReactElement {
  const t = useTranslations('admin.builder');
  return (
    <aside className="flex w-[320px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-[color:var(--border)] bg-[color:var(--card)]/40 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-[color:var(--fg-strong)]">
          {t('inspector.title')}
        </h2>
        <button
          type="button"
          onClick={props.onClose}
          className="rounded-md border border-[color:var(--border)] px-2 py-1 text-xs text-[color:var(--fg-muted)] hover:bg-[color:var(--card)]"
        >
          {t('inspector.close')}
        </button>
      </div>
      <Editor {...props} />
      {props.data.kind !== 'agent' && props.data.kind !== 'plugin' && (
        <button
          type="button"
          onClick={() => props.onDelete(props.data)}
          className="mt-auto rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400 hover:bg-red-500/20"
        >
          {t('inspector.delete')}
        </button>
      )}
    </aside>
  );
}

function Editor(props: InspectorPanelProps): React.ReactElement {
  const { data } = props;
  switch (data.kind) {
    case 'agent':
      return <AgentEditor slug={props.slug} agent={data.agent} onSaved={props.onSaved} />;
    case 'subagent':
      return (
        <SubAgentEditor slug={props.slug} subAgent={data.subAgent} onSaved={props.onSaved} />
      );
    case 'skill':
      return <SkillEditor skill={data.skill} onSaved={props.onSaved} />;
    case 'mcp':
      return <McpEditor server={data.server} onSaved={props.onSaved} />;
    case 'schedule':
      return <ScheduleViewer schedule={data.schedule} />;
    case 'channel':
      return <ChannelEditor slug={props.slug} data={data} onSaved={props.onSaved} />;
    case 'plugin':
      return <PluginEditor slug={props.slug} plugin={data.plugin} onSaved={props.onSaved} />;
    default:
      return <ReadOnly />;
  }
}

function ReadOnly(): React.ReactElement {
  const t = useTranslations('admin.builder');
  return <p className="text-sm text-[color:var(--fg-muted)]">{t('inspector.readOnly')}</p>;
}

function useSaver(): {
  pending: boolean;
  error: string | null;
  run: (fn: () => Promise<void>) => Promise<void>;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<void>): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }
  return { pending, error, run };
}

function ErrLine({ error }: { error: string | null }): React.ReactElement | null {
  if (!error) return null;
  return <p className="text-xs text-red-500">{error}</p>;
}

// ── Agent ────────────────────────────────────────────────────────────────
function AgentEditor({
  slug,
  agent,
  onSaved,
}: {
  slug: string;
  agent: AgentNode;
  onSaved: () => void;
}): React.ReactElement {
  const t = useTranslations('admin.builder');
  const r = agent.modelRouting;
  const [mode, setMode] = useState<ModelRoutingMode>(r?.mode ?? 'single');
  const [main, setMain] = useState(r?.main ?? '');
  const [triage, setTriage] = useState(r?.triage ?? '');
  const [simple, setSimple] = useState(r?.simple ?? '');
  const { pending, error, run } = useSaver();
  const [installable, setInstallable] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void listInstallablePlugins(slug)
      .then((res) => {
        if (alive) setInstallable(res.plugins);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [slug]);

  async function enable(id: string): Promise<void> {
    await run(async () => {
      await enablePlugin(slug, id);
      setInstallable((xs) => xs.filter((x) => x !== id));
      onSaved();
    });
  }

  async function save(): Promise<void> {
    await run(async () => {
      const cfg: ModelRoutingConfig = {
        mode,
        main: main.trim(),
        ...(triage.trim() ? { triage: triage.trim() } : {}),
        ...(simple.trim() ? { simple: simple.trim() } : {}),
      };
      await patchModelRouting(slug, main.trim() ? cfg : null);
      onSaved();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] font-semibold text-[color:var(--fg-strong)]">{agent.name}</p>
      <Field label={t('inspector.routingMode')}>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as ModelRoutingMode)}
          className={inputCls}
        >
          <option value="single">single</option>
          <option value="triage">triage</option>
        </select>
      </Field>
      <Field label={t('inspector.modelMain')}>
        <input value={main} onChange={(e) => setMain(e.target.value)} className={inputCls} />
      </Field>
      {mode === 'triage' && (
        <>
          <Field label={t('inspector.modelTriage')}>
            <input value={triage} onChange={(e) => setTriage(e.target.value)} className={inputCls} />
          </Field>
          <Field label={t('inspector.modelSimple')}>
            <input value={simple} onChange={(e) => setSimple(e.target.value)} className={inputCls} />
          </Field>
        </>
      )}
      <ErrLine error={error} />
      <SaveButton onClick={() => void save()} pending={pending} label={t('inspector.save')} />

      <div className="mt-2 border-t border-[color:var(--border)] pt-3">
        <p className="mb-2 text-[11px] uppercase tracking-[0.14em] text-[color:var(--fg-muted)]">
          {t('inspector.addPlugin')}
        </p>
        {installable.length === 0 ? (
          <p className="text-xs text-[color:var(--fg-muted)]">{t('inspector.noInstallable')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {installable.map((id) => (
              <li key={id} className="flex items-center justify-between gap-2">
                <span className="truncate text-xs text-[color:var(--fg-strong)]">{id}</span>
                <button
                  type="button"
                  onClick={() => void enable(id)}
                  disabled={pending}
                  className="shrink-0 rounded-md border border-[color:var(--border)] px-2 py-0.5 text-xs text-[color:var(--accent)] hover:bg-[color:var(--card)] disabled:opacity-50"
                >
                  {t('inspector.enable')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Sub-agent ──────────────────────────────────────────────────────────────
function SubAgentEditor({
  slug,
  subAgent,
  onSaved,
}: {
  slug: string;
  subAgent: SubAgentNode;
  onSaved: () => void;
}): React.ReactElement {
  const t = useTranslations('admin.builder');
  const [name, setName] = useState(subAgent.name);
  const [model, setModel] = useState(subAgent.model ?? '');
  const [prompt, setPrompt] = useState(subAgent.systemPromptOverride ?? '');
  const { pending, error, run } = useSaver();

  async function save(): Promise<void> {
    await run(async () => {
      await patchSubAgent(slug, subAgent.id, {
        name: name.trim(),
        model: model.trim() || null,
        systemPromptOverride: prompt.trim() || null,
      });
      onSaved();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label={t('inspector.name')}>
        <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
      </Field>
      <Field label={t('inspector.model')}>
        <input value={model} onChange={(e) => setModel(e.target.value)} className={inputCls} />
      </Field>
      <Field label={t('inspector.systemPrompt')}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          className={inputCls}
        />
      </Field>
      <ErrLine error={error} />
      <SaveButton onClick={() => void save()} pending={pending} label={t('inspector.save')} />
    </div>
  );
}

// ── Skill ────────────────────────────────────────────────────────────────
function SkillEditor({
  skill,
  onSaved,
}: {
  skill: SkillNode;
  onSaved: () => void;
}): React.ReactElement {
  const t = useTranslations('admin.builder');
  const [name, setName] = useState(skill.name);
  const [body, setBody] = useState(skill.body);
  const { pending, error, run } = useSaver();
  const readOnly = skill.source === 'file';

  async function save(): Promise<void> {
    await run(async () => {
      await patchSkill(skill.id, { name: name.trim(), body });
      onSaved();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {readOnly && (
        <p className="rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-500">
          {t('inspector.skillFileReadOnly')}
        </p>
      )}
      <Field label={t('inspector.name')}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={readOnly}
          className={inputCls}
        />
      </Field>
      <Field label={t('inspector.skillBody')}>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={readOnly}
          rows={12}
          className={`${inputCls} font-mono text-xs`}
        />
      </Field>
      <ErrLine error={error} />
      {!readOnly && (
        <SaveButton onClick={() => void save()} pending={pending} label={t('inspector.save')} />
      )}
    </div>
  );
}

// ── MCP server ──────────────────────────────────────────────────────────────
function McpEditor({
  server,
  onSaved,
}: {
  server: McpServerNode;
  onSaved: () => void;
}): React.ReactElement {
  const t = useTranslations('admin.builder');
  // Local post-discover override, scoped to the current server id. When the
  // selected server changes (id mismatch), the override is ignored and we
  // fall back to the prop — no setState-in-effect needed.
  const [override, setOverride] = useState<McpServerNode | null>(null);
  const live = override && override.id === server.id ? override : server;
  const { pending, error, run } = useSaver();

  async function discover(): Promise<void> {
    await run(async () => {
      const updated = await discoverMcpTools(server.id);
      setOverride(updated);
      onSaved();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label={t('inspector.name')}>
        <input value={live.name} readOnly className={inputCls} />
      </Field>
      <Field label={t('inspector.transport')}>
        <input value={live.transport} readOnly className={inputCls} />
      </Field>
      <Field label={t('inspector.endpoint')}>
        <input value={live.endpoint ?? ''} readOnly className={inputCls} />
      </Field>
      <div className="text-xs text-[color:var(--fg-muted)]">
        {live.discoveredTools.length} {t('nodes.tools')}
        {live.lastDiscoveredAt ? ` · ${live.lastDiscoveredAt}` : ''}
      </div>
      <ErrLine error={error} />
      <SaveButton onClick={() => void discover()} pending={pending} label={t('inspector.discover')} />
    </div>
  );
}

// ── Channel (bind a draft, or view a binding) ────────────────────────────────
function ChannelEditor({
  slug,
  data,
  onSaved,
}: {
  slug: string;
  data: ChannelNodeData;
  onSaved: () => void;
}): React.ReactElement {
  const t = useTranslations('admin.builder');
  const [channelType, setChannelType] = useState(data.channel.channelType);
  const [channelKey, setChannelKey] = useState(data.channel.channelKey);
  const { pending, error, run } = useSaver();
  const isDraft = !!data.draft;

  async function bind(): Promise<void> {
    await run(async () => {
      const type = channelType.trim();
      const key = channelKey.trim();
      if (!type || !key) throw new Error(t('inspector.channelMissing'));
      await createGraphEdge(slug, {
        kind: 'channel_bind',
        source: `channel:${type}:${key}`,
        target: 'agent:_',
      });
      onSaved();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label={t('inspector.channelType')}>
        <input
          value={channelType}
          onChange={(e) => setChannelType(e.target.value)}
          readOnly={!isDraft}
          placeholder="slack"
          className={inputCls}
        />
      </Field>
      <Field label={t('inspector.channelKey')}>
        <input
          value={channelKey}
          onChange={(e) => setChannelKey(e.target.value)}
          readOnly={!isDraft}
          placeholder="team:acme:general"
          className={inputCls}
        />
      </Field>
      <ErrLine error={error} />
      {isDraft && (
        <SaveButton onClick={() => void bind()} pending={pending} label={t('inspector.bind')} />
      )}
    </div>
  );
}

// ── Plugin (read-only id + detach from this agent) ────────────────────────────
function PluginEditor({
  slug,
  plugin,
  onSaved,
}: {
  slug: string;
  plugin: PluginNode;
  onSaved: () => void;
}): React.ReactElement {
  const t = useTranslations('admin.builder');
  const { pending, error, run } = useSaver();

  async function detach(): Promise<void> {
    await run(async () => {
      await disablePlugin(slug, plugin.id);
      onSaved();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label={t('inspector.pluginId')}>
        <input value={plugin.id} readOnly className={inputCls} />
      </Field>
      <p className="text-xs text-[color:var(--fg-muted)]">{t('inspector.pluginHint')}</p>
      <ErrLine error={error} />
      <button
        type="button"
        onClick={() => void detach()}
        disabled={pending}
        className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400 hover:bg-red-500/20 disabled:opacity-50"
      >
        {t('inspector.pluginDetach')}
      </button>
    </div>
  );
}

// ── Schedule (read-only view) ─────────────────────────────────────────────
function ScheduleViewer({ schedule }: { schedule: ScheduleNode }): React.ReactElement {
  const t = useTranslations('admin.builder');
  return (
    <div className="flex flex-col gap-3">
      <Field label={t('inspector.cron')}>
        <input value={schedule.cron} readOnly className={inputCls} />
      </Field>
      <Field label={t('inspector.timezone')}>
        <input value={schedule.timezone} readOnly className={inputCls} />
      </Field>
      <div className="text-xs text-[color:var(--fg-muted)]">
        {schedule.status}
        {schedule.lastRunAt ? ` · ${schedule.lastRunAt}` : ''}
      </div>
    </div>
  );
}
