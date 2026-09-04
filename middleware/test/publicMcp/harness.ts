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
import {
  createPrivacyTurnHandle,
  NativeToolRegistry,
  ToolDispatchService,
  ToolIdempotencyStore,
} from '@omadia/orchestrator';
import type {
  DispatchableToolSpec,
  DomainTool,
  PrivacyTurnHandle,
  ToolDispatchResult,
} from '@omadia/orchestrator';
import { isWriteCapableTool } from '@omadia/plugin-api';
import type { PrivacyGuardService, WriteCapability } from '@omadia/plugin-api';

import { publicPaths, STATIC_PUBLIC_PATHS } from '../../src/auth/publicPaths.js';
import { createRequireAuth } from '../../src/auth/requireAuth.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';
import {
  createInMemoryPublicMcpKeyBindingStore,
  type PublicMcpKeyBindingStore,
} from '../../src/mcp/publicMcpKeyBindings.js';
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

/**
 * Re-exported so this harness's five consumers keep their import site, while
 * the behaviour lives in ONE place (#1024). The local copy this replaces
 * ignored `OMADIA_EXPECT_LOOPBACK`, so on a listener-denied runner
 * `publicMcpPrivacy.e2e` and `publicMcpMaskingAssertion` passed green while
 * asserting nothing about masking.
 */
export { isSandboxListenDenied } from '../_helpers/listenLoopback.js';

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
  /**
   * Declared write capabilities, i.e. what `isWriteCapableTool` reads.
   * Omitted ⇒ the tool declares nothing and the dispatch layer treats it as a
   * READ — which is exactly the "unannotated write tool" case the endpoint must
   * still catch via the operator's `write_tools` list.
   */
  readonly writeCapabilities?: readonly WriteCapability[];
}

/** A minimal `update` capability, enough for `isWriteCapableTool` to fire. */
export const DECLARED_WRITE: readonly WriteCapability[] = [
  { dataClass: 'test.record', operation: 'update' },
];

/**
 * A dispatcher for ONE agent, advertising exactly `tools`.
 *
 * A FAKE: it runs no privacy pipeline, so it exercises the endpoint's
 * authorization gates without the Privacy Shield in the way. `withPrivacy` is
 * therefore a pass-through that only RECORDS whether a handle was installed —
 * enough to assert the endpoint supplies one. Real masking behaviour is proven
 * against `realDispatcher` below, which runs the actual `ToolDispatchService`.
 */
export function fakeDispatcher(
  tools: readonly FakeTool[],
  seen?: { name: string; input: unknown }[],
  privacyInstalled?: { value: boolean },
): PublicMcpDispatcher {
  const specs: DispatchableToolSpec[] = tools.map((t) => ({
    name: t.name,
    description: `desc:${t.name}`,
    input_schema: { type: 'object' as const, properties: {} },
  }));
  return {
    listDispatchableToolSpecs: () => specs,
    isWriteCapable: (name) =>
      isWriteCapableTool(tools.find((t) => t.name === name)?.writeCapabilities),
    async dispatch(name, input) {
      seen?.push({ name, input });
      const tool = tools.find((t) => t.name === name);
      if (!tool) return { content: `Error: unknown tool \`${name}\`.`, isError: true };
      if (tool.handle) return tool.handle(input);
      return { content: `dispatched:${name}` };
    },
    async withPrivacy(_handle, fn) {
      if (privacyInstalled) privacyInstalled.value = true;
      return fn();
    },
  };
}

/**
 * A dispatcher backed by the REAL `ToolDispatchService`, with the real privacy
 * data-plane boundary wired the way `wirePublicMcp.ts` wires it.
 *
 * Used for the PII assertions. A fake dispatcher could be made to "look masked"
 * by returning masked text, which would prove nothing — these tests must show
 * that a tool returning genuine PII produces an HTTP response WITHOUT that PII,
 * because the real `afterDispatch` pipeline ran.
 */
