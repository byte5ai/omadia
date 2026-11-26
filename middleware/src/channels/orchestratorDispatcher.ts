import { CHAT_AGENT_SERVICE, parseAgentCommand, turnPrincipal } from '@omadia/channel-sdk';
import type {
  ChatAgent,
  ChatAgentBundle,
  ChatTurnInput,
  ChannelResolveResult,
  ChannelRouteContext,
  ChannelUserKind,
  TurnOrigin,
} from '@omadia/channel-sdk';
import type { ChannelKind } from '@omadia/plugin-api';
import { runGeneratorInExecutionContext, type ModelExecutionContext } from '@omadia/usage-telemetry';

/**
 * W5 memory-ACL (#860) — validate a `TurnOrigin` arriving from an
 * independently-versioned channel plugin.
 *
 * This is a TRUST BOUNDARY, not a cast. The origin decides which memory tier a
 * turn reaches, so a malformed one must never become a partially-populated
 * object that resolves to *some* tier: it resolves to NONE. Every rejection
 * below returns `undefined`, which `memoryAxesForOrigin` reads as context-free
 * — the agent-private stack every turn gets today.
 *
 * Note the deliberate shallowness: `scope` and `principal` are handed on
 * unvalidated beyond "is an object", because `memoryAxesForOrigin` already
 * switches on `scope.kind` with a default that falls through to context-free,
 * and re-implementing that discrimination here would be a second, drifting
 * copy of the §2 table. What this function guarantees is only that the SHAPE
 * cannot throw and that `channelType`/`container` cannot be smuggled through
 * as non-strings.
 */
function readTurnOrigin(raw: unknown, channelId: string): TurnOrigin | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const candidate = raw as Record<string, unknown>;

  const channelType = candidate['channelType'];
  if (typeof channelType !== 'string' || channelType.trim().length === 0) {
    return undefined;
  }
  // #1774 / #1826 (ADR-0182) — reserved origin types. `http` is the kernel's
  // own web account room (`webAccountOrigin`), whose user id counts as
  // canonical without an identity lookup: no channel plugin may state it.
  // `api` names an API key's room and only the Public API channel states it.
  if (!mayStateOriginType(channelType, channelId)) {
    console.warn(
      `[security-audit] orchestratorDispatcher: channel ${channelId} stated the reserved origin type '${channelType}' — turn runs context-free`,
    );
    return undefined;
  }
  const scope = candidate['scope'];
  if (scope === null || typeof scope !== 'object') return undefined;

  const rawContainer = candidate['container'];
  let container: TurnOrigin['container'];
  if (rawContainer !== undefined) {
    if (rawContainer === null || typeof rawContainer !== 'object') return undefined;
    const kind = (rawContainer as Record<string, unknown>)['kind'];
    const id = (rawContainer as Record<string, unknown>)['id'];
    // An unknown container kind is dropped rather than rejected: the turn is
    // still a legitimate conversation, it simply has no team tier. Dropping is
    // the narrower answer; rejecting the whole origin would be wider only in
    // the sense of losing the channel tier too, so both are safe — but keeping
    // the narrow tier is the more useful of the two.
    if ((kind === 'team' || kind === 'tenant') && typeof id === 'string' && id.length > 0) {
      container = { kind, id };
    }
  }

  const rawPrincipal = candidate['principal'];
  const principal =
    rawPrincipal !== null && typeof rawPrincipal === 'object'
      ? (rawPrincipal as TurnOrigin['principal'])
      : undefined;

  const rawType = candidate['conversationType'];
  return {
    channelType,
    scope: scope as TurnOrigin['scope'],
    ...(container ? { container } : {}),
    ...(principal ? { principal } : {}),
    // #2043 — only the two known values pass; anything else stays "unknown".
    ...(rawType === 'group' || rawType === 'direct' ? { conversationType: rawType } : {}),
  };
}

/** The Public API channel plugin, the one channel that may state an `api` origin. */
const PUBLIC_API_CHANNEL_ID = '@omadia/channel-api';

function mayStateOriginType(channelType: string, channelId: string): boolean {
  const type = channelType.trim().toLowerCase();
  if (type === 'http') return false;
  if (type === 'api') return channelId === PUBLIC_API_CHANNEL_ID;
  return true;
}

