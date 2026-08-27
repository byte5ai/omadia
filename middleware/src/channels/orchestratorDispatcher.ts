import { CHAT_AGENT_SERVICE } from '@omadia/channel-sdk';
import type {
  ChatAgent,
  ChatAgentBundle,
  ChannelUserKind,
  TurnOrigin,
} from '@omadia/channel-sdk';
import type { ChannelKind } from '@omadia/plugin-api';

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
function readTurnOrigin(raw: unknown): TurnOrigin | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const candidate = raw as Record<string, unknown>;

  const channelType = candidate['channelType'];
  if (typeof channelType !== 'string' || channelType.trim().length === 0) {
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

  return {
    channelType,
    scope: scope as TurnOrigin['scope'],
    ...(container ? { container } : {}),
    ...(principal ? { principal } : {}),
  };
}

/**
 * #430 fixup — map the channel-plugin-facing {@link ChannelUserKind}
 * namespace to the KG-facing {@link ChannelKind} the ACL/identity model
 * understands. Deliberately partial: `discord-user` / `whatsapp-phone` have
 * no `ChannelKind` counterpart yet, and `custom` (the canvas/Omadia-UI
 * channel's own namespace, which carries its already-resolved
 * `omadiaUserId` via a different path — `metadata.omadiaUserId`) is not a
 * single channel at all. Callers must treat `undefined` as "cannot safely
 * resolve an identity for this turn", not fall back to guessing.
 */
function toChannelKind(kind: ChannelUserKind): ChannelKind | undefined {
  switch (kind) {
    case 'teams-aad':
      return 'teams';
    case 'slack-user':
      return 'slack';
    case 'telegram-chat':
      return 'telegram';
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
   * US7 per-binding routing: resolve the *scoped* ChatAgent bound to a turn's
   * `(channelType, channelKey)` via the multi-orchestrator `channelResolver`.
   * Returns `undefined` when no binding (and no platform fallback Agent)
   * matches, OR when the resolver is not wired (Postgres-less deployment) — the
   * dispatcher then falls back to the static `dispatch_service`. Optional so the
   * legacy single-Agent boot and unit tests work without it.
   */
  resolveBinding?(channelType: string, channelKey: string): ChatAgent | undefined;
  /**
   * Map a `channelId` (plugin catalog id) to its `channel_bindings.channel_type`
   * selector (`de.byte5.channel.teams` → `teams`). Optional — paired with
   * `resolveBinding`; absent disables per-binding routing.
   */
  channelTypeFor?(channelId: string): string;
}

/**
 * Build the real `TurnDispatcher`. Per turn:
 *
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
 *      the binding resolver.
 *
 * Resolution is lazy per turn so the currently-active orchestrator (and the
 * live binding table, post hot-reload) is always used. Classic channels with no
 * bindings and no `dispatch_service` dispatch to `chatAgent` exactly as before.
 */
export function createOrchestratorDispatcher(
  deps: OrchestratorDispatcherDeps,
): TurnDispatcher {
  return {
    async *streamTurn(input) {
      const block = deps.getChannelBlock(input.channelId);
      const dispatchService = resolveDispatchService(block);

      let agent: ChatAgent | undefined;

      // (1) Per-binding routing — only for channels that would otherwise hit
      // the shared chatAgent. An explicit dispatch_service (canvas) opts out.
      if (
        dispatchService === CHAT_AGENT_SERVICE &&
        deps.resolveBinding &&
        deps.channelTypeFor &&
        input.channelKey
      ) {
        const channelType =
          input.channelType ?? deps.channelTypeFor(input.channelId);
        agent = deps.resolveBinding(channelType, input.channelKey);
      }

      // (2) Static dispatch_service fallback (legacy + canvas).
      if (!agent) {
        agent = deps.getAgentBundle(dispatchService)?.agent;
      }

      if (!agent) {
        console.warn(
          `[channels] no '${dispatchService}' agent registered — turn ignored (scope=${input.scope})`,
        );
        yield { type: 'error', message: 'orchestrator unavailable' };
        return;
      }
      // Omadia UI: thread the canvas session id (set by the canvas channel in
      // the turn metadata) into ChatTurnInput so a canvas-aware orchestrator can
      // stamp it onto the surface_* events it synthesises. Classic channels set
      // no such metadata — the field stays undefined and nothing changes.
      const canvasSessionId =
        typeof input.metadata?.['canvasSessionId'] === 'string'
          ? (input.metadata['canvasSessionId'] as string)
          : undefined;
      // The structured UI action (button click, choice pick) set by the canvas
      // channel — protocol 1.0 §5.1's typed-field promise. The originating
      // element's TargetRef rides along so Tier 2 knows WHICH element fired.
      const rawAction = input.metadata?.['action'];
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
      const rawRefresh = input.metadata?.['canvasRefresh'];
      const canvasRefresh =
        typeof rawRefresh === 'object' &&
        rawRefresh !== null &&
        typeof (rawRefresh as { basedOnRevision?: unknown }).basedOnRevision === 'string'
          ? (rawRefresh as { basedOnRevision: string; currentTree: unknown; scope?: string })
          : undefined;
      // PR-9b-3 in-place action — same metadata ride as `canvasRefresh`: the
      // client's live tree so a canvas-aware orchestrator skips the skeleton
      // and patches on top of it. Re-checked here (defence in depth).
      const rawState = input.metadata?.['canvasState'];
      const canvasState =
        typeof rawState === 'object' &&
        rawState !== null &&
        typeof (rawState as { basedOnRevision?: unknown }).basedOnRevision === 'string'
          ? (rawState as { basedOnRevision: string; currentTree: unknown })
          : undefined;
      // #430 fixup — the ONLY place a `ChatTurnInput.channelIdentity` is
      // produced. `userId` above stays the raw channel-native id (unchanged,
      // documented behaviour); `channelIdentity` gives downstream code
      // (dataset ingest ACL) a typed, resolvable channel kind when one
      // exists, without guessing for kinds the KG model doesn't cover.
      const channelKind = toChannelKind(input.userRef.kind);
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
      const origin = readTurnOrigin(input.metadata?.['origin']);
      yield* agent.chatStream({
        userMessage: input.text,
        sessionScope: input.scope,
        userId: input.userRef.id,
        ...(origin ? { origin } : {}),
        ...(channelIdentity ? { channelIdentity } : {}),
        ...(canvasSessionId ? { canvasSessionId } : {}),
        ...(action ? { action } : {}),
        ...(canvasRefresh ? { canvasRefresh } : {}),
        ...(canvasState ? { canvasState } : {}),
        // a TEXT turn may be row-bound too (beam / context action) — thread
        // the TargetRef even without a structured action.
        ...(input.target !== undefined ? { target: input.target } : {}),
      });
    },
  };
}