export function realDispatcher(
  tools: readonly FakeTool[],
  seen?: { name: string; input: unknown }[],
  opts?: {
    /**
     * Which of `ToolDispatchService`'s TWO dispatch branches to route through.
     * They are separate code paths with separately-written privacy handling, so
     * a guarantee proven on one proves nothing about the other.
     */
    readonly via?: 'native' | 'domain';
    /**
     * Wire a real `ToolIdempotencyStore`, so `_meta.idempotencyKey` actually
     * takes the replay branch. Off by default: without it `dispatchIdempotent`
     * skips the cache entirely, and any test that thinks it is exercising a
     * replay is exercising two ordinary dispatches instead.
     */
    readonly idempotency?: boolean;
  },
): PublicMcpDispatcher {
  const registry = new NativeToolRegistry();
  const domainTools: DomainTool[] = [];
  const run = async (tool: FakeTool, input: unknown): Promise<string> => {
    seen?.push({ name: tool.name, input });
    const result = tool.handle ? await tool.handle(input) : { content: `dispatched:${tool.name}` };
    return result.content;
  };

  for (const tool of tools) {
    if (opts?.via === 'domain') {
      domainTools.push({
        name: tool.name,
        spec: {
          name: tool.name,
          description: `desc:${tool.name}`,
          input_schema: { type: 'object' as const, properties: {}, required: [] },
        },
        domain: 'domain.test',
        handle: (input: unknown) => run(tool, input),
        ...(tool.writeCapabilities ? { writeCapabilities: tool.writeCapabilities } : {}),
      } as unknown as DomainTool);
      continue;
    }
    registry.register(tool.name, {
      handler: (input: unknown) => run(tool, input),
      spec: {
        name: tool.name,
        description: `desc:${tool.name}`,
        input_schema: { type: 'object' as const, properties: {} },
      },
      ...(tool.writeCapabilities ? { writeCapabilities: tool.writeCapabilities } : {}),
    });
  }

  let slot: PrivacyTurnHandle | undefined;
  const dispatch = new ToolDispatchService({
    nativeTools: registry,
    domainTools,
    // Explicit, exactly as production does it: this path runs outside any turn,
    // so the ambient `turnContext` fallback is `undefined` here.
    privacy: () => slot,
    ...(opts?.idempotency === true ? { idempotency: new ToolIdempotencyStore() } : {}),
  });

  return {
    dispatch: (name, input, options) => dispatch.dispatch(name, input, options),
    listDispatchableToolSpecs: () => dispatch.listDispatchableToolSpecs(),
    isWriteCapable: (name) => dispatch.isWriteCapable(name),
    async withPrivacy(handle, fn) {
      slot = handle;
      try {
        return await fn();
      } finally {
        slot = undefined;
      }
    },
  };
}

/**
 * A `PrivacyGuardService` stub that genuinely masks.
 *
 * `mask` replaces every email-looking span with `[email]`, so a test can assert
 * the real address never reaches the wire. `failOn` makes `internToolResultV4`
 * throw for one tool, which is the provider-error case the endpoint must fail
 * CLOSED on (the dispatch layer's own behaviour there is fail-OPEN).
 */
export function maskingPrivacyService(opts?: { failOn?: string }): PrivacyGuardService {
  return {
    async internToolResultV4(request) {
      if (opts?.failOn === request.toolName) {
        throw new Error('privacy provider is unavailable');
      }
      return {
        digestText: request.rawResult.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]'),
        datasetId: 'ds-test',
      };
    },
    async recordBypassedTool() {},
    async runV4Tool() {
      return { resultText: '' };
    },
    async subAgentResultV4() {
      return { resultText: '' };
    },
    async takeRenderedAnswerV4() {
      return undefined;
    },
    v4ToolSpecs() {
      return [];
    },
    async finalizeTurn() {
      return undefined;
    },
  } as unknown as PrivacyGuardService;
}

/** A privacy provider function shaped the way `PublicMcpServerDeps` wants it. */
export function privacyProviderFrom(
  service: PrivacyGuardService | undefined,
): (scope: { sessionId: string; turnId: string }) => PrivacyTurnHandle | undefined {
  return (scope) =>
    service
      ? createPrivacyTurnHandle({ service, sessionId: scope.sessionId, turnId: scope.turnId })
      : undefined;
}

export interface HarnessOptions {
  readonly keys: readonly FakeKey[];
  /** Raw binding rows — normalized by the production code path, not bypassed. */
  readonly bindingRows: readonly Record<string, unknown>[];
  /** Replaces the whole binding store. For proving what an external caller sees
   *  when the store itself FAILS, which `bindingRows` cannot express. */
  readonly bindingStore?: PublicMcpKeyBindingStore;
  /** agentId → dispatcher. An agent absent here is "not active". */
  readonly dispatchers: Readonly<Record<string, PublicMcpDispatcher>>;
  /** Default true in the harness so the authorization tests are not all gated
   *  behind a privacy provider. Production defaults the OPPOSITE way (masking
   *  required); the privacy tests set this false explicitly. */
  readonly allowWithoutPrivacyMasking?: boolean;
  /** Installed `privacyRedact` provider. Absent ⇒ none installed. */
  readonly privacyService?: PrivacyGuardService;
  /** Full override of the per-dispatch handle factory, for tests that need a
   *  handle built with non-default options (e.g. a firing `resolveBypass`). */
  readonly privacy?: (scope: {
    sessionId: string;
    turnId: string;
  }) => PrivacyTurnHandle | undefined;
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
    : publicPaths();

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
    allowWithoutPrivacyMasking: opts.allowWithoutPrivacyMasking ?? true,
    privacy: opts.privacy ?? privacyProviderFrom(opts.privacyService),
    graphPool: undefined,
    log: () => {},
    apiKeys: fakeApiKeyStore(opts.keys),
    rateLimiter: createRateLimiter(),
    bindings:
      opts.bindingStore ??
      createInMemoryPublicMcpKeyBindingStore(
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
