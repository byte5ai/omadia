/**
 * #1912 / ADR-0210 — operator-set static request headers for http/sse MCP
 * servers (an API key in `x-api-key`, `Authorization: Bearer …`).
 *
 * Storage model, the same one the config fields already use (epic #459):
 *
 *  - `mcp_servers.headers` holds TEMPLATES only. A plain header is stored as
 *    typed; a SECRET header is stored as the placeholder `{header_<name>}`.
 *  - The secret value goes to the Vault under the config field
 *    `header_<name>` (`McpConfigService`, namespace `@omadia/mcp-config`) and
 *    is substituted into the header at connect time. It never reaches the DB
 *    row, a response body or a log line.
 *  - The config schema is re-derived from endpoint + header placeholders on
 *    every header save, so new placeholders appear as fields and fields whose
 *    placeholder vanished are dropped together with their Vault secret.
 */

import type { McpConfigField } from '@omadia/orchestrator';

import { deriveMcpConfigSchema } from '../agents/subAgentToolHydration.js';

/** One header as the operator submits it. */
export interface McpHeaderInput {
  readonly name: string;
  /** Plain value, or the new secret. Absent/empty on a secret header keeps
   *  the stored secret. */
  readonly value?: string;
  readonly secret: boolean;
}

/** One header as the operator surface shows it: never a secret value. */
export interface McpHeaderView {
  readonly name: string;
  readonly secret: boolean;
  /** The plain value; `null` for a secret header. */
  readonly value: string | null;
  /** Secret headers only: whether the Vault holds a value. */
  readonly secretSet?: boolean;
}

export interface McpHeaderRefusal {
  readonly code: string;
  readonly message: string;
}

/** RFC 9110 `token`: the characters a header name may use. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
/** Longest header value accepted. */
export const MAX_HEADER_VALUE_CHARS = 8192;
/** Most headers on one server. */
export const MAX_HEADERS = 20;

/**
 * Headers the MCP transport sets itself, or that would break the HTTP framing.
 * `Authorization` is NOT here on purpose: a static bearer token is the main use
 * case. On a server that also runs OAuth, the OAuth token wins (`httpRequestInit`).
 */
const RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'content-type',
  'accept',
  'connection',
  'transfer-encoding',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);

const SECRET_FIELD_PREFIX = 'header_';

