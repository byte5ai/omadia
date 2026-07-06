'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import {
  addPersonaSkill,
  discoverMcpTools,
  listSkills,
  patchModelRouting,
  patchSubAgent,
  removePersonaSkill,
  type AgentNode,
  type McpServerNode,
  type ModelRoutingConfig,
  type ModelRoutingMode,
  type ScheduleNode,
  type SkillNode,
  type SkillRisk,
  type SubAgentNode,
} from '../../../_lib/agentBuilder';
import { listBuilderModels } from '../../../_lib/api';
import type { BuilderModelInfo } from '../../../_lib/builderTypes';
import { Button } from '@/app/_components/ui/Button';
import { SkillEditor } from '../../../_components/admin/SkillEditor';
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
        <Button variant="secondary" size="sm" onClick={props.onClose}>
          {t('inspector.close')}
        </Button>
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
  const catalog = useModelCatalog();

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

  // Picker placeholder for `main`: while the catalog is loading we show
  // "Loading models…"; afterwards prefer the platform default ("(platform
  // default: X)") and fall back to a neutral "(default)" so a loaded catalog
  // without a declared default never displays the stale loading copy.
  const mainPlaceholder = catalog.loading
    ? t('inspector.modelPickerLoading')
    : catalog.defaultId
      ? t('inspector.platformDefault', { model: catalog.defaultId })
      : t('inspector.modelDefault');

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] font-semibold text-[color:var(--fg-strong)]">{agent.name}</p>
      {agent.effectiveModel && (
        <p className="text-xs text-[color:var(--fg-muted)]">
          {t('inspector.effectiveModel', { model: agent.effectiveModel })}
        </p>
      )}
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
        <ModelSelect
          value={main}
          onChange={setMain}
          catalog={catalog}
          placeholder={mainPlaceholder}
        />
      </Field>
      {mode === 'triage' && (
        <>
          <Field label={t('inspector.modelTriage')}>
            <ModelSelect
              value={triage}
              onChange={setTriage}
              catalog={catalog}
              placeholder={t('inspector.modelDefault')}
            />
          </Field>
          <Field label={t('inspector.modelSimple')}>
            <ModelSelect
              value={simple}
              onChange={setSimple}
              catalog={catalog}
              placeholder={t('inspector.modelDefault')}
            />
          </Field>
        </>
      )}
      <ErrLine error={error} />
      <ErrLine error={catalog.error} />
      <SaveButton
        onClick={() => void save()}
        pending={pending || catalog.loading}
        label={t('inspector.save')}
      />
      <div className="mt-2 border-t border-[color:var(--border)] pt-3">
        <PersonaSkillsSection slug={slug} agent={agent} onSaved={onSaved} />
      </div>
    </div>
  );
}

// ── Persona skills (Wave 8) ──────────────────────────────────────────────
/**
 * Direct-answer persona candidates for this Agent: skills attached straight
 * to the Agent (no sub-agent) that the per-turn classifier may adopt as the
 * top-level system prompt. Self-loads the full skill catalog once so the
 * "attach" picker can exclude already-attached skills.
 */
