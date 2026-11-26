'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import {
  addEdge,
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type EdgeChangeset,
  type Node,
  type NodeChangeset,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { Button } from '@/app/_components/ui/Button';
import { ChannelSelect, DurationInput, QuorumSelect, RefPicker, SelectPicker } from './GuidedControls';
import { ScheduleBuilder } from './ScheduleBuilder';
import { ConditionBuilder } from './ConditionBuilder';
import { KeyValueEditor } from './KeyValueEditor';
import {
  ApiError,
  getConductorActions,
  getConductorAgents,
  getConductorEventCatalog,
  getConductorRoles,
  getConductorRun,
  getConductorWorkflowGraph,
  previewConductorWorkflow,
  type ConductorValidationWarning,
  startConductorRun,
  type ConductorPreviewResult,
  type ConductorRunResult,
  type ConductorWorkflow,
} from '@/app/_lib/api';
import { KIND_BADGE_FG, KIND_COLOR } from './stepKindColors';
import { describeActionId } from './actionIdLabel';
import { PersonPicker } from './PersonPicker';
import { publishConductorDraft } from './draftPublish';

// ── Node data model ────────────────────────────────────────────────────────
// node.id is a stable internal id; data.stepId is the user-facing (renameable)
// step id used in the serialized graph, so renaming never breaks edges.

type StepKind = 'agent' | 'action' | 'human' | 'timer';
const TRIGGER_KINDS = ['manual', 'event', 'cron', 'webhook', 'channel', 'agent', 'workflow'] as const;
type TriggerKind = typeof TRIGGER_KINDS[number];
type Trigger = Record<string, unknown> & { id: string; kind: TriggerKind };
const NEW_TRIGGER: Trigger = { id: 'tr', kind: 'manual' };

/** #1698 — the guards a new edge out of a human step starts with: approval, then rejection. */
const APPROVED_GUARD = JSON.stringify({ op: 'eq', path: 'stepResult.approved', value: true });
const REJECTED_GUARD = JSON.stringify({ op: 'eq', path: 'stepResult.approved', value: false });

interface StepNodeData extends Record<string, unknown> {
  stepId: string;
  kind: StepKind;
  agentId: string;
  prompt: string;
  actionId: string;
  actionServerName?: string;
  original?: Record<string, unknown>;
  initialPosition?: Node['position'];
  timerDuration: string;
  input: string; // JSON string
  human: {
    principalKind: 'user' | 'role';
    principalRef: string;
    channel: string;
    message: string;
    reminderInterval: string;
    deadline: string;
    quorum: 'any' | 'all';
    /** #759 — only an explicit {approved:true} approves. */
    strictApproval: boolean;
  };
  postcondition: string; // JSON string, optional
  fallbackTransitionId: string;
  isEntry: boolean;
}

type StepNode = Node<StepNodeData>;

