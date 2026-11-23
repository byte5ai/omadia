import { admitModelCall } from '@omadia/llm-provider';
import { perCallerService, type ModelPassthroughService, type OperatorJob, type OperatorJobsService, type PerCallerFactory } from '@omadia/plugin-api';

import { effectiveKind, type PluginKind } from '../api/admin-v1.js';

import type { ModelWorkHandle, ModelWorkRuns } from './modelWorkRuns.js';

/**
 * Spec 2042 §5.10 — operator jobs and Anthropic Messages passthrough for
 * system modules (`operatorJobs@1`, `modelPassthrough@1`, plugin-api
 * `modelPassthrough.ts`).
 *
 * The module holds no model credentials and talks to no model API: the
 * kernel opens the job (a recorded operator job with budget, deadline and
 * cancel), takes the instance's Anthropic credentials, admits each call in
 * the job's execution context and returns the provider's response. A job
 * object is only valid when this kernel issued it; one the plugin built
 * itself is refused.
 */

/** Ceilings on what a system module may ask for one job. */
const MAX_JOB_CALLS = 10_000;
const MAX_JOB_DEADLINE_MS = 24 * 60 * 60 * 1000;
const JOB_KIND_PATTERN = /^[a-z][a-z0-9_-]{0,59}$/;

/** The only client headers forwarded; the kernel adds the credentials. */
const FORWARDED_HEADERS = ['anthropic-version', 'anthropic-beta', 'accept', 'content-type'] as const;
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

export class ModelPassthroughError extends Error {
  constructor(
    readonly code:
      | 'model_passthrough.unknown_job'
      | 'model_passthrough.no_credentials'
      | 'model_passthrough.invalid_job'
      | 'model_passthrough.not_system_module',
    message: string,
  ) {
    super(message);
    this.name = 'ModelPassthroughError';
  }
}

export interface AnthropicCredentials {
  readonly apiKey: string | null | undefined;
  readonly baseURL: string | undefined;
}

export interface ModelPassthroughDeps {
  readonly runs: Pick<ModelWorkRuns, 'open'>;
  /** The instance's current Anthropic client (credentials change at runtime). */
  readonly anthropic: () => AnthropicCredentials;
  /** Test seam. */
  readonly fetchImpl?: typeof fetch;
}

export interface ModelPassthroughServices {
  operatorJobsFor(pluginId: string): OperatorJobsService;
  passthroughFor(pluginId: string): ModelPassthroughService;
}

export function createModelPassthrough(deps: ModelPassthroughDeps): ModelPassthroughServices {
  // Only kernel-issued jobs, and only by the plugin they were issued to.
  const issued = new WeakMap<OperatorJob, { readonly handle: ModelWorkHandle; readonly pluginId: string }>();
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    operatorJobsFor(pluginId) {
      return {
        async open(input) {
          if (typeof input.kind !== 'string' || !JOB_KIND_PATTERN.test(input.kind)) {
            throw new ModelPassthroughError('model_passthrough.invalid_job', `job kind must match ${String(JOB_KIND_PATTERN)}`);
          }
          const budgetCalls = clampInt(input.budgetCalls, 1, MAX_JOB_CALLS);
          const deadlineMs = clampInt(input.deadlineMs, 1_000, MAX_JOB_DEADLINE_MS);
          const handle = await deps.runs.open(
            {
              kind: `${pluginId}:${input.kind}`.slice(0, 100),
              context: 'operator_job',
              budgetCalls,
              deadlineMs,
              effects: (Array.isArray(input.effects) ? input.effects : []).map(String).slice(0, 20),
            },
            input.startedBy,
          );
          const job: OperatorJob = {
            id: handle.id,
            signal: handle.signal,
            end: (outcome) => handle.finish(outcome),
          };
          issued.set(job, { handle, pluginId });
          return job;
        },
      };
    },

    passthroughFor(pluginId) {
      return {
        async forwardAnthropicMessages(input) {
          const entry = issued.get(input.job);
          if (!entry || entry.pluginId !== pluginId) {
            throw new ModelPassthroughError('model_passthrough.unknown_job', 'the job was not opened through operatorJobs for this plugin');
          }
          const { apiKey, baseURL } = deps.anthropic();
          if (!apiKey) {
            throw new ModelPassthroughError(
              'model_passthrough.no_credentials',
              'no Anthropic API key is set on this instance; the model passthrough needs the Anthropic model provider configured',
            );
          }
          const headers: Record<string, string> = { 'x-api-key': apiKey };
          for (const name of FORWARDED_HEADERS) {
            const value = input.headers[name];
            if (typeof value === 'string' && value.length > 0) headers[name] = value;
          }
          headers['anthropic-version'] ??= DEFAULT_ANTHROPIC_VERSION;
          headers['content-type'] ??= 'application/json';
          const url = `${(baseURL ?? 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages${safeQuery(input.query)}`;
          return entry.handle.admit(async () => {
            admitModelCall('complete');
            const signal = input.signal ? AbortSignal.any([input.signal, entry.handle.signal]) : entry.handle.signal;
            const upstream = await fetchImpl(url, { method: 'POST', headers, body: input.body, signal });
            return withoutCredential(upstream, apiKey);
          });
        },
      };
    },
  };
}

