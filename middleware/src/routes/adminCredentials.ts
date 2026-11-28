/**
 * #2320 — the admin read and revoke surface of the credential keychain
 * (ADR-0102). Mounted at `/api/v1/admin/credentials` behind `requireAuth`.
 *
 *   GET  /                         → every credential's metadata
 *   GET  /:id/grants               → the grants against one credential
 *   POST /:id/revoke               → revoke a credential
 *   POST /grants/:grantId/revoke   → revoke one grant
 *
 * ## What never leaves this route
 *
 * No secret material: the route only calls the metadata reads of
 * `CredentialStore` (`getSecretMaterial` is not in its deps type). No
 * fingerprint either — it is safe to log but adds nothing an operator can act
 * on, and the less of a secret's shadow the UI holds, the better.
 *
 * ## Who may revoke
 *
 * ADR-0102: "the person who owns a credential decides about it; nobody else,
 * an admin included". So a `personal` credential and the grants against it
 * are revoked by its owner only (`403 credential.forbidden` for anyone else),
 * the same session identity rule the asks router uses
 * (`user:<omadia_user_id>`, nothing from the body). A `service` credential
 * has no single owner; any signed-in operator administers it (ADR-0113: one
 * admin role).
 *
 * Every revocation is written to the admin audit trail (ADR-0100), best
 * effort: the revocation stands when the row cannot be written.
 */

import { Router, type Request, type Response } from 'express';

import {
  makePrincipal,
  principalsEqual,
  type Credential,
  type CredentialGrant,
  type CredentialStore,
  type Principal,
} from '@omadia/channel-sdk';

import { recordOperatorAudit, type AdminAuditLog } from '../auth/adminAuditLog.js';

export interface AdminCredentialsRouteDeps {
  /** Metadata reads and the two revocations — never `getSecretMaterial`. */
  readonly store: Pick<
    CredentialStore,
    'listCredentials' | 'getCredential' | 'listGrantsForCredential' | 'getGrant' | 'revokeCredential' | 'revokeGrant'
  >;
  readonly adminAudit?: Pick<AdminAuditLog, 'record'>;
}

export interface CredentialDto {
  readonly id: string;
  readonly name: string;
  readonly kind: Credential['kind'];
  readonly owner: string | null;
  readonly broker: {
    readonly host: string;
    readonly injection_scheme: string;
    readonly allowed_methods: readonly string[];
    readonly path_prefixes: readonly string[];
  } | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly revoked_at: string | null;
  readonly revoked_by: string | null;
  /** Whether the session caller may revoke it (owner rule above). */
  readonly can_revoke: boolean;
}

export interface CredentialGrantDto {
  readonly id: string;
  readonly credential_id: string;
  readonly principal: string;
  readonly mode: CredentialGrant['mode'];
  readonly purpose: string;
  readonly granted_by: string;
  readonly granted_at: string;
  readonly expires_at: string | null;
  readonly consumed_at: string | null;
  readonly revoked_at: string | null;
  readonly revoked_by: string | null;
}

function principalLabel(principal: Principal): string {
  return principal.kind === 'user' ? `user:${principal.userId}` : `role:${principal.roleKey}`;
}

