import { ApiError } from './api';

/**
 * #760 — typed client for the privacy miss-report queue
 * (`/api/v1/operator/privacy/miss-reports`). Same dual-environment shape as
 * `receipts.ts`/`channels.ts`: browser via `/bot-api`, server via
 * MIDDLEWARE_URL + forwarded cookies.
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

export interface MissReportDto {
  id: string;
  reporter: string;
  term: string;
  description?: string;
  turnId?: string;
  status: 'open' | 'resolved';
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt: string;
}

const BASE = '/v1/operator/privacy/miss-reports';

export async function createMissReport(input: {
  term: string;
  description?: string;
  turnId?: string;
}): Promise<MissReportDto> {
  const res = await fetch(botApi(BASE), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await forwardCookieHeader()) },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new ApiError(res.status, `miss-report create failed: ${String(res.status)}`);
  return (await res.json()) as MissReportDto;
}

export async function listMissReports(
  status: 'open' | 'resolved' | 'all' = 'open',
): Promise<{ items: MissReportDto[] }> {
  const res = await fetch(botApi(`${BASE}?status=${status}`), {
    headers: { ...(await forwardCookieHeader()) },
    cache: 'no-store',
  });
  if (!res.ok) throw new ApiError(res.status, `miss-report list failed: ${String(res.status)}`);
  return (await res.json()) as { items: MissReportDto[] };
}

export async function resolveMissReport(id: string): Promise<MissReportDto> {
  const res = await fetch(botApi(`${BASE}/${encodeURIComponent(id)}/resolve`), {
    method: 'POST',
    headers: { ...(await forwardCookieHeader()) },
  });
  if (!res.ok) throw new ApiError(res.status, `miss-report resolve failed: ${String(res.status)}`);
  return (await res.json()) as MissReportDto;
}
