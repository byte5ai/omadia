'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { Button } from '@/app/_components/ui/Button';
import {
  ApiError,
  getConductorEventCatalog,
  getConductorRun,
  getConductorWorkflowGraph,
  previewConductorWorkflow,
  publishConductorWorkflow,
  startConductorRun,
  type ConductorPreviewResult,
  type ConductorRunResult,
  type ConductorWorkflow,
} from '@/app/_lib/api';

// ── Node data model ────────────────────────────────────────────────────────
// node.id is a stable internal id; data.stepId is the user-facing (renameable)
// step id used in the serialized graph, so renaming never breaks edges.

type StepKind = 'agent' | 'action' | 'human';

interface StepNodeData extends Record<string, unknown> {
  stepId: string;
  kind: StepKind;
  agentId: string;
  prompt: string;
  actionId: string;
  input: string; // JSON string
  human: {
    principalKind: 'user' | 'role';
    principalRef: string;
    channel: string;
    message: string;
    reminderInterval: string;
    deadline: string;
    quorum: 'any' | 'all';
  };
  postcondition: string; // JSON string, optional
  fallbackTransitionId: string;
  isEntry: boolean;
}

type StepNode = Node<StepNodeData>;

const KIND_COLOR: Record<StepKind, string> = {
  agent: '#6ab7ff',
  action: '#8b9cff',
  human: '#f2b95e',
};

