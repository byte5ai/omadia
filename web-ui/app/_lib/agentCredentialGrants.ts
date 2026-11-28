import { adminJson, arrayField } from './adminJson';

/**
 * #2320 / #2319 — typed client for an agent's credential grants
 * (`credentialBroker@1`, ADR-0290/ADR-0355):
 * `GET|PUT|DELETE /v1/operator/agents/:slug/credential-grants[/:credentialId]`.
 * A grant names one credential and never carries a secret; it only narrows
 * what the turn's account may already use.
 */

export interface AgentCredentialGrantDto {
  readonly credentialId: string;
  readonly name: string | null;
  readonly kind: string | null;
  readonly host: string | null;
  readonly revoked: boolean;
  readonly grantedBy: string;
  readonly grantedAt: string;
}

function grantsPath(slug: string): string {
  return `/v1/operator/agents/${encodeURIComponent(slug)}/credential-grants`;
}

export async function listAgentCredentialGrants(slug: string): Promise<AgentCredentialGrantDto[]> {
  const path = grantsPath(slug);
  return arrayField<AgentCredentialGrantDto>(await adminJson(path), 'grants', path);
}

export async function grantAgentCredential(slug: string, credentialId: string): Promise<void> {
  await adminJson(`${grantsPath(slug)}/${encodeURIComponent(credentialId)}`, { method: 'PUT' });
}

export async function removeAgentCredentialGrant(slug: string, credentialId: string): Promise<void> {
  await adminJson(`${grantsPath(slug)}/${encodeURIComponent(credentialId)}`, { method: 'DELETE' });
}
