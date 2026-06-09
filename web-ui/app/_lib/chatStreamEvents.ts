'use client';

import type {
  ChatSession,
  DiagramAttachment,
  FollowUpOption,
  KgWalkEdge,
  KgWalkNode,
  KgWalkPayload,
  Message,
  NudgeEvent,
  OutgoingFileAttachment,
  PalaiaExcerpt,
  PendingUserChoice,
  PlanSnapshot,
  PrivacyReceipt,
  RecalledContextSnapshot,
  SubAgentEvent,
  ToolEvent,
  UseChatSessionsResult,
} from './chatSessions';

/**
 * Wire-format for chat stream events. Mirrors `ChatStreamEvent` in
 * `middleware/src/services/orchestrator.ts`. Validation is lax on purpose —
 * the server is trusted and any shape drift should surface as an obvious
 * UI bug rather than a silent drop.
 */
export type ChatStreamEvent =
  | { type: 'iteration_start'; iteration: number }
  /** Per-turn Haiku-triage verdict, emitted once at turn start. */
  | {
      type: 'turn_routing';
      bucket: 'simple' | 'complex' | 'fallback';
      classifierModel: string;
      model: string;
    }
  | { type: 'text_delta'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: unknown;
      /** Server-resolved agent metadata; absent for helper tools. */
      agent?: ToolEvent['agent'];
    }
  | {
      type: 'tool_result';
      id: string;
      output: string;
      durationMs: number;
      isError?: boolean;
    }
  | {
      type: 'nudge';
      id: string;
      nudgeId: string;
      text: string;
      cta?: {
        label: string;
        toolName: string;
        arguments: Record<string, unknown>;
      };
    }
  | { type: 'tool_progress'; id: string; elapsedMs: number }
  | {
      type: 'heartbeat';
      sinceLastActivityMs: number;
      currentIteration: number;
      toolCallsThisIter: number;
      phase?: 'thinking' | 'streaming' | 'tool_running' | 'idle';
      tokensStreamedThisIter?: number;
    }
  | {
      type: 'stream_token_chunk';
      iteration: number;
      deltaTokens: number;
      cumulativeOutputTokens: number;
      tokensPerSec: number;
    }
  | {
      type: 'iteration_usage';
      iteration: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    }
  | { type: 'sub_iteration'; parentId: string; iteration: number }
  | {
      type: 'sub_tool_use';
      parentId: string;
      id: string;
      name: string;
      input: unknown;
    }
  | {
      type: 'sub_tool_result';
      parentId: string;
      id: string;
      output: string;
      durationMs: number;
      isError: boolean;
    }
  | {
      type: 'done';
      answer: string;
      toolCalls: number;
      iterations: number;
      /** Model this turn ran on (per-turn router → Sonnet/Opus, or default). */
      model?: string;
      turnId?: string;
      palaiaExcerpt?: PalaiaExcerpt;
      autoPromotedMkId?: string;
      attachments?: DiagramAttachment[];
      fileAttachments?: OutgoingFileAttachment[];
      pendingUserChoice?: PendingUserChoice;
      followUpOptions?: FollowUpOption[];
      privacyReceipt?: PrivacyReceipt;
      maskedValues?: readonly string[];
    }
  /** #133 (E9) — opaque turn annotation the orchestrator forwarded from a
   *  turn-hook. `channel: 'plan'` carries a live PlanSnapshot. */
  | { type: 'turn_annotation'; channel: string; payload: unknown }
  /** Mid-turn steering — a user message injected via `/chat/steer` was folded
   *  into the running turn at iteration `iteration`. */
  | { type: 'steer_applied'; iteration: number; message: string }
  | { type: 'error'; message: string };

/**
 * Fold one stream event into the session that owns the pending assistant
 * message. Pure-ish: writes go through `sessions.mutateActive`. The session
 * is matched by id; events for non-active sessions are no-ops here — the
 * caller (StreamRunner) is responsible for routing to the right pending id.
 *
 * Note: mutateActive only writes to the *currently active* session. The
 * stream-runner uses it because in practice a stream's session and the
 * active session coincide while a turn is firing. If we ever want to run
 * background turns for a non-active session we'll need a per-session
 * `mutateById` helper.
 */
