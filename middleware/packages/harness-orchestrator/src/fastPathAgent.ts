import {
  toSemanticAnswer,
  withDataText,
  withoutDataText,
  type AiDisclosure,
  type ChatAgent,
  type ChatAgentToolDefinition,
  type ChatStreamEvent,
  type ChatStreamObserver,
  type ChatTurnInput,
  type FastPathDecision,
  type SemanticAnswer,
} from '@omadia/channel-sdk';
import type { ChatTriageOutcome, ChatTriageRequest } from '@omadia/fast-path';
import type { CaptureDisclosure, DataPayload, DataPlanGuard } from '@omadia/plugin-api';

import { isValidSessionId } from './chatSessionStore.js';
import type { SessionLogEntry } from './sessionLogger.js';
import type { SummaryBoundaryGuard } from './summaryBoundaryGuard.js';

/**
 * Deterministic fast path for every NON-canvas channel (web chat, HTTP API,
 * Teams, Telegram, Slack, …) — a `ChatAgent` decorator around the bundle's
 * agent (outside the verifier). Per human text turn it asks the `fastPath@1`
 * service (`@omadia/fast-path`) for ONE fast-model triage:
 *
 *   - deterministic → the service ran the ONE read query and rendered the
 *     templated summary + a markdown table; the wrapper streams it as
 *     `text_delta` + `done` (the normal ChatAgent event shape every channel
 *     renders), records the turn through the session logger, and the inner
 *     agent is never called;
 *   - agent → the turn passes through unchanged, with the triage's
 *     simple/complex verdict as `routeHint` (the model router takes it
 *     instead of classifying again; ignored when routing is off);
 *   - any miss (service absent, channel filtered, privacy refusal, invalid
 *     plan, tool error, …) → the inner agent, byte-for-byte.
 *
 * Why the verifier may be bypassed for a hit: the answer carries no model
 * claim. The rows are system data straight from the tool, the figures are
 * computed (`{count}`, currency-safe `{sum:…}`), and the triage model only
 * chose a query and a sentence template from the masked request — it never
 * saw a row. That is the contract `ChatAgent.holdsContentUntilVerdict`
 * states for a wrapper's own content, so the flag is forwarded unchanged.
 *
 * Canvas turns are the canvas orchestrator's (it runs its own composer on
 * the same service); slash commands, attachments, empty text, structured
 * actions and system/headless turns (schedules, conductor steps, verifier
 * retries, fresh checks, answer-size re-runs) are never triaged.
 */

export interface FastPathTriagePort {
  channelEnabled(channel: string): boolean;
  triageChatTurn(req: ChatTriageRequest): Promise<ChatTriageOutcome>;
}

export interface FastPathAgentDeps {
  /** the `fastPath@1` service, resolved lazily per turn */
  fastPath: () => FastPathTriagePort | undefined;
  /** the tools the wrapped agent itself offers its model now — the fast
   *  path plans and runs only these (∩ the configured fast-path tools);
   *  undefined = unknown → no fast path (fail closed) */
  permittedTools: () => ReadonlySet<string> | undefined;
  /** the definitions of those tools the fast path may plan generically
   *  (`ChatAgent.offeredToolDefinitions`); absent → catalog/learned only */
  toolDefinitions?: () => ReadonlyArray<ChatAgentToolDefinition>;
  /** the bundle's session logger — a hit is recorded like any turn */
  logSession?: (
    entry: SessionLogEntry,
  ) => Promise<{ turnExternalId: string; captureDisclosure?: CaptureDisclosure }>;
  /** a Privacy Shield runs: the recorded turn gets an EMPTY masked view so
   *  no capture decorator sends the rows to a model of its own */
  privacyGuarded: () => boolean;
  /**
   * #1876 — the agent's own AI disclosure for a fast-lane answer: the same
   * per-turn resolution and first-turn fold as any answer of this agent
   * (`Orchestrator.discloseCliAnswer`). Absent → the text goes out as is.
   */
  disclose?: (
    answer: string,
    input: ChatTurnInput,
  ) => { readonly answer: string; readonly aiDisclosure?: AiDisclosure };
  /** #1876 — the agent whose fast lane this is: learned plans and the answer
   *  cache are keyed by it. */
  agentSlug?: string;
  /** #2085 — the agent's boundary check, applied to every plan (new or
   *  cached) before it runs (spec 2042 §5.13 1a). */
  checkPlan?: DataPlanGuard;
  /** Criterion 33 — the agent's boundaries over the planner's summary
   *  template and column labels (model-written prose), new or cached; the
   *  service runs it with `checkPlan`, before the fetch. A refusal is a
   *  miss: the agent's full loop answers instead. */
  checkSummary?: SummaryBoundaryGuard;
  log: (message: string) => void;
}

/** Session scopes of headless, non-human turns. */
const SYSTEM_SCOPE = /^(schedule|conductor|conductor-builder|routine|plan|system)[:_-]/;

