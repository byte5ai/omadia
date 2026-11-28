import { adminJson, arrayField } from './adminJson';

/**
 * #2320 — typed client for the keychain admin surface (ADR-0102):
 * `/v1/admin/credentials` (metadata, grants, revocation) and
 * `/v1/admin/credential-asks` (the owner's ask inbox). The server never sends
 * a secret or a fingerprint; `can_revoke` follows its owner rule, the UI only
 * mirrors it.
 */

export type CredentialKind = 'personal' | 'service';
export type CredentialGrantMode = 'once' | 'standing';

export interface CredentialDto {
  readonly id: string;
  readonly name: string;
  readonly kind: CredentialKind;
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
  readonly can_revoke: boolean;
}

export interface CredentialGrantDto {
  readonly id: string;
  readonly credential_id: string;
  readonly principal: string;
  readonly mode: CredentialGrantMode;
  readonly purpose: string;
  readonly granted_by: string;
  readonly granted_at: string;
  readonly expires_at: string | null;
  readonly consumed_at: string | null;
  readonly revoked_at: string | null;
  readonly revoked_by: string | null;
}

export interface CredentialGrantsResponse {
  readonly credential: CredentialDto;
  readonly grants: readonly CredentialGrantDto[];
  readonly can_revoke_grants: boolean;
}

export type CredentialAskStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export interface CredentialAskDto {
  readonly id: string;
  readonly credential_id: string;
  readonly requester: string;
  readonly owner: string;
  readonly purpose: string;
  readonly mode: CredentialGrantMode;
  readonly requested_grant_expires_at: string | null;
  readonly ask_expires_at: string;
  readonly status: CredentialAskStatus;
  readonly created_at: string;
  readonly resolved_at: string | null;
  readonly resolved_by: string | null;
  readonly grant_id: string | null;
}

const CREDENTIALS = '/v1/admin/credentials';
const ASKS = '/v1/admin/credential-asks';

export async function listCredentials(): Promise<CredentialDto[]> {
  return arrayField<CredentialDto>(await adminJson(CREDENTIALS), 'credentials', CREDENTIALS);
}

export async function listCredentialGrants(credentialId: string): Promise<CredentialGrantsResponse> {
  const path = `${CREDENTIALS}/${encodeURIComponent(credentialId)}/grants`;
  const body = await adminJson<CredentialGrantsResponse>(path);
  return { ...body, grants: arrayField<CredentialGrantDto>(body, 'grants', path) };
}

export async function revokeCredential(credentialId: string): Promise<void> {
  await adminJson(`${CREDENTIALS}/${encodeURIComponent(credentialId)}/revoke`, { method: 'POST' });
}

export async function revokeCredentialGrant(grantId: string): Promise<void> {
  await adminJson(`${CREDENTIALS}/grants/${encodeURIComponent(grantId)}/revoke`, { method: 'POST' });
}

/** Asks addressed to the signed-in owner (server-scoped to the session). */
export async function listPendingAsks(): Promise<CredentialAskDto[]> {
  const path = `${ASKS}/pending`;
  return arrayField<CredentialAskDto>(await adminJson(path), 'asks', path);
}

/** Asks the signed-in user made. */
export async function listMyAsks(): Promise<CredentialAskDto[]> {
  const path = `${ASKS}/mine`;
  return arrayField<CredentialAskDto>(await adminJson(path), 'asks', path);
}

export async function resolveAsk(askId: string, action: 'approve' | 'deny'): Promise<void> {
  await adminJson(`${ASKS}/${encodeURIComponent(askId)}/${action}`, { method: 'POST' });
}

export async function cancelAsk(askId: string): Promise<void> {
  await adminJson(`${ASKS}/${encodeURIComponent(askId)}/cancel`, { method: 'POST' });
}
