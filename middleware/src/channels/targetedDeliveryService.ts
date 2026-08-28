// Principal-addressed targeted delivery (#330 B3). THE place principal
// resolution happens for DMs: 'user:<id>' resolves to one target, 'role:<key>'
// fans out to ALL current holders at send time (late-bound; notification
// semantics — one delivery per holder, no quorum). Role→holder resolution is
// a kernel invariant (the holder-source union decides who may approve — see
// roleHolderSource.ts); a channel plugin only ever receives one resolved user
// per delivery. Never a silent drop and never a throw for emptiness or
// unreachability: every non-delivery lands in the report's diagnostics.

import type {
  AggregateHolderLookup,
  TargetedDeliveryOutcome,
  TargetedMessage,
  TargetedSendDiagnostic,
  TargetedSendReport,
} from '@omadia/channel-sdk';
import { parsePrincipal } from '@omadia/channel-sdk';

import type { TargetedSendRegistry } from './targetedSendRegistry.js';

export interface TargetedDeliveryService {
  /** `principal` is the wire form: 'user:<id>' | 'role:<key>'. */
  sendToPrincipal(input: {
    channelType: string;
    principal: string;
    message: TargetedMessage;
  }): Promise<TargetedSendReport>;
}

export function createTargetedDeliveryService(deps: {
  providers: TargetedSendRegistry;
  /** Role→holders resolver (the Conductor holder registry). Absent on the
   *  no-Postgres path — role sends then report 'role_resolution_unavailable'
   *  while user sends keep working. */
  resolveRoleHolders?: (roleKey: string) => Promise<AggregateHolderLookup>;
  /** Cached per-user conversation references for a channel type (the
   *  conductor channel-binding store). Absent = providers materialize 1:1
   *  conversations themselves (Teams proactive messaging can). */
  lookupConversationRefs?: (principalIds: string[], channelType: string) => Promise<Map<string, unknown>>;
  log?: (msg: string) => void;
}): TargetedDeliveryService {
  const log = deps.log ?? (() => undefined);

  async function deliverAll(
    channelType: string,
    principalIds: readonly string[],
    message: TargetedMessage,
  ): Promise<{
    deliveries: { principalId: string; outcome: TargetedDeliveryOutcome }[];
    diagnostics: TargetedSendDiagnostic[];
  }> {
    const provider = deps.providers.get(channelType);
    if (!provider) {
      return {
        deliveries: [],
        diagnostics: [
          {
            code: 'no_targeted_send_provider',
            message: `no targeted-send provider registered for channel type '${channelType}'`,
          },
        ],
      };
    }

    // Skip the lookup entirely for an empty fan-out (role_has_no_holders path).
    const refs =
      deps.lookupConversationRefs && principalIds.length > 0
        ? await deps.lookupConversationRefs([...principalIds], channelType).catch((err: unknown) => {
            // Degraded, not silent: downstream this surfaces as per-holder
            // 'no_binding' outcomes, so name the real cause once here.
            log(
              `[channels] targeted send: conversation-ref lookup for ${channelType} failed (falling back to provider-side resolution): ${err instanceof Error ? err.message : String(err)}`,
            );
            return new Map<string, unknown>();
          })
        : new Map<string, unknown>();

    const deliveries: { principalId: string; outcome: TargetedDeliveryOutcome }[] = [];
    const diagnostics: TargetedSendDiagnostic[] = [];
    for (const principalId of principalIds) {
      const conversationRef = refs.get(principalId);
      let outcome: TargetedDeliveryOutcome;
      try {
        outcome = await provider.sendToUser(
          { principalId, ...(conversationRef !== undefined ? { conversationRef } : {}) },
          message,
        );
      } catch (err) {
        // Providers should RETURN unreachability; a throw is still confined to
        // this holder so the remaining fan-out continues.
        outcome = {
          outcome: 'unreachable',
          code: 'channel_error',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      deliveries.push({ principalId, outcome });
      if (outcome.outcome === 'unreachable') {
        diagnostics.push({
          code: 'holder_unreachable',
          message: `delivery to '${principalId}' failed: ${outcome.code} — ${outcome.message}`,
          principalId,
        });
        log(`[channels] targeted send to '${principalId}' (${channelType}) unreachable: ${outcome.code}`);
      }
    }
    return { deliveries, diagnostics };
  }

  return {
    async sendToPrincipal(input) {
      const principal = parsePrincipal(input.principal);
      if (!principal) {
        // No fabricated empty principal — its absence plus the diagnostic IS
        // the answer.
        return {
          resolution: { kind: 'single-user' },
          deliveries: [],
          diagnostics: [
            {
              code: 'invalid_principal',
              message: `'${input.principal}' is not a valid principal ('user:<id>' | 'role:<key>')`,
            },
          ],
        };
      }

      if (principal.kind === 'user') {
        const { deliveries, diagnostics } = await deliverAll(input.channelType, [principal.userId], input.message);
        return { principal, resolution: { kind: 'single-user' }, deliveries, diagnostics };
      }

      // role: late-bound fan-out to all current holders — broadcast, no quorum.
      if (!deps.resolveRoleHolders) {
        return {
          principal,
          resolution: { kind: 'role', holders: [], partial: true },
          deliveries: [],
          diagnostics: [
            {
              code: 'role_resolution_unavailable',
              message: `role '${principal.roleKey}' cannot be resolved: no role-holder resolver wired (no graph database?)`,
            },
          ],
        };
      }

      let lookup: AggregateHolderLookup;
      try {
        lookup = await deps.resolveRoleHolders(principal.roleKey);
      } catch (err) {
        return {
          principal,
          resolution: { kind: 'role', holders: [], partial: true },
          deliveries: [],
          diagnostics: [
            {
              code: 'role_resolution_unavailable',
              message: `role '${principal.roleKey}' resolution failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      const diagnostics: TargetedSendDiagnostic[] = [];
      if (lookup.partial) {
        // Lower-bound semantics surfaced, never hidden: deliveries to the known
        // holders still go out, but the report says the list may be incomplete.
        diagnostics.push({
          code: 'role_resolution_partial',
          message: `role '${principal.roleKey}' holder list is partial — delivered to the known holders only`,
        });
      }
      if (lookup.holders.length === 0 && !lookup.partial) {
        // An empty role is a delivery diagnostic / escalation, not a silent drop.
        diagnostics.push({
          code: 'role_has_no_holders',
          message: `role '${principal.roleKey}' has no current holder — nothing was delivered`,
        });
      }

      const { deliveries, diagnostics: deliveryDiagnostics } = await deliverAll(
        input.channelType,
        lookup.holders,
        input.message,
      );
      return {
        principal,
        resolution: { kind: 'role', holders: lookup.holders, partial: lookup.partial },
        deliveries,
        diagnostics: [...diagnostics, ...deliveryDiagnostics],
      };
    },
  };
}