/**
 * The service a caller resolves: built for its plugin id, refused to every
 * plugin that is not a system module (a capability or archetype plugin
 * reaches models through `ctx.llm` in its caller's context).
 */
export function systemModuleOnlyService<T>(
  name: string,
  kindOf: (pluginId: string) => PluginKind | undefined,
  make: (pluginId: string) => T,
): PerCallerFactory<T> {
  return perCallerService((caller): T => {
    const kind = kindOf(caller.pluginId);
    if (kind === undefined || effectiveKind(kind) !== 'system-module') {
      throw new ModelPassthroughError(
        'model_passthrough.not_system_module',
        `'${name}' is only given to system modules; plugin '${caller.pluginId}' reaches models through ctx.llm`,
      );
    }
    return make(caller.pluginId);
  });
}

/** Response headers never handed back: hop-by-hop, recomputed, auth-like. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'transfer-encoding',
  'content-length',
  'content-encoding',
  'keep-alive',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'set-cookie',
  'www-authenticate',
  'proxy-authenticate',
]);

/**
 * The provider's response without the instance's credential: auth-like
 * headers dropped, and every occurrence of the key in the body (streamed or
 * not, also split across chunks) replaced by `[REDACTED]`. The module the
 * response goes to never held the key and must not learn it from an echo.
 */
export function withoutCredential(upstream: Response, secret: string): Response {
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase()) && !value.includes(secret)) headers.set(name, value);
  });
  const init = { status: upstream.status, statusText: upstream.statusText, headers };
  if (!upstream.body || secret.length === 0) return new Response(upstream.body, init);
  return new Response(upstream.body.pipeThrough(redactStream(secret)), init);
}

const REDACTED = new TextEncoder().encode('[REDACTED]');

/** Replace `secret` in a byte stream, holding back a tail shorter than the
 *  secret so a match split across chunks is still found. */
function redactStream(secret: string): TransformStream<Uint8Array, Uint8Array> {
  const needle = new TextEncoder().encode(secret);
  let carry = new Uint8Array(0);
  const indexOf = (hay: Uint8Array, from: number): number => {
    outer: for (let i = from; i <= hay.length - needle.length; i += 1) {
      for (let j = 0; j < needle.length; j += 1) if (hay[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  };
  const concat = (parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const scrub = (buf: Uint8Array): Uint8Array => {
    const parts: Uint8Array[] = [];
    let start = 0;
    for (let i = indexOf(buf, 0); i !== -1; i = indexOf(buf, start)) {
      parts.push(buf.subarray(start, i), REDACTED);
      start = i + needle.length;
    }
    parts.push(buf.subarray(start));
    return concat(parts);
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const scrubbed = scrub(concat([carry, chunk]));
      const keep = Math.min(needle.length - 1, scrubbed.length);
      carry = scrubbed.slice(scrubbed.length - keep);
      if (scrubbed.length > keep) controller.enqueue(scrubbed.subarray(0, scrubbed.length - keep));
    },
    flush(controller) {
      if (carry.length > 0) controller.enqueue(carry);
    },
  });
}

function clampInt(raw: unknown, min: number, max: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : min;
  return Math.min(max, Math.max(min, n));
}

/** Only a plain query string (`?beta=true`) passes; nothing that changes the path. */
function safeQuery(query: string | undefined): string {
  if (!query) return '';
  return /^\?[A-Za-z0-9_.~=&%-]*$/.test(query) ? query : '';
}
