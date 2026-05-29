'use client';

import type {
  ChatSession,
  DiagramAttachment,
  FollowUpOption,
  Message,
  NudgeEvent,
  OutgoingFileAttachment,
  PalaiaExcerpt,
  PendingUserChoice,
  PrivacyReceipt,
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
    case 'iteration_usage':
      return {
        ...m,
        lastUsage: {
          inputTokens: event.inputTokens,
          cacheReadInputTokens: event.cacheReadInputTokens,
        },
      };
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
    case 'iteration_start':
    default:
      return m;
  }
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