function StepNodeView({ data, selected }: NodeProps<StepNode>): React.JSX.Element {
  const primary =
    data.kind === 'agent' ? data.agentId || '—' : data.kind === 'action' ? data.actionId || '—' : data.human.principalRef || '—';
  return (
    <div
      style={{ borderColor: selected ? 'var(--fg-strong)' : KIND_COLOR[data.kind] }}
      className="min-w-[150px] rounded-md border-2 bg-[color:var(--card)] px-3 py-2 text-[color:var(--fg-strong)] shadow"
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span
          className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
          style={{ background: KIND_COLOR[data.kind], color: '#0b0b0b' }}
        >
          {data.kind}
        </span>
        {data.isEntry && (
          <span className="rounded bg-[color:var(--fg-strong)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--card)]">
            entry
          </span>
        )}
      </div>
      <div className="mt-1 font-mono text-[13px] font-medium">{data.stepId}</div>
      <div className="font-mono text-[11px] text-[color:var(--fg-muted)]">{primary}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes: NodeTypes = { step: StepNodeView };

function emptyData(kind: StepKind, n: number): StepNodeData {
  return {
    stepId: `${kind}-${n}`,
    kind,
    agentId: kind === 'agent' ? 'fallback' : '',
    prompt: kind === 'agent' ? 'Do your task.' : '',
    actionId: '',
    input: '',
    human: {
      principalKind: 'role',
      principalRef: '',
      channel: 'teams',
      message: '',
      reminderInterval: '',
      deadline: '',
      quorum: 'any',
    },
    postcondition: '',
    fallbackTransitionId: '',
    isEntry: n === 1,
  };
}

interface ValidationError {
  code: string;
  message: string;
}

// A request from the parent (e.g. the "Edit" button in the workflows list) to load a
// workflow into the canvas. The nonce changes on every click so re-editing the same
// workflow reloads it even though the slug is unchanged.
export interface CanvasEditRequest {
  slug: string;
  nonce: number;
}

// A request from the parent to render a draft graph (e.g. the conversational builder's evolving
// draft, US7) directly into the canvas. The nonce changes each push so the same graph re-renders.
export interface CanvasGraphRequest {
  graph: unknown;
  nonce: number;
}

function CanvasInner({
  workflows,
  onSaved,
  editRequest,
  loadGraphRequest,
}: {
  workflows: ConductorWorkflow[];
  onSaved: () => void;
  editRequest: CanvasEditRequest | null;
  loadGraphRequest: CanvasGraphRequest | null;
}): React.JSX.Element {
  const t = useTranslations('conductor');
  const [nodes, setNodes] = useState<StepNode[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);

  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [triggerKind, setTriggerKind] = useState<'manual' | 'event' | 'cron'>('manual');
  const [triggerEventId, setTriggerEventId] = useState('');
  const [triggerCron, setTriggerCron] = useState('');
  // Declared emittable events (US4 / FR-028) — the Designer sources the event-trigger picker from the
  // live catalog. Best-effort: an empty catalog just falls back to free-text entry.
  const [eventCatalog, setEventCatalog] = useState<string[]>([]);
  const eventListId = useId(); // unique per canvas instance — no datalist id collision on double-mount

  useEffect(() => {
    let cancelled = false;
    void getConductorEventCatalog()
      .then((c) => {
        // Defensive: a 200 with an unexpected body would otherwise make state non-array and crash render.
        if (!cancelled) setEventCatalog(Array.isArray(c?.events) ? c.events : []);
      })
      // Errors degrade to the empty-catalog hint + free-text entry. (A 401 still triggers getJson's
      // standard login redirect — same as every other page fetch — which is the desired behaviour.)
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Monotonic id source — guarantees unique node/edge ids even if a click double-fires.
  const nextId = useRef(0);
  const lastAction = useRef(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [runResult, setRunResult] = useState<ConductorRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewResult, setPreviewResult] = useState<ConductorPreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns) as StepNode[]);
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((es) => applyEdgeChanges(changes, es));
  }, []);
  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    nextId.current += 1;
    const id = `t-${String(nextId.current)}`;
    setEdges((es) => addEdge({ ...c, id, data: { guard: '' } }, es));
  }, []);

  const addStep = useCallback((kind: StepKind) => {
    // Swallow a double-fired click (synthetic input / accidental double-click) so a
    // single intent never produces two nodes.
    const now = Date.now();
    if (now - lastAction.current < 350) return;
    lastAction.current = now;
    nextId.current += 1;
    const n = nextId.current;
    const id = `node-${String(n)}`;
    setNodes((ns) => [
      ...ns,
      {
        id,
        type: 'step',
        position: { x: 80 + (ns.length % 4) * 200, y: 80 + Math.floor(ns.length / 4) * 130 },
        data: { ...emptyData(kind, n), isEntry: ns.length === 0 },
      },
    ]);
  }, []);

  const patchNode = useCallback((nodeId: string, patch: Partial<StepNodeData>) => {
    setNodes((ns) => ns.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node)));
  }, []);

  const setEntry = useCallback((nodeId: string) => {
    setNodes((ns) => ns.map((node) => ({ ...node, data: { ...node.data, isEntry: node.id === nodeId } })));
  }, []);

  const deleteSelected = useCallback(() => {
    if (selectedNode) {
      setNodes((ns) => ns.filter((n) => n.id !== selectedNode));
      setEdges((es) => es.filter((e) => e.source !== selectedNode && e.target !== selectedNode));
      setSelectedNode(null);
    } else if (selectedEdge) {
      setEdges((es) => es.filter((e) => e.id !== selectedEdge));
      setSelectedEdge(null);
    }
  }, [selectedNode, selectedEdge]);

  // ── serialize canvas → graph JSON ─────────────────────────────────────────
  const buildGraph = useCallback((): { graph: unknown; error?: string } => {
    const idMap = new Map<string, string>(); // node.id → stepId
    for (const n of nodes) idMap.set(n.id, n.data.stepId);

    const transitions = edges.map((e) => {
      const tr: Record<string, unknown> = {
        id: e.id,
        source: idMap.get(e.source) ?? e.source,
        target: idMap.get(e.target) ?? e.target,
      };
      const guard = (e.data?.guard as string | undefined)?.trim();
      if (guard) tr.guard = JSON.parse(guard);
      return tr;
    });

    const steps = nodes.map((n) => {
      const d = n.data;
      const s: Record<string, unknown> = { id: d.stepId, kind: d.kind, position: n.position };
      if (d.kind === 'agent') {
        s.agentId = d.agentId;
        if (d.prompt.trim()) s.prompt = d.prompt;
      } else if (d.kind === 'action') {
        s.actionId = d.actionId;
        if (d.input.trim()) s.input = JSON.parse(d.input);
      } else {
        s.human = {
          principal: { kind: d.human.principalKind, ref: d.human.principalRef },
          channel: d.human.channel,
          message: d.human.message,
          ...(d.human.reminderInterval.trim() ? { reminderInterval: d.human.reminderInterval } : {}),
          ...(d.human.deadline.trim() ? { deadline: d.human.deadline } : {}),
          quorum: d.human.quorum,
        };
      }
      if (d.postcondition.trim()) s.postcondition = JSON.parse(d.postcondition);
      if (d.fallbackTransitionId.trim()) s.fallbackTransitionId = d.fallbackTransitionId;
      return s;
    });

    const entry = nodes.find((n) => n.data.isEntry) ?? nodes[0];
    const trigger: Record<string, unknown> = { id: 'tr', kind: triggerKind };
    if (triggerKind === 'event' && triggerEventId.trim()) trigger.eventId = triggerEventId;
    if (triggerKind === 'cron' && triggerCron.trim()) trigger.cron = triggerCron;

    return {
      graph: {
        entryStepId: entry?.data.stepId ?? '',
        steps,
        transitions,
        triggers: [trigger],
      },
    };
  }, [nodes, edges, triggerKind, triggerEventId, triggerCron]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setValidationErrors([]);
    let graph: unknown;
    try {
      graph = buildGraph().graph;
    } catch (err) {
      setSaveError(`JSON field error: ${err instanceof Error ? err.message : String(err)}`);
      setSaving(false);
      return;
    }
    try {
      await publishConductorWorkflow({ slug, name, graph, enable: true });
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        try {
          const body = JSON.parse(err.body) as { errors?: ValidationError[] };
          if (Array.isArray(body.errors)) setValidationErrors(body.errors);
        } catch {
          /* not json */
        }
        setSaveError(err.message);
      } else setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  }, [buildGraph, slug, name, onSaved]);

  // Rehydrate the canvas (nodes/edges/trigger) from a serialized WorkflowGraph. Shared by the
  // "Load existing workflow" path and the conversational builder (US7), which pushes its evolving
  // draft graph in via `loadGraphRequest` so the chat and the canvas are two windows on one draft.
  const hydrateFromGraph = useCallback((graph: unknown) => {
    const g = graph as {
      entryStepId: string;
      steps: Array<Record<string, unknown>>;
      transitions?: Array<Record<string, unknown>>;
      triggers?: Array<Record<string, unknown>>;
    };
    if (!g || !Array.isArray(g.steps)) return;
    const transitionsIn = Array.isArray(g.transitions) ? g.transitions : [];
    {
      const newNodes: StepNode[] = g.steps.map((step, i) => {
        const kind = step.kind as StepKind;
        const base = emptyData(kind, i + 1);
        const human = (step.human ?? {}) as Record<string, unknown>;
        const principal = (human.principal ?? {}) as Record<string, unknown>;
        const pos = (step.position ?? { x: 80 + (i % 4) * 200, y: 80 + Math.floor(i / 4) * 130 }) as { x: number; y: number };
        return {
          id: String(step.id),
          type: 'step',
          position: pos,
          data: {
            ...base,
            stepId: String(step.id),
            kind,
            agentId: String(step.agentId ?? ''),
            prompt: String(step.prompt ?? ''),
            actionId: String(step.actionId ?? ''),
            input: step.input ? JSON.stringify(step.input, null, 2) : '',
            human: {
              principalKind: (principal.kind as 'user' | 'role') ?? 'role',
              principalRef: String(principal.ref ?? ''),
              channel: String(human.channel ?? 'teams'),
              message: String(human.message ?? ''),
              reminderInterval: String(human.reminderInterval ?? ''),
              deadline: String(human.deadline ?? ''),
              quorum: (human.quorum as 'any' | 'all') ?? 'any',
            },
            postcondition: step.postcondition ? JSON.stringify(step.postcondition, null, 2) : '',
            fallbackTransitionId: String(step.fallbackTransitionId ?? ''),
            isEntry: step.id === g.entryStepId,
          },
        };
      });
      const newEdges: Edge[] = transitionsIn.map((tr) => ({
        id: String(tr.id),
        source: String(tr.source),
        target: String(tr.target),
        data: { guard: tr.guard ? JSON.stringify(tr.guard) : '' },
      }));
      setNodes(newNodes);
      setEdges(newEdges);
      nextId.current += g.steps.length + transitionsIn.length;
      const trig = g.triggers?.[0];
      if (trig) {
        setTriggerKind((trig.kind as 'manual' | 'event' | 'cron') ?? 'manual');
        setTriggerEventId(String(trig.eventId ?? ''));
        setTriggerCron(String(trig.cron ?? ''));
      }
    }
  }, []);

  const loadWorkflow = useCallback(
    async (wfSlug: string) => {
      try {
        const { workflow, graph } = await getConductorWorkflowGraph(wfSlug);
        setSlug(workflow.slug);
        setName(workflow.name);
        hydrateFromGraph(graph);
      } catch (err) {
        setSaveError(err instanceof ApiError ? err.message : String(err));
      }
    },
    [hydrateFromGraph],
  );

  // Load the workflow the parent asked us to edit. The parent hands us a fresh
  // object (new nonce) on every "Edit" click, so this fires once per click.
  useEffect(() => {
    if (editRequest?.slug) void loadWorkflow(editRequest.slug);
  }, [editRequest, loadWorkflow]);

  // Mirror the conversational builder's draft into the canvas (US7). A new nonce each turn means a
  // re-push of the same-shaped graph still re-renders, so chat edits show up live on the canvas.
  useEffect(() => {
    if (loadGraphRequest) hydrateFromGraph(loadGraphRequest.graph);
  }, [loadGraphRequest, hydrateFromGraph]);

  const handleRun = useCallback(async () => {
    if (!slug) return;
    const now = Date.now();
    if (now - lastAction.current < 600) return;
    lastAction.current = now;
    setBusy(true);
    setRunResult(null);
    try {
      const started = await startConductorRun(slug, {});
      setRunResult(started);
      for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        const latest = await getConductorRun(slug, started.run.id);
        setRunResult(latest);
        if (latest.run.status !== 'running') break;
      }
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [slug]);

  const handlePreview = useCallback(async () => {
    if (!slug) return;
    const now = Date.now();
    if (now - lastAction.current < 600) return;
    lastAction.current = now;
    setPreviewing(true);
    setPreviewResult(null);
    try {
      setPreviewResult(await previewConductorWorkflow(slug, {}));
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setPreviewing(false);
    }
  }, [slug]);

  const sel = useMemo(() => nodes.find((n) => n.id === selectedNode) ?? null, [nodes, selectedNode]);
  const selEdge = useMemo(() => edges.find((e) => e.id === selectedEdge) ?? null, [edges, selectedEdge]);

  const input =
    'w-full rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1 text-[13px] text-[color:var(--fg-strong)]';
  const lbl = 'grid gap-1 text-[12px] text-[color:var(--fg-muted)]';

  return (
    <div className="grid gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-3">
        <label className={lbl}>
          {t('slugLabel')}
          <input className={input} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="release-signoff" />
        </label>
        <label className={lbl}>
          {t('nameLabel')}
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Release sign-off" />
        </label>
        <label className={lbl}>
          {t('triggerLabel')}
          <select className={input} value={triggerKind} onChange={(e) => setTriggerKind(e.target.value as 'manual' | 'event' | 'cron')}>
            <option value="manual">manual</option>
            <option value="event">event</option>
            <option value="cron">cron</option>
          </select>
        </label>
        {triggerKind === 'event' && (
          <label className={lbl}>
            {t('eventIdLabel')}
            {/* Pick a declared event from the live catalog (datalist), or type a custom id. */}
            <input
              className={input}
              list={eventListId}
              value={triggerEventId}
              onChange={(e) => setTriggerEventId(e.target.value)}
              placeholder="github.pull_request.merged"
            />
            <datalist id={eventListId}>
              {[...new Set(eventCatalog)].map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            <span className="mt-1 text-[12px] text-[color:var(--fg-muted)]">
              {eventCatalog.length > 0 ? t('eventCatalogHint', { count: eventCatalog.length }) : t('eventCatalogEmpty')}
            </span>
          </label>
        )}
        {triggerKind === 'cron' && (
          <label className={lbl}>
            cron
            <input className={input} value={triggerCron} onChange={(e) => setTriggerCron(e.target.value)} placeholder="0 9 * * 1" />
          </label>
        )}
        <label className={lbl}>
          {t('loadLabel')}
          <select className={input} value="" onChange={(e) => e.target.value && void loadWorkflow(e.target.value)}>
            <option value="">—</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.slug}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <Button variant="primary" busy={saving} disabled={saving} onClick={() => void handleSave()}>
          {saving ? t('publishing') : t('saveButton')}
        </Button>
        <Button variant="secondary" busy={busy} disabled={busy || !slug} onClick={() => void handleRun()}>
          {busy ? t('running') : t('runButton')}
        </Button>
        <Button variant="ghost" busy={previewing} disabled={previewing || !slug} onClick={() => void handlePreview()}>
          {previewing ? t('previewing') : t('dryRunButton')}
        </Button>
      </div>

      {saveError && <p className="text-[14px] text-[color:var(--danger,#e5484d)]">{saveError}</p>}
      {validationErrors.length > 0 && (
        <div className="rounded-md border border-[color:var(--danger,#e5484d)] p-3">
          <div className="mb-1 text-[13px] font-semibold text-[color:var(--danger,#e5484d)]">{t('validationHeading')}</div>
          <ul className="list-inside list-disc text-[13px] text-[color:var(--fg-muted)]">
            {validationErrors.map((v, i) => (
              <li key={i}>
                <span className="font-mono">{v.code}</span>: {v.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Palette */}
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => addStep('agent')}>
          + {t('addAgent')}
        </Button>
        <Button variant="ghost" onClick={() => addStep('action')}>
          + {t('addAction')}
        </Button>
        <Button variant="ghost" onClick={() => addStep('human')}>
          + {t('addHuman')}
        </Button>
        {(selectedNode || selectedEdge) && (
          <Button variant="ghost" onClick={deleteSelected}>
            {t('deleteSelected')}
          </Button>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* Canvas */}
        <div className="h-[480px] rounded-lg border border-[color:var(--border)]">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_e, n) => {
              setSelectedNode(n.id);
              setSelectedEdge(null);
            }}
            onEdgeClick={(_e, ed) => {
              setSelectedEdge(ed.id);
              setSelectedNode(null);
            }}
            onPaneClick={() => {
              setSelectedNode(null);
              setSelectedEdge(null);
            }}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>

        {/* Inspector */}
        <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-3">
          {!sel && !selEdge && <p className="text-[13px] text-[color:var(--fg-muted)]">{t('inspectorEmpty')}</p>}

          {sel && (
            <div className="grid gap-3">
              <div className="text-[12px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">
                {sel.data.kind} {t('stepLabel')}
              </div>
              <label className={lbl}>
                {t('stepIdLabel')}
                <input className={input} value={sel.data.stepId} onChange={(e) => patchNode(sel.id, { stepId: e.target.value })} />
              </label>
              {sel.data.kind === 'agent' && (
                <>
                  <label className={lbl}>
                    {t('agentSlugLabel')}
                    <input className={input} value={sel.data.agentId} onChange={(e) => patchNode(sel.id, { agentId: e.target.value })} />
                  </label>
                  <label className={lbl}>
                    {t('promptLabel')}
                    <textarea className={`${input} min-h-[80px]`} value={sel.data.prompt} onChange={(e) => patchNode(sel.id, { prompt: e.target.value })} />
                  </label>
                </>
              )}
              {sel.data.kind === 'action' && (
                <>
                  <label className={lbl}>
                    {t('actionIdLabel')}
                    <input className={input} value={sel.data.actionId} onChange={(e) => patchNode(sel.id, { actionId: e.target.value })} />
                  </label>
                  <label className={lbl}>
                    {t('inputLabel')}
                    <textarea className={`${input} min-h-[60px] font-mono`} value={sel.data.input} onChange={(e) => patchNode(sel.id, { input: e.target.value })} placeholder="{}" />
                  </label>
                </>
              )}
              {sel.data.kind === 'human' && (
                <>
                  <label className={lbl}>
                    {t('principalLabel')}
                    <div className="flex gap-2">
                      <select
                        className={input}
                        value={sel.data.human.principalKind}
                        onChange={(e) => patchNode(sel.id, { human: { ...sel.data.human, principalKind: e.target.value as 'user' | 'role' } })}
                      >
                        <option value="role">role</option>
                        <option value="user">user</option>
                      </select>
                      <input
                        className={input}
                        value={sel.data.human.principalRef}
                        onChange={(e) => patchNode(sel.id, { human: { ...sel.data.human, principalRef: e.target.value } })}
                        placeholder="approver.release"
                      />
                    </div>
                  </label>
                  <label className={lbl}>
                    {t('channelLabel')}
                    <input className={input} value={sel.data.human.channel} onChange={(e) => patchNode(sel.id, { human: { ...sel.data.human, channel: e.target.value } })} />
                  </label>
                  <label className={lbl}>
                    {t('messageLabel')}
                    <textarea className={`${input} min-h-[50px]`} value={sel.data.human.message} onChange={(e) => patchNode(sel.id, { human: { ...sel.data.human, message: e.target.value } })} />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className={lbl}>
                      {t('reminderLabel')}
                      <input className={input} value={sel.data.human.reminderInterval} onChange={(e) => patchNode(sel.id, { human: { ...sel.data.human, reminderInterval: e.target.value } })} placeholder="PT6H" />
                    </label>
                    <label className={lbl}>
                      {t('deadlineLabel')}
                      <input className={input} value={sel.data.human.deadline} onChange={(e) => patchNode(sel.id, { human: { ...sel.data.human, deadline: e.target.value } })} placeholder="PT24H" />
                    </label>
                  </div>
                </>
              )}
              <label className={lbl}>
                {t('postconditionLabel')}
                <textarea className={`${input} min-h-[50px] font-mono`} value={sel.data.postcondition} onChange={(e) => patchNode(sel.id, { postcondition: e.target.value })} placeholder='{"op":"exists","path":"stepResult.text"}' />
              </label>
              <label className={lbl}>
                {t('fallbackLabel')}
                <select className={input} value={sel.data.fallbackTransitionId} onChange={(e) => patchNode(sel.id, { fallbackTransitionId: e.target.value })}>
                  <option value="">—</option>
                  {edges.filter((e) => e.source === sel.id).map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2 text-[13px] text-[color:var(--fg-muted)]">
                <input type="checkbox" checked={sel.data.isEntry} onChange={() => setEntry(sel.id)} />
                {t('entryLabel')}
              </label>
            </div>
          )}

          {selEdge && (
            <div className="grid gap-3">
              <div className="text-[12px] font-semibold uppercase tracking-wider text-[color:var(--fg-muted)]">{t('transitionLabel')}</div>
              <div className="font-mono text-[12px] text-[color:var(--fg-muted)]">{selEdge.id}</div>
              <label className={lbl}>
                {t('guardLabel')}
                <textarea
                  className={`${input} min-h-[60px] font-mono`}
                  value={(selEdge.data?.guard as string) ?? ''}
                  onChange={(e) => setEdges((es) => es.map((ed) => (ed.id === selEdge.id ? { ...ed, data: { ...ed.data, guard: e.target.value } } : ed)))}
                  placeholder='{"op":"eq","path":"stepResult.approved","value":true}'
                />
              </label>
            </div>
          )}
        </div>
      </div>

      {runResult && (
        <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-3">
          <div className="mb-2 text-[14px] text-[color:var(--fg-strong)]">
            {t('lastRunHeading')} · {t('statusLabel')}: <span className="font-mono">{runResult.run.status}</span>
          </div>
          <pre className="overflow-x-auto rounded-md bg-black/20 p-3 text-[12px] text-[color:var(--fg-strong)]">
            {JSON.stringify(runResult.run.context, null, 2)}
          </pre>
        </div>
      )}

      {previewResult && (
        <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]/40 p-3">
          <div className="mb-2 text-[14px] text-[color:var(--fg-strong)]">
            {t('dryRunHeading')} · {t('statusLabel')}: <span className="font-mono">{previewResult.status}</span>
          </div>
          <p className="mb-2 text-[12px] text-[color:var(--fg-muted)]">{t('dryRunHint')}</p>
          <table className="w-full text-left text-[13px]">
            <thead className="text-[color:var(--fg-muted)]">
              <tr>
                <th className="py-1 pr-3">{t('colStep')}</th>
                <th className="py-1 pr-3">actor</th>
                <th className="py-1 pr-3">{t('colPostcondition')}</th>
                <th className="py-1">{t('colTransition')}</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {previewResult.steps.map((s, i) => (
                <tr key={i} className="border-t border-[color:var(--border)]">
                  <td className="py-1 pr-3">{s.stepId}</td>
                  <td className="py-1 pr-3 text-[11px]">{s.actor}</td>
                  <td className="py-1 pr-3">{s.postcondition}</td>
                  <td className="py-1">{s.transition ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ConductorCanvas(props: {
  workflows: ConductorWorkflow[];
  onSaved: () => void;
  editRequest?: CanvasEditRequest | null;
  loadGraphRequest?: CanvasGraphRequest | null;
}): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <CanvasInner
        {...props}
        editRequest={props.editRequest ?? null}
        loadGraphRequest={props.loadGraphRequest ?? null}
      />
    </ReactFlowProvider>
  );
}