function StepNodeView({ data, selected }: NodeProps<StepNode>): React.JSX.Element {
  const t = useTranslations('conductor');
  const action = data.kind === 'action' ? describeActionId(data.actionId, data.actionServerName) : null;
  const primary =
    data.kind === 'agent' ? data.agentId || '—'
      : data.kind === 'action' ? action?.label || '—'
      : data.kind === 'timer' ? data.timerDuration || '—' : data.human.principalRef || '—';
  return (
    <div
      style={{ borderColor: selected ? 'var(--fg-strong)' : KIND_COLOR[data.kind] }}
      className="min-w-[150px] rounded-md border-2 bg-[color:var(--card)] px-3 py-2 text-[color:var(--fg-strong)] shadow"
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span
          className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase"
          style={{ background: KIND_COLOR[data.kind], color: KIND_BADGE_FG }}
        >
          {t(`stepKinds.${data.kind}`)}
        </span>
        {data.isEntry && (
          <span className="rounded bg-[color:var(--fg-strong)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--card)]">
            {t('entryLabel')}
          </span>
        )}
      </div>
      <div className="mt-1 font-mono text-[13px] font-medium">{data.stepId}</div>
      <div className="font-mono text-[11px] text-[color:var(--fg-muted)]">
        {primary}
        {action?.isMcp ? <span className="ml-1 rounded bg-black/20 px-1 text-[9px] font-semibold uppercase">{t('actionMcpBadge')}</span> : null}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes: NodeTypes = { step: StepNodeView };

function emptyData(kind: StepKind, n: number, defaultPrompt = ''): StepNodeData {
  return {
    stepId: `${kind}-${n}`,
    kind,
    agentId: kind === 'agent' ? 'fallback' : '',
    prompt: kind === 'agent' ? defaultPrompt : '',
    actionId: '',
    timerDuration: '',
    input: '',
    human: {
      principalKind: 'role',
      principalRef: '',
      channel: 'teams',
      message: '',
      reminderInterval: '',
      deadline: '',
      quorum: 'any',
      strictApproval: false,
    },
    postcondition: '',
    fallbackTransitionId: '',
    isEntry: n === 1,
  };
}

/** #1698 — one definition of "this edge leaves a human step", used by the connect handler
 *  (against a ref) and by the inspector hint (against render-time state). */
function isHumanNode(ns: StepNode[], id: string | null | undefined): boolean {
  return ns.some((n) => n.id === id && n.data.kind === 'human');
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
// The template instantiation path (#429) additionally carries the instance slug/name so the
// canvas form is publish-ready — and never publishes the template graph over a previously
// loaded workflow's slug — plus the template form's `enable` choice, so Save honors the
// default-off toggle (a cron template left disabled must not start its schedule just because
// it was routed through the designer). The chat draft path omits all three.
export interface CanvasGraphRequest {
  graph: unknown;
  nonce: number;
  slug?: string;
  name?: string;
  enable?: boolean;
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
  // #1698 — `onConnect` needs the node list to see whether the edge leaves a human step, but
  // `nodes` changes on every drag; a ref keeps the callback dependency-free like every other
  // one in this file (the rest reach their state through functional updaters).
  const nodesRef = useRef<StepNode[]>([]);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);

  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState<string | null>(null);
  const [scheduleZones, setScheduleZones] = useState<{ slug: string; byCron: Record<string, string> } | null>(null);
  // Auto-derive the slug from the name until the user edits the slug directly (or a workflow loads).
  const slugEdited = useRef(false);
  const [triggers, setTriggers] = useState<Trigger[] | undefined>([NEW_TRIGGER]);
  const originalGraph = useRef<Record<string, unknown>>({});
  const activeTrigger = triggers?.[0] ?? NEW_TRIGGER;
  const triggerKind = activeTrigger.kind;
  const triggerEventId = String(activeTrigger.eventId ?? '');
  const triggerCron = String(activeTrigger.cron ?? '');
  const dirty = useRef(false);
  const revision = useRef(0);
  const loadToken = useRef(0);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [undoDeletion, setUndoDeletion] = useState<{ nodes: StepNode[]; edges: Edge[]; wasDirty: boolean } | null>(null);

  const setDirty = useCallback((value: boolean) => {
    dirty.current = value;
    setHasUnsavedChanges(value);
  }, []);
  const markEdited = useCallback(() => {
    revision.current += 1;
    setDirty(true);
    setUndoDeletion(null);
  }, [setDirty]);
  const allowDiscard = useCallback(() => !dirty.current || window.confirm(t('discardCanvasChanges')), [t]);
  const patchTrigger = useCallback((patch: Partial<Trigger>) => {
    markEdited();
    setTriggers((current) => {
      const [first = NEW_TRIGGER, ...rest] = current ?? [];
      const next = { ...first, ...patch };
      if (next.kind !== first.kind) {
        if (next.kind !== 'event' && next.kind !== 'webhook') delete next.eventId;
        if (next.kind !== 'cron') delete next.cron;
        if (next.kind !== 'event' && next.kind !== 'webhook') delete next.filter;
      }
      return [next, ...rest];
    });
  }, [markEdited]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const editorUrl = window.location.href;
    const editorState: unknown = window.history.state;
    const navigation = (window as Window & {
      navigation?: {
        currentEntry: { key: string } | null;
        traverseTo: (key: string) => { finished: Promise<unknown> };
      };
    }).navigation;
    const editorEntry = navigation?.currentEntry?.key;
    let restoringEntry = false;
    let confirmedLink = false;
    const onUnload = (event: BeforeUnloadEvent) => {
      if (confirmedLink) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const onLink = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!link || link.download || (link.target && link.target !== '_self')) return;
      const url = new URL(link.href);
      // Full-document navigation uses beforeunload. The app's same-origin links can navigate
      // client-side, so guard those before their click handlers run.
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      if (!allowDiscard()) {
        event.preventDefault();
        event.stopPropagation();
      } else {
        confirmedLink = true;
        window.setTimeout(() => { confirmedLink = false; }, 0);
      }
    };
    const onHistory = (event: PopStateEvent) => {
      if (restoringEntry) {
        event.stopImmediatePropagation();
        return;
      }
      if (window.location.pathname === new URL(editorUrl).pathname || allowDiscard()) return;
      // Back/Forward already moved the history cursor. Stop Next from applying the
      // route, then restore the editor entry without reloading its component state.
      event.stopImmediatePropagation();
      if (navigation && editorEntry) {
        restoringEntry = true;
        void navigation.traverseTo(editorEntry).finished
          .catch(() => window.history.pushState(editorState, '', editorUrl))
          .finally(() => { restoringEntry = false; });
      } else {
        window.history.pushState(editorState, '', editorUrl);
      }
    };
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('popstate', onHistory, true);
    document.addEventListener('click', onLink, true);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('popstate', onHistory, true);
      document.removeEventListener('click', onLink, true);
    };
  }, [allowDiscard, hasUnsavedChanges]);
  // Declared emittable events (US4 / FR-028) — the Designer sources the event-trigger picker from the
  // live catalog. Best-effort: an empty catalog just falls back to free-text entry.
  const [eventCatalog, setEventCatalog] = useState<string[]>([]);
  // Known role keys (US6) — source for the human-step principal picker. Best-effort like the events.
  const [roleCatalog, setRoleCatalog] = useState<string[]>([]);
  // Live agent + action catalogs — real dropdowns for the agent/action steps. Best-effort.
  const [agentCatalog, setAgentCatalog] = useState<Array<{ slug: string; name: string }>>([]);
  const [actionCatalog, setActionCatalog] = useState<string[]>([]);
  const [actionServerNames, setActionServerNames] = useState<Record<string, string>>({});
  const displayNodes = useMemo(() => nodes.map((node) => {
    const actionServerName = actionServerNames[node.data.actionId];
    return node.data.kind === 'action' && actionServerName
      ? { ...node, data: { ...node.data, actionServerName } }
      : node;
  }), [nodes, actionServerNames]);
  const eventListId = useId(); // unique per canvas instance — no datalist id collision on double-mount

  useEffect(() => {
    let cancelled = false;
    void getConductorEventCatalog()
      .then((c) => {
        // Defensive: a 200 with an unexpected body would otherwise make state non-array and crash render.
        // #1713: the ids of inbound webhook endpoints are emittable here too (operator-minted,
        // so no manifest declares them) — suggested alongside the plugin-declared ones.
        const declared = Array.isArray(c?.events) ? c.events : [];
        const endpoints = Array.isArray(c?.endpointEvents) ? c.endpointEvents : [];
        if (!cancelled) setEventCatalog([...new Set([...declared, ...endpoints])].sort());
      })
      // Errors degrade to the empty-catalog hint + free-text entry. (A 401 still triggers getJson's
      // standard login redirect — same as every other page fetch — which is the desired behaviour.)
      .catch(() => undefined);
    void getConductorRoles()
      .then((r) => {
        if (!cancelled) setRoleCatalog(Array.isArray(r?.roles) ? r.roles.map((x) => x.key).filter(Boolean) : []);
      })
      .catch(() => undefined);
    void getConductorAgents()
      .then((r) => {
        if (!cancelled) setAgentCatalog(Array.isArray(r?.agents) ? r.agents.filter((a) => a.slug) : []);
      })
      .catch(() => undefined);
    void getConductorActions()
      .then((r) => {
        if (!cancelled) {
          setActionCatalog(Array.isArray(r?.actions) ? r.actions.filter(Boolean) : []);
          setActionServerNames(r?.serverNames ?? {});
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // What `enable` to publish with on Save. Hand-built and edited workflows keep the historical
  // enabled-on-save behaviour (and the store only applies `enable` on FIRST create anyway — a
  // re-publish never flips an existing workflow's status). A template handoff (#429) overrides
  // it with the form's default-off toggle so "Open in designer" → Save cannot silently enable
  // a scheduled template the operator chose to keep off.
  const publishEnable = useRef(true);
  // Monotonic id source — guarantees unique node/edge ids even if a click double-fires.
  const nextId = useRef(0);
  const lastAction = useRef(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  // #759 — non-blocking warnings from a SUCCESSFUL publish (amber, not red).
  const [validationWarnings, setValidationWarnings] = useState<ConductorValidationWarning[]>([]);
  const [runResult, setRunResult] = useState<ConductorRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewResult, setPreviewResult] = useState<ConductorPreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const onNodesChange = useCallback((changes: NodeChangeset<StepNode>) => {
    if (changes.getByType('position').some((change) => change.position)) markEdited();
    setNodes((ns) => changes.applyTo(ns));
  }, [markEdited]);
  const onEdgesChange = useCallback((changes: EdgeChangeset) => {
    setEdges((es) => changes.applyTo(es));
  }, []);
  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    markEdited();
    nextId.current += 1;
    while (edges.some((edge) => edge.id === `t-${String(nextId.current)}`)) nextId.current += 1;
    const id = `t-${String(nextId.current)}`;
    // #1698 — an edge drawn OUT OF A HUMAN STEP is pre-filled with a guard. An unguarded edge
    // can no longer carry a rejection (the engine refuses to take it), so an empty guard here
    // is the shape that leaves a rejected run with nowhere to go. The FIRST such edge gets the
    // approval guard and the next one the rejection guard — which is the two-edge shape the
    // inspector hint asks for, and pre-filling `true` twice would instead collide at run time
    // as `ambiguous_guards`. Everything the author drew stays editable in the inspector; every
    // edge out of a non-human step keeps starting empty.
    setEdges((es) => {
      const guard = isHumanNode(nodesRef.current, c.source)
        ? es.some((e) => e.source === c.source && (e.data?.guard as string | undefined) === APPROVED_GUARD)
          ? REJECTED_GUARD
          : APPROVED_GUARD
        : '';
      return addEdge({ ...c, id, data: { guard } }, es);
    });
  }, [edges, markEdited]);

  const addStep = useCallback((kind: StepKind) => {
    // Swallow a double-fired click (synthetic input / accidental double-click) so a
    // single intent never produces two nodes.
    const now = Date.now();
    if (now - lastAction.current < 350) return;
    lastAction.current = now;
    markEdited();
    nextId.current += 1;
    while (nodes.some((node) => node.id === `node-${nextId.current}` || node.data.stepId === `${kind}-${nextId.current}`)) {
      nextId.current += 1;
    }
    const n = nextId.current;
    const id = `node-${String(n)}`;
    setNodes((ns) => [
      ...ns,
      {
        id,
        type: 'step',
        position: { x: 80 + (ns.length % 4) * 200, y: 80 + Math.floor(ns.length / 4) * 130 },
        data: { ...emptyData(kind, n, t('defaultAgentPrompt')), isEntry: ns.length === 0 },
      },
    ]);
  }, [markEdited, nodes, t]);

  const patchNode = useCallback((nodeId: string, patch: Partial<StepNodeData>) => {
    markEdited();
    setNodes((ns) => ns.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node)));
  }, [markEdited]);

  const setEntry = useCallback((nodeId: string) => {
    markEdited();
    setNodes((ns) => ns.map((node) => ({ ...node, data: { ...node.data, isEntry: node.id === nodeId } })));
  }, [markEdited]);

  const deleteSelected = useCallback(() => {
    if (!selectedNode && !selectedEdge) return;
    setUndoDeletion({ nodes, edges, wasDirty: dirty.current });
    revision.current += 1;
    setDirty(true);
    if (selectedNode) {
      setNodes((ns) => ns.filter((n) => n.id !== selectedNode));
      setEdges((es) => es.filter((e) => e.source !== selectedNode && e.target !== selectedNode));
      setSelectedNode(null);
    } else if (selectedEdge) {
      setEdges((es) => es.filter((e) => e.id !== selectedEdge));
      setSelectedEdge(null);
    }
  }, [edges, nodes, selectedNode, selectedEdge, setDirty]);

  const undoDelete = useCallback(() => {
    if (!undoDeletion) return;
    revision.current += 1;
    setNodes(undoDeletion.nodes);
    setEdges(undoDeletion.edges);
    setDirty(undoDeletion.wasDirty);
    setUndoDeletion(null);
  }, [setDirty, undoDeletion]);

  // ── serialize canvas → graph JSON ─────────────────────────────────────────
  const buildGraph = useCallback((): { graph: unknown; error?: string } => {
    const idMap = new Map<string, string>(); // node.id → stepId
    for (const n of nodes) idMap.set(n.id, n.data.stepId);

    const transitions = edges.map((e) => {
      const tr: Record<string, unknown> = {
        ...(e.data?.original as Record<string, unknown> | undefined),
        id: e.id,
        source: idMap.get(e.source) ?? e.source,
        target: idMap.get(e.target) ?? e.target,
      };
      const guard = (e.data?.guard as string | undefined)?.trim();
      if (guard) tr.guard = JSON.parse(guard);
      else delete tr.guard;
      return tr;
    });

    const steps = nodes.map((n) => {
      const d = n.data;
      const s: Record<string, unknown> = { ...d.original, id: d.stepId, kind: d.kind };
      if (!d.initialPosition || n.position.x !== d.initialPosition.x || n.position.y !== d.initialPosition.y) {
        s.position = { ...(s.position as Record<string, unknown> | undefined), ...n.position };
      }
      if (d.kind === 'agent') {
        s.agentId = d.agentId;
        if (d.prompt || s.prompt !== undefined) s.prompt = d.prompt;
      } else if (d.kind === 'action') {
        s.actionId = d.actionId;
        if (d.input.trim()) s.input = JSON.parse(d.input);
        else delete s.input;
      } else if (d.kind === 'timer') {
        s.timer = { ...(s.timer as Record<string, unknown> | undefined), duration: d.timerDuration };
      } else {
        const human: Record<string, unknown> = {
          ...(s.human as Record<string, unknown> | undefined),
          channel: d.human.channel,
          message: d.human.message,
        };
        human.principal = { ...(human.principal as Record<string, unknown> | undefined), kind: d.human.principalKind, ref: d.human.principalRef };
        for (const key of ['reminderInterval', 'deadline'] as const) {
          if (d.human[key].trim()) human[key] = d.human[key];
          else if (human[key] != null) delete human[key];
        }
        if (human.quorum !== undefined || d.human.quorum !== 'any') human.quorum = d.human.quorum;
        if (human.strictApproval !== undefined || d.human.strictApproval) human.strictApproval = d.human.strictApproval;
        s.human = human;
      }
      if (d.postcondition.trim()) s.postcondition = JSON.parse(d.postcondition);
      else delete s.postcondition;
      if (d.fallbackTransitionId.trim()) s.fallbackTransitionId = d.fallbackTransitionId;
      else delete s.fallbackTransitionId;
      return s;
    });

    const entry = nodes.find((n) => n.data.isEntry) ?? nodes[0];

    return {
      graph: {
        ...originalGraph.current,
        entryStepId: entry?.data.stepId ?? '',
        steps,
        transitions,
        ...(triggers === undefined ? {} : { triggers }),
      },
    };
  }, [nodes, edges, triggers]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setValidationErrors([]);
    setValidationWarnings([]);
    const savedRevision = revision.current;
    let graph: unknown;
    try {
      graph = buildGraph().graph;
    } catch {
      setSaveError(t('invalidGraphJson'));
      setSaving(false);
      return;
    }
    try {
      const body = { slug, name, graph, enable: publishEnable.current, ...(description !== null ? { description } : {}) };
      const out = await publishConductorDraft(body, () => window.confirm(t('confirmPublishVersion', { slug })));
      if (!out) return;
      // #759 — surface non-blocking validator warnings on a successful publish.
      setValidationWarnings(out.warnings ?? []);
      if (savedRevision === revision.current) {
        setDirty(false);
        setUndoDeletion(null);
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        try {
          const body = JSON.parse(err.body) as { errors?: ValidationError[] };
          if (Array.isArray(body.errors)) setValidationErrors(body.errors);
        } catch {
          /* not json */
        }
        if (err.code === 'conductor.reserved_slug' || err.code === 'conductor.reserved_slug_prefix') {
          setSaveError(t('reservedWorkflowSlug', { slug }));
        } else if (err.code !== 'conductor.invalid_graph') {
          setSaveError(t('publishWorkflowFailed'));
        }
      } else setSaveError(t('publishWorkflowFailed'));
    } finally {
      setSaving(false);
    }
  }, [buildGraph, slug, name, description, onSaved, setDirty, t]);

  // Rehydrate the canvas (nodes/edges/trigger) from a serialized WorkflowGraph. Shared by the
  // "Load existing workflow" path and the conversational builder (US7), which pushes its evolving
  // draft graph in via `loadGraphRequest` so the chat and the canvas are two windows on one draft.
  const hydrateFromGraph = useCallback((graph: unknown) => {
    const g = graph as {
      entryStepId: string;
      steps: Array<Record<string, unknown>>;
      transitions?: Array<Record<string, unknown>>;
      triggers?: Trigger[];
    };
    if (!g || !Array.isArray(g.steps)) return;
    originalGraph.current = g;
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
            original: step,
            initialPosition: pos,
            stepId: String(step.id),
            kind,
            agentId: String(step.agentId ?? ''),
            prompt: String(step.prompt ?? ''),
            actionId: String(step.actionId ?? ''),
            input: step.input !== undefined ? JSON.stringify(step.input, null, 2) : '',
            timerDuration: String((step.timer as { duration?: string } | undefined)?.duration ?? ''),
            human: {
              principalKind: (principal.kind as 'user' | 'role') ?? 'role',
              principalRef: String(principal.ref ?? ''),
              channel: String(human.channel ?? 'teams'),
              message: String(human.message ?? ''),
              reminderInterval: String(human.reminderInterval ?? ''),
              deadline: String(human.deadline ?? ''),
              quorum: (human.quorum as 'any' | 'all') ?? 'any',
              strictApproval: human.strictApproval === true,
            },
            postcondition: step.postcondition !== undefined ? JSON.stringify(step.postcondition, null, 2) : '',
            fallbackTransitionId: String(step.fallbackTransitionId ?? ''),
            isEntry: step.id === g.entryStepId,
          },
        };
      });
      const newEdges: Edge[] = transitionsIn.map((tr) => ({
        id: String(tr.id),
        source: String(tr.source),
        target: String(tr.target),
        data: { original: tr, guard: tr.guard !== undefined ? JSON.stringify(tr.guard) : '' },
      }));
      setNodes(newNodes);
      setEdges(newEdges);
      setSelectedNode(null);
      setSelectedEdge(null);
      setUndoDeletion(null);
      nextId.current += g.steps.length + transitionsIn.length;
      setTriggers(g.triggers);
    }
  }, []);

  const loadWorkflow = useCallback(
    async (wfSlug: string) => {
      if (!allowDiscard()) return;
      const token = ++loadToken.current;
      const atRevision = revision.current;
      try {
        const { workflow, graph, schedules } = await getConductorWorkflowGraph(wfSlug);
        if (token !== loadToken.current || atRevision !== revision.current) return;
        revision.current += 1;
        slugEdited.current = true; // a loaded workflow keeps its slug; don't auto-rewrite from the name
        publishEnable.current = true; // back to the ordinary save semantics (no-op for existing slugs)
        setSlug(workflow.slug);
        setName(workflow.name);
        setDescription(workflow.description);
        setScheduleZones({
          slug: workflow.slug,
          byCron: Object.fromEntries((schedules ?? []).map((schedule) => [schedule.cron.trim(), schedule.timezone])),
        });
        hydrateFromGraph(graph);
        setDirty(false);
      } catch (err) {
        setSaveError(err instanceof ApiError ? err.message : String(err));
      }
    },
    [allowDiscard, hydrateFromGraph, setDirty],
  );

  // Load the workflow the parent asked us to edit. The parent hands us a fresh
  // object (new nonce) on every "Edit" click, so this fires once per click.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- prop-nonce-triggered imperative load
    if (editRequest?.slug) void loadWorkflow(editRequest.slug);
  }, [editRequest, loadWorkflow]);

  // Mirror the conversational builder's draft into the canvas (US7). A new nonce each turn means a
  // re-push of the same-shaped graph still re-renders, so chat edits show up live on the canvas.
  // A request carrying slug/name (template instantiation, #429) also (re)targets the form fields,
  // replacing whatever workflow identity a previous load left behind, and its `enable` choice
  // becomes the publish flag for Save. Requests without `enable` (chat drafts) reset to the
  // ordinary enabled-on-save behaviour so a stale template flag never leaks into a later draft.
  useEffect(() => {
    if (!loadGraphRequest || !allowDiscard()) return;
    loadToken.current += 1;
    revision.current += 1;
    publishEnable.current = loadGraphRequest.enable ?? true;
    slugEdited.current = loadGraphRequest.slug !== undefined;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- prop-nonce-triggered imperative load
    setSlug(loadGraphRequest.slug ?? '');
    setName(loadGraphRequest.name ?? '');
    setDescription(null);
    setScheduleZones(null);
    hydrateFromGraph(loadGraphRequest.graph);
    setDirty(true);
  }, [loadGraphRequest, hydrateFromGraph, allowDiscard, setDirty]);

  const onCanvasDeleteKey = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Backspace' && event.key !== 'Delete') return;
    if (!(event.target instanceof Element) || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (selectedNode || selectedEdge) {
      event.preventDefault();
      deleteSelected();
    }
  }, [deleteSelected, selectedNode, selectedEdge]);

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
          {t('nameLabel')}
          <input
            className={input}
            value={name}
            onChange={(e) => {
              markEdited();
              setName(e.target.value);
              if (!slugEdited.current) setSlug(slugify(e.target.value));
            }}
            placeholder="Release sign-off"
          />
        </label>
        <label className={lbl}>
          {t('slugLabel')}
          <input
            className={`${input} font-mono`}
            value={slug}
            onChange={(e) => {
              markEdited();
              slugEdited.current = true;
              setSlug(slugifyLive(e.target.value));
            }}
            placeholder="release-signoff"
          />
        </label>
        <label className={lbl}>
          {t('triggerLabel')}
          <select className={input} value={triggerKind} onChange={(e) => patchTrigger({ kind: e.target.value as TriggerKind })}>
            {TRIGGER_KINDS.map((kind) => (
              <option key={kind} value={kind} disabled={kind === 'channel' || kind === 'agent' || kind === 'workflow'}>
                {t(`triggerKinds.${kind}`)}
              </option>
            ))}
          </select>
        </label>
        {(triggerKind === 'event' || triggerKind === 'webhook') && (
          <label className={lbl}>
            {t('eventIdLabel')}
            {/* Pick a known id from the live catalog (datalist), or type the id senders will post. */}
            <input
              className={input}
              list={eventListId}
              value={triggerEventId}
              onChange={(e) => patchTrigger({ eventId: e.target.value })}
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
          <div className="grid gap-1">
            <ScheduleBuilder
              label={t('scheduleWithZone', { zone: (scheduleZones?.slug === slug ? scheduleZones.byCron[triggerCron.trim()] : undefined) ?? 'UTC' })}
              value={triggerCron}
              onChange={(cron) => patchTrigger({ cron })}
            />
            <span className="text-[11px] text-[color:var(--fg-muted)]">{t('scheduleMissedSlots')}</span>
          </div>
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
        <Button variant="primary" busy={saving} disabled={saving || !slug || !name} onClick={() => void handleSave()}>
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
      {validationWarnings.length > 0 && (
        <div className="rounded-md border border-[color:var(--warning,#f5a623)] p-3">
          <div className="mb-1 text-[13px] font-semibold text-[color:var(--warning,#f5a623)]">{t('validationWarningsHeading')}</div>
          <ul className="list-inside list-disc text-[13px] text-[color:var(--fg-muted)]">
            {validationWarnings.map((v, i) => (
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
        <Button variant="ghost" onClick={() => addStep('timer')}>
          + {t('addTimer')}
        </Button>
        {(selectedNode || selectedEdge) && (
          <Button variant="ghost" onClick={deleteSelected}>
            {t('deleteSelected')}
          </Button>
        )}
        {undoDeletion && <Button variant="ghost" onClick={undoDelete}>{t('undoDeletion')}</Button>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* Canvas */}
        <div className="h-[480px] rounded-lg border border-[color:var(--border)]" onKeyDown={onCanvasDeleteKey}>
          <ReactFlow
            className="conductor-canvas"
            nodes={displayNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            deleteKeyCode={null}
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
                {t(`stepKinds.${sel.data.kind}`)} {t('stepLabel')}
              </div>
              <label className={lbl}>
                {t('stepIdLabel')}
                <input className={input} value={sel.data.stepId} onChange={(e) => patchNode(sel.id, { stepId: e.target.value })} />
              </label>
              {sel.data.kind === 'agent' && (
                <>
                  {agentCatalog.length > 0 ? (
                    <SelectPicker
                      label={t('agentSlugLabel')}
                      value={sel.data.agentId}
                      onChange={(v) => patchNode(sel.id, { agentId: v })}
                      options={agentCatalog.map((a) => ({ value: a.slug, label: `${a.name} (${a.slug})` }))}
                      emptyLabel={t('agentPick')}
                      hint={t('agentSlugHint')}
                    />
                  ) : (
                    <RefPicker
                      label={t('agentSlugLabel')}
                      value={sel.data.agentId}
                      onChange={(v) => patchNode(sel.id, { agentId: v })}
                      options={[]}
                      placeholder="fallback"
                      hint={t('agentSlugHint')}
                    />
                  )}
                  <label className={lbl}>
                    {t('promptLabel')}
                    <textarea className={`${input} min-h-[80px]`} value={sel.data.prompt} onChange={(e) => patchNode(sel.id, { prompt: e.target.value })} />
                  </label>
                </>
              )}
              {sel.data.kind === 'action' && (
                <>
                  {actionCatalog.length > 0 ? (
                    <SelectPicker
                      label={t('actionIdLabel')}
                      value={sel.data.actionId}
                      onChange={(v) => patchNode(sel.id, { actionId: v })}
                      options={actionCatalog.map((a) => ({ value: a, label: describeActionId(a, actionServerNames[a]).label }))}
                      emptyLabel={t('actionPick')}
                      hint={t('actionIdHint')}
                    />
                  ) : (
                    <RefPicker
                      label={t('actionIdLabel')}
                      value={sel.data.actionId}
                      onChange={(v) => patchNode(sel.id, { actionId: v })}
                      options={[]}
                      hint={t('actionIdHint')}
                    />
                  )}
                  <KeyValueEditor label={t('inputLabel')} value={sel.data.input} onChange={(v) => patchNode(sel.id, { input: v })} />
                </>
              )}
              {sel.data.kind === 'human' && (
                <>
                  <div className={lbl}>
                    {t('principalLabel')}
                    {/* Stacked, not side-by-side: the inspector is narrow and the people picker
                        needs the full width for its suggestion list (live check 2026-10-30). */}
                    <div className="grid gap-2">
                      <select
                        className={input}
                        value={sel.data.human.principalKind}
                        onChange={(e) => patchNode(sel.id, { human: { ...sel.data.human, principalKind: e.target.value as 'user' | 'role' } })}
                      >
                        <option value="role">{t('principalKinds.role')}</option>
                        <option value="user">{t('principalKinds.user')}</option>
                      </select>
                      <div className="min-w-0">
                        {sel.data.human.principalKind === 'role' ? (
                          <RefPicker
                            label=""
                            value={sel.data.human.principalRef}
                            onChange={(v) => patchNode(sel.id, { human: { ...sel.data.human, principalRef: v } })}
                            options={roleCatalog}
                            placeholder="approver.release"
                          />
                        ) : (
                          // People directory (channel plugins) — picking a candidate also pins the
                          // channel it is routable on; free text (an address) stays valid.
                          <PersonPicker
                            value={sel.data.human.principalRef}
                            channel={sel.data.human.channel}
                            onChange={(ref, candidate) =>
                              patchNode(sel.id, {
                                human: { ...sel.data.human, principalRef: ref, ...(candidate ? { channel: candidate.channelType } : {}) },
                              })
                            }
                          />
                        )}
                      </div>
                    </div>
                  </div>
                  <ChannelSelect
                    label={t('channelLabel')}
                    value={sel.data.human.channel}
                    onChange={(v) => patchNode(sel.id, { human: { ...sel.data.human, channel: v } })}
                  />
                  <label className={lbl}>
                    {t('messageLabel')}
                    <textarea className={`${input} min-h-[50px]`} value={sel.data.human.message} onChange={(e) => patchNode(sel.id, { human: { ...sel.data.human, message: e.target.value } })} />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <DurationInput
                      label={t('reminderLabel')}
                      value={sel.data.human.reminderInterval}
                      onChange={(v) => patchNode(sel.id, { human: { ...sel.data.human, reminderInterval: v } })}
                    />
                    <DurationInput
                      label={t('deadlineLabel')}
                      value={sel.data.human.deadline}
                      onChange={(v) => patchNode(sel.id, { human: { ...sel.data.human, deadline: v } })}
                    />
                  </div>
                  <QuorumSelect
                    label={t('quorumLabel')}
                    value={sel.data.human.quorum}
                    onChange={(q) => patchNode(sel.id, { human: { ...sel.data.human, quorum: q } })}
                  />
                  {/* #759 — strict approval: only an explicit approve advances. */}
                  <label className="flex items-start gap-2 text-[12px] text-[color:var(--fg-muted)]">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={sel.data.human.strictApproval}
                      onChange={(e) =>
                        patchNode(sel.id, { human: { ...sel.data.human, strictApproval: e.target.checked } })
                      }
                    />
                    <span>
                      {t('strictApprovalLabel')}
                      <span className="block text-[11px]">{t('strictApprovalHint')}</span>
                    </span>
                  </label>
                </>
              )}
              {sel.data.kind === 'timer' && (
                <DurationInput label={t('timerDuration')} value={sel.data.timerDuration}
                  onChange={(timerDuration) => patchNode(sel.id, { timerDuration })} />
              )}
              <ConditionBuilder
                label={t('postconditionLabel')}
                value={sel.data.postcondition}
                onChange={(v) => patchNode(sel.id, { postcondition: v })}
              />
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
              <ConditionBuilder
                label={t('guardLabel')}
                value={(selEdge.data?.guard as string) ?? ''}
                onChange={(v) => {
                  markEdited();
                  setEdges((es) => es.map((ed) => (ed.id === selEdge.id ? { ...ed, data: { ...ed.data, guard: v } } : ed)));
                }}
              />
              {/* #1698 — only for an edge out of a human step: an empty guard here is the
                  shape that strands a rejected approval, so say so where it is editable. */}
              {isHumanNode(nodes, selEdge.source) && (
                <p className="text-[11px] text-[color:var(--fg-muted)]">{t('guardHumanRejectionHint')}</p>
              )}
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

/** Slugify a workflow name into the a-z0-9-dash form the backend expects. Folds accents/umlauts
 *  (München → munchen) so non-ASCII names still produce a usable slug instead of a dash-mangled one. */
function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Sanitize the slug field WHILE typing — keeps a hyphen the user is typing (only strips leading
 *  dashes), so `my-flow` can be authored left-to-right. Full trim happens via slugify on name-derive. */
function slugifyLive(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '');
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
