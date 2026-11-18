// The kernel-run agent turn ('agentTurn@1', #2043): the facilitation engine
// asks the kernel to run ONE turn as a facilitator and gets the text back.
// Nothing is posted; the engine decides what to send, through its own outbox.
//
// The turn runs through the agent's own `ChatAgent` bundle, so everything
// that makes it this agent's turn applies without being repeated here: the
// identity prompt with the neutrality block, the model policy, the Privacy
// Shield and its receipt, the verifier, the tool grants. `engineContext`
// travels as the turn's system hint, which the orchestrator places AFTER the
// identity and masks like any other wire content.
//
// Who may ask: the instance's facilitation engine plugin, for a
// facilitator-kind agent that plugin is granted to. Nothing else.

import { formatPrincipal, makePrincipal, type ChatTurnInput } from '@omadia/channel-sdk';
import {
  isFacilitatorKind,
  runAsEngineTurn,
  type OrchestratorRegistry,
} from '@omadia/orchestrator';
import type {
  AgentProfile,
  AgentTurnOutcome,
  AgentTurnRequest,
  AgentTurnService,
  ConversationMessageRecord,
} from '@omadia/plugin-api';

import type { ConversationMessageHub } from '../channels/conversationMessages/hub.js';

const MAX_TEXT = 200_000;
const MAX_KEY = 512;
const HISTORY_TURNS = 20;
const HISTORY_SESSIONS = 500;
const MINUTE_MS = 60_000;

export interface AgentTurnServiceDeps {
  readonly getRegistry: () => OrchestratorRegistry | undefined;
  /** For the stored inbound event a turn answers. Absent = no database; a
   *  request naming an inbound event is then refused. */
  readonly messages?: Pick<ConversationMessageHub, 'getEventById'>;
  /** The calling plugin; `undefined` for the kernel itself. */
  readonly callerPluginId: string | undefined;
  /** Is the caller the instance's facilitation engine right now? */
  readonly isEngine: () => boolean;
  readonly history: AgentTurnHistory;
  readonly budget: AgentTurnBudget;
  /** The language the instance answers in, when configured. */
  readonly language?: () => string | undefined;
  readonly log?: (message: string) => void;
}

/** Turns of one session key, so consecutive turns share what was said. Kept
 *  in memory and bounded: the facilitation's durable state is the engine's,
 *  handed in as `engineContext` on every turn. */
export class AgentTurnHistory {
  private readonly sessions = new Map<string, { userMessage: string; assistantAnswer: string }[]>();

  get(key: string): { userMessage: string; assistantAnswer: string }[] {
    return [...(this.sessions.get(key) ?? [])];
  }

  append(key: string, userMessage: string, assistantAnswer: string): void {
    const next = [...(this.sessions.get(key) ?? []), { userMessage, assistantAnswer }].slice(-HISTORY_TURNS);
    this.sessions.delete(key);
    this.sessions.set(key, next);
    while (this.sessions.size > HISTORY_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }
}

/** A ceiling on kernel-run turns per agent and minute, so a loop in an
 *  engine cannot spend without bound. */
export class AgentTurnBudget {
  private readonly starts = new Map<string, number[]>();

