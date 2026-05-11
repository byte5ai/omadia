import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';

import type {
  PreviewActivateOptions,
  PreviewHandle,
  PreviewRouteCapture,
  PreviewRuntime,
  PreviewToolDescriptor,
} from './previewRuntime.js';
import { generateInputForSchema } from './syntheticInput.js';
import type { AgentSpecSkeleton } from './types.js';

/**
 * RuntimeSmokeService (B.9-1) — runs a "does this thing actually boot
 * + invoke without crashing?" pass on a freshly built plugin zip.
 *
 * Pipeline:
 *   1. activate the zip via the existing PreviewRuntime (no separate
 *      sandbox; reuses the same isolation the preview chat uses).
 *   2. for each tool in the resulting toolkit, build a synthetic input
 *      from the spec's JSON-schema (B.9-2 generator), invoke `tool.run`
 *      with a per-tool timeout, capture the outcome.
 *   3. tear the preview down.
 *
 * Pass criteria (Resolution #3): no-crash + no-timeout = pass.
 *   - 'ok': handler resolved normally.
 *   - 'validation_failed': handler threw a ZodError because the
 *     synthetic input didn't satisfy a tighter inner schema. We treat
 *     this as a controlled exit, not a smoke failure — B.10 LLM-judge
 *     will assess whether the validation rules themselves are sensible.
 *   - 'threw': handler raised any other error.
 *   - 'timeout': handler hung past `toolTimeoutMs`.
 *
 * Setup-fields / secrets (Resolution #4): every key gets a stub value
 * `'smoke-test'`. Tools that hit real external auth will get a 401
 * from the provider — that's a controlled exit (status='ok' or
 * status='threw' depending on the SDK's error shape), not a smoke fail.
 */

export type ToolSmokeStatus = 'ok' | 'timeout' | 'threw' | 'validation_failed';

export interface ToolSmokeResult {
  toolId: string;
  status: ToolSmokeStatus;
  durationMs: number;
  errorMessage?: string;
}

export type RuntimeSmokeReason =
  | 'ok'
  | 'activate_failed'
  | 'tool_failures'
  | 'no_tools'
  | 'admin_route_schema_violation';

/**
 * Outcome of probing one admin-route GET endpoint (Theme D).
 *
 * `ok`           — response was 2xx and matched `{ ok: true, ... }`.
 * `empty_warning`— response matched the schema but returned an empty
 *                  array for an external_reads-declared endpoint. NOT a
 *                  failure (a freshly-installed Odoo with 0 employees is
 *                  legitimate); surfaced so the operator can spot config
 *                  drift, but `result.ok` stays true.
 * `schema_violation` — response body is missing the required `ok` field
 *                  (or `ok` is not a boolean). The most common Builder
 *                  bug — Frontend prüft `data.ok`, Backend hat
 *                  `res.json({ devices: [] })` ohne wrapper geschrieben.
 * `http_error`   — response status was 4xx/5xx OR 'ok: false' wrapper.
 * `timeout`      — fetch exceeded the per-route budget.
 * `introspection_failed` — could not extract GET routes from the
 *                  Express router. Treated as a soft pass (we cannot
 *                  prove a violation if we cannot reach the routes).
 */
export type AdminRouteSmokeStatus =
  | 'ok'
  | 'empty_warning'
  | 'schema_violation'
  | 'http_error'
  | 'timeout'
  | 'introspection_failed';

export interface AdminRouteSmokeResult {
  endpoint: string;
  status: AdminRouteSmokeStatus;
  httpStatus?: number;
  durationMs: number;
  reason?: string;
}

export interface RuntimeSmokeResult {
  ok: boolean;
  reason: RuntimeSmokeReason;
  results: ToolSmokeResult[];
  /** Populated when admin-route smoke ran (after tools_smoke). Empty
   *  for plugins that contribute no routes. Theme D. */
  adminRouteResults?: AdminRouteSmokeResult[];
  durationMs: number;
  /** Populated only when reason === 'activate_failed'. */
  activateError?: string;
}

