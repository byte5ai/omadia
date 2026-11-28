/**
 * #2319 — assembles the kernel capability `credentialBroker@1`: the broker
 * itself (first instance on main), the per-agent grant store and its offer
 * snapshot, the two native tools, the operator grant routes and the ask
 * notices. `index.ts` only hands in what already exists there.
 *
 * The broker is deliberately NOT published in the service registry: a plugin
 * holding it could call it outside any agent's envelope. Agents reach it
 * through the two tools, nothing else does.
 */

import type { Pool } from 'pg';

import { formatPrincipal, type CredentialStore, type EncryptedSecretMaterial } from '@omadia/channel-sdk';
import { turnContext, type ConfigStore } from '@omadia/orchestrator';
import type { NativeToolSpec } from '@omadia/plugin-api';
import type { Router } from 'express';

import { systemAuditActor, type AuditEntryInput } from '../auth/adminAuditLog.js';
import { createOperatorCredentialGrantRouter } from '../routes/operatorCredentialGrants.js';
import type { CredentialAsk, CredentialAskStore } from './asks.js';
import {
  AgentCredentialGrantSnapshot,
  InMemoryAgentCredentialGrantStore,
  InMemoryCredentialAskDeliveryStore,
  PostgresAgentCredentialGrantStore,
  PostgresCredentialAskDeliveryStore,
  type AgentCredentialGrantStore,
  type AgentCredentialReach,
  type CredentialAskDeliveryStore,
} from './agentCredentialGrants.js';
import { CredentialBroker, type BrokerAuditEvent } from './broker.js';
import { createCredentialAskNotices, type CredentialAskNoticeDeps } from './credentialAskNotices.js';
import {
  CREDENTIAL_ASK_TOOL_NAME,
  CREDENTIAL_REQUEST_TOOL_NAME,
  createCredentialAskHandler,
  createCredentialRequestHandler,
  credentialAskToolSpec,
  credentialRequestToolSpec,
  credentialToolsOffered,
  type CredentialBrokerAgent,
} from './credentialBrokerTools.js';

export interface CredentialBrokerWiringDeps {
  readonly pool: Pool | undefined;
  readonly credentials: CredentialStore;
  readonly unseal: (material: EncryptedSecretMaterial) => string;
  readonly asks: CredentialAskStore;
  readonly registerNativeTool: (
    name: string,
    registration: {
      readonly handler: (input: unknown) => Promise<string>;
      readonly spec: NativeToolSpec;
      readonly isAvailable: () => boolean;
      readonly sideEffects: 'write';
      readonly kernelSystem: string;
      readonly modelDispatchOnly: true;
    },
  ) => () => void;
  readonly agentBySlug: (slug: string) => CredentialBrokerAgent | undefined;
  readonly agentById: (id: string) => CredentialBrokerAgent | undefined;
  readonly currentConversation: () => { readonly channel: string; readonly conversationRef: unknown } | undefined;
  readonly getConfigStore: () => Pick<ConfigStore, 'getAgentBySlug'> | undefined;
  readonly notices: Omit<CredentialAskNoticeDeps, 'log'>;
  readonly recordAudit: (entry: AuditEntryInput) => Promise<void>;
  readonly log: (message: string) => void;
}

export interface CredentialBrokerWiring {
  readonly broker: CredentialBroker;
  readonly grants: AgentCredentialGrantStore;
  readonly deliveries: CredentialAskDeliveryStore;
  /** Mount under `/api/v1/operator` behind `requireAuth`. */
  readonly operatorRouter: Router;
  /** The asks route's `onResolved`: posts the decision to the asking conversation. */
  onAskResolved(ask: CredentialAsk): Promise<void>;
  /** ADR-0290 — the agent's granted credentials and their declared hosts, for its reach. */
  reachOf(agentId: string): Promise<readonly AgentCredentialReach[]>;
  start(): Promise<void>;
  stop(): void;
}

/** Audit row of one broker decision: never the secret, the query string or a body. */
export function brokerAuditEntry(event: BrokerAuditEvent, agentSlug: string | undefined): AuditEntryInput {
  return {
    actor: systemAuditActor('system:credential-broker'),
    action: 'credential.broker_use',
    target: `credential:${event.credentialId}`,
    after: {
      decision: event.kind,
      principal: formatPrincipal(event.principal),
      host: event.host,
      method: event.method,
      path: event.path,
      ...(agentSlug ? { agent: agentSlug } : {}),
      ...(event.reason ? { reason: event.reason } : {}),
      ...(event.credentialFingerprint ? { fingerprint: event.credentialFingerprint } : {}),
      // Header names are chosen by the model: bounded, like everything else here.
      ...(event.droppedHeaderNames
        ? {
            droppedHeaderNames: event.droppedHeaderNames
              .slice(0, MAX_AUDITED_HEADER_NAMES)
              .map((n) => n.slice(0, MAX_AUDITED_HEADER_NAME_CHARS)),
          }
        : {}),
    },
  };
}