export function applyStreamEvent(
  sessions: UseChatSessionsResult,
  sessionId: string,
  pendingMessageId: string,
  event: ChatStreamEvent,
): void {
  sessions.mutateActive((session) => {
    if (session.id !== sessionId) return session;
    return foldEvent(session, pendingMessageId, event);
  });
}

function foldEvent(
  session: ChatSession,
  pendingId: string,
  event: ChatStreamEvent,
): ChatSession {
  const nextMessages = session.messages.map((m) => {
    if (m.id !== pendingId) return m;
    return foldIntoMessage(m, event);
  });
  return { ...session, messages: nextMessages, updatedAt: Date.now() };
}

function foldIntoMessage(m: Message, event: ChatStreamEvent): Message {
  switch (event.type) {
    case 'text_delta':
      return { ...m, content: m.content + event.text };
    case 'turn_routing':
      return {
        ...m,
        routing: {
          bucket: event.bucket,
          classifierModel: event.classifierModel,
          model: event.model,
        },
      };
    case 'turn_annotation':
      // #133 (E9) — the live plan snapshot. Re-emitted on every step change;
      // we just replace, so the card reflects the latest state.
      if (event.channel === 'plan' && event.payload) {
        return { ...m, plan: event.payload as PlanSnapshot };
      }
      // Cross-session recall probe — what the per-turn probe pulled from
      // prior sessions. Emitted once, before the answer.
      if (event.channel === 'kg_recall' && event.payload) {
        return {
          ...m,
          recalledContext: event.payload as RecalledContextSnapshot,
        };
      }
      // KG-walk neighborhood — the graph the turn traversed. Emitted once,
      // typically before the answer. Parsed defensively: a malformed payload
      // is dropped rather than crashing the fold.
      if (event.channel === 'kg_graph' && event.payload) {
        const walk = parseKgWalk(event.payload);
        return walk ? { ...m, kgWalk: walk } : m;
      }
      // KG-insert — what THIS turn wrote into the graph. Emitted after the
      // answer (post auto-promotion). Merged into the existing walk (marking
      // its nodes/edges `inserted`) so the pane pulses the fresh part; when no
      // walk preceded it, the insert becomes the walk on its own.
      if (event.channel === 'kg_insert' && event.payload) {
        const insert = parseKgWalk(event.payload);
        return insert ? { ...m, kgWalk: mergeKgInsert(m.kgWalk, insert) } : m;
      }
      return m;
    case 'tool_use': {
      const tool: ToolEvent = {
        id: event.id,
        name: event.name,
        input: event.input,
        startedAt: Date.now(),
        subEvents: [],
        ...(event.agent ? { agent: event.agent } : {}),
      };
      return { ...m, tools: [...(m.tools ?? []), tool] };
    }
    case 'tool_progress': {
      const tools = (m.tools ?? []).map((t) =>
        t.id === event.id ? { ...t, liveElapsedMs: event.elapsedMs } : t,
      );
      return { ...m, tools };
    }
    case 'heartbeat':
      return {
        ...m,
        liveness: {
          sinceLastActivityMs: event.sinceLastActivityMs,
          iteration: event.currentIteration,
          toolCallsThisIter: event.toolCallsThisIter,
          ...(event.phase ? { phase: event.phase } : {}),
          ...(typeof event.tokensStreamedThisIter === 'number'
            ? { tokensThisIter: event.tokensStreamedThisIter }
            : {}),
        },
      };
    case 'stream_token_chunk':
      return {
        ...m,
        tokensPerSec: event.tokensPerSec,
        liveness: m.liveness
          ? {
              ...m.liveness,
              tokensThisIter: event.cumulativeOutputTokens,
            }
          : m.liveness,
      };
    case 'iteration_usage': {
      const prev = m.turnUsage;
      return {
        ...m,
        lastUsage: {
          inputTokens: event.inputTokens,
          cacheReadInputTokens: event.cacheReadInputTokens,
        },
        // Sum across iterations so the footer shows the whole turn's spend,
        // not just the last iteration's snapshot.
        turnUsage: {
          inputTokens: (prev?.inputTokens ?? 0) + event.inputTokens,
          outputTokens: (prev?.outputTokens ?? 0) + event.outputTokens,
          cacheReadInputTokens:
            (prev?.cacheReadInputTokens ?? 0) + event.cacheReadInputTokens,
          cacheCreationInputTokens:
            (prev?.cacheCreationInputTokens ?? 0) +
            event.cacheCreationInputTokens,
        },
      };
    }
    case 'tool_result': {
      const tools = (m.tools ?? []).map((t) =>
        t.id === event.id
          ? {
              ...t,
              output: event.output,
              durationMs: event.durationMs,
              isError: event.isError ?? false,
              liveElapsedMs: undefined,
            }
          : t,
      );
      return { ...m, tools };
    }
    case 'nudge': {
      const next: NudgeEvent = {
        id: event.id,
        nudgeId: event.nudgeId,
        text: event.text,
        ...(event.cta ? { cta: event.cta } : {}),
      };
      const existing = m.nudges ?? [];
      const filtered = existing.filter(
        (n) => !(n.id === next.id && n.nudgeId === next.nudgeId),
      );
      return { ...m, nudges: [...filtered, next] };
    }
    case 'sub_iteration':
    case 'sub_tool_use':
    case 'sub_tool_result': {
      const tools = (m.tools ?? []).map((t) => {
        if (t.id !== event.parentId) return t;
        const sub: SubAgentEvent = toSubAgentEvent(event);
        return { ...t, subEvents: [...(t.subEvents ?? []), sub] };
      });
      return { ...m, tools };
    }
    case 'done':
      return {
        ...m,
        content: event.answer,
        telemetry: {
          tool_calls: event.toolCalls,
          iterations: event.iterations,
        },
        ...(event.model ? { model: event.model } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.palaiaExcerpt ? { palaiaExcerpt: event.palaiaExcerpt } : {}),
        ...(event.autoPromotedMkId
          ? { autoPromotedMkId: event.autoPromotedMkId }
          : {}),
        ...(event.attachments && event.attachments.length > 0
          ? { attachments: event.attachments }
          : {}),
        ...(event.fileAttachments && event.fileAttachments.length > 0
          ? { fileAttachments: event.fileAttachments }
          : {}),
        ...(event.pendingUserChoice
          ? { pendingUserChoice: event.pendingUserChoice }
          : {}),
        ...(event.followUpOptions && event.followUpOptions.length > 0
          ? { followUpOptions: event.followUpOptions }
          : {}),
        ...(event.privacyReceipt ? { privacyReceipt: event.privacyReceipt } : {}),
        ...(event.maskedValues && event.maskedValues.length > 0
          ? { maskedValues: event.maskedValues }
          : {}),
        finishedAt: Date.now(),
        streaming: false,
      };
    case 'error':
      return {
        ...m,
        content: m.content + (m.content ? '\n\n' : '') + event.message,
        error: true,
        finishedAt: Date.now(),
        streaming: false,
      };
    case 'steer_applied': {
      // Record the steer so the trace can render an inline "↳ steered" chip
      // under the assistant turn it landed in.
      const steers = [...(m.steers ?? []), event.message];
      return { ...m, steers };
    }
    case 'iteration_start':
    default:
      return m;
  }
}

