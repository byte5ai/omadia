'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

import { ApiError } from '../../../_lib/api';

/**
 * #1885 — the agents page printed the server's English with its machine code
 * and the HTTP status ("config_validation: agent slug … (HTTP 409)") and
 * dropped the field list of a 400, so "invalid_body (HTTP 400)" said nothing
 * about which field was wrong. This reads the operator-agents error envelope
 * (`{ error, message?, issues?: [{ path, message }] }`) and turns the codes
 * this page can explain into catalogue sentences.
 */

export interface ServerIssue {
  readonly path: string;
  readonly message: string;
}

function body(err: unknown): Record<string, unknown> | null {
  if (!(err instanceof ApiError) || err.body.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(err.body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The field list of a Zod `400 invalid_body` (empty when there is none). */
export function serverIssues(err: unknown): ServerIssue[] {
  const raw = body(err)?.['issues'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const rec = entry as Record<string, unknown>;
    const message = text(rec['message']);
    if (message === null) return [];
    const path = Array.isArray(rec['path']) ? rec['path'].join('.') : (text(rec['path']) ?? '');
    return [{ path, message }];
  });
}

/** The server's `message`, never its machine code. */
export function serverReason(err: unknown): string | null {
  return text(body(err)?.['message']);
}

/** The machine code (`error`), when the body has one. */
export function serverCode(err: unknown): string | null {
  return text(body(err)?.['error']);
}

/** The server's reason plus the rejected fields, for a "Request failed: …" detail. */
export function serverDetail(err: unknown): string {
  const fields = serverIssues(err).map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
  const parts = [serverReason(err), ...fields].filter((p): p is string => p !== null);
  if (parts.length > 0) return parts.join('; ');
  if (err instanceof ApiError) return `HTTP ${String(err.status)}`;
  return err instanceof Error ? err.message : String(err);
}

/** Field paths the catalogue can name (`operatorAgents.apiErrors.fields.*`). */
const KNOWN_FIELDS: ReadonlySet<string> = new Set(['slug', 'name', 'description', 'channel_type', 'channel_key']);

/** `(err) => sentence` in the reader's language for the agents page. */
export function useAgentApiErrorText(): (err: unknown) => string {
  const t = useTranslations('operatorAgents');
  return useCallback(
    (err: unknown): string => {
      const code = serverCode(err);
      const raw = body(err);
      if (code === 'slug_taken') return t('apiErrors.slugTaken', { slug: text(raw?.['slug']) ?? '' });
      if (code === 'unknown_channel_type') {
        const known = Array.isArray(raw?.['known_channel_types']) ? raw['known_channel_types'].join(', ') : '';
        return t('apiErrors.unknownChannelType', { type: text(raw?.['channel_type']) ?? '', known });
      }
      if (code === 'not_found') return t('detailErrors.not_found');
      const issues = serverIssues(err);
      if (code === 'invalid_body' && issues.length > 0) {
        const fields = issues.map((i) =>
          KNOWN_FIELDS.has(i.path) ? t(`apiErrors.fields.${i.path}`) : `${i.path}: ${i.message}`,
        );
        return t('apiErrors.invalidFields', { fields: [...new Set(fields)].join(' ') });
      }
      if (code === 'config_validation') return t('apiErrors.refused', { detail: serverDetail(err) });
      return t('detailErrors.unknown', { detail: serverDetail(err) });
    },
    [t],
  );
}
