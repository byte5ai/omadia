// Targeted delivery service surface (#330 B3) — how an AGENT plugin (e.g. the
// Facilitator) sends a report/DM to one Principal. Published by the kernel via
// `serviceRegistry.provide(TARGETED_SEND_SERVICE_NAME, …)`; plugins MUST treat
// the service as optional (older kernels, no-Postgres deployments degrade the
// role path) and reach it through `ctx.services.get(...)` after declaring the
// service name in their manifest (deny-by-default) — as `optional_requires`,
// NOT `requires`: no plugin provides this capability (the kernel does), so a
// hard `requires` is unresolvable and keeps the consumer from ever activating.
//
// The shapes are plugin-api-OWN on purpose: the dependency direction is
// channel-sdk → plugin-api, so this file must not import the channel-sdk. They
// stay structurally compatible with the channel-sdk's TargetedSendReport.

export const TARGETED_SEND_SERVICE_NAME = 'targetedSend';

export interface TargetedSendRequest {
  /** The `channel_bindings.channel_type` to deliver on (e.g. 'teams'). */
  channelType: string;
  /** Wire-form principal: 'user:<id>' | 'role:<key>'. A role fans out to ALL
   *  current holders at send time (one delivery per holder, no quorum). */
  principal: string;
  message: {
    text: string;
  };
}

export type TargetedSendDeliveryOutcome =
  | { outcome: 'delivered' }
  | { outcome: 'unreachable'; code: string; message: string };

export interface TargetedSendResultDiagnostic {
  code: string;
  message: string;
  principalId?: string;
}

/** Structurally mirrors the channel-sdk's TargetedSendReport. `resolution.partial`
 *  means the holder list was a lower bound — "delivered to everyone listed" must
 *  not be read as "delivered to every holder". */
export interface TargetedSendResult {
  resolution:
    | { kind: 'single-user' }
    | { kind: 'role'; holders: readonly string[]; partial: boolean };
  deliveries: readonly { principalId: string; outcome: TargetedSendDeliveryOutcome }[];
  diagnostics: readonly TargetedSendResultDiagnostic[];
}

export interface TargetedSendService {
  sendToPrincipal(request: TargetedSendRequest): Promise<TargetedSendResult>;
}
