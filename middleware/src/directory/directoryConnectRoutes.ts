// #2312 / ADR-0301 — a directory person connects a per-person MCP server
// without an omadia web session, bound to their Teams SSO token. There is no
// bearer link: starting AND completing need the person's own SSO token
// (kernel-verified, ADR-0114), and the flow key is their AAD object id
// (ADR-0300). Mounted at `/api/v1/directory/connect` behind the Teams SSO
// gate, on the kernel's closed public-path list (ADR-0105).

import { Router } from 'express';
import type { Request, Response } from 'express';

import type { McpServerRow } from '@omadia/orchestrator';

import type { AuditEntryInput } from '../auth/adminAuditLog.js';
import { resolveMcpUserKey } from '../services/mcpDelegation.js';
import type { DirectoryPerson, DirectoryStore } from './directoryStore.js';

export interface DirectoryConnectDeps {
  readonly store: Pick<DirectoryStore, 'findByExternalId'>;
  readonly listServers: () => Promise<readonly McpServerRow[]>;
  readonly oauth: {
    isProtected(server: McpServerRow): Promise<boolean>;
    beginAuthorization(
      server: McpServerRow,
      userKey: string,
      actor: { id?: string; email?: string },
      opts: { completion: 'teams-sso' },
    ): Promise<{ authorizeUrl: string }>;
    completeAuthorization(
      state: string,
      code: string,
      iss: string | null,
      completingUserKeyFor: (flow: { serverId: string; userKey: string }) => Promise<string | null>,
      opts: { completion: 'teams-sso' },
    ): Promise<{ serverId: string }>;
  };
  readonly audit: () => { record(entry: AuditEntryInput): Promise<void> } | undefined;
  readonly log?: (message: string) => void;
}

const MAX_PARAM_LENGTH = 4096;

/** Where the kernel mounts these routes (index.ts) — the `startUrl` is a path on this host; the page prefixes its own origin. */
export const CONNECT_MOUNT = '/api/v1/directory/connect';

const text = (value: unknown): string =>
  typeof value === 'string' && value.length <= MAX_PARAM_LENGTH ? value : '';

/** The active directory person of the verified SSO token, or null. */
async function personOf(req: Request, store: DirectoryConnectDeps['store']): Promise<DirectoryPerson | null> {
  const sso = req.teamsSsoUser;
  if (!sso?.oid || !sso.tenantId) return null;
  const person = await store.findByExternalId('entra', sso.tenantId.toLowerCase(), sso.oid.toLowerCase());
  return person?.status === 'active' ? person : null;
}

/** The audit actor of a person: not an account, so a label in the free-text column, never a users.id. */
function personActor(person: DirectoryPerson): { email: string } {
  return { email: `directory:${person.id}` };
}

export function createDirectoryConnectRouter(deps: DirectoryConnectDeps): Router {
  const router = Router();
  const log = deps.log ?? ((m: string) => console.warn(m));

  // ── POST /mcp/:serverId/start ─────────────────────────────────────────────
  router.post('/mcp/:serverId/start', async (req: Request, res: Response) => {
    try {
      const person = await personOf(req, deps.store);
      if (!person) {
        res.status(403).json({ code: 'directory.not_a_person' });
        return;
      }
      const serverId = String(req.params['serverId'] ?? '');
      const server = (await deps.listServers()).find((s) => s.id === serverId);
      if (!server) {
        res.status(404).json({ code: 'directory.unknown_server' });
        return;
      }
      // A service-delegated server is the operator's to connect, not a person's.
      if (resolveMcpUserKey(server, person.externalId) !== person.externalId) {
        res.status(409).json({ code: 'directory.not_per_user' });
        return;
      }
      if (!(await deps.oauth.isProtected(server))) {
        res.status(409).json({ code: 'directory.not_oauth' });
        return;
      }
      const { authorizeUrl } = await deps.oauth.beginAuthorization(server, person.externalId, personActor(person), {
        completion: 'teams-sso',
      });
      // Teams' authentication window must start on this host: it opens
      // `startUrl`, which redirects to the provider (createDirectoryConnectRedirect).
      const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
      res.setHeader('Cache-Control', 'no-store');
      res.json({ startUrl: `${CONNECT_MOUNT}/go/${encodeURIComponent(state)}` });
    } catch (err) {
      log(`[directory-connect] start failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(502).json({ code: 'directory.connect_failed' });
    }
  });

  // ── POST /mcp/complete ────────────────────────────────────────────────────
  router.post('/mcp/complete', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const state = text(body['state']);
    const code = text(body['code']);
    const iss = text(body['iss']) || null;
    if (state === '' || code === '') {
      res.status(400).json({ code: 'directory.missing_code_or_state' });
      return;
    }
    try {
      const person = await personOf(req, deps.store);
      // Still take the flow when the token names nobody: a stray code must not stay redeemable.
      const completer = person?.externalId ?? null;
      const { serverId } = await deps.oauth.completeAuthorization(state, code, iss, async () => completer, {
        completion: 'teams-sso',
      });
      if (person) {
        await deps
          .audit()
          ?.record({
            actor: personActor(person),
            action: 'mcp_server.oauth_connect',
            target: `mcp-server:${serverId}`,
            after: { authorized: true, directoryPersonId: person.id },
          })
          .catch((err: unknown) =>
            log(`[directory-connect] audit failed: ${err instanceof Error ? err.message : String(err)}`),
          );
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ok: true, serverId });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'McpOAuthCompleterMismatchError') {
        res.status(403).json({ code: 'directory.completer_mismatch' });
        return;
      }
      if (name === 'McpOAuthIssuerMismatchError') {
        res.status(400).json({ code: 'directory.issuer_mismatch' });
        return;
      }
      // Never echo the raw error: it can carry the code or the verifier.
      log(`[directory-connect] complete failed (${name || 'error'})`);
      res.status(400).json({ code: 'directory.connect_failed' });
    }
  });

  return router;
}

/**
 * `GET /go/:state` — the first page of Teams' authentication window: a
 * redirect to the provider's authorize URL of a pending `teams-sso` flow.
 * Mounted BEFORE the SSO gate (a browser navigation carries no bearer). It
 * reveals nothing a starter's own `start` call did not; completing still
 * needs the starter's SSO token.
 */
export function createDirectoryConnectRedirect(deps: {
  readonly authorizeUrl: (state: string) => Promise<string | undefined>;
}): Router {
  const router = Router();
  router.get('/:state', async (req: Request, res: Response) => {
    const state = String(req.params['state'] ?? '');
    const url = state.length > 0 && state.length <= 512 ? await deps.authorizeUrl(state).catch(() => undefined) : undefined;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!url || !/^https:\/\//i.test(url)) {
      res.status(404).type('text/plain').send('This connection link has expired. Start Connect again in Teams.');
      return;
    }
    res.redirect(302, url);
  });
  return router;
}