/** The channel a turn came from — for the channel filter and the logs. */
export function channelOfTurn(input: ChatTurnInput): string {
  const fromOrigin = input.origin?.channelType?.trim().toLowerCase();
  if (fromOrigin) return fromOrigin;
  if (input.channelIdentity?.channelKind) return input.channelIdentity.channelKind;
  const scope = input.sessionScope ?? '';
  if (scope.startsWith('http-')) return 'http';
  if (scope.startsWith('teams-')) return 'teams';
  if (scope.startsWith('telegram')) return 'telegram';
  if (scope.startsWith('slack')) return 'slack';
  // a browser chat tab id (the web UI's sessionId)
  if (isValidSessionId(scope)) return 'web';
  return 'api';
}

/** Why a turn is not triaged at all, or undefined when it may be. */
export function passThroughReason(input: ChatTurnInput): string | undefined {
  if (input.canvasSessionId !== undefined) return 'canvas';
  if (input.canvasRefresh !== undefined || input.canvasState !== undefined) return 'canvas';
  if (input.action !== undefined || input.target !== undefined) return 'action';
  const text = input.userMessage.trim();
  if (text.length === 0) return 'empty';
  if (text.startsWith('/')) return 'command';
  if ((input.attachments?.length ?? 0) > 0) return 'attachments';
  if (input.sessionScope === undefined || SYSTEM_SCOPE.test(input.sessionScope)) return 'system';
  if (
    input.extraSystemHint !== undefined ||
    input.fixedSystemHint !== undefined ||
    input.expectedDomainTool !== undefined ||
    input.freshCheck === true ||
    input.answerVerbosity !== undefined ||
    input.routeHint !== undefined ||
    input.planHint !== undefined
  ) {
    return 'system';
  }
  return undefined;
}

type Decision =
  | {
      kind: 'answer';
      text: string;
      toolCalls: number;
      turnId?: string;
      captureDisclosure?: CaptureDisclosure;
      decision?: FastPathDecision;
      /** `text` already carries the fold; this is the structured carrier. */
      aiDisclosure?: AiDisclosure;
      /** The summary sentence alone — what streams as a delta (neither a
       *  disclosure nor side-channel rows go out as a delta). */
      prose: string;
      /** #2085 — the rows, as side-channel data (rendered into `text`);
       *  empty when there are none. */
      data: readonly DataPayload[];
      /** `text` without the rendering of `data`. */
      textWithoutData: string;
    }
  | { kind: 'agent'; input: ChatTurnInput; decision?: FastPathDecision };

/** The channel-facing copy of the fast path's decision trace. */
function toFastPathDecision(
  trace: NonNullable<ChatTriageOutcome['decision']>,
  answered: boolean,
): FastPathDecision {
  return {
    provider: trace.provider,
    ...(trace.model !== undefined ? { model: trace.model } : {}),
    verdict: trace.verdict,
    ...(trace.route !== undefined ? { route: trace.route } : {}),
    ...(trace.tool !== undefined ? { tool: trace.tool } : {}),
    confidence: trace.confidence,
    ms: trace.ms,
    ...(trace.direct === true ? { direct: true as const } : {}),
    ...(answered ? { answered: true as const } : {}),
    ...(trace.steps !== undefined && trace.steps.length > 0 ? { steps: trace.steps.map((s) => ({ ...s })) } : {}),
  };
}

/** `done` stamped with the decision; every other event unchanged. */
async function* stampDecision(
  events: AsyncIterable<ChatStreamEvent>,
  decision: FastPathDecision | undefined,
): AsyncGenerator<ChatStreamEvent> {
  for await (const event of events) {
    yield decision !== undefined && event.type === 'done' ? { ...event, fastPathDecision: decision } : event;
  }
}

/** The wrapper keeps the agent it decorates reachable for introspection
 *  (tests and diagnostics read the CLI agent's construction deps). */
export interface FastPathChatAgent extends ChatAgent {
  readonly inner: ChatAgent;
}

