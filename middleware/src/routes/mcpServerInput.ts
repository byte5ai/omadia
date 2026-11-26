/**
 * #1955 — input checks for the operator MCP routes (`/api/v1/operator/mcp-*`).
 *
 * Before this module the create route validated only the stdio switch and the
 * blocked-host rule: an empty name or endpoint was stored, an endpoint without
 * a scheme was saved and failed only at Discover, and a bad transport, a
 * non-UUID id or a duplicate registry name surfaced as a 500 carrying the raw
 * Postgres message. Every check here answers 400/404/409 with a stable `code`
 * the web UI translates.
 *
 * Shape checks only (ADR-0038: a well-formed id is checked before any lookup).
 * The outbound host rule stays in `mcpOutboundHostGuard.ts` (ADR-0139).
 */

import type { NextFunction, Request, Response } from 'express';

export type McpTransport = 'stdio' | 'http' | 'sse';

const TRANSPORTS: ReadonlySet<string> = new Set(['stdio', 'http', 'sse']);

/** Longest server or registry name accepted; the UI shows it in one line. */
export const MAX_MCP_NAME_LENGTH = 120;

/** A `{placeholder}` template segment, substituted from the server's config
 *  before connect (`mcpRowToConfig`). */
const PLACEHOLDER_RE = /\{[A-Za-z0-9_.-]+\}/g;

export interface McpInputRefusal {
  readonly status: 400 | 404 | 409;
  readonly error: string;
  readonly code: string;
  readonly message: string;
}

export interface ValidMcpServerInput {
  readonly name: string;
  readonly transport: McpTransport;
  readonly endpoint: string;
  readonly status: 'enabled' | 'disabled';
}

/** Narrows a validator result to its refusal. */
export function isMcpInputRefusal(value: unknown): value is McpInputRefusal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { status?: unknown }).status === 'number'
  );
}

function refusal(code: string, message: string): McpInputRefusal {
  return { status: 400, error: 'invalid_mcp_server', code, message };
}

/** Name: trimmed, non-empty, bounded. Returns the trimmed name when valid. */
export function checkMcpName(raw: unknown, what: 'server' | 'registry'): string | McpInputRefusal {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') {
    return { ...refusal('name_required', `a ${what} name is required`), error: `invalid_mcp_${what}` };
  }
  if (name.length > MAX_MCP_NAME_LENGTH) {
    return {
      ...refusal('name_too_long', `a ${what} name has at most ${String(MAX_MCP_NAME_LENGTH)} characters`),
      error: `invalid_mcp_${what}`,
    };
  }
  return name;
}

/**
 * Whether `endpoint` is an http(s) URL once its `{placeholder}` segments are
 * filled. Placeholders are allowed anywhere (an M365 endpoint carries
 * `{tenant_id}` in the path, a self-hosted one `{host}` in the authority), so
 * each is replaced by a neutral token before parsing.
 */
export function isHttpUrlTemplate(endpoint: string): boolean {
  const filled = endpoint.replace(PLACEHOLDER_RE, 'placeholder');
  let url: URL;
  try {
    url = new URL(filled);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
}

/** Validates the body of `POST /mcp-servers`. */
export function validateMcpServerInput(body: unknown): ValidMcpServerInput | McpInputRefusal {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = checkMcpName(b['name'], 'server');
  if (typeof name !== 'string') return name;

  const transport = b['transport'];
  if (typeof transport !== 'string' || !TRANSPORTS.has(transport)) {
    return refusal('invalid_transport', 'transport must be one of stdio, http, sse');
  }

  const status = b['status'] ?? 'enabled';
  if (status !== 'enabled' && status !== 'disabled') {
    return refusal('invalid_status', 'status must be enabled or disabled');
  }

  const endpoint = typeof b['endpoint'] === 'string' ? b['endpoint'].trim() : '';
  if (endpoint === '') {
    return refusal(
      'endpoint_required',
      transport === 'stdio' ? 'a stdio server needs a command line' : 'an http/sse server needs an endpoint URL',
    );
  }
  if (transport !== 'stdio' && !isHttpUrlTemplate(endpoint)) {
    return refusal(
      'endpoint_invalid',
      'the endpoint must be an http:// or https:// URL; {placeholder} segments are allowed',
    );
  }
  return { name, transport: transport as McpTransport, endpoint, status };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Express middleware for `/mcp-servers/:id…` and `/mcp-registries/:id…`: a
 * non-UUID id is a 404 before any handler runs, instead of a Postgres
 * `invalid input syntax for type uuid` 500. Literal sibling routes
 * (`/mcp-servers/rescan-all`, `/mcp-servers/from-registry`) are let through.
 */
export function requireUuidMcpId(literalSegments: ReadonlySet<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const segment = req.path.split('/').filter((s) => s !== '')[0] ?? '';
    if (segment === '' || literalSegments.has(segment) || UUID_RE.test(segment)) {
      next();
      return;
    }
    res.status(404).json({ error: 'mcp_not_found', code: 'not_found', message: 'no such MCP resource' });
  };
}

/** Postgres unique-violation, for the duplicate-registry 409. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505'
  );
}