/** The config field (and Vault key) that holds a secret header's value. */
export function secretHeaderFieldKey(name: string): string {
  return `${SECRET_FIELD_PREFIX}${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
}

function secretTemplate(name: string): string {
  return `{${secretHeaderFieldKey(name)}}`;
}

/** Whether a stored header value is the template of a secret header. */
function isSecretTemplate(name: string, value: unknown): boolean {
  return value === secretTemplate(name);
}

/** Validates the submitted header list: the normalized list, or a refusal. */
export function validateHeaderInput(raw: unknown): McpHeaderInput[] | McpHeaderRefusal {
  if (!Array.isArray(raw)) {
    return { code: 'headers_invalid', message: 'headers must be an array of { name, value, secret }' };
  }
  if (raw.length > MAX_HEADERS) {
    return { code: 'headers_too_many', message: `at most ${String(MAX_HEADERS)} headers per server` };
  }
  const seen = new Set<string>();
  const out: McpHeaderInput[] = [];
  for (const entry of raw) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const name = typeof e['name'] === 'string' ? e['name'].trim() : '';
    if (!HEADER_NAME_RE.test(name)) {
      return { code: 'header_name_invalid', message: `invalid header name "${name}"` };
    }
    const lower = name.toLowerCase();
    if (RESERVED_HEADER_NAMES.has(lower)) {
      return { code: 'header_name_reserved', message: `the MCP transport sets "${name}" itself` };
    }
    if (seen.has(lower)) {
      return { code: 'header_name_duplicate', message: `header "${name}" is listed twice` };
    }
    seen.add(lower);
    if (e['secret'] !== undefined && typeof e['secret'] !== 'boolean') {
      return { code: 'headers_invalid', message: 'secret must be a boolean' };
    }
    const secret = e['secret'] === true;
    const value = e['value'];
    if (value !== undefined && typeof value !== 'string') {
      return { code: 'headers_invalid', message: 'value must be a string' };
    }
    if (typeof value === 'string' && (value.length > MAX_HEADER_VALUE_CHARS || /[\r\n\0]/.test(value))) {
      return { code: 'header_value_invalid', message: `the value of "${name}" is too long or contains a line break` };
    }
    if (!secret && (value === undefined || value === '')) {
      return { code: 'header_value_required', message: `header "${name}" needs a value` };
    }
    out.push({ name, secret, ...(value !== undefined && value !== '' ? { value } : {}) });
  }
  return out;
}

export interface HeaderPlan {
  /** What `mcp_servers.headers` becomes. */
  readonly headers: Record<string, string>;
  /** Secret values to write to the Vault, by field key. */
  readonly secretWrites: ReadonlyMap<string, string>;
  /** Secret headers submitted without a value: their stored secret must exist. */
  readonly keptSecretKeys: readonly string[];
}

/** Turns validated input into stored templates and Vault writes. */
export function planHeaders(input: readonly McpHeaderInput[]): HeaderPlan {
  const headers: Record<string, string> = {};
  const secretWrites = new Map<string, string>();
  const keptSecretKeys: string[] = [];
  for (const h of input) {
    if (!h.secret) {
      headers[h.name] = h.value ?? '';
      continue;
    }
    headers[h.name] = secretTemplate(h.name);
    const key = secretHeaderFieldKey(h.name);
    if (h.value !== undefined) secretWrites.set(key, h.value);
    else keptSecretKeys.push(key);
  }
  return { headers, secretWrites, keptSecretKeys };
}

export interface SchemaReconcile {
  readonly schema: McpConfigField[];
  /** Secret fields of the old schema that no longer exist: delete from the Vault. */
  readonly removedSecretKeys: string[];
}

/**
 * The config schema of an http/sse server after its endpoint or headers
 * changed: one field per placeholder, existing attributes kept, secret-header
 * fields forced secret, vanished fields dropped (their secrets reported).
 *
 * stdio servers are left alone by the caller: their fields are environment
 * variables declared by a registry or the operator, not placeholders.
 */
export function reconcileConfigSchema(
  endpoint: string | null,
  headers: Record<string, unknown>,
  existing: readonly McpConfigField[],
): SchemaReconcile {
  const secretHeaderKeys = new Set(
    Object.entries(headers)
      .filter(([name, value]) => isSecretTemplate(name, value))
      .map(([name]) => secretHeaderFieldKey(name)),
  );
  const schema = deriveMcpConfigSchema(endpoint, headers, existing).map((field) =>
    secretHeaderKeys.has(field.key)
      ? {
          ...field,
          secret: true,
          required: true,
          label: headerLabel(headers, field.key) ?? field.label,
        }
      : field,
  );
  const kept = new Set(schema.map((f) => f.key));
  const removedSecretKeys = existing.filter((f) => f.secret && !kept.has(f.key)).map((f) => f.key);
  return { schema, removedSecretKeys };
}

function headerLabel(headers: Record<string, unknown>, fieldKey: string): string | undefined {
  const name = Object.keys(headers).find((n) => secretHeaderFieldKey(n) === fieldKey);
  return name === undefined ? undefined : `Header ${name}`;
}

/** The operator view of stored headers; secret values never leave the Vault. */
export function viewHeaders(
  headers: Record<string, unknown>,
  secretsSet: Readonly<Record<string, boolean>>,
): McpHeaderView[] {
  return Object.entries(headers)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, value]) =>
      isSecretTemplate(name, value)
        ? {
            name,
            secret: true,
            value: null,
            secretSet: secretsSet[secretHeaderFieldKey(name)] === true,
          }
        : { name, secret: false, value },
    );
}

/** Narrows `validateHeaderInput`'s result to its refusal. */
export function isHeaderRefusal(v: unknown): v is McpHeaderRefusal {
  return !Array.isArray(v);
}