export interface RuntimeSmokeOptions {
  zipBuffer: Buffer;
  spec: AgentSpecSkeleton;
  draftId: string;
  rev: number;
  previewRuntime: PreviewRuntime;
  /** Per-tool budget. Default 10s. */
  toolTimeoutMs?: number;
  /** Per-admin-route budget. Default 5s. */
  adminRouteTimeoutMs?: number;
  /** Test override — replaces the PreviewRuntime.activate step. */
  activate?: (opts: PreviewActivateOptions) => Promise<PreviewHandle>;
}

const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
const DEFAULT_ADMIN_ROUTE_TIMEOUT_MS = 5_000;
const SMOKE_STUB_VALUE = 'smoke-test';

/**
 * Lower-level helper: invoke each tool on an already-activated
 * PreviewHandle, then probe contributed admin-route GET endpoints
 * (Theme D). Used by RuntimeSmokeOrchestrator (B.9-3) which reuses
 * the chat-cache's handle instead of activating a second time.
 *
 * Phase order:
 *   1. tools_smoke — invoke each tool with synthetic input.
 *   2. admin_routes_smoke — when at least one route was registered,
 *      mount the captured routers on a temp localhost server and
 *      probe every GET handler for `{ ok: boolean, ... }` schema.
 *
 * Pass criteria:
 *   - All tools pass OR are `validation_failed`.
 *   - All admin-routes pass OR are `empty_warning` (legitimate empty)
 *     OR are `introspection_failed` (we cannot prove a violation
 *     without a route list — soft pass).
 *
 * Does NOT close the handle — caller owns the lifetime.
 */
export async function invokeToolsOnHandle(opts: {
  handle: PreviewHandle;
  spec: AgentSpecSkeleton;
  toolTimeoutMs?: number;
  /** Per-route budget for admin-routes smoke. Default 5s. */
  adminRouteTimeoutMs?: number;
}): Promise<RuntimeSmokeResult> {
  const start = Date.now();
  const toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const tools = opts.handle.toolkit.tools;
  const adminRouteResults = await smokeAdminRoutes({
    captures: opts.handle.routeCaptures,
    spec: opts.spec,
    timeoutMs: opts.adminRouteTimeoutMs ?? DEFAULT_ADMIN_ROUTE_TIMEOUT_MS,
  });
  const adminOk = adminRouteResults.every((r) => isAdminRouteOk(r));
  const adminViolation = !adminOk;

  if (tools.length === 0) {
    const baseReason: RuntimeSmokeReason = adminViolation
      ? 'admin_route_schema_violation'
      : 'no_tools';
    const ok = !adminViolation;
    return {
      ok,
      reason: baseReason,
      results: [],
      ...(adminRouteResults.length > 0 ? { adminRouteResults } : {}),
      durationMs: Date.now() - start,
    };
  }
  const results: ToolSmokeResult[] = [];
  for (const tool of tools) {
    results.push(await invokeOne(tool, opts.spec, toolTimeoutMs));
  }
  const toolsOk = results.every(
    (r) => r.status === 'ok' || r.status === 'validation_failed',
  );
  const reason: RuntimeSmokeReason = !toolsOk
    ? 'tool_failures'
    : adminViolation
      ? 'admin_route_schema_violation'
      : 'ok';
  return {
    ok: toolsOk && adminOk,
    reason,
    results,
    ...(adminRouteResults.length > 0 ? { adminRouteResults } : {}),
    durationMs: Date.now() - start,
  };
}

