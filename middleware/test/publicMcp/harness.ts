/**
 * W2-3 (issue #542) — shared harness for the public MCP endpoint's e2e tests.
 *
 * ─── Why this reproduces the real chain instead of a bare `express()` app ────
 *
 * The doc comment at the top of `src/auth/publicPaths.ts` records the bug this
 * exists to avoid: epic #470's runner router was mounted without a session
 * guard, and its e2e test built its OWN bare `express()` app to prove it — so
 * the test passed while the route 401'd in production behind the blanket `/api`
 * guard. A test app that omits the guard proves nothing about a route whose
 * reachability depends on it.
 *
 * So this harness assembles, in order, exactly what `src/index.ts` assembles:
 *
 *   1. `express.json({ limit: '10mb' })` — the same global parser, which is why
 *      the 8 MB cap cannot be an `express.json` limit (see `bodyCapMiddleware`).
 *   2. `app.use('/api', requireAuth, <a router>)` — the OB-106 line. It runs for
 *      EVERY `/api/*` request whichever router answers, which is what makes the
 *      `publicPaths` entry load-bearing.
 *   3. `mountPublicMcp(app, requireAuth, …)` — the SAME function index.ts calls,
 *      not a hand-rolled equivalent.
 *   4. `createRequireAuth({ publicPaths: publicPaths({ … }) })` — the SAME
 *      shared allowlist production runs.
 *
 * `withoutPublicPathEntry` drives the negative half: strip the entry and the
 * route must go DARK (401), never open.
 */

import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';

import express, { type Express } from 'express';

import type { ApiKeyRecord, ApiKeyStore, ApiKeyScope } from '@omadia/api-key-auth';
import { createRateLimiter, sha256Hex } from '@omadia/api-key-auth';
import type { DispatchableToolSpec, ToolDispatchResult } from '@omadia/orchestrator';

import { publicPaths, STATIC_PUBLIC_PATHS } from '../../src/auth/publicPaths.js';
import { createRequireAuth } from '../../src/auth/requireAuth.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';
import { createInMemoryPublicMcpKeyBindingStore } from '../../src/mcp/publicMcpKeyBindings.js';
import { PUBLIC_MCP_PATH } from '../../src/mcp/publicMcpPath.js';
import { mountPublicMcp } from '../../src/mcp/wirePublicMcp.js';
import type {
  PublicMcpAuditEntry,
  PublicMcpDispatcher,
} from '../../src/mcp/publicMcpServer.js';

export const MCP_ACCEPT = 'application/json, text/event-stream';

/** Reads either a plain JSON body or the SSE framing the transport may use. */
export function parseMcpJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) {
    return JSON.parse(trimmed) as Record<string, unknown>;
  }
  const data = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter(Boolean);
  return JSON.parse(data.join('\n')) as Record<string, unknown>;
}

/** True when the sandbox refuses loopback listeners, so callers can self-skip. */
export function isSandboxListenDenied(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EPERM';
}

export interface FakeKey {
  readonly token: string;
  readonly id: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly rateLimitPerMinute?: number;
}

/**
 * An `ApiKeyStore` over an in-memory key list.
 *
 * Only `verify` is reachable from the endpoint; the mutators throw so a test
 * that accidentally exercises a write path fails loudly rather than silently
 * "succeeding". Verification hashes the token the same way `apiKeyToken.ts`
 * does, so a token/record mismatch fails here the way it would in production.
 */
export function fakeApiKeyStore(keys: readonly FakeKey[]): ApiKeyStore {
  const records: ApiKeyRecord[] = keys.map((k) => ({
    id: k.id,
    hash: sha256Hex(k.token),
    rateLimitPerMinute: k.rateLimitPerMinute ?? 60,
    scopes: k.scopes,
    createdAt: Date.now(),
  }));
  return {
    create: () => Promise.reject(new Error('not used')),
    list: () => Promise.reject(new Error('not used')),
    revoke: () => Promise.reject(new Error('not used')),
    verify: (token) =>
      Promise.resolve(records.find((r) => r.hash === sha256Hex(String(token)))),
  };
}

export interface FakeTool {
  readonly name: string;
  /** Called on dispatch. Default returns a deterministic marker. */
  readonly handle?: (input: unknown) => Promise<ToolDispatchResult>;
}

/** A dispatcher for ONE agent, advertising exactly `tools`. */
export function fakeDispatcher(
  tools: readonly FakeTool[],
  seen?: { name: string; input: unknown }[],
): PublicMcpDispatcher {
  const specs: DispatchableToolSpec[] = tools.map((t) => ({
    name: t.name,
    description: `desc:${t.name}`,
    input_schema: { type: 'object' as const, properties: {} },
  }));
  return {
    listDispatchableToolSpecs: () => specs,
    async dispatch(name, input) {
      seen?.push({ name, input });
      const tool = tools.find((t) => t.name === name);
      if (!tool) return { content: `Error: unknown tool \`${name}\`.`, isError: true };
      if (tool.handle) return tool.handle(input);
      return { content: `dispatched:${name}` };
    },
  };
}

