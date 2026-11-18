'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

import { ApiError } from '@/app/_lib/api';
import { apiErrorBodyMessage, mcpGuardCode } from '@/app/admin/mcp/mcpErrors';

export type McpDiscoveryIssue =
  | { kind: 'needs-auth' }
  | { kind: 'config-required'; missing: string[] }
  | { kind: 'endpoint-placeholder'; placeholders: string[] }
  | { kind: 'error'; text: string };

interface ErrorBody {
  error?: unknown;
  missing?: unknown;
  placeholders?: unknown;
}

function parseErrorBody(err: ApiError): ErrorBody | null {
  try {
    const parsed: unknown = JSON.parse(err.body);
    return typeof parsed === 'object' && parsed !== null ? (parsed as ErrorBody) : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function classifyDiscoveryIssue(err: unknown): Exclude<McpDiscoveryIssue, { kind: 'error' }> | null {
  if (!(err instanceof ApiError)) return null;
  const body = parseErrorBody(err);
  if (err.status === 409 && body?.error === 'mcp_needs_auth') {
    return { kind: 'needs-auth' };
  }
  if (err.status === 422 && body?.error === 'mcp_config_required') {
    return { kind: 'config-required', missing: stringList(body.missing) };
  }
  if (err.status === 422 && body?.error === 'mcp_endpoint_placeholder') {
    return { kind: 'endpoint-placeholder', placeholders: stringList(body.placeholders) };
  }
  return null;
}

function technicalErrorText(err: unknown): string {
  return apiErrorBodyMessage(err) ?? (err instanceof Error ? err.message : String(err));
}

export function useMcpAddErrorText(): (err: unknown) => string {
  const t = useTranslations('adminMcp');
  return useCallback(
    (err: unknown): string => {
      const detail = technicalErrorText(err);
      const code = mcpGuardCode(err);
      if (code === 'blocked_host') return t('guard.blockedHost', { detail });
      if (code === 'stdio_disabled') return t('guard.stdioDisabled', { detail });
      return detail;
    },
    [t],
  );
}