function PersonaSkillsSection({
  slug,
  agent,
  onSaved,
}: {
  slug: string;
  agent: AgentNode;
  onSaved: () => void;
}): React.ReactElement {
  const t = useTranslations('admin.builder');
  const [allSkills, setAllSkills] = useState<SkillNode[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedToAdd, setSelectedToAdd] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastRisks, setLastRisks] = useState<SkillRisk[] | null>(null);

  useEffect(() => {
    let active = true;
    listSkills()
      .then((res) => {
        if (active) setAllSkills(res.skills);
      })
      .catch((err) => {
        if (active) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, []);

  // Attached chips are driven by `attachedIds` (always present on the agent,
  // independent of catalog-load state) so a `listSkills()` failure never
  // hides — and makes unremovable — a persona that is actively overriding
  // the orchestrator's identity. Only the enriched name/slug/risks and the
  // "attach" picker (which needs the full catalog) depend on `allSkills`.
  const attachedIds = agent.personaSkillIds ?? [];
  const skillById = new Map((allSkills ?? []).map((s) => [s.id, s]));
  const available = (allSkills ?? []).filter((s) => !attachedIds.includes(s.id));

  async function handleAdd(): Promise<void> {
    if (!selectedToAdd) return;
    setPendingId(selectedToAdd);
    setError(null);
    setLastRisks(null);
    try {
      const link = await addPersonaSkill(slug, selectedToAdd);
      if (link.risks.length > 0) setLastRisks(link.risks);
      setSelectedToAdd('');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingId(null);
    }
  }

  async function handleRemove(skillId: string): Promise<void> {
    setPendingId(skillId);
    setError(null);
    try {
      await removePersonaSkill(slug, skillId);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] font-semibold text-[color:var(--fg-strong)]">
        {t('persona.title')}
      </p>
      <p className="text-xs text-[color:var(--fg-muted)]">
        {attachedIds.length === 0 ? t('persona.hintEmpty') : t('persona.hintSome')}
      </p>
      {attachedIds.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {attachedIds.map((id) => {
            const s = skillById.get(id);
            const risky = (s?.risks?.length ?? 0) > 0;
            return (
              <li
                key={id}
                title={
                  risky
                    ? t('persona.riskWarning', {
                        codes: (s?.risks ?? [])
                          .map((r) => t(`import.risks.code.${r.code}`))
                          .join(', '),
                      })
                    : undefined
                }
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                  risky
                    ? 'border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 text-[color:var(--danger)]'
                    : 'border-[color:var(--border)] bg-[color:var(--card)] text-[color:var(--fg-strong)]'
                }`}
              >
                {risky && <span aria-hidden="true">⚠</span>}
                <span className="truncate">{s?.name ?? id}</span>
                {s && (
                  <span className="font-mono text-[10px] text-[color:var(--fg-muted)]">
                    {s.slug}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void handleRemove(id)}
                  disabled={pendingId === id}
                  aria-label={t('persona.remove')}
                  className="text-[color:var(--fg-muted)] hover:text-[color:var(--danger)]"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {allSkills !== null &&
        (available.length > 0 ? (
          <div className="flex gap-2">
            <select
              value={selectedToAdd}
              onChange={(e) => setSelectedToAdd(e.target.value)}
              className={inputCls}
            >
              <option value="">{t('persona.addPlaceholder')}</option>
              {available.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.slug}){(s.risks?.length ?? 0) > 0 ? ' ⚠' : ''}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleAdd()}
              disabled={!selectedToAdd || pendingId !== null}
            >
              {t('persona.add')}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-[color:var(--fg-muted)]">{t('persona.noSkillsAvailable')}</p>
        ))}
      {lastRisks && lastRisks.length > 0 && (
        <p className="rounded-md border border-[color:var(--danger-edge)] bg-[color:var(--danger)]/8 px-2 py-1.5 text-xs text-[color:var(--danger)]">
          {t('persona.riskWarning', {
            codes: lastRisks.map((r) => t(`import.risks.code.${r.code}`)).join(', '),
          })}
        </p>
      )}
      <ErrLine error={error ?? loadError} />
    </div>
  );
}

interface ModelCatalogState {
  models: BuilderModelInfo[];
  defaultId: string | null;
  loading: boolean;
  error: string | null;
}

function useModelCatalog(): ModelCatalogState {
  const [state, setState] = useState<ModelCatalogState>({
    models: [],
    defaultId: null,
    loading: true,
    error: null,
  });
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await listBuilderModels();
        if (!alive) return;
        setState({
          models: res.models,
          defaultId: res.default ?? null,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (!alive) return;
        setState({
          models: [],
          defaultId: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

function ModelSelect({
  value,
  onChange,
  catalog,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  catalog: ModelCatalogState;
  placeholder: string;
}): React.ReactElement {
  // Stale-binding: a persisted value that no installed provider serves anymore.
  // Keep it visible (disabled) so the operator sees what is set and can pick a
  // replacement instead of having the field silently snap to a different model.
  // Match the provider-qualified id, the bare vendor id (pre-picker configs and
  // the platform default persist this form), and aliases — only a value that
  // resolves to NO registered model is genuinely stale.
  const known = catalog.models.some(
    (m) => m.id === value || m.model_id === value || m.aliases.includes(value),
  );
  const showStale = value !== '' && !known && !catalog.loading;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={inputCls}
      disabled={catalog.loading}
    >
      <option value="">{placeholder}</option>
      {catalog.models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label} ({m.provider})
        </option>
      ))}
      {showStale && (
        <option value={value} disabled>
          {value} — stale
        </option>
      )}
    </select>
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
  // Issue #296 follow-up — sub-agent picker uses the same registry-driven
  // dropdown as the parent agent so an operator cannot pin a sub-agent to a
  // model id no installed provider serves.
  const catalog = useModelCatalog();

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
        <ModelSelect
          value={model}
          onChange={setModel}
          catalog={catalog}
          placeholder={t('inspector.modelDefault')}
        />
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
      <ErrLine error={catalog.error} />
      <SaveButton
        onClick={() => void save()}
        pending={pending || catalog.loading}
        label={t('inspector.save')}
      />
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