/**
 * #430 fixup — map the channel-plugin-facing {@link ChannelUserKind}
 * namespace to the KG-facing {@link ChannelKind} the ACL/identity model
 * understands. Deliberately partial: `discord-user` / `whatsapp-phone` have
 * no `ChannelKind` counterpart yet. Callers must treat `undefined` as "cannot
 * safely resolve an identity for this turn", not fall back to guessing.
 *
 * #1107 — the public chat API also arrives as `custom`, but unlike the
 * canvas/Omadia-UI channel (which carries a resolved human identity via
 * `session.subject` / `metadata.omadiaUserId`) it authenticates the caller AS
 * its API key: `harness-channel-api` sets `id: 'key:<uuid>'` (issue #438, "the
 * key IS its own identity"). That `key:` prefix is the API channel's own,
 * never-caller-controlled convention, so it is the safe discriminator between
 * the two `custom` producers — canvas ids are never `key:`-prefixed. Without
 * this the turn's receipt is written with `channel = NULL` and API traffic is
 * invisible in every per-channel view. Takes the whole ref, not just `kind`,
 * because the discriminant for `api` lives in the id.
 */
function toChannelKind(ref: {
  kind: ChannelUserKind;
  id: string;
}): ChannelKind | undefined {
  switch (ref.kind) {
    case 'teams-aad':
      return 'teams';
    case 'slack-user':
      return 'slack';
    case 'telegram-chat':
      return 'telegram';
    case 'custom':
      return ref.id.startsWith('key:') ? 'api' : undefined;
    default:
      return undefined;
  }
}

import type { ChannelManifestBlock } from '../api/admin-v1.js';
import type { TurnDispatcher } from './coreApi.js';
import { resolveDispatchService } from './dispatchService.js';

/**
 * Minimal structural dependencies of the orchestrator dispatcher, injected so
 * the routing logic is unit-testable without standing up the full boot graph.
 * At boot these are backed by `pluginCatalog`, the multi-orchestrator
 * `channelResolver`, and the `serviceRegistry`.
 */
export interface OrchestratorDispatcherDeps {
  /** A loaded channel plugin's manifest `channel` block, by channel id. */
  getChannelBlock(channelId: string): ChannelManifestBlock | undefined;
  /** The ChatAgentBundle registered under a bare service key, or undefined. */
  getAgentBundle(service: string): ChatAgentBundle | undefined;
  /**
   * #2055 — the management layer's ChatAgent for a turn's `(channelType,
   * channelKey)` and sender: in front of the routed agent, or answering with
   * the `system` notice when no agent may answer (agent disabled, deleted,
   * not available, nothing addressed); it also handles `/agent`. Never
   * another agent. Returns `undefined` when the resolver is not wired
   * (Postgres-less deployment) — the dispatcher then falls back to the static
   * `dispatch_service`. Optional so the legacy single-agent boot and unit
   * tests work without it.
   */
  resolveBinding?(channelType: string, channelKey: string, context: ChannelRouteContext): ChatAgent | undefined;
  /**
   * Map a `channelId` (plugin catalog id) to its `channel_bindings.channel_type`
   * selector (`de.byte5.channel.teams` → `teams`). Optional — paired with
   * `resolveBinding`; absent disables per-binding routing.
   */
  channelTypeFor?(channelId: string): string;
  /**
   * #2059 — explicit addressing by agent id (a canvas, a UI with an agent
   * picker): the agent's own envelope, checked like any routing target
   * (enabled, not deleted, available to the sender here). A `reject` result
   * carries a `chatAgent` that answers with the `system` notice naming the
   * agent. Returns `undefined` when the platform cannot address by id (no
   * registry, or an older resolver): the turn is then refused, never routed
   * to another agent.
   */
  resolveAgent?(
    agentId: string,
    target: { readonly channelType: string; readonly channelKey: string },
    context: ChannelRouteContext,
  ): ChannelResolveResult | undefined;
}

/**
 * #2059 — the agent id a turn addresses, if it names one. Set by a UI that
 * lets the user pick an agent per conversation (`metadata.agentId`); a
 * non-string or blank value counts as no address.
 */