export function wrapChatAgentWithFastPath(inner: ChatAgent, deps: FastPathAgentDeps): FastPathChatAgent {
  async function record(
    input: ChatTurnInput,
    text: string,
    toolCalls: number,
  ): Promise<{ turnId: string; captureDisclosure?: CaptureDisclosure } | undefined> {
    if (!deps.logSession || input.sessionScope === undefined) return undefined;
    const guarded = deps.privacyGuarded();
    try {
      const { turnExternalId, captureDisclosure } = await deps.logSession({
        scope: input.sessionScope,
        userMessage: input.userMessage,
        assistantAnswer: text,
        toolCalls,
        iterations: 0,
        ...(input.userId !== undefined ? { userId: input.userId } : {}),
        // No model saw the rows: under a shield, an EMPTY masked view tells
        // a capture decorator to send nothing to a model of its own.
        ...(guarded ? { maskedView: { userMessage: '', assistantAnswer: '' } } : {}),
        unprotected: !guarded,
      });
      return { turnId: turnExternalId, ...(captureDisclosure ? { captureDisclosure } : {}) };
    } catch (err) {
      deps.log(`[fast-path] session log failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  async function decide(input: ChatTurnInput): Promise<Decision> {
    if (passThroughReason(input) !== undefined) return { kind: 'agent', input };
    const fp = deps.fastPath();
    const channel = channelOfTurn(input);
    if (!fp || !fp.channelEnabled(channel)) return { kind: 'agent', input };
    let permittedTools: ReadonlySet<string> | undefined;
    try {
      permittedTools = deps.permittedTools();
    } catch {
      permittedTools = undefined;
    }
    if (permittedTools === undefined) {
      deps.log(`[fast-path] miss channel=${channel} reason=tool-set-unknown`);
      return { kind: 'agent', input };
    }
    let toolDefinitions: ReadonlyArray<ChatAgentToolDefinition> | undefined;
    try {
      toolDefinitions = deps.toolDefinitions?.();
    } catch {
      toolDefinitions = undefined; // generic specs are an extra, never a reason to miss
    }
    let outcome: ChatTriageOutcome;
    try {
      outcome = await fp.triageChatTurn({
        channel,
        permittedTools,
        ...(toolDefinitions !== undefined ? { toolDefinitions } : {}),
        ...(input.sessionScope !== undefined ? { sessionKey: input.sessionScope } : {}),
        ...(deps.agentSlug !== undefined ? { agentSlug: deps.agentSlug } : {}),
        ...(deps.checkPlan !== undefined ? { checkPlan: deps.checkPlan } : {}),
        ...(deps.checkSummary !== undefined ? { checkSummary: deps.checkSummary } : {}),
        userMessage: input.userMessage,
      });
    } catch (err) {
      deps.log(`[fast-path] miss channel=${channel} reason=triage-threw: ${err instanceof Error ? err.message : String(err)}`);
      return { kind: 'agent', input };
    }
    if (outcome.kind === 'agent') {
      return {
        kind: 'agent',
        // a miss without any hint passes the very same input object on
        input:
          outcome.route || outcome.planHint
            ? {
                ...input,
                ...(outcome.route ? { routeHint: outcome.route } : {}),
                ...(outcome.planHint ? { planHint: outcome.planHint } : {}),
              }
            : input,
        ...(outcome.decision ? { decision: toFastPathDecision(outcome.decision, false) } : {}),
      };
    }
    // #2085 — the summary is prose (the model wrote its template) and passes
    // the identity guard around this wrapper; the rows are side-channel data:
    // rendered for people, never in the transcript a later model reads.
    const prose = outcome.summary;
    const data: readonly DataPayload[] = outcome.table.rows.length > 0 ? [outcome.table] : [];
    const recorded = await record(input, prose, outcome.toolCalls);
    // Marked after recording: the transcript keeps the answer, as for a turn.
    const combined = withDataText(prose, data);
    const disclosed = deps.disclose?.(combined, input);
    const text = disclosed?.answer ?? combined;
    return {
      kind: 'answer',
      text,
      prose,
      data,
      textWithoutData: withoutDataText(text, data),
      ...(disclosed?.aiDisclosure ? { aiDisclosure: disclosed.aiDisclosure } : {}),
      toolCalls: outcome.toolCalls,
      ...recorded,
      ...(outcome.decision ? { decision: toFastPathDecision(outcome.decision, true) } : {}),
    };
  }

  const agent: FastPathChatAgent = {
    inner,
    offeredToolNames: () => deps.permittedTools() ?? new Set<string>(),
    ...(deps.toolDefinitions !== undefined ? { offeredToolDefinitions: deps.toolDefinitions } : {}),
    async chat(input: ChatTurnInput): Promise<SemanticAnswer> {
      const d = await decide(input);
      if (d.kind === 'agent') return inner.chat(d.input);
      // The fold is in `d.text`: the carrier joins after the conversion, so
      // `toSemanticAnswer` does not fold a second time.
      const answer = toSemanticAnswer({
        answer: d.text,
        toolCalls: d.toolCalls,
        iterations: 0,
        ...(d.turnId ? { turnId: d.turnId } : {}),
      });
      return {
        ...answer,
        ...(d.data.length > 0 ? { data: d.data, textWithoutData: d.textWithoutData } : {}),
        ...(d.aiDisclosure ? { aiDisclosure: d.aiDisclosure } : {}),
      };
    },
    async *chatStream(input: ChatTurnInput, observer?: ChatStreamObserver): AsyncGenerator<ChatStreamEvent> {
      const d = await decide(input);
      if (d.kind === 'agent') {
        yield* stampDecision(inner.chatStream(d.input, observer), d.decision);
        return;
      }
      yield { type: 'text_delta', text: d.prose };
      yield {
        type: 'done',
        answer: d.text,
        toolCalls: d.toolCalls,
        iterations: 0,
        ...(d.turnId ? { turnId: d.turnId } : {}),
        ...(d.captureDisclosure ? { captureDisclosure: d.captureDisclosure } : {}),
        ...(d.aiDisclosure ? { aiDisclosure: d.aiDisclosure } : {}),
        ...(d.data.length > 0 ? { data: d.data, textWithoutData: d.textWithoutData } : {}),
        ...(d.decision ? { fastPathDecision: d.decision } : {}),
      };
    },
    ...(inner.holdsContentUntilVerdict !== undefined
      ? { holdsContentUntilVerdict: inner.holdsContentUntilVerdict }
      : {}),
  };
  return agent;
}
