import { ApiError } from './api';
import type { PrivacyReceipt } from './chatSessions';

/**
 * #757 — typed client for the operator receipts REST surface
 * (`/api/v1/operator/receipts`). Mirrors the `channels.ts` pattern: works
 * from both server components (MIDDLEWARE_URL + forwarded cookies) and the
 * browser (`/bot-api` catch-all route).
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

export interface TurnReceiptDto {
  turnId: string;
  sessionScope?: string;
  channel?: string;
  model?: string;
  receipt: PrivacyReceipt;
  createdAt: string;
}

export interface ReceiptsPageDto {
  items: TurnReceiptDto[];
  nextCursor?: string;
}

export async function listReceipts(opts?: {
  scope?: string;
  cursor?: string;
  limit?: number;
}): Promise<ReceiptsPageDto> {
  const params = new URLSearchParams();
  if (opts?.scope) params.set('scope', opts.scope);
  if (opts?.cursor) params.set('cursor', opts.cursor);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.size > 0 ? `?${params.toString()}` : '';
  const res = await fetch(botApi(`/v1/operator/receipts${qs}`), {
    headers: { ...(await forwardCookieHeader()) },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new ApiError(res.status, `receipts list failed: ${String(res.status)}`);
  }
  return (await res.json()) as ReceiptsPageDto;
}