/**
 * Defensive parse of a `kg_graph` annotation payload. The server is trusted
 * but the contract is young, so partial/missing fields are tolerated: any
 * node/edge that lacks its required string fields is skipped, and a payload
 * with no usable nodes returns null (the caller then leaves `kgWalk` unset).
 */
function parseKgWalk(payload: unknown): KgWalkPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const rec = payload as Record<string, unknown>;

  const rootIds = Array.isArray(rec['rootIds'])
    ? rec['rootIds'].filter((v): v is string => typeof v === 'string')
    : [];

  const nodes: KgWalkNode[] = Array.isArray(rec['nodes'])
    ? rec['nodes'].reduce<KgWalkNode[]>((acc, raw) => {
        if (!raw || typeof raw !== 'object') return acc;
        const n = raw as Record<string, unknown>;
        if (typeof n['id'] !== 'string') return acc;
        acc.push({
          id: n['id'],
          label: typeof n['label'] === 'string' ? n['label'] : n['id'],
          kind: typeof n['kind'] === 'string' ? n['kind'] : 'Entity',
          ...(typeof n['score'] === 'number' ? { score: n['score'] } : {}),
          ...(n['inserted'] === true ? { inserted: true } : {}),
        });
        return acc;
      }, [])
    : [];

  const edges: KgWalkEdge[] = Array.isArray(rec['edges'])
    ? rec['edges'].reduce<KgWalkEdge[]>((acc, raw) => {
        if (!raw || typeof raw !== 'object') return acc;
        const e = raw as Record<string, unknown>;
        if (typeof e['from'] !== 'string' || typeof e['to'] !== 'string') {
          return acc;
        }
        acc.push({
          from: e['from'],
          to: e['to'],
          type: typeof e['type'] === 'string' ? e['type'] : 'REL',
          hop: typeof e['hop'] === 'number' ? e['hop'] : 1,
          ...(e['inserted'] === true ? { inserted: true } : {}),
        });
        return acc;
      }, [])
    : [];

  if (nodes.length === 0) return null;
  return { rootIds, nodes, edges };
}

