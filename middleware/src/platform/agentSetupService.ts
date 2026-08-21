// Agent auto-provisioning + guarded conversation bindings (#330 C2a).
//
// Two plugin-facing, deny-by-default kernel services that remove the manual
// Facilitator setup steps:
//
//   'agentProvisioning'   — ensureAgent(): idempotently create a top-level
//                           Agent, seed a persona skill (create-only, slug
//                           namespaced to the agent — agents have no
//                           instructions column, the Wave-8
//                           agent_persona_skills path IS the persona) and
//                           attach the calling plugin. An EXISTING agent is
//                           never mutated: no create, no persona write, and
//                           an existing agent_plugins row is left exactly as
//                           the operator configured it (no config wipe, no
//                           re-enable — review H4).
//
//   'conversationBindings' — bind(): create a conversation-scoped channel
//                           binding, ONLY for a conversation the kernel
//                           itself observed a group bot_added for (the
//                           ObservedConversationInvites index — populated
//                           straight from the ConversationEventHub, so a
//                           plugin cannot fabricate eligibility), and only
//                           when nobody else holds it (channel_bindings PK).
//                           unbind() is equally guarded (review H1): a plugin
//                           can only release bindings recorded in
//                           conductor_ephemeral_attachments under its OWN
//                           agent slug — operator-authored bindings are out
//                           of reach, and a pre-existing operator binding is
//                           never adopted into the ephemeral lifecycle
//                           (review H5). Both mutations are audited.
//
// Cleanup truth lives in conductor_ephemeral_attachments: a row only
// disappears after its binding/role were successfully disposed of, so the
// sweep below retries what a reap-time cleanup missed (review H2).
//
// Trust model: like conductorEphemeralRuns' `agentId`, the caller names its
// plugin/agent identity itself — in-process plugins are code the operator
// installed; the parameter is attribution, not authentication. The guards
// above bound what even a misbehaving plugin can reach.

import type { AgentRow, ConfigStore } from '@omadia/orchestrator';
import { AgentGraphStore, ConfigValidationError } from '@omadia/orchestrator';
import type { Pool } from 'pg';

import type { ConductorEphemeralAttachmentsStore, EphemeralAttachment } from '../conductor/ephemeralAttachmentsStore.js';
import type { ObservedConversationInvites, ObservedInvite } from './observedConversationInvites.js';

/** Structural — all this module needs from the multi-orchestrator registry. */
interface ReloadableRegistry {
  reload(): Promise<unknown>;
}

const FALLBACK_SLUG = 'fallback';
const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface EnsureAgentInput {
  slug: string;
  name: string;
  description?: string;
  /** The calling plugin (attached to the agent, enabled). Attribution — see trust model. */
  pluginId: string;
  /** Persona seed. Create-only and namespaced: `slug` MUST start with
   *  `<agent slug>-`, and an existing skills row is NEVER overwritten
   *  (review H3 — upsert here would be a cross-agent prompt-injection
   *  vector). Only applied when THIS call creates the agent. */
  personaSkill?: { slug: string; name: string; body: string };
}

export interface EnsureAgentResult {
  created: boolean;
  agentSlug: string;
}

export interface AgentProvisioningService {
  ensureAgent(input: EnsureAgentInput): Promise<EnsureAgentResult>;
}

export interface BindResult {
  bound: boolean;
  reason?: 'not_observed' | 'bound_to_other_agent' | 'agent_missing' | 'kernel_not_ready';
  /** true when the conversation was already bound to this agent by the
   *  OPERATOR — the binding works, but it is deliberately NOT adopted into
   *  the ephemeral lifecycle (the sweep must never delete operator setup). */
  preexistingOperatorBinding?: boolean;
  invite?: ObservedInvite;
}

export interface BindingAuditEntry {
  actor: string;
  action: 'bind' | 'unbind';
  channelType: string;
  channelKey: string;
  agentSlug: string;
}

export interface ConversationBindingsService {
  bind(input: { agentSlug: string; channelType: string; conversationId: string; pendingTtlMs?: number }): Promise<BindResult>;
  /** Guarded: releases the binding only when an ephemeral-attachment row for
   *  this conversation exists AND carries the caller's own agentSlug. */
  unbind(input: { agentSlug: string; channelType: string; conversationId: string }): Promise<{ unbound: boolean }>;
  /** Tie the pending attachment to its facilitation run (after
   *  createEphemeralRun) so the reaper disposes of binding + role with it.
   *  Guarded to the caller's own pending row. */
  attachWorkflow(input: {
    agentSlug: string;
    channelType: string;
    conversationId: string;
    workflowId: string;
    roleKey?: string;
    expiresAt: Date;
  }): Promise<{ attached: boolean }>;
  /** The observed invite for a conversation (inviter, channel) — how the
   *  plugin learns WHO to assign the initiator role to. */
  observedInvite(channelType: string, conversationId: string): ObservedInvite | undefined;
}