/** The discretion system both tools reach (Spec 2042 §5.11, `toolSystemOf`). */
export const CREDENTIAL_BROKER_SYSTEM = 'credential-broker';

/**
 * Both tools write (a request may change data upstream; an ask sends the
 * purpose to the owner), count as the `credential-broker` system for the
 * discretion egress check and read labels, and are refused on a plugin's
 * `ctx.tools.invoke`, which skips the Privacy Shield.
 */
const TOOL_GUARDS = { sideEffects: 'write', kernelSystem: CREDENTIAL_BROKER_SYSTEM, modelDispatchOnly: true } as const;

/** Audit rows hold at most this many dropped header names, each this long. */
const MAX_AUDITED_HEADER_NAMES = 20;
const MAX_AUDITED_HEADER_NAME_CHARS = 64;

/** How often stale ask deliveries (resolved elsewhere, expired) are swept. */
const DELIVERY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export function wireCredentialBroker(deps: CredentialBrokerWiringDeps): CredentialBrokerWiring {
  const grants: AgentCredentialGrantStore = deps.pool
    ? new PostgresAgentCredentialGrantStore(deps.pool)
    : new InMemoryAgentCredentialGrantStore();
  const deliveries: CredentialAskDeliveryStore = deps.pool
    ? new PostgresCredentialAskDeliveryStore(deps.pool)
    : new InMemoryCredentialAskDeliveryStore();
  const snapshot = new AgentCredentialGrantSnapshot(grants, deps.log);

  const broker = new CredentialBroker({
    store: deps.credentials,
    unseal: deps.unseal,
    // Read inside the call's async context, so the agent of the turn is known.
    onAudit: (event) => {
      void deps.recordAudit(brokerAuditEntry(event, turnContext.current()?.agentSlug)).catch((err: unknown) => {
        deps.log(`[security-audit] credential.broker_use could not be recorded — ${err instanceof Error ? err.message : String(err)}`);
      });
    },
  });

  const notices = createCredentialAskNotices({ ...deps.notices, log: deps.log });
  const toolDeps = {
    broker,
    credentials: deps.credentials,
    grants,
    snapshot,
    asks: deps.asks,
    deliveries,
    notices,
    agentBySlug: deps.agentBySlug,
    currentConversation: deps.currentConversation,
    log: deps.log,
  };
  const isAvailable = (): boolean => credentialToolsOffered(toolDeps);
  const disposers = [
    deps.registerNativeTool(CREDENTIAL_REQUEST_TOOL_NAME, {
      handler: createCredentialRequestHandler(toolDeps),
      spec: credentialRequestToolSpec,
      isAvailable,
      ...TOOL_GUARDS,
    }),
    deps.registerNativeTool(CREDENTIAL_ASK_TOOL_NAME, {
      handler: createCredentialAskHandler(toolDeps),
      spec: credentialAskToolSpec,
      isAvailable,
      ...TOOL_GUARDS,
    }),
  ];

  // A delivery row holds a conversation reference; once its ask can no longer
  // be decided (expired, cancelled, resolved without the hook) it goes.
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  const sweepDeliveries = async (): Promise<void> => {
    try {
      const removed = await deliveries.purgeStale(new Date());
      if (removed > 0) deps.log(`[credential-broker] swept ${String(removed)} stale ask deliveries`);
    } catch (err) {
      deps.log(`[credential-broker] ask delivery sweep failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const operatorRouter = createOperatorCredentialGrantRouter({
    getConfigStore: deps.getConfigStore,
    credentials: deps.credentials,
    grants,
    refresh: () => snapshot.refresh(),
    recordAudit: deps.recordAudit,
  });

  return {
    broker,
    grants,
    deliveries,
    operatorRouter,
    async onAskResolved(ask) {
      const target = await deliveries.take(ask.id);
      if (!target) return;
      const [credential, agent] = [await deps.credentials.getCredential(ask.credentialId), deps.agentById(target.agentId)];
      await notices.deliverDecision(ask, target, {
        credentialName: credential?.name ?? ask.credentialId,
        agentName: agent?.name ?? 'The agent',
      });
    },
    async reachOf(agentId) {
      const held = await grants.list(agentId);
      const credentials = await Promise.all(held.map((g) => deps.credentials.getCredential(g.credentialId)));
      return credentials.flatMap((c): AgentCredentialReach[] =>
        c && !c.revokedAt ? [{ credentialId: c.id, name: c.name, kind: c.kind, host: c.broker?.host ?? null }] : [],
      );
    },
    async start() {
      await snapshot.refresh();
      snapshot.start();
      sweepTimer ??= setInterval(() => void sweepDeliveries(), DELIVERY_SWEEP_INTERVAL_MS);
      sweepTimer.unref?.();
    },
    stop() {
      snapshot.stop();
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = undefined;
      for (const dispose of disposers) dispose();
    },
  };
}
