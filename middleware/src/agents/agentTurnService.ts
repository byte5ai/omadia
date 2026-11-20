// The kernel-run agent turn ('agentTurn@2', #2043, #2090): the facilitation
// engine asks the kernel to run ONE turn as a facilitator and gets the text
// back. Nothing is posted; the engine decides what to send, through its own
// outbox. Every turn is an authorized action under an execution scope of one
// of the engine's processes; a turn without a scope (the first major) is gone
// (#2067).
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

import {
  formatPrincipal,
  makePrincipal,
  withoutFoldedAiDisclosure,
  type ChatTurnInput,
  type ConversationRoster,
} from '@omadia/channel-sdk';
import {
  archetypeAdds,
  archetypeOf,
  effectiveArchetypeAgentSettings,
  getArchetype,
  type ArchetypeAgentSettingValue,
  chatParticipantsFromRoster,
  runAsEngineTurn,
  turnContext,
  type OrchestratorRegistry,
} from '@omadia/orchestrator';
import type {
  ExecutionAuthorizationService,
  ExecutionRefusalCode,
  ScopedAgentTurnOutcome,
  ScopedAgentTurnRequest,
  ScopedAgentTurnService,
  AgentProfile,
  AgentTurnOutcome,
  AgentTurnRequest,
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
  readonly messages?: Pick<ConversationMessageHub, 'getProcessEventById'>;
  /** The calling plugin; `undefined` for the kernel itself. */
  readonly callerPluginId: string | undefined;
  /** Is the caller the instance's facilitation engine right now? */
  readonly isEngine: () => boolean;
  readonly history: AgentTurnHistory;
  readonly budget: AgentTurnBudget;
  /** The language the instance answers in, when configured. */
  readonly language?: () => string | undefined;
  /**
   * #2048 — the conversation's roster, read as the agent's own identity. Gives
   * the turn an audience, so the audience floor bounds it by the people in
   * the conversation. Absent (or unreadable) = no roster: the floor closes for
   * a group turn and every tool is refused, never widened.
   */
  readonly roster?: (
    channelType: string,
    conversationId: string,
    agentSlug: string,
  ) => Promise<ConversationRoster | undefined>;
  /**
   * #2066 — the agent's stored archetype settings (migration 0102). Absent
   * (no database) = none: the plugin's instance settings apply.
   */
  readonly archetypeSettings?: (agentId: string) => Promise<Readonly<Record<string, unknown>>>;
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

/**
 * The turn itself, without its authorization: what `agentTurn@2` runs once
 * the execution scope has granted it. Kernel-internal; no plugin gets this.
 */
export interface GuardedAgentTurnService {
  /**
   * Run one turn. `processId` is the process the turn belongs to: a named
   * inbound event is looked up among what THAT process received.
   *
   * `accept` is asked once the answer exists and before anything keeps it
   * (the session history): a turn whose answer must not stand is failed
   * instead, and leaves no trace for the next turn to build on.
   */
  runGuarded(request: AgentTurnRequest, processId: string, accept?: () => boolean): Promise<AgentTurnOutcome>;
  /** The agent's profile when the caller may run it; `undefined` otherwise. */
  getProfile(agentSlug: string): Promise<AgentProfile | undefined>;
}

export function createAgentTurnService(deps: AgentTurnServiceDeps): GuardedAgentTurnService {
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
    // #2088 — the archetype's descriptor must add `agent_turn`.
    if (!archetypeAdds(entry.agent, 'agent_turn')) {
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

  const run = async (request: AgentTurnRequest, processId: string, accept?: () => boolean): Promise<AgentTurnOutcome> => {
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
        const scope = {
          agentSlug: request.agentSlug,
          channelType: request.channelType,
          conversationId: request.conversationId,
        };
        // A process reads conversations through subscriptions of its own
        // (`conversationMessages@2`), so the event is one THAT process
        // received: never another process's, also not of the same plugin.
        // The kernel itself runs no process and has no such event.
        if (deps.callerPluginId !== undefined) {
          inbound = await deps.messages
            ?.getProcessEventById({ ...scope, processId }, deps.callerPluginId, request.inboundEventId)
            .catch(() => undefined);
        }
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
              ...(inbound
                ? {
                    callerUserRef: {
                      kind: inbound.author.kind,
                      id: inbound.author.id,
                      ...(inbound.author.displayName ? { displayName: inbound.author.displayName } : {}),
                    },
                  }
                : {}),
            },
          },
          () => {
            const run = () => resolved.entry.built.bundle.agent.chat(turn);
            const readRoster = deps.roster;
            if (!readRoster) return run();
            return turnContext.runWithChatParticipants(
              chatParticipantsFromRoster(() =>
                readRoster(request.channelType, request.conversationId, request.agentSlug),
              ),
              run,
            );
          },
        );
        // The engine gets the text WITHOUT the AI disclosure sentence a turn
        // folds into its answer. It posts this text through an own-identity
        // send, and the marking is decided there: the channel's AI label, or
        // the sentence once. Left in, a labelling channel showed both.
        const text = withoutFoldedAiDisclosure(answer.text, answer.aiDisclosure);
        if (accept && !accept()) {
          return { outcome: 'failed', message: 'the answer was not accepted' };
        }
        // #2085 — the history feeds the next turn's model: side-channel rows
        // stay out of it (they reach people through `text` only).
        const prose =
          answer.textWithoutData !== undefined
            ? withoutFoldedAiDisclosure(answer.textWithoutData, answer.aiDisclosure)
            : text;
        deps.history.append(sessionScope, request.input, prose);
        const turnId = (answer as { turnId?: unknown }).turnId;
        return {
          outcome: 'completed',
          text,
          ...(typeof turnId === 'string' ? { turnId } : {}),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`[agent-turn] turn as '${request.agentSlug}' failed: ${message}`);
        return { outcome: 'failed', message };
      }
  };

  return {
    runGuarded: run,

    async getProfile(agentSlug: string): Promise<AgentProfile | undefined> {
      if (!isText(agentSlug, 128)) return undefined;
      const resolved = bound(agentSlug);
      if ('outcome' in resolved) return undefined;
      const { agent } = resolved.entry;
      const registry = deps.getRegistry();
      const language = agent.identityLanguage?.trim() || deps.language?.();
      const archetypeSettings = await readArchetypeSettings(deps, agent);
      return {
        agentSlug: agent.slug,
        kind: 'facilitator',
        archetype: archetypeOf(agent),
        displayName: agent.identityName?.trim() || agent.name,
        ...(agent.identityShortDescription?.trim()
          ? { shortDescription: agent.identityShortDescription.trim() }
          : {}),
        ...(language ? { language } : {}),
        ownIdentityChannelTypes: registry?.channelTypesWithIdentity?.(agent.slug) ?? [],
        ...(Object.keys(archetypeSettings).length > 0 ? { archetypeSettings } : {}),
      };
    },
  };
}