export function createAgentSetupServices(deps: {
  pool: Pool;
  /** LAZY on purpose: 'configStore' / 'orchestratorRegistry' are provided by
   *  the orchestrator plugin at ITS activation — resolving at call time keeps
   *  this seam independent of plugin boot order. */
  getConfigStore: () => ConfigStore | undefined;
  getRegistry: () => ReloadableRegistry | undefined;
  invites: ObservedConversationInvites;
  attachments: ConductorEphemeralAttachmentsStore;
  /** The ONE cleanup path (shared with onEphemeralReaped in index.ts):
   *  remove binding, close role holders, delete the row — and only delete
   *  the row on success, so retries stay possible. */
  disposeAttachment: (attachment: EphemeralAttachment, actor: string) => Promise<void>;
  auditBindingChange?: (entry: BindingAuditEntry) => Promise<void>;
  now?: () => Date;
  log?: (msg: string) => void;
}): {
  agentProvisioning: AgentProvisioningService;
  conversationBindings: ConversationBindingsService;
  startAttachmentSweep: (opts?: { intervalMs?: number }) => () => void;
} {
  const log = deps.log ?? (() => undefined);
  const graph = new AgentGraphStore(deps.pool);

  function stores(): { configStore: ConfigStore; registry: ReloadableRegistry } | undefined {
    const configStore = deps.getConfigStore();
    const registry = deps.getRegistry();
    return configStore && registry ? { configStore, registry } : undefined;
  }

  async function audit(entry: BindingAuditEntry): Promise<void> {
    await deps.auditBindingChange?.(entry).catch((err: unknown) => {
      log(`[agent-setup] binding audit (${entry.action} ${entry.channelKey}) failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  const agentProvisioning: AgentProvisioningService = {
    async ensureAgent(input) {
      const slug = input.slug.trim();
      if (slug === FALLBACK_SLUG) {
        throw new ConfigValidationError(`ensureAgent may not manage the '${FALLBACK_SLUG}' agent`);
      }
      if (input.personaSkill && !input.personaSkill.slug.startsWith(`${slug}-`)) {
        throw new ConfigValidationError(
          `ensureAgent: personaSkill.slug must be namespaced under '${slug}-' (got '${input.personaSkill.slug}')`,
        );
      }
      const kernel = stores();
      if (!kernel) throw new Error('agentProvisioning: configStore/orchestratorRegistry not published yet (orchestrator plugin inactive?)');
      const { configStore, registry } = kernel;

      const ensureAttachment = async (agent: AgentRow): Promise<void> => {
        // Insert-if-absent only: an existing agent_plugins row carries operator
        // decisions (config, enabled=false) that an upsert would wipe (H4).
        const attached = (await configStore.listAgentPlugins(agent.id)).some((p) => p.pluginId === input.pluginId);
        if (attached) return;
        await configStore.upsertAgentPlugin(agent.id, { pluginId: input.pluginId, enabled: true });
      };

      const existing = await configStore.getAgentBySlug(slug);
      if (existing) {
        await ensureAttachment(existing);
        await registry.reload();
        return { created: false, agentSlug: slug };
      }

      let agent: AgentRow;
      try {
        agent = await configStore.createAgent({
          slug,
          name: input.name,
          description: input.description ?? null,
        });
      } catch (err) {
        // Lost a create race — treat like the existing-agent path.
        if (err instanceof ConfigValidationError) {
          const raced = await configStore.getAgentBySlug(slug);
          if (raced) {
            await ensureAttachment(raced);
            await registry.reload();
            return { created: false, agentSlug: slug };
          }
        }
        throw err;
      }

      if (input.personaSkill) {
        // Create-only (H3): a taken slug is skipped loudly, never clobbered.
        const skill = await graph.insertSkill({
          slug: input.personaSkill.slug,
          name: input.personaSkill.name,
          body: input.personaSkill.body,
          source: 'db',
        });
        if (skill) {
          await graph.addPersonaSkill(agent.id, skill.id);
        } else {
          log(`[agent-setup] persona skill slug '${input.personaSkill.slug}' already exists — left untouched, agent '${slug}' starts without it`);
        }
      }
      await configStore.upsertAgentPlugin(agent.id, { pluginId: input.pluginId, enabled: true });
      await registry.reload();
      log(`[agent-setup] provisioned agent '${slug}' for ${input.pluginId} (persona skill: ${input.personaSkill ? input.personaSkill.slug : 'none'})`);
      return { created: true, agentSlug: slug };
    },
  };

  const conversationBindings: ConversationBindingsService = {
    async bind(input) {
      const invite = deps.invites.get(input.channelType, input.conversationId);
      if (!invite) {
        return { bound: false, reason: 'not_observed' };
      }
      const kernel = stores();
      if (!kernel) return { bound: false, reason: 'kernel_not_ready', invite };
      const { configStore, registry } = kernel;
      const agent = await configStore.getAgentBySlug(input.agentSlug);
      if (!agent) return { bound: false, reason: 'agent_missing', invite };

      const expiresAt = new Date((deps.now ?? (() => new Date()))().getTime() + (input.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS));
      try {
        await configStore.createChannelBinding(agent.id, {
          channelType: input.channelType,
          channelKey: input.conversationId,
        });
      } catch (err) {
        if (err instanceof ConfigValidationError) {
          const bindings = await configStore.listChannelBindingsForAgent(agent.id);
          const mine = bindings.some(
            (b) => b.channelType === input.channelType && b.channelKey === input.conversationId,
          );
          if (!mine) return { bound: false, reason: 'bound_to_other_agent', invite };
          // Bound to this agent already. Ephemeral row present → OUR earlier
          // auto-bind, refresh it. No row → an OPERATOR binding: usable, but
          // never adopted into the self-disposing lifecycle (H5 — the sweep
          // must not delete hand-made setup).
          const row = await deps.attachments.getByConversation(input.channelType, input.conversationId);
          if (row && row.agentSlug === input.agentSlug) {
            await deps.attachments.upsertPending({
              agentSlug: input.agentSlug,
              channelType: input.channelType,
              channelKey: input.conversationId,
              expiresAt,
            });
            return { bound: true, invite };
          }
          return { bound: true, preexistingOperatorBinding: true, invite };
        }
        throw err;
      }
      await deps.attachments.upsertPending({
        agentSlug: input.agentSlug,
        channelType: input.channelType,
        channelKey: input.conversationId,
        expiresAt,
      });
      await registry.reload();
      await audit({ actor: `agent:${input.agentSlug}`, action: 'bind', channelType: input.channelType, channelKey: input.conversationId, agentSlug: input.agentSlug });
      log(`[agent-setup] auto-bound ${input.channelType}/${input.conversationId} → '${input.agentSlug}' (invite-guarded)`);
      return { bound: true, invite };
    },

    async unbind(input) {
      // H1 — a plugin may only release what the ephemeral lifecycle recorded
      // under its own agent slug. Operator bindings and other agents'
      // attachments are unreachable from this surface.
      const row = await deps.attachments.getByConversation(input.channelType, input.conversationId);
      if (!row || row.agentSlug !== input.agentSlug) {
        log(`[agent-setup] unbind of ${input.channelType}/${input.conversationId} by '${input.agentSlug}' refused (no owned ephemeral attachment)`);
        return { unbound: false };
      }
      await deps.disposeAttachment(row, `agent:${input.agentSlug}`);
      return { unbound: true };
    },

    async attachWorkflow(input) {
      const attached = await deps.attachments.attachToWorkflow({
        agentSlug: input.agentSlug,
        channelType: input.channelType,
        channelKey: input.conversationId,
        workflowId: input.workflowId,
        roleKey: input.roleKey ?? null,
        expiresAt: input.expiresAt,
      });
      return { attached: attached !== undefined };
    },

    observedInvite(channelType, conversationId) {
      return deps.invites.get(channelType, conversationId);
    },
  };

  /** Retry + expiry sweep over BOTH states: expired 'pending' rows are
   *  invites that never became a facilitation; expired 'attached' rows are
   *  the H2 retry path for cleanups the reap missed. One shared disposal. */
  function startAttachmentSweep(opts?: { intervalMs?: number }): () => void {
    const tick = async (): Promise<void> => {
      try {
        const now = (deps.now ?? (() => new Date()))();
        const expired = [
          ...(await deps.attachments.listExpiredPending(now)),
          ...(await deps.attachments.listExpiredAttached(now)),
        ];
        for (const attachment of expired) {
          try {
            await deps.disposeAttachment(attachment, 'attachment-sweep');
          } catch (err) {
            log(`[agent-setup] sweep disposal of ${attachment.channelType}/${attachment.channelKey} failed (kept for retry): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        log(`[agent-setup] attachment sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), opts?.intervalMs ?? SWEEP_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }

  return { agentProvisioning, conversationBindings, startAttachmentSweep };
}
