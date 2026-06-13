'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import {
  discoverMcpTools,
  patchModelRouting,
  patchSkill,
  patchSubAgent,
  type AgentNode,
  type McpServerNode,
  type ModelRoutingConfig,
  type ModelRoutingMode,
  type ScheduleNode,
  type SkillNode,
  type SubAgentNode,
} from '../../../_lib/agentBuilder';
import type { BuilderNodeData } from '../nodes/types';
import { Field, inputCls, SaveButton } from './InspectorControls';

export interface InspectorPanelProps {
  slug: string;
  data: BuilderNodeData;
  onClose: () => void;
  /** Re-fetch the authoritative graph after a successful save. */
  onSaved: () => void;
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
  return <p className="text-xs text-[color:var(--danger)]">{error}</p>;
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
        <p className="rounded-md bg-[color:var(--warning)]/10 px-2 py-1 text-xs text-[color:var(--warning)]">
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
