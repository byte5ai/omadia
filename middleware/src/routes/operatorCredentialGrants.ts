/**
 * #2319 / ADR-0290 — the operator's grant of named credentials to an agent
 * (kernel capability `credentialBroker@1`). Mounted under `/api/v1/operator`
 * behind `requireAuth`; the admin UI is #2320.
 *
 *  - `GET    /agents/:slug/credential-grants`                → `{ slug, capability, grants: [...] }`
 *  - `PUT    /agents/:slug/credential-grants/:credentialId`  → 201 new / 200 existing
 *  - `DELETE /agents/:slug/credential-grants/:credentialId`  → 204 / 404
 *
 * A grant names one credential; there is no "all credentials" grant. It
 * never carries a secret, and granting a credential to an agent does not let
 * anyone use it: the broker still needs the account's own credential grant
 * (ADR-0102, ADR-0355). Every change is audited as
 * `agent.credential_grant_change` with the operator as actor (ADR-0100).
 */

import { Router, type Request, type Response } from 'express';

import type { Credential, CredentialStore } from '@omadia/channel-sdk';
import type { ConfigStore } from '@omadia/orchestrator';

import { auditActorFromRequest, type AuditEntryInput } from '../auth/adminAuditLog.js';
import type { AgentCredentialGrant, AgentCredentialGrantStore } from '../credentials/agentCredentialGrants.js';
import { CREDENTIAL_BROKER_CAPABILITY } from '../credentials/credentialBrokerTools.js';
import { isPreviewDraftAgentSlug } from '../plugins/builder/previewDraftAgents.js';

export interface OperatorCredentialGrantRouterOptions {
  readonly getConfigStore: () => Pick<ConfigStore, 'getAgentBySlug'> | undefined;
  readonly credentials: Pick<CredentialStore, 'getCredential'>;
  readonly grants: AgentCredentialGrantStore;
  /** Re-read the offering snapshot after a change. */
  readonly refresh: () => Promise<void>;
  readonly recordAudit?: (entry: AuditEntryInput) => Promise<void>;
}

const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,100}$/;

interface GrantView {
  readonly credentialId: string;
  readonly name: string | null;
  readonly kind: string | null;
  readonly host: string | null;
  readonly revoked: boolean;
  readonly grantedBy: string;
  readonly grantedAt: string;
}

function grantView(grant: AgentCredentialGrant, credential: Credential | undefined): GrantView {
  return {
    credentialId: grant.credentialId,
    name: credential?.name ?? null,
    kind: credential?.kind ?? null,
    host: credential?.broker?.host ?? null,
    revoked: credential?.revokedAt !== undefined,
    grantedBy: grant.grantedBy,
    grantedAt: grant.grantedAt.toISOString(),
  };
}

/** A malformed id on the Postgres backend (22P02) is an unknown credential. */
function isInvalidId(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '22P02';
}

export function createOperatorCredentialGrantRouter(options: OperatorCredentialGrantRouterOptions): Router {
  const router = Router();

  const recordAudit = async (entry: AuditEntryInput): Promise<void> => {
    try {
      await options.recordAudit?.(entry);
    } catch (err) {
      console.error(
        `[security-audit] ${entry.action} ${entry.target} could not be recorded:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const refresh = async (): Promise<void> => {
    await options.refresh().catch((err: unknown) => {
      console.warn(`[credential-broker] snapshot refresh after a change failed: ${String(err)}`);
    });
  };

  function fail(res: Response, err: unknown): void {
    console.error('[credential-broker] operator route failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'internal_error' });
  }

  async function agentOr404(req: Request, res: Response) {
    const store = options.getConfigStore();
    if (!store) {
      res.status(503).json({ error: 'multi_orchestrator_unavailable' });
      return undefined;
    }
    const slug = req.params['slug'];
    if (typeof slug !== 'string' || slug.length === 0) {
      res.status(400).json({ error: 'invalid_slug' });
      return undefined;
    }
    const agent = await store.getAgentBySlug(slug);
    if (!agent) {
      res.status(404).json({ error: 'not_found', slug });
      return undefined;
    }
    return agent;
  }

  async function credentialOr404(req: Request, res: Response): Promise<Credential | undefined> {
    const id = req.params['credentialId'];
    if (typeof id !== 'string' || !CREDENTIAL_ID.test(id)) {
      res.status(400).json({ error: 'invalid_credential_id' });
      return undefined;
    }
    let credential: Credential | undefined;
    try {
      credential = await options.credentials.getCredential(id);
    } catch (err) {
      if (!isInvalidId(err)) throw err;
    }
    if (!credential) {
      res.status(404).json({ error: 'credential_not_found' });
      return undefined;
    }
    return credential;
  }

  // #2049 — a Plugin Builder preview's draft agent is read and deleted, never configured.
  router.use('/agents/:slug/credential-grants', (req: Request, res: Response, next) => {
    const slug = req.params['slug'];
    if (typeof slug === 'string' && isPreviewDraftAgentSlug(slug) && !['GET', 'HEAD', 'DELETE'].includes(req.method)) {
      res.status(409).json({ error: 'preview_draft_agent', message: `"${slug}" is the draft agent of a Plugin Builder preview` });
      return;
    }
    next();
  });

  router.get('/agents/:slug/credential-grants', async (req, res) => {
    try {
      const agent = await agentOr404(req, res);
      if (!agent) return;
      const grants = await options.grants.list(agent.id);
      const views = await Promise.all(
        grants.map(async (g) => grantView(g, await options.credentials.getCredential(g.credentialId))),
      );
      res.json({ slug: agent.slug, capability: CREDENTIAL_BROKER_CAPABILITY, grants: views });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/agents/:slug/credential-grants/:credentialId', async (req, res) => {
    try {
      const agent = await agentOr404(req, res);
      if (!agent) return;
      const credential = await credentialOr404(req, res);
      if (!credential) return;
      if (credential.revokedAt) {
        res.status(409).json({ error: 'credential_revoked' });
        return;
      }
      const actor = auditActorFromRequest(req);
      const { grant, created } = await options.grants.put(agent.id, credential.id, actor.id ?? actor.email ?? 'operator');
      const view = grantView(grant, credential);
      if (created) {
        await recordAudit({
          actor,
          action: 'agent.credential_grant_change',
          target: `agent:${agent.slug}`,
          before: null,
          after: { credentialId: credential.id, name: credential.name, host: view.host },
        });
        await refresh();
      }
      res.status(created ? 201 : 200).json(view);
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/agents/:slug/credential-grants/:credentialId', async (req, res) => {
    try {
      const agent = await agentOr404(req, res);
      if (!agent) return;
      const id = req.params['credentialId'];
      if (typeof id !== 'string' || !CREDENTIAL_ID.test(id)) {
        res.status(400).json({ error: 'invalid_credential_id' });
        return;
      }
      let removed = false;
      try {
        removed = await options.grants.remove(agent.id, id);
      } catch (err) {
        if (!isInvalidId(err)) throw err;
      }
      if (!removed) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await recordAudit({
        actor: auditActorFromRequest(req),
        action: 'agent.credential_grant_change',
        target: `agent:${agent.slug}`,
        before: { credentialId: id },
        after: null,
      });
      await refresh();
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}
