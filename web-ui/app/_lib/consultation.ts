/**
 * Spec 2042 §5.4 (#2047) — operator client for consultation switches and
 * directed grants (`/api/v1/operator/agents/:slug/consultation`).
 */

import { ApiError } from './api';
import { callJson } from './agents';

export const MEMORY_ACCESS_MODES = ['none', 'discreet'] as const;
export type MemoryAccessMode = (typeof MEMORY_ACCESS_MODES)[number];

export const DISCLOSURE_LEVELS = ['none', 'existence', 'aggregate', 'redacted', 'full'] as const;
export type DisclosureLevel = (typeof DISCLOSURE_LEVELS)[number];

export interface ConsultationGrantDto {
  from: string;
  to: string;
  channelScope: string[] | null;
  allowedCapabilities: string[];
  memoryAccess: MemoryAccessMode;
  disclosure: Record<string, DisclosureLevel>;
  maxCallsPerTurn: number;
  maxCallsPerDay: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
}

export interface AgentConsultationDto {
  slug: string;
  consultable: boolean;
  mayConsult: boolean;
  consults: ConsultationGrantDto[];
  consultedBy: ConsultationGrantDto[];
}

export interface ConsultationGrantInput {
  allowedCapabilities: string[];
  memoryAccess: MemoryAccessMode;
  disclosure: Record<string, DisclosureLevel>;
  maxCallsPerTurn: number;
  maxCallsPerDay: number;
}

const base = (slug: string): string => `/v1/operator/agents/${encodeURIComponent(slug)}/consultation`;

export function getAgentConsultation(slug: string): Promise<AgentConsultationDto> {
  return callJson<AgentConsultationDto>(base(slug));
}

export function setConsultationSwitches(
  slug: string,
  patch: { consultable?: boolean; mayConsult?: boolean },
): Promise<unknown> {
  return callJson(base(slug), { method: 'PUT', body: JSON.stringify(patch) });
}

export function putConsultationGrant(slug: string, to: string, input: ConsultationGrantInput): Promise<unknown> {
  return callJson(`${base(slug)}/grants/${encodeURIComponent(to)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function deleteConsultationGrant(slug: string, to: string): Promise<unknown> {
  return callJson(`${base(slug)}/grants/${encodeURIComponent(to)}`, { method: 'DELETE' });
}

export const CONSULTATION_ERROR_CODES = [
  'archetype_omits',
  'self_grant',
  'invalid_disclosure',
  'invalid_body',
  'not_found',
] as const;
export type ConsultationErrorCode = (typeof CONSULTATION_ERROR_CODES)[number];

/** The server's error code when it is one this client can name, else null. */
export function parseConsultationErrorCode(err: unknown): ConsultationErrorCode | null {
  if (!(err instanceof ApiError)) return null;
  try {
    const code = (JSON.parse(err.body) as { error?: unknown }).error;
    return typeof code === 'string' && (CONSULTATION_ERROR_CODES as readonly string[]).includes(code)
      ? (code as ConsultationErrorCode)
      : null;
  } catch {
    return null;
  }
}
