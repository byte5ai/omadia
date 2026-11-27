import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

import { ApiError } from '../../_lib/api';

/**
 * Localized text for codes the MCP operator routes answer with (#1941, #1955,
 * #1959). Every mapping is keyed on the stable `code`, never on the server's
 * English `message`, so the line follows the operator's locale; an unknown
 * code falls back to the caller's generic text.
 */

/** `code` of a #1955 input refusal → `adminMcp.input.*` key. */
const INPUT_ERROR_KEYS: Readonly<Record<string, string>> = {
  name_required: 'nameRequired',
  name_too_long: 'nameTooLong',
  endpoint_required: 'endpointRequired',
  endpoint_invalid: 'endpointInvalid',
  invalid_transport: 'invalidTransport',
  invalid_status: 'invalidStatus',
  name_taken: 'nameTaken',
  url_invalid: 'urlInvalid',
  not_found: 'notFound',
};

/** The `adminMcp.input.*` key for an input refusal, or `null`. */
export function mcpInputErrorKey(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code === null) return null;
  if (err.status !== 400 && err.status !== 404 && err.status !== 409) return null;
  return INPUT_ERROR_KEYS[err.code] ?? null;
}

export interface UnackedRiskTool {
  readonly toolName: string;
  readonly severity: string;
}

/** #1941 — the tools a 409 `mcp_server_has_unacked_risks` names, or `null`. */
export function parseUnackedRisks(err: unknown): UnackedRiskTool[] | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  try {
    const body = JSON.parse(err.body) as { error?: unknown; tools?: unknown };
    if (body.error !== 'mcp_server_has_unacked_risks' || !Array.isArray(body.tools)) return null;
    return body.tools.filter(
      (t): t is UnackedRiskTool =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as UnackedRiskTool).toolName === 'string' &&
        typeof (t as UnackedRiskTool).severity === 'string',
    );
  } catch {
    return null;
  }
}

/** Scan severity → `skills.verdict.*` label key. */
const SEVERITY_KEYS: Readonly<Record<string, string>> = {
  high_risk: 'highRisk',
  flagged: 'flagged',
  scan_failed: 'scanFailed',
  too_large_to_scan: 'tooLargeToScan',
  no_signals: 'noSignals',
  not_yet_scanned: 'notYetScanned',
  pending: 'pending',
};

/** Localized label for a verdict severity; the raw value when unknown. */
export function useSeverityLabel(): (severity: string) => string {
  const t = useTranslations('skills.verdict');
  return useCallback(
    (severity: string) => {
      const key = SEVERITY_KEYS[severity];
      return key ? t(key) : severity;
    },
    [t],
  );
}

/** #1959 — localized label for a heuristic risk code; the raw code when unknown. */
export function useRiskCodeLabel(): (code: string) => string {
  const t = useTranslations('skills.verdict.riskCode');
  return useCallback((code: string) => (t.has(code) ? t(code) : code), [t]);
}

/** `mcp_call_log.error` reasons the kernel writes → `adminMcp.audit.reason.*`. */
const AUDIT_REASON_KEYS: Readonly<Record<string, string>> = {
  auth_required: 'authRequired',
  'privacy masking skipped': 'maskingSkipped',
  'privacy masking failed': 'maskingFailed',
  'privacy provider absent': 'privacyProviderAbsent',
  'write rate limited': 'writeRateLimited',
  'not allowlisted': 'notAllowlisted',
  'no public MCP binding': 'noBinding',
  'agent not active': 'agentInactive',
  'concurrency ceiling': 'capacity',
  'tool reported an error': 'toolError',
};

/** #1959 — localized failure reason of an audit row; `null` for a reason
 *  without a translation (the raw text then stays in the tooltip only). */
export function useAuditReasonText(): (reason: string | null) => string | null {
  const t = useTranslations('adminMcp.audit.reason');
  return useCallback(
    (reason: string | null) => {
      if (reason === null) return null;
      const key = AUDIT_REASON_KEYS[reason];
      return key ? t(key) : null;
    },
    [t],
  );
}