/**
 * Merge a `kg_insert` delta into the existing per-turn walk. New nodes/edges
 * (already flagged `inserted`) are appended; a node/edge that was already part
 * of the recalled walk is upgraded in place to `inserted: true` so the pane
 * pulses it. `rootIds` from both are unioned. When there was no prior walk the
 * insert stands on its own.
 */
function mergeKgInsert(
  prior: KgWalkPayload | undefined,
  insert: KgWalkPayload,
): KgWalkPayload {
  if (!prior) return insert;

  const insertedNodeIds = new Set(insert.nodes.map((n) => n.id));
  const nodes: KgWalkNode[] = prior.nodes.map((n) =>
    insertedNodeIds.has(n.id) ? { ...n, inserted: true } : n,
  );
  const haveNodeId = new Set(nodes.map((n) => n.id));
  for (const n of insert.nodes) {
    if (!haveNodeId.has(n.id)) {
      nodes.push(n);
      haveNodeId.add(n.id);
    }
  }

  const edgeKey = (e: KgWalkEdge): string => `${e.from} ${e.to} ${e.type}`;
  const insertedEdgeKeys = new Set(insert.edges.map(edgeKey));
  const edges: KgWalkEdge[] = prior.edges.map((e) =>
    insertedEdgeKeys.has(edgeKey(e)) ? { ...e, inserted: true } : e,
  );
  const haveEdgeKey = new Set(edges.map(edgeKey));
  for (const e of insert.edges) {
    if (!haveEdgeKey.has(edgeKey(e))) {
      edges.push(e);
      haveEdgeKey.add(edgeKey(e));
    }
  }

  const rootIds = Array.from(new Set([...prior.rootIds, ...insert.rootIds]));
  return { rootIds, nodes, edges };
}

function toSubAgentEvent(
  event: Extract<
    ChatStreamEvent,
    { type: 'sub_iteration' | 'sub_tool_use' | 'sub_tool_result' }
  >,
): SubAgentEvent {
  switch (event.type) {
    case 'sub_iteration':
      return {
        kind: 'iteration',
        at: Date.now(),
        iteration: event.iteration,
      };
    case 'sub_tool_use':
      return {
        kind: 'tool_use',
        at: Date.now(),
        id: event.id,
        name: event.name,
        input: event.input,
      };
    case 'sub_tool_result':
      return {
        kind: 'tool_result',
        at: Date.now(),
        id: event.id,
        output: event.output,
        durationMs: event.durationMs,
        isError: event.isError,
      };
  }
}