export async function runRuntimeSmoke(
  opts: RuntimeSmokeOptions,
): Promise<RuntimeSmokeResult> {
  const start = Date.now();
  const toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  const { configValues, secretValues } = stubSetup(opts.spec);

  const activateOpts: PreviewActivateOptions = {
    zipBuffer: opts.zipBuffer,
    draftId: opts.draftId,
    rev: opts.rev,
    configValues,
    secretValues,
    smokeMode: true,
  };

  let handle: PreviewHandle;
  try {
    handle = await (opts.activate
      ? opts.activate(activateOpts)
      : opts.previewRuntime.activate(activateOpts));
  } catch (err) {
    return {
      ok: false,
      reason: 'activate_failed',
      results: [],
      durationMs: Date.now() - start,
      activateError: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const tools = handle.toolkit.tools;
    const adminRouteResults = await smokeAdminRoutes({
      captures: handle.routeCaptures,
      spec: opts.spec,
      timeoutMs: opts.adminRouteTimeoutMs ?? DEFAULT_ADMIN_ROUTE_TIMEOUT_MS,
    });
    const adminOk = adminRouteResults.every((r) => isAdminRouteOk(r));
    const adminViolation = !adminOk;

    if (tools.length === 0) {
      const reason: RuntimeSmokeReason = adminViolation
        ? 'admin_route_schema_violation'
        : 'no_tools';
      return {
        ok: !adminViolation,
        reason,
        results: [],
        ...(adminRouteResults.length > 0 ? { adminRouteResults } : {}),
        durationMs: Date.now() - start,
      };
    }

    const results: ToolSmokeResult[] = [];
    for (const tool of tools) {
      results.push(await invokeOne(tool, opts.spec, toolTimeoutMs));
    }

    const toolsOk = results.every(
      (r) => r.status === 'ok' || r.status === 'validation_failed',
    );
    const reason: RuntimeSmokeReason = !toolsOk
      ? 'tool_failures'
      : adminViolation
        ? 'admin_route_schema_violation'
        : 'ok';
    return {
      ok: toolsOk && adminOk,
      reason,
      results,
      ...(adminRouteResults.length > 0 ? { adminRouteResults } : {}),
      durationMs: Date.now() - start,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function stubSetup(spec: AgentSpecSkeleton): {
  configValues: Record<string, unknown>;
  secretValues: Record<string, string>;
} {
  const setupFields = Array.isArray(spec.setup_fields) ? spec.setup_fields : [];
  const configValues: Record<string, unknown> = {};
  const secretValues: Record<string, string> = {};
  for (const raw of setupFields) {
    if (!raw || typeof raw !== 'object') continue;
    const f = raw as { key?: unknown; type?: unknown };
    if (typeof f.key !== 'string') continue;
    if (f.type === 'secret' || f.type === 'oauth') {
      secretValues[f.key] = SMOKE_STUB_VALUE;
    } else {
      configValues[f.key] = SMOKE_STUB_VALUE;
    }
  }
  return { configValues, secretValues };
}

async function invokeOne(
  tool: PreviewToolDescriptor,
  spec: AgentSpecSkeleton,
  timeoutMs: number,
): Promise<ToolSmokeResult> {
  const toolStart = Date.now();

  const specTools = Array.isArray(spec.tools) ? (spec.tools as unknown[]) : [];
  const toolSpec = specTools.find((t) => {
    if (!t || typeof t !== 'object') return false;
    return (t as { id?: unknown }).id === tool.id;
  }) as { input?: unknown } | undefined;
  const inputSchema = toolSpec?.input ?? null;
  const synthetic = generateInputForSchema(inputSchema);

  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      resolve({
        toolId: tool.id,
        status: 'timeout',
        durationMs: Date.now() - toolStart,
        errorMessage: `tool exceeded ${String(timeoutMs)}ms`,
      });
    }, timeoutMs);

    void Promise.resolve()
      .then(() => tool.run(synthetic))
      .then(
        () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          resolve({
            toolId: tool.id,
            status: 'ok',
            durationMs: Date.now() - toolStart,
          });
        },
        (err: unknown) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          const isZodError = err instanceof Error && err.name === 'ZodError';
          const message = err instanceof Error ? err.message : String(err);
          resolve({
            toolId: tool.id,
            status: isZodError ? 'validation_failed' : 'threw',
            durationMs: Date.now() - toolStart,
            errorMessage: truncateMessage(message),
          });
        },
      );
  });
}

function truncateMessage(s: string, max = 800): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * `result.ok` includes a route as long as it passed OR is a soft-pass
 * outcome — empty external_reads results and introspection failures do
 * not block the build.
 */