function iso(date: Date | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** May `caller` administer `credential`? Owner-only for personal ones. */
export function mayAdministerCredential(credential: Pick<Credential, 'kind' | 'owner'>, caller: Principal): boolean {
  if (credential.kind === 'service') return true;
  return credential.owner !== undefined && principalsEqual(credential.owner, caller);
}

function toCredentialDto(credential: Credential, caller: Principal): CredentialDto {
  return {
    id: credential.id,
    name: credential.name,
    kind: credential.kind,
    owner: credential.owner ? principalLabel(credential.owner) : null,
    broker: credential.broker
      ? {
          host: credential.broker.host,
          injection_scheme: credential.broker.injectionScheme,
          allowed_methods: credential.broker.allowedMethods,
          path_prefixes: credential.broker.pathPrefixes,
        }
      : null,
    created_by: credential.createdBy,
    created_at: credential.createdAt.toISOString(),
    revoked_at: iso(credential.revokedAt),
    revoked_by: credential.revokedBy ?? null,
    can_revoke: credential.revokedAt === undefined && mayAdministerCredential(credential, caller),
  };
}

function toGrantDto(grant: CredentialGrant): CredentialGrantDto {
  return {
    id: grant.id,
    credential_id: grant.credentialId,
    principal: principalLabel(grant.principal),
    mode: grant.mode,
    purpose: grant.purpose,
    granted_by: grant.grantedBy,
    granted_at: grant.grantedAt.toISOString(),
    expires_at: iso(grant.expiresAt),
    consumed_at: iso(grant.consumedAt),
    revoked_at: iso(grant.revokedAt),
    revoked_by: grant.revokedBy ?? null,
  };
}

interface SessionCaller {
  readonly userId: string;
  readonly principal: Principal;
}

/** `omadia_user_id` only — the identity rule of `credentialAsks.ts`. */
function requireSessionCaller(req: Request, res: Response): SessionCaller | null {
  const raw = req.session?.omadia_user_id;
  const userId = typeof raw === 'string' ? raw.trim() : '';
  const principal = userId ? makePrincipal('user', userId) : undefined;
  if (!principal) {
    res.status(401).json({ code: 'auth.required', message: 'login required' });
    return null;
  }
  return { userId, principal };
}

function forbidden(res: Response): void {
  res.status(403).json({
    code: 'credential.forbidden',
    message: 'only the owner of a personal credential may revoke it or its grants',
  });
}

export function createAdminCredentialsRouter(deps: AdminCredentialsRouteDeps): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response): Promise<void> => {
    const caller = requireSessionCaller(req, res);
    if (!caller) return;
    try {
      const credentials = await deps.store.listCredentials();
      res.json({ credentials: credentials.map((c) => toCredentialDto(c, caller.principal)) });
    } catch (err) {
      console.error('[admin-credentials] list failed:', err);
      res.status(500).json({ code: 'credential.list_failed', message: 'could not list credentials' });
    }
  });

  router.get('/:id/grants', async (req: Request, res: Response): Promise<void> => {
    const caller = requireSessionCaller(req, res);
    if (!caller) return;
    const id = req.params.id as string;
    try {
      const credential = await deps.store.getCredential(id);
      if (!credential) {
        res.status(404).json({ code: 'credential.not_found', message: 'no credential with that id' });
        return;
      }
      const grants = await deps.store.listGrantsForCredential(id);
      res.json({
        credential: toCredentialDto(credential, caller.principal),
        grants: grants.map(toGrantDto),
        can_revoke_grants: mayAdministerCredential(credential, caller.principal),
      });
    } catch (err) {
      console.error('[admin-credentials] grant list failed:', err);
      res.status(500).json({ code: 'credential.list_failed', message: 'could not list the grants' });
    }
  });

  router.post('/:id/revoke', async (req: Request, res: Response): Promise<void> => {
    const caller = requireSessionCaller(req, res);
    if (!caller) return;
    const id = req.params.id as string;
    try {
      const credential = await deps.store.getCredential(id);
      if (!credential) {
        res.status(404).json({ code: 'credential.not_found', message: 'no credential with that id' });
        return;
      }
      if (!mayAdministerCredential(credential, caller.principal)) {
        forbidden(res);
        return;
      }
      const revoked = await deps.store.revokeCredential(id, caller.userId);
      if (!revoked) {
        res.status(409).json({ code: 'credential.already_revoked', message: 'the credential is already revoked' });
        return;
      }
      await recordOperatorAudit(deps.adminAudit, req, {
        action: 'credential.revoke',
        target: `credential:${id}`,
        before: { name: credential.name, kind: credential.kind, revoked: false },
        after: { name: credential.name, kind: credential.kind, revoked: true },
      });
      const after = await deps.store.getCredential(id);
      res.json({ credential: toCredentialDto(after ?? credential, caller.principal) });
    } catch (err) {
      console.error('[admin-credentials] revoke failed:', err);
      res.status(500).json({ code: 'credential.revoke_failed', message: 'could not revoke the credential' });
    }
  });

  router.post('/grants/:grantId/revoke', async (req: Request, res: Response): Promise<void> => {
    const caller = requireSessionCaller(req, res);
    if (!caller) return;
    const grantId = req.params.grantId as string;
    try {
      const grant = await deps.store.getGrant(grantId);
      const credential = grant ? await deps.store.getCredential(grant.credentialId) : undefined;
      if (!grant || !credential) {
        res.status(404).json({ code: 'credential.grant_not_found', message: 'no grant with that id' });
        return;
      }
      if (!mayAdministerCredential(credential, caller.principal)) {
        forbidden(res);
        return;
      }
      const revoked = await deps.store.revokeGrant(grantId, caller.userId);
      if (!revoked) {
        res.status(409).json({ code: 'credential.grant_already_revoked', message: 'the grant is already revoked' });
        return;
      }
      await recordOperatorAudit(deps.adminAudit, req, {
        action: 'credential.grant_revoke',
        target: `credential-grant:${grantId}`,
        before: { credential: credential.name, principal: principalLabel(grant.principal), mode: grant.mode, revoked: false },
        after: { credential: credential.name, principal: principalLabel(grant.principal), mode: grant.mode, revoked: true },
      });
      const after = await deps.store.getGrant(grantId);
      res.json({ grant: toGrantDto(after ?? grant) });
    } catch (err) {
      console.error('[admin-credentials] grant revoke failed:', err);
      res.status(500).json({ code: 'credential.revoke_failed', message: 'could not revoke the grant' });
    }
  });

  return router;
}