function addressedAgentId(metadata: Record<string, unknown> | undefined): string | undefined {
  const raw = metadata?.['agentId'];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

/** The canvas fields of a turn's metadata, shape-checked (a channel is a trust
 *  boundary: anything of another shape counts as absent). */
interface CanvasTurnFields {
  readonly canvasSessionId?: string;
  readonly action?: { type: string; payload?: unknown; target?: unknown };
  readonly canvasRefresh?: { basedOnRevision: string; currentTree: unknown; scope?: string };
  readonly canvasState?: { basedOnRevision: string; currentTree: unknown };
  /** a turn with no words for a model: a refresh, an action, or a canvas turn without text */
  readonly structured: boolean;
}

function readCanvasTurn(input: {
  readonly text: string;
  readonly target?: unknown;
  readonly metadata?: Record<string, unknown> | undefined;
}): CanvasTurnFields {
  const metadata = input.metadata;
  const canvasSessionId =
    typeof metadata?.['canvasSessionId'] === 'string' ? (metadata['canvasSessionId'] as string) : undefined;
  // The structured UI action (button click, choice pick) set by the canvas
  // channel — protocol 1.0 §5.1's typed-field promise. The originating
  // element's TargetRef rides along so Tier 2 knows WHICH element fired.
  const rawAction = metadata?.['action'];
  const action =
    typeof rawAction === 'object' &&
    rawAction !== null &&
    typeof (rawAction as { type?: unknown }).type === 'string'
      ? {
          ...(rawAction as { type: string; payload?: unknown }),
          ...(input.target !== undefined ? { target: input.target } : {}),
        }
      : undefined;
  // Deterministic canvas refresh (omadia-ui#5) — same metadata ride as
  // `action`; shape-validated by the channel, re-checked here.
  const rawRefresh = metadata?.['canvasRefresh'];
  const canvasRefresh =
    typeof rawRefresh === 'object' &&
    rawRefresh !== null &&
    typeof (rawRefresh as { basedOnRevision?: unknown }).basedOnRevision === 'string'
      ? (rawRefresh as { basedOnRevision: string; currentTree: unknown; scope?: string })
      : undefined;
  // PR-9b-3 in-place action — same metadata ride as `canvasRefresh`: the
  // client's live tree so a canvas-aware orchestrator skips the skeleton
  // and patches on top of it. Re-checked here (defence in depth).
  const rawState = metadata?.['canvasState'];
  const canvasState =
    typeof rawState === 'object' &&
    rawState !== null &&
    typeof (rawState as { basedOnRevision?: unknown }).basedOnRevision === 'string'
      ? (rawState as { basedOnRevision: string; currentTree: unknown })
      : undefined;
  return {
    ...(canvasSessionId ? { canvasSessionId } : {}),
    ...(action ? { action } : {}),
    ...(canvasRefresh ? { canvasRefresh } : {}),
    ...(canvasState ? { canvasState } : {}),
    structured:
      canvasRefresh !== undefined ||
      action !== undefined ||
      (canvasSessionId !== undefined && input.text.trim().length === 0),
  };
}

/**
 * Build the real `TurnDispatcher`. Per turn:
 *
 *   0. **Explicit addressing (#2059).** A turn that names an agent
 *      (`metadata.agentId`, from a canvas or an agent picker) goes to exactly
 *      that agent's envelope via `resolveAgent`, with no model in front. This
 *      stage runs before the `dispatch_service` opt-out below on purpose: a
 *      canvas channel has `dispatch_service: canvasChatAgent` and still
 *      reaches the agent it named. A refusal is answered with the `system`
 *      notice, a platform that cannot address by id refuses the turn; neither
 *      ever falls through to another agent.
 *      When the channel declares an explicit `dispatch_service` (the canvas
 *      presentation helper) and the resolver BOUND the agent, the turn goes
 *      to that service with `ChatTurnInput.agentId` — set here, after the
 *      check, never from metadata — and the service works inside the agent's
 *      envelope (`agentEnvelope@1`). `/agent` commands stay with the
 *      management layer, and a structured canvas turn (`canvasRefresh`,
 *      `action`, a canvas turn without text) never reaches an agent as a
 *      model turn: without the service it ends in an error.
 *   1. **Per-binding routing (US7).** When the channel routes to the shared
 *      `chatAgent` (i.e. declares no explicit `dispatch_service`) and a
 *      `channelKey` is known, resolve the Agent the operator *bound* to this
 *      `(channelType, channelKey)` via the `channelResolver`. This is what
 *      makes a Teams/web turn reach its scoped orchestrator instead of the
 *      fully-tooled singleton.
 *   2. **Static dispatch_service fallback.** No binding match (or no resolver,
 *      or an explicit `dispatch_service` like Omadia UI's `canvasChatAgent`) →
 *      fetch that bundle from the registry exactly as before. An explicit
 *      `dispatch_service` is an intentional override and is NEVER re-routed by
 *      the binding resolver (only stage 0 outranks it).
 *
 * Resolution is lazy per turn so the currently-active orchestrator (and the
 * live binding table, post hot-reload) is always used. Classic channels with no
 * bindings and no `dispatch_service` dispatch to `chatAgent` exactly as before.
 */
/** The error a turn gets when no agent can take it. Shown in the chat. */
export const NO_AGENT_AVAILABLE_MESSAGE = 'no agent is available for this conversation';

export function createOrchestratorDispatcher(
  deps: OrchestratorDispatcherDeps,
): TurnDispatcher {
  return {
    async *streamTurn(input) {
      const block = deps.getChannelBlock(input.channelId);
      const dispatchService = resolveDispatchService(block);

      let agent: ChatAgent | undefined;
      /** the agent id handed to the `dispatch_service` (set by stage 0 only) */
      let handedAgentId: string | undefined;
      /** Spec 2042 §5.10 — the addressed agent's turn, opened around the
       *  channel's service when it takes the turn (set with `handedAgentId`) */
      let handedTurn: ModelExecutionContext | undefined;
      /** the turn is answered by a notice or by the channel's own service, not by a model of an agent */
      let modelFree = false;
      const origin = readTurnOrigin(input.metadata?.['origin'], input.channelId);
      const canvas = readCanvasTurn(input);

      // (0) #2059 Explicit addressing. A turn that names an agent goes to
      // THAT agent's envelope, with no model in front of it. Missing,
      // unknown or unavailable never falls through to another agent: the
      // resolver's `chatAgent` answers a `reject` with the `system` notice,
      // and a platform that cannot address by id refuses the turn.
      const addressedId = addressedAgentId(input.metadata);
      const locale =
        typeof input.metadata?.['locale'] === 'string' ? (input.metadata['locale'] as string) : undefined;
      if (addressedId !== undefined) {
        const channelType =
          input.channelType ?? deps.channelTypeFor?.(input.channelId) ?? input.channelId;
        const channelKey = input.channelKey ?? input.scope;
        const routed = deps.resolveAgent?.(
          addressedId,
          { channelType, channelKey },
          {
            principal: turnPrincipal(input.userRef, origin?.principal),
            ...(locale ? { locale } : {}),
          },
        );
        if (!routed?.chatAgent) {
          console.warn(
            `[channels] agent ${addressedId} cannot be addressed on ${channelType}:${channelKey} — turn refused (scope=${input.scope})`,
          );
          yield {
            type: 'error',
            message: 'the addressed agent is not available for this conversation',
          };
          return;
        }
        agent = routed.chatAgent;
        // a refusal is a notice from `system`: no model runs
        modelFree = routed.decision !== 'bound';
        // The agent is bound and the channel has its own service (the canvas
        // presentation helper): the service takes the turn, inside the
        // envelope of the agent just checked. A refusal and a `/agent`
        // command are the management layer's own answer, with no helper.
        if (
          routed.decision === 'bound' &&
          dispatchService !== CHAT_AGENT_SERVICE &&
          parseAgentCommand(input.text) === undefined
        ) {
          const service = deps.getAgentBundle(dispatchService)?.agent;
          if (service) {
            agent = service;
            handedAgentId = addressedId;
            modelFree = true;
            // The service's own model work (the canvas helper's skeleton,
            // its fast lane and decision model) runs before and beside the
            // agent's chat agent, which opens the agent turn only around its
            // own stream. It is that agent's turn all the same.
            const slug = routed.speaker?.slug ?? addressedId;
            handedTurn = { kind: 'agent_turn', ownerId: slug, agentSlug: slug };
          }
        }
      }

      // (1) Per-binding routing — only for channels that would otherwise hit
      // the shared chatAgent. An explicit dispatch_service (canvas) opts out.
      if (
        !agent &&
        dispatchService === CHAT_AGENT_SERVICE &&
        deps.resolveBinding &&
        deps.channelTypeFor &&
        input.channelKey
      ) {
        const channelType =
          input.channelType ?? deps.channelTypeFor(input.channelId);
        // #2055 — the management layer decides; its ChatAgent answers a
        // refusal with the `system` notice and handles `/agent` itself.
        const principal = turnPrincipal(input.userRef, origin?.principal);
        agent = deps.resolveBinding(channelType, input.channelKey, { principal });
      }

      // (2) Static dispatch_service fallback (legacy + canvas).
      if (!agent) {
        agent = deps.getAgentBundle(dispatchService)?.agent;
        modelFree = agent !== undefined && dispatchService !== CHAT_AGENT_SERVICE;
      }

      if (!agent) {
        console.warn(
          `[channels] no '${dispatchService}' agent registered — turn ignored (scope=${input.scope})`,
        );
        yield { type: 'error', message: NO_AGENT_AVAILABLE_MESSAGE };
        return;
      }
      // Omadia UI: the canvas fields of the turn metadata (session id, structured
      // action, refresh, live state) were read above; they are threaded into
      // ChatTurnInput so a canvas-aware service can stamp the session id onto
      // the surface_* events it synthesises. Classic channels set no such
      // metadata — the fields stay undefined and nothing changes.
      const { canvasSessionId, action, canvasRefresh, canvasState } = canvas;
      // A structured canvas turn has no words for a model to answer: it runs in
      // the channel's own service (deterministically, or as that service's own
      // silent step), is answered by a notice, or does not run — never as a
      // model turn at an agent.
      if (canvas.structured && !modelFree) {
        console.warn(
          `[channels] structured canvas turn without a '${dispatchService}' service — refused, not run as a model turn (scope=${input.scope})`,
        );
        yield { type: 'error', message: 'canvas_helper_unavailable' };
        return;
      }
      // #430 fixup — the ONLY place a `ChatTurnInput.channelIdentity` is
      // produced. `userId` above stays the raw channel-native id (unchanged,
      // documented behaviour); `channelIdentity` gives downstream code
      // (dataset ingest ACL) a typed, resolvable channel kind when one
      // exists, without guessing for kinds the KG model doesn't cover.
      const channelKind = toChannelKind(input.userRef);
      const channelIdentity = channelKind
        ? { channelKind, channelUserId: input.userRef.id }
        : undefined;
      // W5 memory-ACL (#860) — forward the channel plugin's `TurnOrigin` when
      // it sent one. This is the ONE seam between an independently-versioned
      // channel package and the memory partitioning, so it is validated here
      // rather than trusted: a shape this code does not recognise is DROPPED,
      // which resolves the turn context-free (today's agent-private memory).
      // Fail-closed applies to the transport too — an old plugin sends no
      // `origin` at all and gets exactly the same answer, so there is no flag
      // day in either direction.
      const turnInput: ChatTurnInput = {
        userMessage: input.text,
        sessionScope: input.scope,
        userId: input.userRef.id,
        ...(origin ? { origin } : {}),
        // handed to the channel's service after the check above; the management
        // layer's wrapper (which fills the locale) is not in front of it
        ...(handedAgentId !== undefined ? { agentId: handedAgentId } : {}),
        ...(handedAgentId !== undefined && locale ? { locale } : {}),
        ...(channelIdentity ? { channelIdentity } : {}),
        ...(canvasSessionId ? { canvasSessionId } : {}),
        ...(action ? { action } : {}),
        ...(canvasRefresh ? { canvasRefresh } : {}),
        ...(canvasState ? { canvasState } : {}),
        // a TEXT turn may be row-bound too (beam / context action) — thread
        // the TargetRef even without a structured action.
        ...(input.target !== undefined ? { target: input.target } : {}),
      };
      const chosen = agent;
      yield* handedTurn
        ? runGeneratorInExecutionContext(handedTurn, () => chosen.chatStream(turnInput))
        : chosen.chatStream(turnInput);
    },
  };
}