function isAdminRouteOk(r: AdminRouteSmokeResult): boolean {
  return (
    r.status === 'ok' ||
    r.status === 'empty_warning' ||
    r.status === 'introspection_failed'
  );
}

/**
 * Mounts the captured admin routers on a temporary localhost http
 * server, probes every GET handler, and validates the response
 * against the `{ ok: boolean, ... }` contract documented in the
 * boilerplate's CLAUDE.md (Theme G).
 *
 * Empty arrays from external_reads-declared endpoints are warnings,
 * not failures — the boilerplate guidance allows legitimate "0 rows"
 * responses (e.g. fresh Odoo install with no employees).
 */
async function smokeAdminRoutes(opts: {
  captures: ReadonlyArray<PreviewRouteCapture>;
  spec: AgentSpecSkeleton;
  timeoutMs: number;
}): Promise<AdminRouteSmokeResult[]> {
  const active = opts.captures.filter((c) => !c.disposed);
  if (active.length === 0) return [];

  const probe = await startProbeServer(active);
  if (!probe) {
    return active.map((c) => ({
      endpoint: c.prefix,
      status: 'introspection_failed' as const,
      durationMs: 0,
      reason: 'unable to mount captured router on probe server',
    }));
  }
  try {
    const externalReadIds = collectExternalReadIds(opts.spec);
    const results: AdminRouteSmokeResult[] = [];
    for (const target of probe.targets) {
      results.push(
        await probeOneAdminRoute({
          baseUrl: probe.baseUrl,
          target,
          timeoutMs: opts.timeoutMs,
          externalReadIds,
        }),
      );
    }
    return results;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

interface ProbeTarget {
  endpoint: string;
  routePath: string;
  declaresExternalRead: boolean;
}

interface ProbeServer {
  baseUrl: string;
  targets: ProbeTarget[];
  close: () => Promise<void>;
}

async function startProbeServer(
  captures: ReadonlyArray<PreviewRouteCapture>,
): Promise<ProbeServer | null> {
  let app: ReturnType<typeof express>;
  const targets: ProbeTarget[] = [];
  try {
    app = express();
    for (const capture of captures) {
      const routerLike = capture.router as unknown as {
        stack?: ReadonlyArray<unknown>;
      } & ((...args: unknown[]) => void);
      if (typeof routerLike !== 'function') continue;
      app.use(capture.prefix, routerLike);
      const getRoutes = extractGetRoutes(routerLike);
      for (const routePath of getRoutes) {
        targets.push({
          endpoint: joinUrlPath(capture.prefix, routePath),
          routePath,
          declaresExternalRead: false,
        });
      }
    }
  } catch {
    return null;
  }

  let server: Server;
  try {
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
  } catch {
    return null;
  }
  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr === 'string') {
    server.close();
    return null;
  }
  const baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  return {
    baseUrl,
    targets,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Express's router.stack is not stable public API. Best-effort
 * introspection: look for entries with a `route` whose `methods.get`
 * is true. Returns [] when the shape doesn't match — caller treats an
 * empty list as "no routes to probe", not as a failure.
 */
function extractGetRoutes(router: unknown): string[] {
  try {
    const stack = (router as { stack?: ReadonlyArray<unknown> }).stack;
    if (!Array.isArray(stack)) return [];
    const out: string[] = [];
    for (const layer of stack) {
      const route = (layer as { route?: { path?: unknown; methods?: unknown } })
        .route;
      if (!route || typeof route.path !== 'string') continue;
      const methods = route.methods as Record<string, unknown> | undefined;
      if (methods?.['get'] === true) {
        out.push(route.path);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function joinUrlPath(prefix: string, route: string): string {
  const left = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const right = route.startsWith('/') ? route : `/${route}`;
  return `${left}${right}`;
}

/**
 * Pulls every `id` from `spec.external_reads` so the smoke can
 * heuristically flag empty array responses on declared lookups.
 */
function collectExternalReadIds(spec: AgentSpecSkeleton): Set<string> {
  const ids = new Set<string>();
  const reads = Array.isArray(spec.external_reads) ? spec.external_reads : [];
  for (const raw of reads) {
    if (!raw || typeof raw !== 'object') continue;
    const id = (raw as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  return ids;
}

async function probeOneAdminRoute(opts: {
  baseUrl: string;
  target: ProbeTarget;
  timeoutMs: number;
  externalReadIds: Set<string>;
}): Promise<AdminRouteSmokeResult> {
  const start = Date.now();
  const url = `${opts.baseUrl}${opts.target.endpoint}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'x-smoke-mode': '1' },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    const aborted =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      endpoint: opts.target.endpoint,
      status: aborted ? 'timeout' : 'http_error',
      durationMs: Date.now() - start,
      reason: aborted
        ? `fetch exceeded ${String(opts.timeoutMs)}ms`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }

  if (res.status >= 400) {
    return {
      endpoint: opts.target.endpoint,
      status: 'http_error',
      httpStatus: res.status,
      durationMs: Date.now() - start,
      reason: `HTTP ${String(res.status)}`,
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      endpoint: opts.target.endpoint,
      status: 'schema_violation',
      httpStatus: res.status,
      durationMs: Date.now() - start,
      reason: 'response body is not JSON',
    };
  }

  if (!body || typeof body !== 'object') {
    return {
      endpoint: opts.target.endpoint,
      status: 'schema_violation',
      httpStatus: res.status,
      durationMs: Date.now() - start,
      reason: 'response body is not a JSON object',
    };
  }

  const okField = (body as { ok?: unknown }).ok;
  if (typeof okField !== 'boolean') {
    return {
      endpoint: opts.target.endpoint,
      status: 'schema_violation',
      httpStatus: res.status,
      durationMs: Date.now() - start,
      reason: "response body missing required 'ok: boolean' field",
    };
  }

  if (okField === false) {
    const errMsg = (body as { error?: unknown }).error;
    return {
      endpoint: opts.target.endpoint,
      status: 'http_error',
      httpStatus: res.status,
      durationMs: Date.now() - start,
      reason:
        typeof errMsg === 'string'
          ? `endpoint reported failure: ${errMsg}`
          : 'endpoint reported ok:false without error message',
    };
  }

  if (matchesExternalRead(opts.target.endpoint, opts.externalReadIds)) {
    if (containsEmptyArrayPayload(body)) {
      return {
        endpoint: opts.target.endpoint,
        status: 'empty_warning',
        httpStatus: res.status,
        durationMs: Date.now() - start,
        reason: 'declared external_read returned an empty array',
      };
    }
  }

  return {
    endpoint: opts.target.endpoint,
    status: 'ok',
    httpStatus: res.status,
    durationMs: Date.now() - start,
  };
}

/**
 * Heuristic: an admin route URL whose last segment matches a declared
 * external_reads id is treated as a probe target for empty-detection.
 * E.g. `/api/<slug>/admin/api/employees` against external_read id
 * `list_employees` matches via the `employees` segment.
 */
function matchesExternalRead(endpoint: string, ids: Set<string>): boolean {
  if (ids.size === 0) return false;
  const segments = endpoint.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  for (const id of ids) {
    if (id === last) return true;
    if (id.startsWith('list_') && id.slice('list_'.length) === last) {
      return true;
    }
  }
  return false;
}

/**
 * Empty-detection: a 2xx body with `ok:true` whose only non-`ok`
 * payload field is an empty array. Conservative — a body shaped like
 * `{ ok: true, items: [], page: 1 }` is NOT flagged because a numeric
 * field is present (operator likely paginating). Only flags the simple
 * "wrapper around an empty array" case.
 */
function containsEmptyArrayPayload(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const entries = Object.entries(body as Record<string, unknown>);
  const payloadEntries = entries.filter(([k]) => k !== 'ok');
  if (payloadEntries.length !== 1) return false;
  const [, value] = payloadEntries[0]!;
  return Array.isArray(value) && value.length === 0;
}