/**
 * #2066 — the settings that still fit the archetype's declared fields. A read
 * failure is logged and answered with none: the plugin then uses its instance
 * settings, which is what an unset field means anyway.
 */
async function readArchetypeSettings(
  deps: AgentTurnServiceDeps,
  agent: { readonly id: string; readonly slug: string; readonly archetype?: string },
): Promise<Readonly<Record<string, ArchetypeAgentSettingValue>>> {
  if (!deps.archetypeSettings) return {};
  try {
    const stored = await deps.archetypeSettings(agent.id);
    return effectiveArchetypeAgentSettings(getArchetype(archetypeOf(agent)), stored);
  } catch (err) {
    deps.log?.(
      `[agent-turn] archetype settings of '${agent.slug}' could not be read, instance settings apply: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

// ---------------------------------------------------------------------------
// agentTurn@2 (#2090) — the same turn, as an authorized action
// ---------------------------------------------------------------------------

export interface ScopedAgentTurnServiceDeps extends AgentTurnServiceDeps {
  /** The calling plugin's execution authorization; absent without a database. */
  readonly execution: () => ExecutionAuthorizationService | undefined;
  /**
   * Counts the model calls made inside the turn and refuses every call
   * beyond `limit` (the provider gate, `meterModelCalls`). `probe` gives the
   * counts so far.
   */
  readonly meter: <T>(
    work: (probe: () => { modelCalls: number; refused: number }) => Promise<T>,
    options: {
      limit: number;
      /** Spec 2042 §5.10 — the execution scope is the model calls' context. */
      context?: { kind: 'execution_scope'; ownerId: string; agentSlug: string };
    },
  ) => Promise<{ value: T; modelCalls: number; refused: number }>;
}

const MAX_RESERVED_MODEL_CALLS = 200;

export function createScopedAgentTurnService(deps: ScopedAgentTurnServiceDeps): ScopedAgentTurnService {
  const base = createAgentTurnService(deps);
  const log = deps.log ?? (() => undefined);
  const refusedV2 = (
    code: Extract<ScopedAgentTurnOutcome, { outcome: 'refused' }>['code'],
    message: string,
    executionCode?: ExecutionRefusalCode,
  ): ScopedAgentTurnOutcome => ({
    outcome: 'refused',
    code,
    message,
    ...(executionCode ? { executionCode } : {}),
  });

  return {
    getProfile: (agentSlug) => base.getProfile(agentSlug),

    async runTurn(request: ScopedAgentTurnRequest): Promise<ScopedAgentTurnOutcome> {
      if (
        !isText(request?.scopeId, 128) ||
        !isText(request.processId, MAX_KEY) ||
        !isText(request.agentSlug, 128) ||
        typeof request.phase !== 'string' ||
        typeof request.purpose !== 'string'
      ) {
        return refusedV2('unavailable', 'scopeId, processId, agentSlug, phase and purpose are required');
      }
      if (request.emission !== 'prose') {
        return refusedV2('unavailable', "a turn's emission type is 'prose'");
      }
      const reserved = request.budget?.modelCalls;
      if (!Number.isInteger(reserved) || reserved < 1 || reserved > MAX_RESERVED_MODEL_CALLS) {
        return refusedV2('unavailable', `budget.modelCalls is a whole number from 1 to ${String(MAX_RESERVED_MODEL_CALLS)}`);
      }
      const execution = deps.execution();
      if (!execution) return refusedV2('unavailable', 'execution authorization needs a database');
      // The caller must be allowed to run this agent at all, before a unit of
      // the scope is spent on finding out.
      if ((await base.getProfile(request.agentSlug)) === undefined) {
        return refusedV2('not_bound', `agent '${request.agentSlug}' is not an agent this plugin runs`);
      }
      // The scope must be this process's and this agent's. A scope of another
      // plugin is not in the list, so it reads as unknown.
      const scope = (await execution.listScopes(request.processId)).find((s) => s.id === request.scopeId);
      if (!scope || scope.agentSlug !== request.agentSlug) {
        return refusedV2('not_authorized', 'no such scope for this process and agent', 'unknown_scope');
      }

      const authorization = await execution.authorize({
        scopeId: scope.id,
        phase: request.phase,
        purpose: request.purpose,
        action: 'model_turn',
        emission: 'prose',
        modelCalls: reserved,
        ...(request.target !== undefined ? { target: request.target } : {}),
      });
      if (authorization.outcome === 'refused') {
        return refusedV2('not_authorized', authorization.message, authorization.code);
      }

      // The reservation is a hard cap: the gate refuses every model call
      // beyond it. An answer produced although a call was refused (a helper
      // or a guard that carried on without its model) does not stand.
      let used = 0;
      let refusedCalls = 0;
      let outcome: AgentTurnOutcome;
      try {
        const metered = await deps.meter(
          (probe) => base.runGuarded(request, request.processId, () => probe().refused === 0),
          {
            limit: reserved,
            context: { kind: 'execution_scope', ownerId: scope.id, agentSlug: request.agentSlug },
          },
        );
        used = metered.modelCalls;
        refusedCalls = metered.refused;
        outcome = metered.value;
      } catch (err) {
        outcome = { outcome: 'failed', message: err instanceof Error ? err.message : String(err) };
      }
      // Whatever happened: what was not used goes back to the scope.
      await execution.settle(authorization.authorizationId, { modelCalls: used });
      if (refusedCalls > 0) {
        log(
          `[agent-turn] turn as '${request.agentSlug}' (process ${request.processId}) needed more than the ${String(reserved)} model calls it reserved; ${String(refusedCalls)} call(s) refused, no text returned`,
        );
        return {
          outcome: 'refused',
          code: 'reservation_exceeded',
          message: `the turn needed more than the ${String(reserved)} model calls it reserved; it was ended and returned no text`,
          authorizationId: authorization.authorizationId,
          modelCalls: { reserved, used, refused: refusedCalls },
        };
      }
      if (outcome.outcome === 'completed') {
        return {
          ...outcome,
          authorizationId: authorization.authorizationId,
          modelCalls: { reserved, used },
        };
      }
      if (outcome.outcome === 'failed') {
        return { ...outcome, authorizationId: authorization.authorizationId };
      }
      return outcome;
    },
  };
}