  constructor(
    private readonly maxPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  tryTake(agentSlug: string): boolean {
    if (this.maxPerMinute <= 0) return true;
    const at = this.now();
    const recent = (this.starts.get(agentSlug) ?? []).filter((t) => at - t < MINUTE_MS);
    if (recent.length >= this.maxPerMinute) {
      this.starts.set(agentSlug, recent);
      return false;
    }
    this.starts.set(agentSlug, [...recent, at]);
    return true;
  }
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function refused(
  code: Extract<AgentTurnOutcome, { outcome: 'refused' }>['code'],
  message: string,
): AgentTurnOutcome {
  return { outcome: 'refused', code, message };
}

export function createAgentTurnService(deps: AgentTurnServiceDeps): AgentTurnService {
  const log = deps.log ?? (() => undefined);

  /** The registry entry when the caller may run this agent, else a refusal. */
  function bound(agentSlug: string): { entry: NonNullable<ReturnType<OrchestratorRegistry['get']>> } | AgentTurnOutcome {
    const { callerPluginId } = deps;
    if (callerPluginId !== undefined && !deps.isEngine()) {
      return refused('not_bound', 'only the facilitation engine plugin may run an agent turn');
    }
    const registry = deps.getRegistry();
    if (!registry) return refused('unavailable', 'the agent registry is not available');
    const entry = registry.get(agentSlug);
    if (!entry) return refused('unknown_agent', `agent '${agentSlug}' is not active`);
    if (!isFacilitatorKind(entry.agent)) {
      return refused('not_bound', `agent '${agentSlug}' is not a facilitator; an engine runs facilitators only`);
    }
    if (
      callerPluginId !== undefined &&
      !entry.plugins.some((p) => p.enabled && p.pluginId === callerPluginId)
    ) {
      return refused('not_bound', `agent '${agentSlug}' is not granted the facilitation engine`);
    }
    return { entry };
  }

  return {
    async runTurn(request: AgentTurnRequest): Promise<AgentTurnOutcome> {
      if (
        !isText(request?.agentSlug, 128) ||
        !isText(request.sessionKey, MAX_KEY) ||
        !isText(request.channelType, 64) ||
        !isText(request.conversationId, MAX_KEY) ||
        !isText(request.input, MAX_TEXT)
      ) {
        return refused('unavailable', 'agentSlug, sessionKey, channelType, conversationId and input are required');
      }
      if (request.engineContext !== undefined && (typeof request.engineContext !== 'string' || request.engineContext.length > MAX_TEXT)) {
        return refused('unavailable', 'engineContext must be text');
      }
      const resolved = bound(request.agentSlug);
      if ('outcome' in resolved) return resolved;
      const pluginId = deps.callerPluginId ?? '@omadia/core';

      // The inbound event is read from the kernel's own record: the caller of
      // the turn is whoever the PLATFORM said wrote the message.
      let inbound: ConversationMessageRecord | undefined;
      if (request.inboundEventId !== undefined) {
        inbound = await deps.messages
          ?.getEventById(
            {
              agentSlug: request.agentSlug,
              channelType: request.channelType,
              conversationId: request.conversationId,
            },
            deps.callerPluginId,
            request.inboundEventId,
          )
          .catch(() => undefined);
        if (!inbound) {
          return refused(
            'unavailable',
            'the inbound event is not a stored message of this conversation for this agent',
          );
        }
      }
      if (!deps.budget.tryTake(request.agentSlug)) {
        return refused('budget_exceeded', `agent '${request.agentSlug}' reached its turn budget for this minute`);
      }

      const principal = inbound ? makePrincipal('user', inbound.author.id) : undefined;
      const sessionScope = `facilitation:${request.agentSlug}:${request.sessionKey}`;
      const turn: ChatTurnInput = {
        userMessage: request.input,
        sessionScope,
        priorTurns: deps.history.get(sessionScope),
        ...(request.engineContext?.trim() ? { extraSystemHint: request.engineContext } : {}),
        ...(inbound ? { userId: inbound.author.id } : {}),
        origin: {
          channelType: request.channelType,
          scope: { kind: 'conversation', conversationId: request.conversationId },
          ...(principal ? { principal } : {}),
        },
      };
      try {
        const answer = await runAsEngineTurn(
          {
            pluginId,
            toolContext: {
              channelType: request.channelType,
              conversationId: request.conversationId,
              ...(inbound ? { inboundEventId: inbound.eventId } : {}),
              ...(principal ? { callerPrincipalId: formatPrincipal(principal) } : {}),
              ...(inbound ? { callerUserRef: { kind: inbound.author.kind, id: inbound.author.id } } : {}),
            },
          },
          () => resolved.entry.built.bundle.agent.chat(turn),
        );
        deps.history.append(sessionScope, request.input, answer.text);
        const turnId = (answer as { turnId?: unknown }).turnId;
        return {
          outcome: 'completed',
          text: answer.text,
          ...(typeof turnId === 'string' ? { turnId } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`[agent-turn] turn as '${request.agentSlug}' failed: ${message}`);
        return { outcome: 'failed', message };
      }
    },

    async getProfile(agentSlug: string): Promise<AgentProfile | undefined> {
      if (!isText(agentSlug, 128)) return undefined;
      const resolved = bound(agentSlug);
      if ('outcome' in resolved) return undefined;
      const { agent } = resolved.entry;
      const registry = deps.getRegistry();
      const language = agent.identityLanguage?.trim() || deps.language?.();
      return {
        agentSlug: agent.slug,
        kind: 'facilitator',
        displayName: agent.identityName?.trim() || agent.name,
        ...(agent.identityShortDescription?.trim()
          ? { shortDescription: agent.identityShortDescription.trim() }
          : {}),
        ...(language ? { language } : {}),
        ownIdentityChannelTypes: registry?.channelTypesWithIdentity?.(agent.slug) ?? [],
      };
    },
  };
}
