import { ApiError } from './api';

/**
 * #761 — typed client for the provenance verification surface
 * (`/api/v1/operator/provenance`). Same dual-environment shape as
 * `receipts.ts`.
 */

function botApi(path: string): string {
  if (typeof window !== 'undefined') {
    return `/bot-api${path}`;
  }
  const base = process.env['MIDDLEWARE_URL'] ?? 'http://localhost:3979';
  return `${base}/api${path}`;
}

async function forwardCookieHeader(): Promise<Record<string, string>> {
  if (typeof window !== 'undefined') return {};
  try {
    const mod = await import('next/headers');
    const jar = await mod.cookies();
    const cookieHeader = jar
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    return cookieHeader ? { cookie: cookieHeader } : {};
  } catch {
    return {};
  }
}

export interface ProvenanceVerifyDto {
  ok: boolean;
  checkedEntries: number;
  headSeq?: number;
  headHashHex?: string;
  recordedHeadSeq: number;
  truncated: boolean;
  preChainRows: number;
  firstBrokenSeq?: number;
  breakKind?: string;
  checkpoints: {
    total: number;
    verified: number;
    findings: Array<{ seq: number; kind: string }>;
    signaturesChecked: boolean;
  };
  prefix: {
    reapedUpToSeq: number;
    anchored: boolean;
    prematureDeletion?: { provenCreatedAfterIso: string; retentionDays: number };
  };
}

export interface ProvenancePublicKeyDto {
  configured: boolean;
  publicKeyPem?: string;
  fingerprint?: string;
  checkpointIntervalMinutes: number;
  anchorConfigured: boolean;
}

export async function verifyProvenance(): Promise<ProvenanceVerifyDto> {
  const res = await fetch(botApi('/v1/operator/provenance/verify'), {
    headers: { ...(await forwardCookieHeader()) },
    cache: 'no-store',
  });
  if (!res.ok) throw new ApiError(res.status, `provenance verify failed: ${String(res.status)}`);
  return (await res.json()) as ProvenanceVerifyDto;
}

export async function getProvenancePublicKey(): Promise<ProvenancePublicKeyDto> {
  const res = await fetch(botApi('/v1/operator/provenance/public-key'), {
    headers: { ...(await forwardCookieHeader()) },
    cache: 'no-store',
  });
  if (!res.ok) throw new ApiError(res.status, `public-key fetch failed: ${String(res.status)}`);
  return (await res.json()) as ProvenancePublicKeyDto;
}

/** Browser URL of the signed JSONL export (download link). */
export function provenanceExportUrl(): string {
  return '/bot-api/v1/operator/provenance/export';
}
