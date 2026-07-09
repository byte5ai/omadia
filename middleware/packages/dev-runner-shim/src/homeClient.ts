/**
 * Epic #470 W0 — phone-home HTTP client (spec §4/§5). Talks the runner API at
 * `${baseUrl}/api/v1/dev-runner`, authenticating every call with the per-job
 * bearer. Node's global `fetch` only — no dependency. Errors carry the status
 * and the server `{code}` when present, never the bearer token.
 */

import {
  RUNNER_API_PREFIX,
  type DevJobSpec,
  type RunnerResult,
  type SeqRunnerEvent,
  type ShimEnv,
} from './protocol.js';

export interface ScmToken {
  token: string;
  expiresAt: string;
}

export interface HeartbeatReply {
  ok: boolean;
  cancelRequested: boolean;
}

/** The phone-home surface the shim lifecycle depends on. Injectable in tests. */
export interface HomeApi {
  fetchSpec(): Promise<DevJobSpec>;
  fetchScmToken(): Promise<ScmToken>;
  postEvents(provision: number, events: SeqRunnerEvent[]): Promise<number>;
  heartbeat(): Promise<HeartbeatReply>;
  postDiff(bundle: string): Promise<string>;
  postResult(result: RunnerResult): Promise<void>;
}

/** Thrown for any non-2xx phone-home response. Never includes the bearer. */
export class HomeError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'HomeError';
  }
}

export class HomeClient implements HomeApi {
  private readonly base: string;
  private readonly jobId: string;
  private readonly authHeader: string;

  public constructor(
    env: Pick<ShimEnv, 'baseUrl' | 'jobId' | 'jobToken'>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = `${env.baseUrl}${RUNNER_API_PREFIX}`;
    this.jobId = env.jobId;
    this.authHeader = `Bearer ${env.jobToken}`;
  }

  /** GET /jobs/:id/spec — flips provisioning→running host-side. */
  public async fetchSpec(): Promise<DevJobSpec> {
    return this.json<DevJobSpec>('GET', '/spec');
  }

  /** GET /jobs/:id/scm-token — one-shot, read-only clone credential. */
  public async fetchScmToken(): Promise<ScmToken> {
    return this.json<ScmToken>('GET', '/scm-token');
  }

  /** POST /jobs/:id/events — idempotent per (job, provision, seq). */
  public async postEvents(provision: number, events: SeqRunnerEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const body = await this.json<{ accepted: number }>('POST', '/events', {
      json: { provision, events },
    });
    return body.accepted;
  }

  /** POST /jobs/:id/heartbeat — carries the cancel signal back. */
  public async heartbeat(): Promise<HeartbeatReply> {
    return this.json<HeartbeatReply>('POST', '/heartbeat', { json: {} });
  }

  /** POST /jobs/:id/diff — unified diff + numstat as one text/plain artifact. */
  public async postDiff(bundle: string): Promise<string> {
    const body = await this.json<{ artifactId: string }>('POST', '/diff', {
      text: bundle,
    });
    return body.artifactId;
  }

  /** POST /jobs/:id/result — terminal report. */
  public async postResult(result: RunnerResult): Promise<void> {
    await this.json<{ ok: boolean }>('POST', '/result', { json: result });
  }

  private async json<T>(
    method: string,
    path: string,
    opts?: { json?: unknown; text?: string },
  ): Promise<T> {
    const headers: Record<string, string> = { authorization: this.authHeader };
    let body: string | undefined;
    if (opts?.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts?.text !== undefined) {
      headers['content-type'] = 'text/plain';
      body = opts.text;
    }
    const res = await this.fetchImpl(`${this.base}/jobs/${encodeURIComponent(this.jobId)}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    if (!res.ok) {
      let code: string | undefined;
      try {
        const parsed = (await res.json()) as { code?: string; message?: string };
        code = parsed.code;
      } catch {
        /* non-JSON error body; the status is enough */
      }
      throw new HomeError(res.status, code, `${method} ${path} → ${String(res.status)}${code ? ` (${code})` : ''}`);
    }
    // A 204 or empty body is valid for the void-ish calls; parse defensively.
    const raw = await res.text();
    return (raw.length > 0 ? JSON.parse(raw) : {}) as T;
  }
}
