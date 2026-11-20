// Operator routes for an agent's own bots on channels other than Teams
// (spec 2042 §5.3). Mounted next to the operator-agents router:
//
//   GET    /api/v1/operator/agents/:slug/channel-identities
//          → which channels can run a bot for this agent, the fields the
//            operator fills in, and the agent's bot per channel with status
//   PUT    /api/v1/operator/agents/:slug/channel-identities/:channelType
//          body { credentials: { <field>: <value> } }
//          → the plugin checks and starts the bot; the routing key is stored
//   DELETE /api/v1/operator/agents/:slug/channel-identities/:channelType
//          → the plugin stops the bot and forgets the credentials; the row goes
//
// Teams has its own provisioning chain (`/:slug/teams-identity`).
// Credentials are never echoed, stored or put into the audit trail.

import { Router } from 'express';
import type { Request, Response } from 'express';

import { auditActorFromRequest, type AuditEntryInput } from '../auth/adminAuditLog.js';
import type { AgentChannelIdentityService, IdentityAgent } from '../platform/agentChannelIdentityService.js';

const CHANNEL_TYPE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export interface OperatorAgentChannelIdentitiesOptions {
  /** Undefined while the database or the orchestrator registry is not up. */
  readonly getService: () => AgentChannelIdentityService | undefined;
  /** A live agent by slug; deleted agents are not found. */
  readonly findAgent: (slug: string) => Promise<IdentityAgent | undefined>;
  readonly recordAudit?: (entry: AuditEntryInput) => Promise<void>;
}

export function createOperatorAgentChannelIdentitiesRouter(options: OperatorAgentChannelIdentitiesOptions): Router {
  const router = Router();

  const audit = async (entry: AuditEntryInput): Promise<void> => {
    try {
      if (options.recordAudit) await options.recordAudit(entry);
      else console.log(`[security-audit] ${entry.action} ${entry.target}`);
    } catch (err) {
      console.error(
        `[security-audit] ${entry.action} ${entry.target} could not be recorded:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  /** Service and agent, or the response is already sent. */
  async function context(req: Request, res: Response): Promise<{ service: AgentChannelIdentityService; agent: IdentityAgent } | undefined> {
    const service = options.getService();
    if (!service) {
      res.status(503).json({ error: 'agent_identities_unavailable', message: 'the agent registry is not running' });
      return undefined;
    }
    const slug = req.params['slug'];
    if (typeof slug !== 'string' || slug === '') {
      res.status(400).json({ error: 'invalid_slug' });
      return undefined;
    }
    const agent = await options.findAgent(slug);
    if (!agent) {
      res.status(404).json({ error: 'not_found' });
      return undefined;
    }
    return { service, agent };
  }

  function channelTypeParam(req: Request, res: Response): string | undefined {
    const raw = req.params['channelType'];
    if (typeof raw !== 'string' || !CHANNEL_TYPE_RE.test(raw) || raw === 'teams') {
      res.status(400).json({ error: 'invalid_channel_type' });
      return undefined;
    }
    return raw;
  }

  const fail = (res: Response, err: unknown): void => {
    console.error('[agent-identities] request failed:', err instanceof Error ? err.message : String(err));
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  };

  router.get('/:slug/channel-identities', async (req: Request, res: Response) => {
    try {
      const ctx = await context(req, res);
      if (!ctx) return;
      res.json({ agent: ctx.agent.slug, ...(await ctx.service.overview(ctx.agent)) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/:slug/channel-identities/:channelType', async (req: Request, res: Response) => {
    try {
      const channelType = channelTypeParam(req, res);
      if (!channelType) return;
      const ctx = await context(req, res);
      if (!ctx) return;
      const body = (req.body ?? {}) as { credentials?: unknown };
      const result = await ctx.service.provision(ctx.agent, channelType, body.credentials);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error, message: result.message });
        return;
      }
      await audit({
        actor: auditActorFromRequest(req),
        action: 'agent.channel_identity.set',
        target: `agent:${ctx.agent.id}`,
        after: { channelType, channelKey: result.identity.channelKey },
      });
      res.status(201).json({ ok: true, identity: result.identity });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/:slug/channel-identities/:channelType', async (req: Request, res: Response) => {
    try {
      const channelType = channelTypeParam(req, res);
      if (!channelType) return;
      const ctx = await context(req, res);
      if (!ctx) return;
      const result = await ctx.service.remove(ctx.agent, channelType);
      if (!result.ok) {
        res.status(result.status).json({ error: result.error, message: result.message });
        return;
      }
      await audit({
        actor: auditActorFromRequest(req),
        action: 'agent.channel_identity.delete',
        target: `agent:${ctx.agent.id}`,
        before: { channelType, channelKey: result.removed.channelKey },
      });
      res.json({ ok: true, released: result.released });
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