export interface HarnessOptions {
  readonly keys: readonly FakeKey[];
  /** Raw binding rows — normalized by the production code path, not bypassed. */
  readonly bindingRows: readonly Record<string, unknown>[];
  /** agentId → dispatcher. An agent absent here is "not active". */
  readonly dispatchers: Readonly<Record<string, PublicMcpDispatcher>>;
  /** Default true, matching production's fail-closed default. */
  readonly allowWithoutPrivacySeam?: boolean;
  /**
   * Strips `PUBLIC_MCP_PATH` from the allowlist handed to `requireAuth`, to
   * prove the entry is load-bearing rather than decorative.
   */
  readonly withoutPublicPathEntry?: boolean;
  readonly audit?: PublicMcpAuditEntry[];
  readonly toolTimeoutMs?: number;
  readonly maxConcurrentCalls?: number;
}

export interface Harness {
  readonly url: string;
  readonly app: Express;
  readonly mounted: boolean;
  post(body: unknown, opts?: { token?: string; headers?: Record<string, string> }): Promise<Response>;
  rpc(
    body: unknown,
    opts?: { token?: string },
  ): Promise<{ status: number; payload: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** A real session-cookie signer, so the "no cookie" 401 is the production one. */
const SESSION_KEY = new TextEncoder().encode('harness-session-signing-key-32bytes!!');

export async function startHarness(opts: HarnessOptions): Promise<Harness> {
  const app = express();
  app.set('trust proxy', true);

  // (1) The SAME global parser index.ts installs. Its 10mb limit is why the
  // endpoint's own 8 MB ceiling is enforced post-parse.
  app.use(express.json({ limit: '10mb' }));

  const allowlist = opts.withoutPublicPathEntry
    ? STATIC_PUBLIC_PATHS.filter((re) => !re.test(PUBLIC_MCP_PATH))
    : publicPaths({ devEndpointsEnabled: false });

  const requireAuth = createRequireAuth({
    signingKey: SESSION_KEY,
    whitelist: new EmailWhitelist('operator@example.com'),
    publicPaths: allowlist,
  });

  // (2) The OB-106 line: requireAuth for every /api/* request, whichever router
  // ultimately answers. The trailing router is a stand-in for createChatRouter —
  // what matters is that the guard runs first for the whole prefix.
  app.use('/api', requireAuth, express.Router());

  // (3) The production wire function, not a re-implementation.
  const audit = opts.audit;
  const mounted = mountPublicMcp(app, requireAuth, {
    enabled: true,
    allowWithoutPrivacySeam: opts.allowWithoutPrivacySeam ?? true,
    graphPool: undefined,
    log: () => {},
    apiKeys: fakeApiKeyStore(opts.keys),
    rateLimiter: createRateLimiter(),
    bindings: createInMemoryPublicMcpKeyBindingStore(
      opts.bindingRows as Parameters<typeof createInMemoryPublicMcpKeyBindingStore>[0],
    ),
    resolveDispatcher: (agentId) => opts.dispatchers[agentId],
    ...(audit ? { audit: (entry: PublicMcpAuditEntry) => audit.push(entry) } : {}),
    ...(opts.toolTimeoutMs !== undefined ? { toolTimeoutMs: opts.toolTimeoutMs } : {}),
    ...(opts.maxConcurrentCalls !== undefined
      ? { maxConcurrentCalls: opts.maxConcurrentCalls }
      : {}),
  });

  const server: Server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${String(port)}${PUBLIC_MCP_PATH}`;

  async function post(
    body: unknown,
    o?: { token?: string; headers?: Record<string, string> },
  ): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: MCP_ACCEPT,
        ...(o?.token ? { Authorization: `Bearer ${o.token}` } : {}),
        ...(o?.headers ?? {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  return {
    url,
    app,
    mounted,
    post,
    async rpc(body, o) {
      const res = await post(body, o);
      const text = await res.text();
      return {
        status: res.status,
        payload: text.length > 0 ? parseMcpJson(text) : {},
      };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** A `tools/list` JSON-RPC request. Stateless: no `initialize`, no session id. */
export function listToolsRequest(id = 1): unknown {
  return { jsonrpc: '2.0', method: 'tools/list', params: {}, id };
}

/** A `tools/call` JSON-RPC request. */
export function callToolRequest(name: string, args: unknown = {}, id = 2): unknown {
  return { jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id };
}

/** Tool names from a `tools/list` reply, or `undefined` when it errored. */
export function toolNames(payload: Record<string, unknown>): string[] | undefined {
  const result = payload['result'] as { tools?: { name: string }[] } | undefined;
  return result?.tools?.map((t) => t.name);
}

/** The JSON-RPC error message, or undefined when the reply succeeded. */
export function rpcErrorMessage(payload: Record<string, unknown>): string | undefined {
  const err = payload['error'] as { message?: string } | undefined;
  if (err?.message !== undefined) return err.message;
  // A tool-level failure surfaces as a successful RPC with isError set.
  const result = payload['result'] as
    | { isError?: boolean; content?: { text?: string }[] }
    | undefined;
  if (result?.isError) return result.content?.[0]?.text;
  return undefined;
}

/** The text content of a successful `tools/call` reply. */
export function callResultText(payload: Record<string, unknown>): string | undefined {
  const result = payload['result'] as { content?: { text?: string }[] } | undefined;
  return result?.content?.[0]?.text;
}
