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
      ...(event.droppedHeaderNames ? { droppedHeaderNames: event.droppedHeaderNames } : {}),
    },
  };
}

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
      sideEffects: 'write',
    }),
    deps.registerNativeTool(CREDENTIAL_ASK_TOOL_NAME, {
      handler: createCredentialAskHandler(toolDeps),
      spec: credentialAskToolSpec,
      isAvailable,
      sideEffects: 'write',
    }),
  ];

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
      const out: AgentCredentialReach[] = [];
      for (const grant of held) {
        const credential = await deps.credentials.getCredential(grant.credentialId);
        if (!credential || credential.revokedAt) continue;
        out.push({ credentialId: credential.id, name: credential.name, kind: credential.kind, host: credential.broker?.host ?? null });
      }
      return out;
    },
    async start() {
      await snapshot.refresh();
      snapshot.start();
    },
    stop() {
      snapshot.stop();
      for (const dispose of disposers) dispose();
    },
  };
}
